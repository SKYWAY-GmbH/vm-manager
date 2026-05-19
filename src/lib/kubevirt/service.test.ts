import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const customClient = vi.hoisted(() => ({
  createNamespacedCustomObject: vi.fn(),
  deleteNamespacedCustomObject: vi.fn(),
  getNamespacedCustomObject: vi.fn(),
  listCustomObjectForAllNamespaces: vi.fn(),
  listNamespacedCustomObject: vi.fn(),
  patchNamespacedCustomObject: vi.fn(),
}));

const coreClient = vi.hoisted(() => ({
  createNamespacedPersistentVolumeClaim: vi.fn(),
  createPersistentVolume: vi.fn(),
  deleteNamespacedPersistentVolumeClaim: vi.fn(),
  deletePersistentVolume: vi.fn(),
  listPersistentVolume: vi.fn(),
  patchPersistentVolume: vi.fn(),
  readNamespacedPersistentVolumeClaim: vi.fn(),
  readPersistentVolume: vi.fn(),
}));

const rawKubeRequest = vi.hoisted(() => vi.fn());
const patchNamespacedCustomObjectMergePatch = vi.hoisted(() => vi.fn());
const patchPersistentVolumeMergePatch = vi.hoisted(() => vi.fn());

vi.mock("./client", () => ({
  getCoreV1Client: () => coreClient,
  getCustomObjectsClient: () => customClient,
  patchNamespacedCustomObjectMergePatch,
  patchPersistentVolumeMergePatch,
  requestKubeJson: rawKubeRequest,
}));

const longhornApi = vi.hoisted(() => ({
  attachVolumeForMaintenance: vi.fn(),
  chooseMaintenanceNode: vi.fn(),
  detachMaintenanceVolume: vi.fn(),
  revertSnapshot: vi.fn(),
}));

vi.mock("./longhorn-api", () => longhornApi);

import { createVirtualMachineSnapshot, restoreVirtualMachineBackup } from "./service";
import type {
  KubeLonghornBackup,
  KubeLonghornVolume,
  KubePersistentVolume,
  KubePersistentVolumeClaim,
  KubeVirtVirtualMachine,
  KubeVirtVirtualMachineInstance,
} from "./types";

function notFoundError() {
  return Object.assign(new Error("not found"), { code: 404 });
}

const vm: KubeVirtVirtualMachine = {
  metadata: { name: "vm-01", namespace: "windows" },
  spec: {
    runStrategy: "Manual",
    template: {
      spec: {
        volumes: [
          { name: "rootdisk", persistentVolumeClaim: { claimName: "rootdisk-pvc" } },
          {
            name: "tpmstate",
            persistentVolumeClaim: { claimName: "persistent-state-for-vm-01" },
          },
        ],
      },
    },
  },
  status: { printableStatus: "Stopped", ready: false },
};

const runningVm: KubeVirtVirtualMachine = {
  ...vm,
  status: { printableStatus: "Running", ready: true, created: true },
};

const pvc: KubePersistentVolumeClaim = {
  metadata: { name: "rootdisk-pvc", namespace: "windows", labels: { app: "vm-01" } },
  spec: {
    accessModes: ["ReadWriteOnce"],
    resources: { requests: { storage: "20Gi" } },
    storageClassName: "longhorn",
    volumeMode: "Block",
    volumeName: "pv-root",
  },
  status: { phase: "Bound" },
};

const pv: KubePersistentVolume = {
  metadata: { name: "pv-root", labels: { storage: "longhorn" } },
  spec: {
    accessModes: ["ReadWriteOnce"],
    capacity: { storage: "20Gi" },
    csi: {
      driver: "driver.longhorn.io",
      fsType: "ext4",
      volumeAttributes: { numberOfReplicas: "3" },
      volumeHandle: "pvc-123",
    },
    persistentVolumeReclaimPolicy: "Delete",
    storageClassName: "longhorn",
    volumeMode: "Block",
  },
};

const detachedVolume: KubeLonghornVolume = {
  metadata: { name: "pvc-123", namespace: "longhorn-system" },
  spec: { size: "21474836480", frontend: "blockdev", dataEngine: "v1", numberOfReplicas: 3 },
  status: { state: "detached", restoreRequired: false },
};

const attachedMaintenanceVolume: KubeLonghornVolume = {
  ...detachedVolume,
  status: { state: "attached", frontendDisabled: true, restoreRequired: false },
};

const backup: KubeLonghornBackup = {
  metadata: { name: "backup-a", namespace: "longhorn-system" },
  spec: { snapshotName: "snap-a", backupMode: "incremental" },
  status: {
    state: "Completed",
    progress: 100,
    url: "s3://backupstore?volume=pvc-123&backup=backup-a",
    volumeName: "pvc-123",
    volumeSize: "21474836480",
    snapshotName: "snap-a",
    backupCreatedAt: "2026-05-19T10:00:00Z",
  },
};

