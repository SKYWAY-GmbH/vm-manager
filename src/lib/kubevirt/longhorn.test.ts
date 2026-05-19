import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  buildRestoredPv,
  buildRestoredPvc,
  restoreVolumeName,
  sanitizeLonghornName,
  shortenLonghornName,
  snapshotsForVolume,
  toLonghornBackupSummary,
} from "./longhorn";
import type { KubePersistentVolume, KubePersistentVolumeClaim } from "./types";

describe("Longhorn helper functions", () => {
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
});
