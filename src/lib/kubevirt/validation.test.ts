import { describe, expect, it } from "vitest";
import type {
  VirtualMachineBackupSummary,
  VirtualMachineSnapshotSummary,
  VirtualMachineSummary,
} from "./types";
import {
  manualRuntimeDurationDaysSchema,
  validateActionForVm,
  validateBackupRestorePreconditions,
  validateRestorePreconditions,
  validateSnapshotName,
} from "./validation";

function vm(
  powerState: VirtualMachineSummary["powerState"],
  activeOperations: VirtualMachineSummary["activeOperations"] = [],
): VirtualMachineSummary {
  return {
    id: "windows/vm-01",
    name: "vm-01",
    namespace: "windows",
    powerState,
    printableStatus: powerState,
    ready: null,
    ipAddresses: [],
    runStrategy: "Manual",
    resources: { current: {}, desired: {}, pendingRestart: false },
    rdp: { status: powerState === "online" ? "unavailable" : "offline", sessions: [] },
    conditions: [],
    activeOperations,
  };
}

const readySnapshot: VirtualMachineSnapshotSummary = {
  name: "snap-a",
  namespace: "windows",
  sourceName: "vm-01",
  readyToUse: true,
  phase: "Ready",
  conditions: [],
};

const readyBackup: VirtualMachineBackupSummary = {
  name: "backup-a",
  namespace: "longhorn-system",
  volumeName: "pvc-123",
  readyToUse: true,
  phase: "Completed",
};

describe("snapshot name validation", () => {
  it("accepts DNS subdomain names", () => {
    expect(validateSnapshotName("vm-01.baseline").ok).toBe(true);
  });

  it("rejects uppercase names", () => {
    expect(validateSnapshotName("VM-01").ok).toBe(false);
  });

  it("rejects names with trailing separators", () => {
    expect(validateSnapshotName("vm-01-").ok).toBe(false);
  });
});

describe("action validation", () => {
  it("allows start only for stopped VMs", () => {
    expect(validateActionForVm("start", vm("offline")).ok).toBe(true);
    expect(validateActionForVm("start", vm("online")).ok).toBe(false);
    expect(validateActionForVm("start", vm("unknown")).ok).toBe(false);
  });

  it("allows reboot only for running VMs", () => {
    expect(validateActionForVm("reboot", vm("online")).ok).toBe(true);
    expect(validateActionForVm("reboot", vm("offline")).ok).toBe(false);
  });

  it("blocks stop when state is offline or unknown", () => {
    expect(validateActionForVm("stop", vm("offline")).ok).toBe(false);
    expect(validateActionForVm("force-stop", vm("unknown")).ok).toBe(false);
  });

  it("blocks power changes while a restore is active", () => {
    const restoringVm = vm("offline", [{ type: "restore", name: "restore-a", phase: "Running" }]);

    expect(validateActionForVm("start", restoringVm)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("storage operation is in progress"),
    });
    expect(validateActionForVm("stop", restoringVm).ok).toBe(false);
    expect(validateActionForVm("reboot", restoringVm).ok).toBe(false);
    expect(validateActionForVm("force-stop", restoringVm).ok).toBe(false);
  });
});

describe("manual runtime duration validation", () => {
  it("allows 1-7 days and 30 days", () => {
    expect(manualRuntimeDurationDaysSchema.safeParse(1).success).toBe(true);
    expect(manualRuntimeDurationDaysSchema.safeParse(7).success).toBe(true);
    expect(manualRuntimeDurationDaysSchema.safeParse(30).success).toBe(true);
  });

  it("rejects unsupported durations", () => {
    expect(manualRuntimeDurationDaysSchema.safeParse(0).success).toBe(false);
    expect(manualRuntimeDurationDaysSchema.safeParse(8).success).toBe(false);
    expect(manualRuntimeDurationDaysSchema.safeParse(1.5).success).toBe(false);
  });
});

describe("restore preconditions", () => {
  it("allows ready snapshots only when VM is stopped", () => {
    expect(validateRestorePreconditions(vm("offline"), readySnapshot).ok).toBe(true);
    expect(validateRestorePreconditions(vm("online"), readySnapshot).ok).toBe(false);
  });

  it("blocks pending snapshots", () => {
    expect(
      validateRestorePreconditions(vm("offline"), {
        ...readySnapshot,
        readyToUse: false,
      }).ok,
    ).toBe(false);
  });

  it("blocks restores while another restore is active", () => {
    expect(
      validateRestorePreconditions(
        vm("offline", [{ type: "restore", name: "restore-a", phase: "Running" }]),
        readySnapshot,
      ),
    ).toMatchObject({
      ok: false,
      reason: "A VM storage operation is already in progress.",
    });
  });

  it("blocks snapshots marked as not restorable", () => {
    expect(
      validateRestorePreconditions(vm("offline"), {
        ...readySnapshot,
        restoreBlockedReason: "The underlying volume is missing.",
      }),
    ).toMatchObject({
      ok: false,
      reason: "The underlying volume is missing.",
    });
  });

  it("allows completed backups only when VM is stopped", () => {
    expect(validateBackupRestorePreconditions(vm("offline"), readyBackup).ok).toBe(true);
    expect(validateBackupRestorePreconditions(vm("online"), readyBackup).ok).toBe(false);
    expect(
      validateBackupRestorePreconditions(vm("offline"), {
        ...readyBackup,
        readyToUse: false,
        phase: "InProgress",
      }).ok,
    ).toBe(false);
  });
});