function setupBase({
  virtualMachine = vm,
  vmi,
}: {
  virtualMachine?: KubeVirtVirtualMachine;
  vmi?: KubeVirtVirtualMachineInstance;
} = {}) {
  customClient.getNamespacedCustomObject.mockImplementation(
    ({ plural, name }: { plural: string; name: string }) => {
      if (plural === "virtualmachines") {
        return Promise.resolve(virtualMachine);
      }

      if (plural === "virtualmachineinstances") {
        return vmi ? Promise.resolve(vmi) : Promise.reject(notFoundError());
      }

      if (plural === "volumes") {
        if (
          name.startsWith("pvc-123-restore") ||
          name === "pvc-123-longhorn-name" ||
          name === "pvc-existing-restore"
        ) {
          return Promise.resolve({
            metadata: { name },
            status: { state: "detached", restoreRequired: false },
          });
        }

        return Promise.resolve(detachedVolume);
      }

      return Promise.reject(notFoundError());
    },
  );

  customClient.listNamespacedCustomObject.mockImplementation(({ plural }: { plural: string }) => {
    if (plural === "snapshots") {
      return Promise.resolve({
        items: [
          {
            metadata: { name: "snap-a", namespace: "longhorn-system" },
            spec: { volume: "pvc-123" },
            status: { readyToUse: true, creationTime: "2026-05-19T10:00:00Z" },
          },
        ],
      });
    }

    if (plural === "backups") {
      return Promise.resolve({ items: [backup] });
    }

    return Promise.resolve({ items: [] });
  });

  coreClient.readNamespacedPersistentVolumeClaim.mockResolvedValue(pvc);
  coreClient.readPersistentVolume.mockResolvedValue(pv);
  coreClient.listPersistentVolume.mockResolvedValue({ items: [] });
  coreClient.createPersistentVolume.mockResolvedValue({});
  coreClient.createNamespacedPersistentVolumeClaim.mockResolvedValue({});
  coreClient.patchPersistentVolume.mockResolvedValue({});
  coreClient.deleteNamespacedPersistentVolumeClaim.mockResolvedValue({});
  patchNamespacedCustomObjectMergePatch.mockResolvedValue({});
  patchPersistentVolumeMergePatch.mockResolvedValue({});
  customClient.createNamespacedCustomObject.mockImplementation(
    ({ plural, body }: { plural: string; body: { metadata?: { name?: string } } }) => {
      if (plural === "volumes") {
        return Promise.resolve({
          metadata: { name: body.metadata?.name },
          status: { state: "detached", restoreRequired: false },
        });
      }

      return Promise.resolve(body);
    },
  );
  customClient.patchNamespacedCustomObject.mockResolvedValue({});
  rawKubeRequest.mockResolvedValue({});
  longhornApi.chooseMaintenanceNode.mockResolvedValue("node-a");
  longhornApi.attachVolumeForMaintenance.mockResolvedValue({});
  longhornApi.detachMaintenanceVolume.mockResolvedValue({});
  longhornApi.revertSnapshot.mockResolvedValue({});
}

