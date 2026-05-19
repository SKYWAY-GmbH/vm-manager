import { describe, expect, it } from "vitest";
import type { VirtualMachineSnapshotSummary, VirtualMachineSummary } from "./types";
import {
  validateActionForVm,
  validateRestorePreconditions,
  validateSnapshotName,
} from "./validation";

function vm(powerState: VirtualMachineSummary["powerState"]): VirtualMachineSummary {
  return {
    id: "windows/vm-01",
    name: "vm-01",
    namespace: "windows",
    powerState,
    printableStatus: powerState,
    ready: null,
    ipAddresses: [],
    runStrategy: "Manual",
    conditions: [],
    activeOperations: [],
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
});
