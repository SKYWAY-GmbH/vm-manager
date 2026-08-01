import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("./manual-runtime-reconciler", () => ({
  ensureManualRuntimeReconcilerStarted: vi.fn(),
}));

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
  listNode: vi.fn(),
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

import { VM_MANAGER_MANAGED_KEY } from "./management";
import {
  VM_MANAGER_MANUAL_RUNTIME_DURATION_DAYS_KEY,
  VM_MANAGER_MANUAL_RUNTIME_EXPIRES_AT_KEY,
  VM_MANAGER_MANUAL_RUNTIME_STARTED_AT_KEY,
  VM_MANAGER_MANUAL_RUNTIME_STOP_REQUESTED_AT_KEY,
  VM_MANAGER_MANUAL_RUNTIME_VMI_UID_KEY,
} from "./manual-runtime";
import {
  createVirtualMachineSnapshot,
  getVirtualMachine,
  listVirtualMachineRollbacks,
  listVirtualMachines,
  performVirtualMachineAction,
  resetVirtualMachineManualRuntimeTimeout,
  restoreVirtualMachineBackup,
} from "./service";
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
  metadata: {
    name: "vm-01",
    namespace: "windows",
    labels: { [VM_MANAGER_MANAGED_KEY]: "true" },
  },
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

const alwaysVm: KubeVirtVirtualMachine = {
  ...vm,
  spec: {
    ...vm.spec,
    runStrategy: "Always",
  },
};

const runningAlwaysVm: KubeVirtVirtualMachine = {
  ...alwaysVm,
  status: { printableStatus: "Running", ready: true, created: true },
};

