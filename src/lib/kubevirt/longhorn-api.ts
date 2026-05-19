import "server-only";

import { ApiError } from "./errors";

const DEFAULT_LONGHORN_API_URL = "http://longhorn-backend.longhorn-system.svc:9500/v1";
const REQUEST_TIMEOUT_MS = 60_000;

interface LonghornNode {
  name?: string;
  allowScheduling?: boolean;
}

interface LonghornNodeCollection {
  data?: LonghornNode[];
}

function longhornApiBase(): URL {
  const raw = process.env.LONGHORN_API_URL ?? DEFAULT_LONGHORN_API_URL;
  return new URL(raw.endsWith("/") ? raw : `${raw}/`);
}

function longhornPath(path: string): URL {
  const cleanPath = path.startsWith("/") ? path.slice(1) : path;
  return new URL(cleanPath, longhornApiBase());
}

function errorMessage(body: unknown, fallback: string): string {
  if (typeof body === "string" && body.trim()) {
    return body.trim();
  }

  if (typeof body === "object" && body !== null) {
    if ("message" in body && typeof body.message === "string") {
      return body.message;
    }

    if ("code" in body && typeof body.code === "string") {
      return body.code;
    }
  }

  return fallback;
}

export async function requestLonghornJson<T>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const payload = body === undefined ? undefined : JSON.stringify(body);

  try {
    const response = await fetch(longhornPath(path), {
      method,
      body: payload,
      headers: payload
        ? {
            Accept: "application/json",
            "Content-Type": "application/json",
          }
        : {
            Accept: "application/json",
          },
      signal: controller.signal,
    });
    const text = await response.text();
    const parsed = text ? JSON.parse(text) : undefined;

    if (!response.ok) {
      throw new ApiError(
        response.status,
        errorMessage(parsed, `Longhorn API request failed with HTTP ${response.status}.`),
      );
    }

    return parsed as T;
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }

    if (error instanceof SyntaxError) {
      throw new ApiError(502, "Longhorn API returned invalid JSON.");
    }

    if (error instanceof DOMException && error.name === "AbortError") {
      throw new ApiError(504, "Longhorn API request timed out.");
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function chooseMaintenanceNode(): Promise<string> {
  const nodes = await requestLonghornJson<LonghornNodeCollection>("GET", "/nodes");
  const node = (nodes.data ?? []).find(
    (candidate) => candidate.name && candidate.allowScheduling !== false,
  );
  if (!node?.name) {
    throw new ApiError(409, "No schedulable Longhorn node is available for maintenance attach.");
  }

  return node.name;
}

export async function attachVolumeForMaintenance(volumeName: string, nodeName: string) {
  return requestLonghornJson("POST", `/volumes/${encodeURIComponent(volumeName)}?action=attach`, {
    hostId: nodeName,
    disableFrontend: true,
    attachedBy: "vm-manager",
    attacherType: "vm-manager",
    attachmentID: "vm-manager-maintenance",
  });
}

export async function detachMaintenanceVolume(volumeName: string) {
  return requestLonghornJson("POST", `/volumes/${encodeURIComponent(volumeName)}?action=detach`, {
    attachmentID: "vm-manager-maintenance",
    forceDetach: false,
  });
}

export async function revertSnapshot(volumeName: string, snapshotName: string) {
  return requestLonghornJson(
    "POST",
    `/volumes/${encodeURIComponent(volumeName)}?action=snapshotRevert`,
    {
      name: snapshotName,
    },
  );
}
