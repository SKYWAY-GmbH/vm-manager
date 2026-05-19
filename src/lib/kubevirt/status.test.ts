import { describe, expect, it } from "vitest";
import {
  getActiveOperations,
  getIpAddresses,
  normalizePowerState,
  toRestoreSummary,
  toSnapshotSummary,
  toVmSummary,
} from "./status";
import type {
  KubeVirtVirtualMachine,
  KubeVirtVirtualMachineInstance,
  KubeVirtVirtualMachineRestore,
  KubeVirtVirtualMachineSnapshot,
} from "./types";

describe("KubeVirt status normalization", () => {
  it("treats running printable status as online", () => {
    const vm: KubeVirtVirtualMachine = {
      metadata: { name: "vm-01", namespace: "windows" },
      status: { printableStatus: "Running" },
    };

    expect(normalizePowerState(vm)).toBe("online");
  });

  it("treats halted runStrategy as offline", () => {
    const vm: KubeVirtVirtualMachine = {
      metadata: { name: "vm-01", namespace: "windows" },
      spec: { runStrategy: "Halted" },
    };

    expect(normalizePowerState(vm)).toBe("offline");
  });

  it("treats terminal VMIs as offline", () => {
    const vm: KubeVirtVirtualMachine = {
      metadata: { name: "vm-01", namespace: "windows" },
      status: { created: true },
    };
    const vmi: KubeVirtVirtualMachineInstance = {
      metadata: { name: "vm-01", namespace: "windows" },
      status: { phase: "Succeeded" },
    };

    expect(normalizePowerState(vm, vmi)).toBe("offline");
  });

  it("extracts unique sorted interface IPs", () => {
    const vmi: KubeVirtVirtualMachineInstance = {
      status: {
        interfaces: [
          { ipAddress: "10.0.0.11", ipAddresses: ["10.0.0.11", "fd00::11"] },
          { ipAddress: "10.0.0.10" },
        ],
      },
    };

    expect(getIpAddresses(vmi)).toEqual(["10.0.0.10", "10.0.0.11", "fd00::11"]);
  });

  it("builds summaries with readiness and active operations", () => {
    const vm: KubeVirtVirtualMachine = {
      metadata: {
        name: "vm-01",
        namespace: "windows",
        uid: "uid-1",
        annotations: {
          "vm-manager.skyway.tools/manual-runtime-started-at": "2026-05-19T10:00:00Z",
          "vm-manager.skyway.tools/manual-runtime-expires-at": "2026-05-26T10:00:00Z",
          "vm-manager.skyway.tools/manual-runtime-duration-days": "7",
          "vm-manager.skyway.tools/manual-runtime-vmi-uid": "vmi-uid-1",
        },
      },
      spec: { runStrategy: "Manual" },
      status: { printableStatus: "Running", ready: true },
    };
    const vmi: KubeVirtVirtualMachineInstance = {
      metadata: {
        name: "vm-01",
        namespace: "windows",
        uid: "vmi-uid-1",
        creationTimestamp: "2026-05-19T09:58:00Z",
      },
      status: { nodeName: "node-a", interfaces: [{ ipAddress: "10.0.0.10" }] },
    };
    const snapshot: KubeVirtVirtualMachineSnapshot = {
      metadata: { name: "snap-a", namespace: "windows" },
      spec: { source: { kind: "VirtualMachine", name: "vm-01" } },
      status: { readyToUse: false, phase: "InProgress" },
    };

    expect(toVmSummary(vm, vmi, [snapshot], [])).toMatchObject({
      id: "windows/vm-01",
      uid: "uid-1",
      powerState: "online",
      ready: true,
      nodeName: "node-a",
      ipAddresses: ["10.0.0.10"],
      runningSince: "2026-05-19T09:58:00Z",
      manualRuntime: {
        expiresAt: "2026-05-26T10:00:00Z",
        durationDays: 7,
        vmiUid: "vmi-uid-1",
      },
      activeOperations: [{ type: "snapshot", name: "snap-a", phase: "InProgress" }],
    });
  });
});

describe("snapshot and restore summaries", () => {
  it("normalizes snapshot readiness", () => {
    const snapshot = toSnapshotSummary({
      metadata: { name: "snap-a", namespace: "windows" },
      spec: { source: { kind: "VirtualMachine", name: "vm-01" } },
      status: { readyToUse: true },
    });

    expect(snapshot).toMatchObject({
      name: "snap-a",
      readyToUse: true,
      phase: "Ready",
      sourceName: "vm-01",
    });
  });

  it("normalizes restore failure condition", () => {
    const restore = toRestoreSummary({
      metadata: { name: "restore-a", namespace: "windows" },
      spec: {
        target: { kind: "VirtualMachine", name: "vm-01" },
        virtualMachineSnapshotName: "snap-a",
      },
      status: {
        complete: false,
        conditions: [{ type: "Failure", status: "True", message: "restore failed" }],
      },
    });

    expect(restore).toMatchObject({
      phase: "Failed",
      message: "restore failed",
      snapshotName: "snap-a",
      targetName: "vm-01",
    });
  });

  it("uses restore condition reasons when no message is present", () => {
    const restore = toRestoreSummary({
      metadata: { name: "restore-a", namespace: "windows" },
      spec: {
        target: { kind: "VirtualMachine", name: "vm-01" },
        virtualMachineSnapshotName: "snap-a",
      },
      status: {
        complete: false,
        conditions: [
          { type: "Progressing", status: "True", reason: "Creating new PVCs" },
          { type: "Ready", status: "False", reason: "Waiting for new PVCs" },
        ],
      },
    });

    expect(restore).toMatchObject({
      phase: "Running",
      message: "Waiting for new PVCs",
    });
  });

  it("filters active operations to pending snapshots and restores", () => {
    const snapshots: KubeVirtVirtualMachineSnapshot[] = [
      {
        metadata: { name: "ready", namespace: "windows" },
        spec: { source: { kind: "VirtualMachine", name: "vm-01" } },
        status: { readyToUse: true },
      },
      {
        metadata: { name: "pending", namespace: "windows" },
        spec: { source: { kind: "VirtualMachine", name: "vm-01" } },
        status: { readyToUse: false },
      },
    ];
    const restores: KubeVirtVirtualMachineRestore[] = [
      {
        metadata: { name: "restore", namespace: "windows" },
        spec: { target: { kind: "VirtualMachine", name: "vm-01" } },
        status: { complete: false },
      },
    ];

    expect(
      getActiveOperations(
        { metadata: { name: "vm-01", namespace: "windows" } },
        undefined,
        snapshots,
        restores,
      ).map((operation) => operation.name),
    ).toEqual(["pending", "restore"]);
  });

  it("uses VM operation annotations ahead of legacy snapshot resources", () => {
    const operations = getActiveOperations(
      {
        metadata: {
          name: "vm-01",
          namespace: "windows",
          annotations: {
            "vm-manager.skyway.tools/operation-type": "backup",
            "vm-manager.skyway.tools/operation-name": "backup-a",
            "vm-manager.skyway.tools/operation-phase": "Running",
          },
        },
      },
      undefined,
      [],
      [],
    );

    expect(operations).toEqual([
      expect.objectContaining({ type: "backup", name: "backup-a", phase: "Running" }),
    ]);
  });
});
