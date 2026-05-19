import { z } from "zod";
import type {
  ValidationResult,
  VirtualMachineSnapshotSummary,
  VirtualMachineSummary,
  VmAction,
} from "./types";

const dnsSubdomain = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;

export const vmActionSchema = z.enum(["start", "stop", "reboot", "force-stop"]);

export const snapshotNameSchema = z
  .string()
  .trim()
  .min(1, "Snapshot name is required.")
  .max(253, "Snapshot names must be 253 characters or fewer.")
  .regex(
    dnsSubdomain,
    "Use a Kubernetes DNS name: lowercase letters, numbers, dashes, and dots; start and end with a letter or number.",
  );

export const createSnapshotSchema = z.object({
  name: snapshotNameSchema,
});

export const createRestoreSchema = z.object({
  snapshotName: snapshotNameSchema,
  restoreName: snapshotNameSchema.optional(),
});

export function validateSnapshotName(name: string): ValidationResult {
  const result = snapshotNameSchema.safeParse(name);
  if (result.success) {
    return { ok: true };
  }

  return { ok: false, reason: result.error.issues[0]?.message ?? "Invalid snapshot name." };
}

export function validateActionForVm(action: VmAction, vm: VirtualMachineSummary): ValidationResult {
  if (action === "start") {
    if (vm.powerState !== "offline") {
      return { ok: false, reason: "Only stopped VMs can be started." };
    }

    return { ok: true };
  }

  if (action === "reboot") {
    if (vm.powerState !== "online") {
      return { ok: false, reason: "Only running VMs can be rebooted." };
    }

    return { ok: true };
  }

  if (action === "stop" || action === "force-stop") {
    if (vm.powerState === "offline") {
      return { ok: false, reason: "The VM is already stopped." };
    }

    if (vm.powerState === "unknown") {
      return { ok: false, reason: "The VM state is unknown. Refresh before changing power." };
    }

    return { ok: true };
  }

  return { ok: false, reason: "Unsupported VM action." };
}

export function validateRestorePreconditions(
  vm: VirtualMachineSummary,
  snapshot: VirtualMachineSnapshotSummary | undefined,
): ValidationResult {
  if (!snapshot) {
    return { ok: false, reason: "Snapshot not found." };
  }

  if (vm.powerState !== "offline") {
    return { ok: false, reason: "Stop the VM before applying a snapshot." };
  }

  if (snapshot.readyToUse !== true) {
    return { ok: false, reason: "Only ready snapshots can be applied." };
  }

  return { ok: true };
}
