import "server-only";

import http from "node:http";
import https from "node:https";
import * as k8s from "@kubernetes/client-node";
import { ApiError } from "./errors";

interface CustomObjectRequest {
  group: string;
  version: string;
  plural: string;
  namespace?: string;
  name?: string;
  gracePeriodSeconds?: number;
  propagationPolicy?: string;
  body?: unknown;
}

export interface CustomObjectsClient {
  listCustomObjectForAllNamespaces(request: CustomObjectRequest): Promise<unknown>;
  listNamespacedCustomObject(request: CustomObjectRequest): Promise<unknown>;
  getNamespacedCustomObject(request: CustomObjectRequest): Promise<unknown>;
  createNamespacedCustomObject(request: CustomObjectRequest): Promise<unknown>;
  deleteNamespacedCustomObject(request: CustomObjectRequest): Promise<unknown>;
}

let kubeConfig: k8s.KubeConfig | null = null;
let customObjectsClient: CustomObjectsClient | null = null;

export function getKubeConfig(): k8s.KubeConfig {
  if (!kubeConfig) {
    const config = new k8s.KubeConfig();
    if (process.env.KUBERNETES_SERVICE_HOST) {
      config.loadFromCluster();
    } else {
      config.loadFromDefault();
    }

    kubeConfig = config;
  }

  return kubeConfig;
}

export function getCustomObjectsClient(): CustomObjectsClient {
  if (!customObjectsClient) {
    customObjectsClient = getKubeConfig().makeApiClient(
      k8s.CustomObjectsApi,
    ) as unknown as CustomObjectsClient;
  }

  return customObjectsClient;
}

function joinServerPath(server: string, path: string): URL {
  const cleanServer = server.endsWith("/") ? server : `${server}/`;
  const cleanPath = path.startsWith("/") ? path.slice(1) : path;
  return new URL(cleanPath, cleanServer);
}

function parseResponseBody(text: string): unknown {
  if (!text) {
    return undefined;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function getErrorMessage(body: unknown, fallback: string): string {
  if (typeof body === "string" && body.trim()) {
    return body.trim();
  }

  if (typeof body === "object" && body !== null) {
    if ("message" in body && typeof body.message === "string") {
      return body.message;
    }

    if ("reason" in body && typeof body.reason === "string") {
      return body.reason;
    }
  }

  return fallback;
}

export async function requestKubeJson(
  method: "POST" | "PUT",
  path: string,
  body?: unknown,
): Promise<unknown> {
  const config = getKubeConfig();
  const cluster = config.getCurrentCluster();
  if (!cluster?.server) {
    throw new ApiError(500, "Kubernetes cluster configuration is not available.");
  }

  const url = joinServerPath(cluster.server, path);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const headers: Record<string, string | number> = {
    Accept: "*/*",
  };

  if (payload) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = Buffer.byteLength(payload);
  }

  const options: https.RequestOptions = {
    method,
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port,
    path: `${url.pathname}${url.search}`,
    headers,
    timeout: 30_000,
  };

  await config.applyToHTTPSOptions(options);

  return new Promise((resolve, reject) => {
    const requestModule = url.protocol === "http:" ? http : https;
    const request = requestModule.request(options, (response) => {
      const chunks: Buffer[] = [];

      response.on("data", (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });

      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        const parsed = parseResponseBody(text);
        const statusCode = response.statusCode ?? 500;

        if (statusCode < 200 || statusCode >= 300) {
          reject(
            new ApiError(
              statusCode,
              getErrorMessage(parsed, `Kubernetes API request failed with HTTP ${statusCode}.`),
            ),
          );
          return;
        }

        resolve(parsed);
      });
    });

    request.on("timeout", () => {
      request.destroy(new ApiError(504, "Kubernetes API request timed out."));
    });

    request.on("error", reject);

    if (payload) {
      request.write(payload);
    }

    request.end();
  });
}
