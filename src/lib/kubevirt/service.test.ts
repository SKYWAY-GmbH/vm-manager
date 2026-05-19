import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const client = vi.hoisted(() => ({
  createNamespacedCustomObject: vi.fn(),
  deleteNamespacedCustomObject: vi.fn(),
  getNamespacedCustomObject: vi.fn(),
  listCustomObjectForAllNamespaces: vi.fn(),
  listNamespacedCustomObject: vi.fn(),
}));

const rawKubeRequest = vi.hoisted(() => vi.fn());

vi.mock("./client", () => ({
  getCustomObjectsClient: () => client,
  requestKubeJson: rawKubeRequest,
}));

import {
  createVirtualMachineRestore,
  getVirtualMachine,
  performVirtualMachineAction,
} from "./service";
import type { KubeVirtVirtualMachineInstance } from "./types";

function notFoundError() {
  return Object.assign(new Error("not found"), { code: 404 });
}

const vm = {
  metadata: { name: "vm-01", namespace: "windows" },
  spec: { runStrategy: "Manual" },
  status: { printableStatus: "Stopped", ready: false },
};

const readySnapshot = {
  metadata: { name: "snap-a", namespace: "windows" },
  spec: { source: { kind: "VirtualMachine", name: "vm-01" } },
  status: { readyToUse: true, phase: "Succeeded" },
};

function vmi(phase: string): KubeVirtVirtualMachineInstance {
  return {
    metadata: { name: "vm-01", namespace: "windows" },
    status: { phase },
  };
}

function setupRestore(vmis: Array<KubeVirtVirtualMachineInstance | "not-found">) {
  const vmiResponses = [...vmis];

  client.getNamespacedCustomObject.mockImplementation(({ plural }: { plural: string }) => {
    if (plural === "virtualmachines") {
      return Promise.resolve(vm);
    }

    if (plural === "virtualmachineinstances") {
      const next = vmiResponses.shift();
      if (next === "not-found" || !next) {
        return Promise.reject(notFoundError());
      }

      return Promise.resolve(next);
    }

    return Promise.reject(notFoundError());
  });

  client.listNamespacedCustomObject.mockImplementation(({ plural }: { plural: string }) => {
    if (plural === "virtualmachinesnapshots") {
      return Promise.resolve({ items: [readySnapshot] });
    }

    if (plural === "virtualmachinerestores") {
      return Promise.resolve({ items: [] });
    }

    return Promise.resolve({ items: [] });
  });

  client.createNamespacedCustomObject.mockImplementation(({ body }: { body: unknown }) =>
    Promise.resolve(body),
  );
  client.deleteNamespacedCustomObject.mockResolvedValue({});
  rawKubeRequest.mockResolvedValue({});
}

describe("createVirtualMachineRestore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deletes a terminal VMI before creating a restore", async () => {
    setupRestore([vmi("Succeeded"), vmi("Succeeded"), "not-found"]);

    const restore = await createVirtualMachineRestore("windows", "vm-01", "snap-a", "restore-a");

    expect(client.deleteNamespacedCustomObject).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: "windows",
        plural: "virtualmachineinstances",
        name: "vm-01",
        gracePeriodSeconds: 0,
      }),
    );
    expect(client.createNamespacedCustomObject).toHaveBeenCalledWith(
      expect.objectContaining({
        plural: "virtualmachinerestores",
      }),
    );
    expect(restore).toMatchObject({ name: "restore-a", snapshotName: "snap-a" });
  });

  it("waits for a non-terminal VMI to disappear instead of deleting it", async () => {
    setupRestore([vmi("Running"), vmi("Running"), "not-found"]);

    await expect(
      createVirtualMachineRestore("windows", "vm-01", "snap-a", "restore-a"),
    ).resolves.toMatchObject({ name: "restore-a" });

    expect(client.deleteNamespacedCustomObject).not.toHaveBeenCalled();
    expect(client.createNamespacedCustomObject).toHaveBeenCalled();
  });

  it("marks snapshots with missing Longhorn source volumes as not restorable", async () => {
    setupRestore(["not-found"]);
    client.listNamespacedCustomObject.mockImplementation(({ plural }: { plural: string }) => {
      if (plural === "virtualmachinesnapshots") {
        return Promise.resolve({ items: [readySnapshot] });
      }

      if (plural === "virtualmachinerestores") {
        return Promise.resolve({ items: [] });
      }

      if (plural === "virtualmachinesnapshotcontents") {
        return Promise.resolve({
          items: [
            {
              spec: {
                virtualMachineSnapshotName: "snap-a",
                volumeBackups: [
                  {
                    volumeName: "persistent-state-for-vm-01",
                    volumeSnapshotName: "vmsnapshot-a",
                  },
                ],
              },
            },
          ],
        });
      }

      if (plural === "volumes") {
        return Promise.resolve({ items: [{ metadata: { name: "other-volume" } }] });
      }

      return Promise.resolve({ items: [] });
    });
    client.listCustomObjectForAllNamespaces.mockResolvedValue({
      items: [
        {
          spec: {
            driver: "driver.longhorn.io",
            source: { volumeHandle: "missing-volume" },
            volumeSnapshotRef: { namespace: "windows", name: "vmsnapshot-a" },
          },
        },
      ],
    });

    const detail = await getVirtualMachine("windows", "vm-01");
    expect(detail.snapshots[0]?.restoreBlockedReason).toContain("Longhorn volume");

    await expect(
      createVirtualMachineRestore("windows", "vm-01", "snap-a", "restore-a"),
    ).rejects.toThrow("cannot be restored");
    expect(client.createNamespacedCustomObject).not.toHaveBeenCalled();
  });
});

describe("performVirtualMachineAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses PUT for KubeVirt VM subresource actions", async () => {
    setupRestore(["not-found"]);

    await performVirtualMachineAction("windows", "vm-01", "start");

    expect(rawKubeRequest).toHaveBeenCalledWith(
      "PUT",
      "/apis/subresources.kubevirt.io/v1/namespaces/windows/virtualmachines/vm-01/start",
      expect.objectContaining({ kind: "StartOptions" }),
    );
  });
});
