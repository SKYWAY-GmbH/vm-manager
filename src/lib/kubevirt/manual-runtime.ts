import { firstTimestamp } from "./timestamps";
import type {
  KubeVirtVirtualMachineInstance,
  ManualRuntimeDurationDays,
  ManualRuntimeSummary,
} from "./types";

export const VM_MANAGER_MANUAL_RUNTIME_STARTED_AT_KEY =
  "vm-manager.skyway.tools/manual-runtime-started-at";
export const VM_MANAGER_MANUAL_RUNTIME_EXPIRES_AT_KEY =
  "vm-manager.skyway.tools/manual-runtime-expires-at";
export const VM_MANAGER_MANUAL_RUNTIME_DURATION_DAYS_KEY =
  "vm-manager.skyway.tools/manual-runtime-duration-days";
export const VM_MANAGER_MANUAL_RUNTIME_VMI_UID_KEY =
  "vm-manager.skyway.tools/manual-runtime-vmi-uid";
export const VM_MANAGER_MANUAL_RUNTIME_STOP_REQUESTED_AT_KEY =
  "vm-manager.skyway.tools/manual-runtime-stop-requested-at";

export const MANUAL_RUNTIME_DEFAULT_DAYS: ManualRuntimeDurationDays = 7;
export const MANUAL_RUNTIME_STOP_GRACE_MS = 12 * 60 * 60 * 1000;
export const MANUAL_RUNTIME_RECONCILE_INTERVAL_MS = 60 * 1000;
export const ALLOWED_MANUAL_RUNTIME_DAYS = [1, 2, 3, 4, 5, 6, 7, 30] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

export type ManualRuntimeAnnotationPatch = Record<string, string | null>;

export function isAllowedManualRuntimeDays(value: unknown): value is ManualRuntimeDurationDays {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    ALLOWED_MANUAL_RUNTIME_DAYS.includes(value as ManualRuntimeDurationDays)
  );
}

export function parseManualRuntimeDurationDays(
  value: string | undefined,
): ManualRuntimeDurationDays | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return isAllowedManualRuntimeDays(parsed) ? parsed : undefined;
}

function validTimestamp(value: string | undefined): string | undefined {
  if (!value || Number.isNaN(Date.parse(value))) {
    return undefined;
  }

  return value;
}

function timestampDate(value: string | undefined): Date | undefined {
  if (!value) {
    return undefined;
  }

  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : new Date(timestamp);
}

export function parseManualRuntimeAnnotations(
  annotations: Record<string, string> | undefined,
): ManualRuntimeSummary | undefined {
  const startedAt = validTimestamp(annotations?.[VM_MANAGER_MANUAL_RUNTIME_STARTED_AT_KEY]);
  const expiresAt = validTimestamp(annotations?.[VM_MANAGER_MANUAL_RUNTIME_EXPIRES_AT_KEY]);
  const durationDays = parseManualRuntimeDurationDays(
    annotations?.[VM_MANAGER_MANUAL_RUNTIME_DURATION_DAYS_KEY],
  );
  const vmiUid = annotations?.[VM_MANAGER_MANUAL_RUNTIME_VMI_UID_KEY] || undefined;
  const stopRequestedAt = validTimestamp(
    annotations?.[VM_MANAGER_MANUAL_RUNTIME_STOP_REQUESTED_AT_KEY],
  );

  if (!startedAt && !expiresAt && !durationDays && !vmiUid && !stopRequestedAt) {
    return undefined;
  }

  return {
    startedAt,
    expiresAt,
    durationDays,
    vmiUid,
    stopRequestedAt,
  };
}

export function manualRuntimeTimerMatchesVmi(
  runtime: ManualRuntimeSummary | undefined,
  vmi: KubeVirtVirtualMachineInstance | undefined,
) {
  return Boolean(
    runtime?.startedAt &&
      runtime.expiresAt &&
      runtime.durationDays &&
      runtime.vmiUid &&
      vmi?.metadata?.uid &&
      runtime.vmiUid === vmi.metadata.uid,
  );
}

export function manualRuntimeAnnotationsForVmi(
  vmi: KubeVirtVirtualMachineInstance,
  durationDays: ManualRuntimeDurationDays,
  startedAt = firstTimestamp(vmi.metadata?.creationTimestamp) ?? new Date().toISOString(),
): ManualRuntimeAnnotationPatch {
  const startedAtDate = timestampDate(startedAt) ?? new Date();
  const expiresAt = new Date(startedAtDate.getTime() + durationDays * DAY_MS).toISOString();

  return {
    [VM_MANAGER_MANUAL_RUNTIME_STARTED_AT_KEY]: startedAtDate.toISOString(),
    [VM_MANAGER_MANUAL_RUNTIME_EXPIRES_AT_KEY]: expiresAt,
    [VM_MANAGER_MANUAL_RUNTIME_DURATION_DAYS_KEY]: String(durationDays),
    [VM_MANAGER_MANUAL_RUNTIME_VMI_UID_KEY]: vmi.metadata?.uid ?? null,
    [VM_MANAGER_MANUAL_RUNTIME_STOP_REQUESTED_AT_KEY]: null,
  };
}

export function defaultManualRuntimeAnnotationsForVmi(
  vmi: KubeVirtVirtualMachineInstance,
): ManualRuntimeAnnotationPatch {
  return manualRuntimeAnnotationsForVmi(vmi, MANUAL_RUNTIME_DEFAULT_DAYS);
}

export function stopRequestedManualRuntimeAnnotation(
  now = new Date(),
): ManualRuntimeAnnotationPatch {
  return {
    [VM_MANAGER_MANUAL_RUNTIME_STOP_REQUESTED_AT_KEY]: now.toISOString(),
  };
}

export function clearManualRuntimeAnnotations(): ManualRuntimeAnnotationPatch {
  return {
    [VM_MANAGER_MANUAL_RUNTIME_STARTED_AT_KEY]: null,
    [VM_MANAGER_MANUAL_RUNTIME_EXPIRES_AT_KEY]: null,
    [VM_MANAGER_MANUAL_RUNTIME_DURATION_DAYS_KEY]: null,
    [VM_MANAGER_MANUAL_RUNTIME_VMI_UID_KEY]: null,
    [VM_MANAGER_MANUAL_RUNTIME_STOP_REQUESTED_AT_KEY]: null,
  };
}

export function manualRuntimePatchBody(annotations: ManualRuntimeAnnotationPatch) {
  return {
    metadata: {
      annotations,
    },
  };
}