const manualRuntimeAnnotations = {
  [VM_MANAGER_MANUAL_RUNTIME_STARTED_AT_KEY]: "2026-05-19T10:00:00Z",
  [VM_MANAGER_MANUAL_RUNTIME_EXPIRES_AT_KEY]: "2026-05-26T10:00:00Z",
  [VM_MANAGER_MANUAL_RUNTIME_DURATION_DAYS_KEY]: "7",
  [VM_MANAGER_MANUAL_RUNTIME_VMI_UID_KEY]: "vmi-uid-1",
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

  it("omits unlabeled VMs from inventory", async () => {
    customClient.listCustomObjectForAllNamespaces.mockImplementation(
      ({ plural }: { plural: string }) =>
        Promise.resolve({
          items:
            plural === "virtualmachines"
              ? [{ ...vm, metadata: { name: "unmanaged", namespace: "windows" } }, vm]
              : [],
        }),
    );

    await expect(listVirtualMachines()).resolves.toMatchObject([{ name: "vm-01" }]);
  });

  it("rejects actions for unlabeled VMs before issuing mutations", async () => {
    setupBase({
      virtualMachine: { ...vm, metadata: { name: "vm-01", namespace: "windows" } },
    });

    await expect(
      performVirtualMachineAction("windows", "vm-01", "force-stop"),
    ).rejects.toMatchObject({
      status: 404,
      message: "Virtual machine windows/vm-01 was not found.",
    });
    expect(rawKubeRequest).not.toHaveBeenCalled();
    expect(patchNamespacedCustomObjectMergePatch).not.toHaveBeenCalled();
    expect(longhornApi.attachVolumeForMaintenance).not.toHaveBeenCalled();
  });

  it("rejects rollback listing for unlabeled VMs", async () => {
    setupBase({
      virtualMachine: { ...vm, metadata: { name: "vm-01", namespace: "windows" } },
    });

    await expect(listVirtualMachineRollbacks("windows", "vm-01")).rejects.toMatchObject({
      status: 404,
    });
    expect(coreClient.listPersistentVolume).not.toHaveBeenCalled();
  });

  it("surfaces rollback inventory failures in degraded VM details", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      setupBase();
      coreClient.readNamespacedPersistentVolumeClaim.mockRejectedValue(notFoundError());
      coreClient.listPersistentVolume.mockRejectedValue(new Error("PV API unavailable"));

      await expect(getVirtualMachine("windows", "vm-01")).resolves.toMatchObject({
        protectionError: expect.stringContaining(
          "Rollback inventory unavailable: PV API unavailable",
        ),
        rollbacks: [],
      });
      expect(error).toHaveBeenCalledWith(
        "Failed to list rollbacks for windows/vm-01",
        expect.any(Error),
      );
    } finally {
      error.mockRestore();
    }
  });

  it("starts Manual VMs with runtime timeout annotations", async () => {
    setupBase();
    const runningVmi: KubeVirtVirtualMachineInstance = {
      metadata: {
        name: "vm-01",
        namespace: "windows",
        uid: "vmi-uid-1",
        creationTimestamp: "2026-05-19T10:00:00Z",
      },
      status: { phase: "Running" },
    };
    customClient.getNamespacedCustomObject.mockImplementation(
      ({ plural }: { plural: string; name: string }) => {
        if (plural === "virtualmachines") {
          return Promise.resolve(vm);
        }

        if (plural === "virtualmachineinstances") {
          const startSubmitted = rawKubeRequest.mock.calls.some((call) =>
            String(call[1]).endsWith("/start"),
          );
          return startSubmitted ? Promise.resolve(runningVmi) : Promise.reject(notFoundError());
        }

        if (plural === "volumes") {
          return Promise.resolve(detachedVolume);
        }

        return Promise.reject(notFoundError());
      },
    );

    await expect(
      performVirtualMachineAction("windows", "vm-01", "start", { timeoutDays: 3 }),
    ).resolves.toMatchObject({ name: "vm-01" });

    expect(rawKubeRequest).toHaveBeenCalledWith(
      "PUT",
      "/apis/subresources.kubevirt.io/v1/namespaces/windows/virtualmachines/vm-01/start",
      expect.objectContaining({ kind: "StartOptions" }),
    );
    expect(patchNamespacedCustomObjectMergePatch).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: "windows",
        name: "vm-01",
        body: {
          metadata: {
            annotations: {
              [VM_MANAGER_MANUAL_RUNTIME_STARTED_AT_KEY]: "2026-05-19T10:00:00.000Z",
              [VM_MANAGER_MANUAL_RUNTIME_EXPIRES_AT_KEY]: "2026-05-22T10:00:00.000Z",
              [VM_MANAGER_MANUAL_RUNTIME_DURATION_DAYS_KEY]: "3",
              [VM_MANAGER_MANUAL_RUNTIME_VMI_UID_KEY]: "vmi-uid-1",
              [VM_MANAGER_MANUAL_RUNTIME_STOP_REQUESTED_AT_KEY]: null,
            },
          },
        },
      }),
    );
  });

  it("rejects Manual starts without a runtime timeout", async () => {
    setupBase();

    await expect(performVirtualMachineAction("windows", "vm-01", "start")).rejects.toMatchObject({
      status: 400,
    });

    expect(rawKubeRequest).not.toHaveBeenCalled();
  });

  it("rejects timeout payloads for non-Manual VM starts", async () => {
    setupBase({ virtualMachine: alwaysVm });

    await expect(
      performVirtualMachineAction("windows", "vm-01", "start", { timeoutDays: 7 }),
    ).rejects.toMatchObject({
      status: 409,
    });

    expect(rawKubeRequest).not.toHaveBeenCalled();
  });

  it("leaves Always VM starts untouched when no timeout is provided", async () => {
    setupBase({ virtualMachine: alwaysVm });

    await expect(performVirtualMachineAction("windows", "vm-01", "start")).resolves.toMatchObject({
      name: "vm-01",
    });

    expect(rawKubeRequest).toHaveBeenCalledWith(
      "PUT",
      "/apis/subresources.kubevirt.io/v1/namespaces/windows/virtualmachines/vm-01/start",
      expect.objectContaining({ kind: "StartOptions" }),
    );
    expect(patchNamespacedCustomObjectMergePatch).not.toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: "windows",
        name: "vm-01",
        body: expect.objectContaining({
          metadata: {
            annotations: expect.objectContaining({
              [VM_MANAGER_MANUAL_RUNTIME_DURATION_DAYS_KEY]: expect.anything(),
            }),
          },
        }),
      }),
    );
  });

  it("clears Manual runtime annotations when stopping", async () => {
    setupBase({
      virtualMachine: {
        ...runningVm,
        metadata: {
          ...runningVm.metadata,
          annotations: manualRuntimeAnnotations,
        },
      },
      vmi: {
        metadata: { name: "vm-01", namespace: "windows", uid: "vmi-uid-1" },
        status: { phase: "Running" },
      },
    });

    await expect(performVirtualMachineAction("windows", "vm-01", "stop")).resolves.toMatchObject({
      name: "vm-01",
    });

    expect(rawKubeRequest).toHaveBeenCalledWith(
      "PUT",
      "/apis/subresources.kubevirt.io/v1/namespaces/windows/virtualmachines/vm-01/stop",
      expect.objectContaining({ kind: "StopOptions" }),
    );
    expect(patchNamespacedCustomObjectMergePatch).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: "windows",
        name: "vm-01",
        body: {
          metadata: {
            annotations: {
              [VM_MANAGER_MANUAL_RUNTIME_STARTED_AT_KEY]: null,
              [VM_MANAGER_MANUAL_RUNTIME_EXPIRES_AT_KEY]: null,
              [VM_MANAGER_MANUAL_RUNTIME_DURATION_DAYS_KEY]: null,
              [VM_MANAGER_MANUAL_RUNTIME_VMI_UID_KEY]: null,
              [VM_MANAGER_MANUAL_RUNTIME_STOP_REQUESTED_AT_KEY]: null,
            },
          },
        },
      }),
    );
  });

  it("does not clear timeout annotations for Always VMs", async () => {
    setupBase({
      virtualMachine: {
        ...runningAlwaysVm,
        metadata: {
          ...runningAlwaysVm.metadata,
          annotations: manualRuntimeAnnotations,
        },
      },
      vmi: {
        metadata: { name: "vm-01", namespace: "windows", uid: "vmi-uid-1" },
        status: { phase: "Running" },
      },
    });

    await expect(performVirtualMachineAction("windows", "vm-01", "stop")).resolves.toMatchObject({
      name: "vm-01",
    });

    expect(patchNamespacedCustomObjectMergePatch).not.toHaveBeenCalledWith(
      expect.objectContaining({
        body: {
          metadata: {
            annotations: {
              [VM_MANAGER_MANUAL_RUNTIME_STARTED_AT_KEY]: null,
              [VM_MANAGER_MANUAL_RUNTIME_EXPIRES_AT_KEY]: null,
              [VM_MANAGER_MANUAL_RUNTIME_DURATION_DAYS_KEY]: null,
              [VM_MANAGER_MANUAL_RUNTIME_VMI_UID_KEY]: null,
              [VM_MANAGER_MANUAL_RUNTIME_STOP_REQUESTED_AT_KEY]: null,
            },
          },
        },
      }),
    );
  });

  it("resets running Manual VM runtime timeout", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-21T12:00:00Z"));
    try {
      setupBase({
        virtualMachine: {
          ...runningVm,
          metadata: {
            ...runningVm.metadata,
            annotations: manualRuntimeAnnotations,
          },
        },
        vmi: {
          metadata: {
            name: "vm-01",
            namespace: "windows",
            uid: "vmi-uid-1",
            creationTimestamp: "2026-05-19T10:00:00Z",
          },
          status: { phase: "Running" },
        },
      });

      await expect(
        resetVirtualMachineManualRuntimeTimeout("windows", "vm-01", 30),
      ).resolves.toMatchObject({ name: "vm-01" });

      expect(patchNamespacedCustomObjectMergePatch).toHaveBeenCalledWith(
        expect.objectContaining({
          namespace: "windows",
          name: "vm-01",
          body: {
            metadata: {
              annotations: {
                [VM_MANAGER_MANUAL_RUNTIME_STARTED_AT_KEY]: "2026-05-21T12:00:00.000Z",
                [VM_MANAGER_MANUAL_RUNTIME_EXPIRES_AT_KEY]: "2026-06-20T12:00:00.000Z",
                [VM_MANAGER_MANUAL_RUNTIME_DURATION_DAYS_KEY]: "30",
                [VM_MANAGER_MANUAL_RUNTIME_VMI_UID_KEY]: "vmi-uid-1",
                [VM_MANAGER_MANUAL_RUNTIME_STOP_REQUESTED_AT_KEY]: null,
              },
            },
          },
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects timeout resets for non-Manual VMs", async () => {
    setupBase({
      virtualMachine: runningAlwaysVm,
      vmi: {
        metadata: { name: "vm-01", namespace: "windows", uid: "vmi-uid-1" },
        status: { phase: "Running" },
      },
    });

    await expect(
      resetVirtualMachineManualRuntimeTimeout("windows", "vm-01", 7),
    ).rejects.toMatchObject({
      status: 409,
    });

    expect(patchNamespacedCustomObjectMergePatch).not.toHaveBeenCalled();
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
