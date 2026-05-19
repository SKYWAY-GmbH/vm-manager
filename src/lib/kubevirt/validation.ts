import { z } from "zod";
import { ALLOWED_MANUAL_RUNTIME_DAYS, isAllowedManualRuntimeDays } from "./manual-runtime";
import type {
  ManualRuntimeDurationDays,
  ValidationResult,
  VirtualMachineBackupSummary,
  VirtualMachineSnapshotSummary,
  VirtualMachineSummary,
  VmAction,
} from "./types";

const dnsSubdomain = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;

export const vmActionSchema = z.enum(["start", "stop", "reboot", "force-stop"]);

export const manualRuntimeDurationDaysSchema = z
  .number()
  .int()
  .refine((value): value is ManualRuntimeDurationDays => isAllowedManualRuntimeDays(value), {
    message: `Runtime timeout must be one of: ${ALLOWED_MANUAL_RUNTIME_DAYS.join(", ")} days.`,
  });

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

export const createBackupSchema = z.object({
  name: snapshotNameSchema,
  backupMode: z.enum(["incremental", "full"]).optional(),
});

export const createRestoreSchema = z.object({
  sourceType: z.enum(["snapshot", "backup"]).optional(),
  snapshotName: snapshotNameSchema.optional(),
  backupName: snapshotNameSchema.optional(),
});

export function validateSnapshotName(name: string): ValidationResult {
  const result = snapshotNameSchema.safeParse(name);
  if (result.success) {
    return { ok: true };
  }

  return { ok: false, reason: result.error.issues[0]?.message ?? "Invalid snapshot name." };
}

export function hasActiveRestore(vm: VirtualMachineSummary): boolean {
  return vm.activeOperations.some((operation) => operation.type === "restore");
}

export function hasActiveOperation(vm: VirtualMachineSummary): boolean {
  return vm.activeOperations.length > 0;
}

export function validateActionForVm(action: VmAction, vm: VirtualMachineSummary): ValidationResult {
  if (hasActiveOperation(vm)) {
    return {
      ok: false,
      reason:
        "A VM storage operation is in progress. Wait until it finishes before changing power.",
    };
  }

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

  if (hasActiveOperation(vm)) {
    return { ok: false, reason: "A VM storage operation is already in progress." };
  }

  if (vm.powerState !== "offline") {
    return { ok: false, reason: "Stop the VM before restoring a snapshot." };
  }

  if (snapshot.readyToUse !== true) {
    return { ok: false, reason: "Only ready snapshots can be restored." };
  }

  if (snapshot.restoreBlockedReason) {
    return { ok: false, reason: snapshot.restoreBlockedReason };
  }

  return { ok: true };
}

export function validateBackupRestorePreconditions(
  vm: VirtualMachineSummary,
  backup: VirtualMachineBackupSummary | undefined,
): ValidationResult {
  if (!backup) {
    return { ok: false, reason: "Backup not found." };
  }

  if (hasActiveOperation(vm)) {
    return { ok: false, reason: "A VM storage operation is already in progress." };
  }

  if (vm.powerState !== "offline") {
    return { ok: false, reason: "Stop the VM before restoring a backup." };
  }

  if (backup.readyToUse !== true) {
    return { ok: false, reason: "Only completed backups can be restored." };
  }

  return { ok: true };
}
