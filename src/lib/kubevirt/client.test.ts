import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const kubeState = vi.hoisted(() => ({ server: "" }));

vi.mock("@kubernetes/client-node", () => {
  class KubeConfig {
    loadFromCluster() {}
    loadFromDefault() {}
    getCurrentCluster() {
      return { server: kubeState.server };
    }
    applyToHTTPSOptions() {
      return Promise.resolve();
    }
    makeApiClient() {
      return {};
    }
  }

  class CoreV1Api {}
  class CustomObjectsApi {}

  return { CoreV1Api, CustomObjectsApi, KubeConfig };
});

import { patchNamespacedCustomObjectMergePatch, patchPersistentVolumeMergePatch } from "./client";

interface SeenRequest {
  body: string;
  contentType: string | undefined;
  method: string | undefined;
  url: string | undefined;
}

describe("Kubernetes patch helpers", () => {
  let server: http.Server;
  const seen: SeenRequest[] = [];

  beforeEach(async () => {
    seen.length = 0;
    server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      request.on("end", () => {
        seen.push({
          body: Buffer.concat(chunks).toString("utf8"),
          contentType: request.headers["content-type"],
          method: request.method,
          url: request.url,
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });

    const address = server.address();
    if (typeof address === "object" && address) {
      kubeState.server = `http://127.0.0.1:${address.port}`;
    }
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  });

  it("sends custom-object merge patches with the merge-patch content type", async () => {
    await patchNamespacedCustomObjectMergePatch({
      group: "kubevirt.io",
      version: "v1",
      namespace: "windows",
      plural: "virtualmachines",
      name: "vm-01",
      body: { metadata: { annotations: { "vm-manager.skyway.tools/operation-type": "snapshot" } } },
    });

    expect(seen[0]).toMatchObject({
      body: JSON.stringify({
        metadata: { annotations: { "vm-manager.skyway.tools/operation-type": "snapshot" } },
      }),
      contentType: "application/merge-patch+json",
      method: "PATCH",
      url: "/apis/kubevirt.io/v1/namespaces/windows/virtualmachines/vm-01",
    });
  });

  it("sends persistent-volume merge patches with the merge-patch content type", async () => {
    await patchPersistentVolumeMergePatch({
      name: "pv-root",
      body: { spec: { persistentVolumeReclaimPolicy: "Retain" } },
    });

    expect(seen[0]).toMatchObject({
      body: JSON.stringify({ spec: { persistentVolumeReclaimPolicy: "Retain" } }),
      contentType: "application/merge-patch+json",
      method: "PATCH",
      url: "/api/v1/persistentvolumes/pv-root",
    });
  });
});