describe("Longhorn rootdisk operations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maintenance-attaches stopped VMs before creating rootdisk snapshots", async () => {
    setupBase();
    customClient.getNamespacedCustomObject.mockImplementation(
      ({ plural, name }: { plural: string; name: string }) => {
        if (plural === "virtualmachines") {
          return Promise.resolve(vm);
        }

        if (plural === "virtualmachineinstances") {
          return Promise.reject(notFoundError());
        }

        if (plural === "volumes" && name === "pvc-123") {
          const attachAlreadyCalled = longhornApi.attachVolumeForMaintenance.mock.calls.length > 0;
          const detachAlreadyCalled = longhornApi.detachMaintenanceVolume.mock.calls.length > 0;
          if (detachAlreadyCalled) {
            return Promise.resolve(detachedVolume);
          }

          return Promise.resolve(attachAlreadyCalled ? attachedMaintenanceVolume : detachedVolume);
        }

        return Promise.reject(notFoundError());
      },
    );

    await expect(createVirtualMachineSnapshot("windows", "vm-01", "snap-a")).resolves.toMatchObject(
      { name: "snap-a", readyToUse: true },
    );

    expect(longhornApi.attachVolumeForMaintenance).toHaveBeenCalledWith("pvc-123", "node-a");
    expect(longhornApi.detachMaintenanceVolume).toHaveBeenCalledWith("pvc-123");
    expect(customClient.createNamespacedCustomObject).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: "longhorn-system",
        plural: "snapshots",
        body: expect.objectContaining({
          kind: "Snapshot",
          spec: expect.objectContaining({ volume: "pvc-123" }),
        }),
      }),
    );
  });

  it("continues running snapshot creation when guest-agent freeze fails", async () => {
    setupBase({
      virtualMachine: runningVm,
      vmi: { metadata: { name: "vm-01", namespace: "windows" }, status: { phase: "Running" } },
    });
    rawKubeRequest.mockRejectedValueOnce(new Error("guest agent unavailable"));

    await expect(createVirtualMachineSnapshot("windows", "vm-01", "snap-a")).resolves.toMatchObject(
      { name: "snap-a" },
    );

    expect(customClient.createNamespacedCustomObject).toHaveBeenCalledWith(
      expect.objectContaining({ plural: "snapshots" }),
    );
    expect(rawKubeRequest).toHaveBeenCalledTimes(1);
    expect(longhornApi.attachVolumeForMaintenance).not.toHaveBeenCalled();
  });

  it("restores backups by creating a volume, retaining the old PV, and binding a new PV first", async () => {
    setupBase();
    customClient.createNamespacedCustomObject.mockImplementation(
      ({ plural, body }: { plural: string; body: { metadata?: { name?: string } } }) => {
        if (plural === "volumes") {
          return Promise.resolve({
            metadata: { name: "pvc-123-longhorn-name" },
            status: { state: "detached", restoreRequired: false },
          });
        }

        return Promise.resolve(body);
      },
    );
    coreClient.readNamespacedPersistentVolumeClaim.mockImplementation(
      ({ name }: { name: string }) => {
        const deleted = coreClient.deleteNamespacedPersistentVolumeClaim.mock.calls.length > 0;
        const recreated = coreClient.createNamespacedPersistentVolumeClaim.mock.calls.length > 0;

        if (name === "rootdisk-pvc" && deleted && !recreated) {
          return Promise.reject(notFoundError());
        }

        return Promise.resolve(pvc);
      },
    );

    await expect(
      restoreVirtualMachineBackup("windows", "vm-01", "backup-a"),
    ).resolves.toMatchObject({ name: "vm-01" });

    const volumeCreate = customClient.createNamespacedCustomObject.mock.calls.find(
      ([request]) => request.plural === "volumes",
    )?.[0];
    expect(volumeCreate.body.spec.size).toBe("21474836480");
    expect(volumeCreate.body.spec.fromBackup).toBe(backup.status?.url);

    expect(patchPersistentVolumeMergePatch).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "pv-root",
        body: expect.objectContaining({
          spec: { persistentVolumeReclaimPolicy: "Retain" },
        }),
      }),
    );

    const newPv = coreClient.createPersistentVolume.mock.calls[0]?.[0].body as KubePersistentVolume;
    expect(newPv.spec?.claimRef).toEqual({
      namespace: "windows",
      name: "rootdisk-pvc",
    });
    expect(newPv.spec?.csi?.volumeHandle).toBe("pvc-123-longhorn-name");

    expect(patchPersistentVolumeMergePatch.mock.invocationCallOrder[0]).toBeLessThan(
      coreClient.deleteNamespacedPersistentVolumeClaim.mock.invocationCallOrder[0],
    );
    expect(coreClient.createPersistentVolume.mock.invocationCallOrder[0]).toBeLessThan(
      coreClient.createNamespacedPersistentVolumeClaim.mock.invocationCallOrder[0],
    );
    expect(rawKubeRequest).toHaveBeenCalledWith(
      "PUT",
      "/apis/subresources.kubevirt.io/v1/namespaces/windows/virtualmachines/vm-01/start",
      expect.objectContaining({ kind: "StartOptions" }),
    );
  });

  it("reuses an unbound Longhorn restore volume from a previous failed attempt", async () => {
    setupBase();
    customClient.listNamespacedCustomObject.mockImplementation(({ plural }: { plural: string }) => {
      if (plural === "snapshots") {
        return Promise.resolve({ items: [] });
      }

      if (plural === "backups") {
        return Promise.resolve({ items: [backup] });
      }

      if (plural === "volumes") {
        return Promise.resolve({
          items: [
            {
              metadata: {
                name: "pvc-existing-restore",
                creationTimestamp: "2026-05-19T20:36:55Z",
                annotations: {
                  "vm-manager.skyway.tools/vm-namespace": "windows",
                  "vm-manager.skyway.tools/vm-name": "vm-01",
                  "vm-manager.skyway.tools/root-volume": "pvc-123",
                  "vm-manager.skyway.tools/root-pvc": "rootdisk-pvc",
                },
              },
              spec: { fromBackup: backup.status?.url },
              status: { state: "detached", restoreRequired: false, kubernetesStatus: {} },
            },
          ],
        });
      }

      return Promise.resolve({ items: [] });
    });
    coreClient.readNamespacedPersistentVolumeClaim.mockImplementation(
      ({ name }: { name: string }) => {
        const deleted = coreClient.deleteNamespacedPersistentVolumeClaim.mock.calls.length > 0;
        const recreated = coreClient.createNamespacedPersistentVolumeClaim.mock.calls.length > 0;

        if (name === "rootdisk-pvc" && deleted && !recreated) {
          return Promise.reject(notFoundError());
        }

        return Promise.resolve(pvc);
      },
    );

    await expect(
      restoreVirtualMachineBackup("windows", "vm-01", "backup-a"),
    ).resolves.toMatchObject({ name: "vm-01" });

    expect(customClient.createNamespacedCustomObject).not.toHaveBeenCalledWith(
      expect.objectContaining({ plural: "volumes" }),
    );
    const newPv = coreClient.createPersistentVolume.mock.calls[0]?.[0].body as KubePersistentVolume;
    expect(newPv.spec?.csi?.volumeHandle).toBe("pvc-existing-restore");
  });
});
