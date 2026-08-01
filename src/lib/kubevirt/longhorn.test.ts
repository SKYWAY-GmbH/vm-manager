import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const customClient = vi.hoisted(() => ({
  deleteNamespacedCustomObject: vi.fn(),
  getNamespacedCustomObject: vi.fn(),
}));
const coreClient = vi.hoisted(() => ({
  deletePersistentVolume: vi.fn(),
  listPersistentVolume: vi.fn(),
  readPersistentVolume: vi.fn(),
}));

vi.mock("./client", () => ({
  getCoreV1Client: () => coreClient,
  getCustomObjectsClient: () => customClient,
  patchNamespacedCustomObjectMergePatch: vi.fn(),
}));

import {
  backupsForVm,
  buildRestoredPv,
  buildRestoredPvc,
  reapExpiredRollbacks,
  restoreVolumeName,
  sanitizeLonghornName,
  shortenLonghornName,
  snapshotsForVolume,
  toLonghornBackupSummary,
} from "./longhorn";
import type { KubePersistentVolume, KubePersistentVolumeClaim } from "./types";

describe("Longhorn helper functions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sanitizes generated Longhorn names as DNS-compatible values", () => {
    expect(sanitizeLonghornName("VM_01 Backup!!")).toBe("vm-01-backup");
    expect(sanitizeLonghornName("---", 20)).toBe("vm-manager");
    expect(sanitizeLonghornName("a".repeat(300))).toHaveLength(253);
  });

  it("shortens restore volume names to Longhorn's 40 character limit", () => {
    expect(shortenLonghornName("VM_01 Backup!!", 40)).toBe("vm-01-backup");

    const name = restoreVolumeName("pvc-4598cc85-fa99-4d4b-b455-425cd8882219", "20260519203655");
    expect(name).toHaveLength(40);
    expect(name).toMatch(/^pvc-4598cc85-fa99-4d4b-b455-[a-z0-9-]+-[a-f0-9]{8}$/);
    expect(name).not.toBe("pvc-4598cc85-fa99-4d4b-b455-425cd8882219");
  });

  it("filters snapshots by exact Longhorn volume name", () => {
    expect(
      snapshotsForVolume(
        [
          {
            metadata: { name: "snap-root", namespace: "longhorn-system" },
            spec: { volume: "pvc-root" },
            status: { readyToUse: true },
          },
          {
            metadata: { name: "snap-data", namespace: "longhorn-system" },
            spec: { volume: "pvc-data" },
            status: { readyToUse: true },
          },
        ],
        "pvc-root",
      ).map((snapshot) => snapshot.name),
    ).toEqual(["snap-root"]);
  });

  it("joins backup readiness from Longhorn status", () => {
    expect(
      toLonghornBackupSummary({
        metadata: { name: "backup-a", namespace: "longhorn-system" },
        spec: { snapshotName: "snap-a", backupMode: "incremental" },
        status: {
          state: "Completed",
          progress: 100,
          volumeName: "pvc-root",
          volumeSize: "21474836480",
        },
      }),
    ).toMatchObject({
      name: "backup-a",
      readyToUse: true,
      phase: "Completed",
      volumeName: "pvc-root",
      volumeSize: "21474836480",
    });
  });

  it("normalizes Date timestamps before sorting backups", () => {
    const backups = backupsForVm(
      [
        {
          metadata: {
            name: "older",
            namespace: "longhorn-system",
            creationTimestamp: new Date("2026-05-19T10:00:00Z"),
          },
          status: { state: "Completed", volumeName: "pvc-root" },
        },
        {
          metadata: {
            name: "newer",
            namespace: "longhorn-system",
            creationTimestamp: new Date("2026-05-19T11:00:00Z"),
          },
          status: { state: "Completed", volumeName: "pvc-root" },
        },
      ],
      { pvcName: "rootdisk", pvName: "pv-root", volumeName: "pvc-root" },
      "windows",
      "vm-01",
    );

    expect(backups.map((backup) => [backup.name, backup.createdAt])).toEqual([
      ["newer", "2026-05-19T11:00:00.000Z"],
      ["older", "2026-05-19T10:00:00.000Z"],
    ]);
  });

  it("builds restored PV claimRef without copying the old claim UID", () => {
    const oldPv: KubePersistentVolume = {
      metadata: { name: "pv-old" },
      spec: {
        claimRef: { namespace: "windows", name: "rootdisk-pvc", uid: "old-uid" },
        csi: { driver: "driver.longhorn.io", volumeHandle: "old-volume" },
      },
    };
    const oldPvc: KubePersistentVolumeClaim = {
      metadata: { namespace: "windows", name: "rootdisk-pvc" },
      spec: { volumeName: "pv-old" },
    };

    expect(
      buildRestoredPv(
        oldPv,
        oldPvc,
        { pvcName: "rootdisk-pvc", pvName: "pv-old", volumeName: "old-volume" },
        "pv-new",
        "new-volume",
      ).spec?.claimRef,
    ).toEqual({ namespace: "windows", name: "rootdisk-pvc" });
  });

  it("builds restored PVCs without CDI source or stale binding metadata", () => {
    const oldPvc: KubePersistentVolumeClaim = {
      metadata: {
        namespace: "windows",
        name: "rootdisk-pvc",
        labels: { app: "vm-01" },
        annotations: {
          "pv.kubernetes.io/bind-completed": "yes",
          "cdi.kubevirt.io/storage.populatedFor": "rootdisk-pvc",
        },
      },
      spec: {
        accessModes: ["ReadWriteOnce"],
        dataSource: { kind: "PersistentVolumeClaim", name: "source-pvc" },
        dataSourceRef: { kind: "PersistentVolumeClaim", name: "source-pvc" },
        resources: { requests: { storage: "20Gi" } },
        storageClassName: "longhorn",
        volumeMode: "Filesystem",
        volumeName: "old-pv",
      },
    };

    const restored = buildRestoredPvc(oldPvc, "new-pv");

    expect(restored.metadata?.annotations).toBeUndefined();
    expect(restored.spec).toEqual({
      accessModes: ["ReadWriteOnce"],
      resources: { requests: { storage: "20Gi" } },
      storageClassName: "longhorn",
      volumeMode: "Filesystem",
      volumeName: "new-pv",
    });
  });

  it("does not reap rollback storage after its VM becomes unmanaged", async () => {
    const rollbackPv: KubePersistentVolume = {
      metadata: {
        name: "pv-old",
        labels: { "vm-manager.skyway.tools/rollback": "true" },
        annotations: {
          "vm-manager.skyway.tools/vm-namespace": "windows",
          "vm-manager.skyway.tools/vm-name": "vm-01",
          "vm-manager.skyway.tools/rollback-expires-at": "2026-05-20T10:00:00Z",
          "vm-manager.skyway.tools/rollback-volume": "volume-old",
        },
      },
      spec: { csi: { volumeHandle: "volume-old" } },
    };
    coreClient.listPersistentVolume.mockResolvedValue({ items: [rollbackPv] });
    coreClient.readPersistentVolume.mockResolvedValue(rollbackPv);
    customClient.getNamespacedCustomObject.mockResolvedValue({
      metadata: { name: "vm-01", namespace: "windows" },
    });

    await reapExpiredRollbacks(new Date("2026-05-21T10:00:00Z"));

    expect(coreClient.deletePersistentVolume).not.toHaveBeenCalled();
    expect(customClient.deleteNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it("reaps expired rollback storage for managed VMs", async () => {
    const rollbackPv: KubePersistentVolume = {
      metadata: {
        name: "pv-old",
        labels: { "vm-manager.skyway.tools/rollback": "true" },
        annotations: {
          "vm-manager.skyway.tools/vm-namespace": "windows",
          "vm-manager.skyway.tools/vm-name": "vm-01",
          "vm-manager.skyway.tools/rollback-expires-at": "2026-05-20T10:00:00Z",
          "vm-manager.skyway.tools/rollback-volume": "volume-old",
        },
      },
      spec: { csi: { volumeHandle: "volume-old" } },
    };
    coreClient.listPersistentVolume.mockResolvedValue({ items: [rollbackPv] });
    coreClient.readPersistentVolume.mockResolvedValue(rollbackPv);
    coreClient.deletePersistentVolume.mockResolvedValue({});
    customClient.getNamespacedCustomObject.mockResolvedValue({
      metadata: {
        name: "vm-01",
        namespace: "windows",
        labels: { "vm-manager.skyway.tools/managed": "true" },
      },
    });
    customClient.deleteNamespacedCustomObject.mockResolvedValue({});

    await reapExpiredRollbacks(new Date("2026-05-21T10:00:00Z"));

    expect(coreClient.deletePersistentVolume).toHaveBeenCalledWith(
      expect.objectContaining({ name: "pv-old" }),
    );
    expect(customClient.deleteNamespacedCustomObject).toHaveBeenCalledWith(
      expect.objectContaining({ name: "volume-old", plural: "volumes" }),
    );
    expect(customClient.deleteNamespacedCustomObject.mock.invocationCallOrder[0]).toBeLessThan(
      coreClient.deletePersistentVolume.mock.invocationCallOrder[0],
    );
  });

  it("skips rollback storage with malformed expiration timestamps", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      coreClient.listPersistentVolume.mockResolvedValue({
        items: [
          {
            metadata: {
              name: "pv-invalid",
              labels: { "vm-manager.skyway.tools/rollback": "true" },
              annotations: {
                "vm-manager.skyway.tools/rollback-expires-at": "not-a-date",
              },
            },
          },
        ],
      });

      await reapExpiredRollbacks(new Date("2026-05-21T10:00:00Z"));

      expect(coreClient.readPersistentVolume).not.toHaveBeenCalled();
      expect(coreClient.deletePersistentVolume).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        'Skipping rollback pv-invalid: invalid vm-manager.skyway.tools/rollback-expires-at value "not-a-date".',
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("continues reaping later rollbacks after an item fails", async () => {
    const rollbackPv = (
      name: string,
      vmName: string,
      volumeName: string,
    ): KubePersistentVolume => ({
      metadata: {
        name,
        labels: { "vm-manager.skyway.tools/rollback": "true" },
        annotations: {
          "vm-manager.skyway.tools/vm-namespace": "windows",
          "vm-manager.skyway.tools/vm-name": vmName,
          "vm-manager.skyway.tools/rollback-expires-at": "2026-05-20T10:00:00Z",
          "vm-manager.skyway.tools/rollback-volume": volumeName,
        },
      },
      spec: { csi: { volumeHandle: volumeName } },
    });
    const first = rollbackPv("pv-first", "vm-first", "volume-first");
    const second = rollbackPv("pv-second", "vm-second", "volume-second");
    coreClient.listPersistentVolume.mockResolvedValue({ items: [first, second] });
    coreClient.readPersistentVolume.mockImplementation(({ name }: { name: string }) =>
      Promise.resolve(name === "pv-first" ? first : second),
    );
    coreClient.deletePersistentVolume.mockResolvedValue({});
    customClient.getNamespacedCustomObject.mockImplementation(({ name }: { name: string }) =>
      Promise.resolve({
        metadata: {
          name,
          namespace: "windows",
          labels: { "vm-manager.skyway.tools/managed": "true" },
        },
      }),
    );
    customClient.deleteNamespacedCustomObject.mockImplementation(({ name }: { name: string }) =>
      name === "volume-first"
        ? Promise.reject(new Error("Longhorn unavailable"))
        : Promise.resolve({}),
    );

    await expect(reapExpiredRollbacks(new Date("2026-05-21T10:00:00Z"))).rejects.toThrow(
      "Failed to reap 1 rollback(s).",
    );

    expect(coreClient.deletePersistentVolume).toHaveBeenCalledTimes(1);
    expect(coreClient.deletePersistentVolume).toHaveBeenCalledWith(
      expect.objectContaining({ name: "pv-second" }),
    );
  });
});
