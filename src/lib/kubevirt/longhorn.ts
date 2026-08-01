import "server-only";

import { createHash } from "node:crypto";
import {
  getCoreV1Client,
  getCustomObjectsClient,
  patchNamespacedCustomObjectMergePatch,
} from "./client";
import { ApiError, getErrorStatus } from "./errors";
import {
  isManagedVirtualMachine,
  VM_MANAGER_MANAGED_KEY,
  VM_MANAGER_OPERATION_MESSAGE_KEY,
  VM_MANAGER_OPERATION_NAME_KEY,
  VM_MANAGER_OPERATION_PHASE_KEY,
  VM_MANAGER_OPERATION_STARTED_AT_KEY,
  VM_MANAGER_OPERATION_TYPE_KEY,
} from "./management";
import { objectKey } from "./status";
import { compareTimestampsDesc, firstTimestamp } from "./timestamps";
import type {
  KubeLonghornBackup,
  KubeLonghornBackupVolume,
  KubeLonghornSnapshot,
  KubeLonghornVolume,
  KubeObjectList,
  KubePersistentVolume,
  KubePersistentVolumeClaim,
  KubeVirtVirtualMachine,
  VirtualMachineBackupSummary,
  VirtualMachineRollbackSummary,
  VirtualMachineRootDiskSummary,
  VirtualMachineSnapshotSummary,
  VmOperation,
} from "./types";

export const LONGHORN_GROUP = "longhorn.io";
export const LONGHORN_VERSION = "v1beta2";
export const LONGHORN_NAMESPACE = "longhorn-system";
export const LONGHORN_CSI_DRIVER = "driver.longhorn.io";

const ROOTDISK_VOLUME_NAME = "rootdisk";
const BACKEND_STATE_PREFIX = "persistent-state-for-";
const ROLLBACK_RETENTION_MS = 24 * 60 * 60 * 1000;
const LONGHORN_VOLUME_NAME_MAX_LENGTH = 40;
const MAX_ROLLBACK_WARNINGS = 500;
const warnedRollbackIssues = new Set<string>();

function warnRollbackOnce(key: string, message: string) {
  if (warnedRollbackIssues.has(key)) {
    return;
  }

  if (warnedRollbackIssues.size >= MAX_ROLLBACK_WARNINGS) {
    warnedRollbackIssues.clear();
  }
  warnedRollbackIssues.add(key);
  console.warn(message);
}

export const VM_MANAGER_VM_NAMESPACE_KEY = "vm-manager.skyway.tools/vm-namespace";
export const VM_MANAGER_VM_NAME_KEY = "vm-manager.skyway.tools/vm-name";
export const VM_MANAGER_ROOT_VOLUME_KEY = "vm-manager.skyway.tools/root-volume";
export const VM_MANAGER_ROOT_PVC_KEY = "vm-manager.skyway.tools/root-pvc";
export const VM_MANAGER_ROLLBACK_KEY = "vm-manager.skyway.tools/rollback";
export const VM_MANAGER_ROLLBACK_EXPIRES_AT_KEY = "vm-manager.skyway.tools/rollback-expires-at";
export const VM_MANAGER_ROLLBACK_VOLUME_KEY = "vm-manager.skyway.tools/rollback-volume";

export interface ResolvedRootDisk {
  summary: VirtualMachineRootDiskSummary;
  pvc: KubePersistentVolumeClaim;
  pv: KubePersistentVolume;
  volume: KubeLonghornVolume;
}

export function items<T>(response: unknown): T[] {
  if (typeof response !== "object" || response === null) {
    return [];
  }

  return ((response as KubeObjectList<T>).items ?? []).filter(Boolean);
}

export function isNotFound(error: unknown): boolean {
  return getErrorStatus(error) === 404;
}

export function sleep(milliseconds: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

export function sanitizeLonghornName(input: string, maxLength = 253): string {
  const sanitized = input
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[^a-z0-9]+$/, "");

  const trimmed = (sanitized || "vm-manager").slice(0, maxLength).replace(/[^a-z0-9]+$/, "");
  return trimmed || "vm-manager";
}

export function shortenLonghornName(input: string, maxLength = LONGHORN_VOLUME_NAME_MAX_LENGTH) {
  const sanitized = sanitizeLonghornName(input);
  if (sanitized.length <= maxLength) {
    return sanitized;
  }

  const hash = createHash("sha256").update(sanitized).digest("hex").slice(0, 8);
  const prefix = sanitized
    .slice(0, Math.max(1, maxLength - hash.length - 1))
    .replace(/[^a-z0-9]+$/, "");

  return `${prefix || "vm"}-${hash}`;
}

export function restoreVolumeName(rootVolumeName: string, suffix = timestampSuffix()) {
  return shortenLonghornName(`${rootVolumeName}-restore-${suffix}`);
}

export function timestampSuffix() {
  return new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14)
    .toLowerCase();
}

export function buildProtectionName(vmName: string, type: "snapshot" | "backup" | "restore") {
  return sanitizeLonghornName(`${vmName}-${type}-${timestampSuffix()}`);
}

export function metadataForVm(
  namespace: string,
  vmName: string,
  root: Pick<VirtualMachineRootDiskSummary, "pvcName" | "volumeName">,
  extraLabels?: Record<string, string>,
  extraAnnotations?: Record<string, string>,
) {
  const labels: Record<string, string> = {
    [VM_MANAGER_MANAGED_KEY]: "true",
    [VM_MANAGER_VM_NAMESPACE_KEY]: sanitizeLabelValue(namespace),
    [VM_MANAGER_VM_NAME_KEY]: sanitizeLabelValue(vmName),
    [VM_MANAGER_ROOT_VOLUME_KEY]: sanitizeLabelValue(root.volumeName),
    ...extraLabels,
  };
  const annotations: Record<string, string> = {
    [VM_MANAGER_VM_NAMESPACE_KEY]: namespace,
    [VM_MANAGER_VM_NAME_KEY]: vmName,
    [VM_MANAGER_ROOT_VOLUME_KEY]: root.volumeName,
    [VM_MANAGER_ROOT_PVC_KEY]: root.pvcName,
    ...extraAnnotations,
  };

  return { labels, annotations };
}

function sanitizeLabelValue(value: string): string {
  return sanitizeLonghornName(value, 63);
}

function rootdiskClaimName(vm: KubeVirtVirtualMachine): string {
  const volumes = vm.spec?.template?.spec?.volumes ?? [];
  const candidates = volumes.filter((volume) => {
    const claimName = volume.persistentVolumeClaim?.claimName;
    return claimName && !claimName.startsWith(BACKEND_STATE_PREFIX);
  });
  const root = candidates.find((volume) => volume.name === ROOTDISK_VOLUME_NAME);

  if (!root?.persistentVolumeClaim?.claimName) {
    throw new ApiError(
      409,
      `Virtual machine ${vm.metadata?.namespace ?? "default"}/${vm.metadata?.name ?? "unknown"} does not define a rootdisk PVC.`,
    );
  }

  return root.persistentVolumeClaim.claimName;
}

async function readPvc(namespace: string, name: string): Promise<KubePersistentVolumeClaim> {
  try {
    return (await getCoreV1Client().readNamespacedPersistentVolumeClaim({
      namespace,
      name,
    })) as KubePersistentVolumeClaim;
  } catch (error) {
    if (isNotFound(error)) {
      throw new ApiError(404, `PVC ${namespace}/${name} was not found.`);
    }

    throw error;
  }
}

async function readPv(name: string): Promise<KubePersistentVolume> {
  try {
    return (await getCoreV1Client().readPersistentVolume({ name })) as KubePersistentVolume;
  } catch (error) {
    if (isNotFound(error)) {
      throw new ApiError(404, `PersistentVolume ${name} was not found.`);
    }

    throw error;
  }
}

export async function readLonghornVolume(name: string): Promise<KubeLonghornVolume> {
  try {
    return (await getCustomObjectsClient().getNamespacedCustomObject({
      group: LONGHORN_GROUP,
      version: LONGHORN_VERSION,
      namespace: LONGHORN_NAMESPACE,
      plural: "volumes",
      name,
    })) as KubeLonghornVolume;
  } catch (error) {
    if (isNotFound(error)) {
      throw new ApiError(404, `Longhorn volume ${name} was not found.`);
    }

    throw error;
  }
}

export async function resolveRootDisk(vm: KubeVirtVirtualMachine): Promise<ResolvedRootDisk> {
  const namespace = vm.metadata?.namespace ?? "default";
  const pvcName = rootdiskClaimName(vm);
  const pvc = await readPvc(namespace, pvcName);
  const pvName = pvc.spec?.volumeName;

  if (!pvName) {
    throw new ApiError(409, `Rootdisk PVC ${namespace}/${pvcName} is not bound to a PV.`);
  }

  const pv = await readPv(pvName);
  const driver = pv.spec?.csi?.driver;
  const volumeName = pv.spec?.csi?.volumeHandle;

  if (driver !== LONGHORN_CSI_DRIVER || !volumeName) {
    throw new ApiError(409, `Rootdisk PVC ${namespace}/${pvcName} is not backed by Longhorn CSI.`);
  }

  const volume = await readLonghornVolume(volumeName);

  return {
    pvc,
    pv,
    volume,
    summary: {
      pvcName,
      pvName,
      volumeName,
      storageClassName: pvc.spec?.storageClassName ?? pv.spec?.storageClassName,
      size: pvc.spec?.resources?.requests?.storage ?? pv.spec?.capacity?.storage,
      currentSize: pv.spec?.capacity?.storage,
      desiredSize: pvc.spec?.resources?.requests?.storage,
      volumeMode: pvc.spec?.volumeMode ?? pv.spec?.volumeMode,
    },
  };
}

export async function listLonghornSnapshots(): Promise<KubeLonghornSnapshot[]> {
  const response = await getCustomObjectsClient().listNamespacedCustomObject({
    group: LONGHORN_GROUP,
    version: LONGHORN_VERSION,
    namespace: LONGHORN_NAMESPACE,
    plural: "snapshots",
  });
  return items<KubeLonghornSnapshot>(response);
}

export async function listLonghornBackups(): Promise<KubeLonghornBackup[]> {
  const response = await getCustomObjectsClient().listNamespacedCustomObject({
    group: LONGHORN_GROUP,
    version: LONGHORN_VERSION,
    namespace: LONGHORN_NAMESPACE,
    plural: "backups",
  });
  return items<KubeLonghornBackup>(response);
}

export async function listLonghornBackupVolumes(): Promise<KubeLonghornBackupVolume[]> {
  const response = await getCustomObjectsClient().listNamespacedCustomObject({
    group: LONGHORN_GROUP,
    version: LONGHORN_VERSION,
    namespace: LONGHORN_NAMESPACE,
    plural: "backupvolumes",
  });
  return items<KubeLonghornBackupVolume>(response);
}

export async function listLonghornVolumes(): Promise<KubeLonghornVolume[]> {
  const response = await getCustomObjectsClient().listNamespacedCustomObject({
    group: LONGHORN_GROUP,
    version: LONGHORN_VERSION,
    namespace: LONGHORN_NAMESPACE,
    plural: "volumes",
  });
  return items<KubeLonghornVolume>(response);
}

export function toLonghornSnapshotSummary(
  snapshot: KubeLonghornSnapshot,
): VirtualMachineSnapshotSummary {
  const readyToUse =
    typeof snapshot.status?.readyToUse === "boolean" ? snapshot.status.readyToUse : null;
  const removed = snapshot.status?.markRemoved === true;
  const phase = snapshot.status?.error
    ? "Error"
    : removed
      ? "Removed"
      : readyToUse
        ? "Ready"
        : "Pending";

  return {
    name: snapshot.metadata?.name ?? "unknown",
    namespace: snapshot.metadata?.namespace ?? LONGHORN_NAMESPACE,
    volumeName: snapshot.spec?.volume,
    createdAt: firstTimestamp(snapshot.status?.creationTime, snapshot.metadata?.creationTimestamp),
    readyToUse,
    phase,
    message: snapshot.status?.error,
    conditions: [],
    size: snapshot.status?.size,
    labels: snapshot.status?.labels ?? snapshot.spec?.labels ?? snapshot.metadata?.labels,
  };
}

export function toLonghornBackupSummary(backup: KubeLonghornBackup): VirtualMachineBackupSummary {
  const state = backup.status?.state ?? "Pending";
  const readyToUse = state === "Completed";

  return {
    name: backup.metadata?.name ?? "unknown",
    namespace: backup.metadata?.namespace ?? LONGHORN_NAMESPACE,
    volumeName: backup.status?.volumeName,
    createdAt: firstTimestamp(backup.status?.backupCreatedAt, backup.metadata?.creationTimestamp),
    snapshotName: backup.status?.snapshotName ?? backup.spec?.snapshotName,
    readyToUse,
    phase: state,
    progress: backup.status?.progress,
    message: backup.status?.error,
    backupMode: backup.spec?.backupMode,
    size: backup.status?.size,
    volumeSize: backup.status?.volumeSize,
    labels: backup.status?.labels ?? backup.spec?.labels ?? backup.metadata?.labels,
  };
}

export function snapshotsForVolume(
  snapshots: KubeLonghornSnapshot[],
  volumeName: string,
): VirtualMachineSnapshotSummary[] {
  return snapshots
    .filter((snapshot) => snapshot.spec?.volume === volumeName)
    .map(toLonghornSnapshotSummary)
    .filter((snapshot) => snapshot.phase !== "Removed")
    .sort((left, right) => compareTimestampsDesc(left.createdAt, right.createdAt));
}

function metadataMatchesVm(
  metadata: { labels?: Record<string, string>; annotations?: Record<string, string> } | undefined,
  namespace: string,
  vmName: string,
) {
  return (
    metadata?.annotations?.[VM_MANAGER_VM_NAMESPACE_KEY] === namespace &&
    metadata.annotations?.[VM_MANAGER_VM_NAME_KEY] === vmName
  );
}

export function backupsForVm(
  backups: KubeLonghornBackup[],
  root: VirtualMachineRootDiskSummary,
  namespace: string,
  vmName: string,
): VirtualMachineBackupSummary[] {
  return backups
    .filter((backup) => {
      if (backup.status?.volumeName === root.volumeName) {
        return true;
      }

      if (metadataMatchesVm(backup.metadata, namespace, vmName)) {
        return true;
      }

      const labels = backup.status?.labels ?? backup.spec?.labels;
      return labels?.[VM_MANAGER_ROOT_VOLUME_KEY] === root.volumeName;
    })
    .map(toLonghornBackupSummary)
    .sort((left, right) => compareTimestampsDesc(left.createdAt, right.createdAt));
}

export async function createLonghornSnapshot(
  namespace: string,
  vmName: string,
  root: VirtualMachineRootDiskSummary,
  snapshotName: string,
): Promise<VirtualMachineSnapshotSummary> {
  const metadata = metadataForVm(namespace, vmName, root);
  const response = (await getCustomObjectsClient().createNamespacedCustomObject({
    group: LONGHORN_GROUP,
    version: LONGHORN_VERSION,
    namespace: LONGHORN_NAMESPACE,
    plural: "snapshots",
    body: {
      apiVersion: `${LONGHORN_GROUP}/${LONGHORN_VERSION}`,
      kind: "Snapshot",
      metadata: {
        name: snapshotName,
        namespace: LONGHORN_NAMESPACE,
        labels: metadata.labels,
        annotations: metadata.annotations,
      },
      spec: {
        volume: root.volumeName,
        createSnapshot: true,
        labels: metadata.labels,
      },
    },
  })) as KubeLonghornSnapshot;

  return toLonghornSnapshotSummary(response);
}

export async function createLonghornBackup(
  namespace: string,
  vmName: string,
  root: VirtualMachineRootDiskSummary,
  backupName: string,
  snapshotName: string,
  backupMode = "incremental",
): Promise<VirtualMachineBackupSummary> {
  const metadata = metadataForVm(namespace, vmName, root);
  const response = (await getCustomObjectsClient().createNamespacedCustomObject({
    group: LONGHORN_GROUP,
    version: LONGHORN_VERSION,
    namespace: LONGHORN_NAMESPACE,
    plural: "backups",
    body: {
      apiVersion: `${LONGHORN_GROUP}/${LONGHORN_VERSION}`,
      kind: "Backup",
      metadata: {
        name: backupName,
        namespace: LONGHORN_NAMESPACE,
        labels: metadata.labels,
        annotations: metadata.annotations,
      },
      spec: {
        snapshotName,
        backupMode,
        labels: metadata.labels,
      },
    },
  })) as KubeLonghornBackup;

  return toLonghornBackupSummary(response);
}

export async function patchVmOperation(
  namespace: string,
  name: string,
  operation: VmOperation | null,
) {
  const annotations =
    operation === null
      ? {
          [VM_MANAGER_OPERATION_TYPE_KEY]: null,
          [VM_MANAGER_OPERATION_NAME_KEY]: null,
          [VM_MANAGER_OPERATION_PHASE_KEY]: null,
          [VM_MANAGER_OPERATION_STARTED_AT_KEY]: null,
          [VM_MANAGER_OPERATION_MESSAGE_KEY]: null,
        }
      : {
          [VM_MANAGER_OPERATION_TYPE_KEY]: operation.type,
          [VM_MANAGER_OPERATION_NAME_KEY]: operation.name,
          [VM_MANAGER_OPERATION_PHASE_KEY]: operation.phase,
          [VM_MANAGER_OPERATION_STARTED_AT_KEY]: operation.createdAt ?? new Date().toISOString(),
          [VM_MANAGER_OPERATION_MESSAGE_KEY]: operation.message ?? null,
        };

  await patchNamespacedCustomObjectMergePatch({
    group: "kubevirt.io",
    version: "v1",
    namespace,
    plural: "virtualmachines",
    name,
    body: {
      metadata: {
        annotations,
      },
    },
  });
}

export function activeOperation(vm: KubeVirtVirtualMachine): VmOperation | undefined {
  const type = vm.metadata?.annotations?.[VM_MANAGER_OPERATION_TYPE_KEY] as
    | VmOperation["type"]
    | undefined;

  if (!type) {
    return undefined;
  }

  return {
    type,
    name: vm.metadata?.annotations?.[VM_MANAGER_OPERATION_NAME_KEY] ?? type,
    phase: vm.metadata?.annotations?.[VM_MANAGER_OPERATION_PHASE_KEY] ?? "Running",
    createdAt: vm.metadata?.annotations?.[VM_MANAGER_OPERATION_STARTED_AT_KEY],
    message: vm.metadata?.annotations?.[VM_MANAGER_OPERATION_MESSAGE_KEY],
  };
}

export async function withVmOperation<T>(
  vm: KubeVirtVirtualMachine,
  type: VmOperation["type"],
  name: string,
  message: string,
  task: () => Promise<T>,
): Promise<T> {
  const namespace = vm.metadata?.namespace ?? "default";
  const vmName = vm.metadata?.name ?? "unknown";
  const existing = activeOperation(vm);

  if (existing) {
    throw new ApiError(
      409,
      `A VM storage operation is already in progress: ${existing.type} ${existing.name}.`,
    );
  }

  await patchVmOperation(namespace, vmName, {
    type,
    name,
    phase: "Running",
    createdAt: new Date().toISOString(),
    message,
  });

  try {
    return await task();
  } finally {
    await patchVmOperation(namespace, vmName, null).catch((error: unknown) => {
      console.error("Failed to clear VM operation annotation", error);
    });
  }
}

export async function listRollbackPvs(
  namespace?: string,
  vmName?: string,
): Promise<VirtualMachineRollbackSummary[]> {
  const response = await getCoreV1Client().listPersistentVolume({
    labelSelector: `${VM_MANAGER_ROLLBACK_KEY}=true`,
  });

  return items<KubePersistentVolume>(response)
    .filter((pv) => {
      if (!namespace || !vmName) {
        return true;
      }

      return (
        pv.metadata?.annotations?.[VM_MANAGER_VM_NAMESPACE_KEY] === namespace &&
        pv.metadata.annotations?.[VM_MANAGER_VM_NAME_KEY] === vmName
      );
    })
    .map((pv) => ({
      pvName: pv.metadata?.name ?? "unknown",
      volumeName:
        pv.metadata?.annotations?.[VM_MANAGER_ROLLBACK_VOLUME_KEY] ?? pv.spec?.csi?.volumeHandle,
      pvcName: pv.metadata?.annotations?.[VM_MANAGER_ROOT_PVC_KEY],
      createdAt: firstTimestamp(pv.metadata?.creationTimestamp),
      expiresAt: pv.metadata?.annotations?.[VM_MANAGER_ROLLBACK_EXPIRES_AT_KEY],
    }))
    .sort((left, right) => compareTimestampsDesc(left.createdAt, right.createdAt));
}

export function rollbackMetadata(
  namespace: string,
  vmName: string,
  root: VirtualMachineRootDiskSummary,
) {
  const expiresAt = new Date(Date.now() + ROLLBACK_RETENTION_MS).toISOString();
  return metadataForVm(
    namespace,
    vmName,
    root,
    {
      [VM_MANAGER_ROLLBACK_KEY]: "true",
    },
    {
      [VM_MANAGER_ROLLBACK_KEY]: "true",
      [VM_MANAGER_ROLLBACK_EXPIRES_AT_KEY]: expiresAt,
      [VM_MANAGER_ROLLBACK_VOLUME_KEY]: root.volumeName,
    },
  );
}

export function buildRestoredPv(
  oldPv: KubePersistentVolume,
  oldPvc: KubePersistentVolumeClaim,
  root: VirtualMachineRootDiskSummary,
  newPvName: string,
  newVolumeName: string,
): KubePersistentVolume {
  return {
    apiVersion: "v1",
    kind: "PersistentVolume",
    metadata: {
      name: newPvName,
      labels: {
        ...(oldPv.metadata?.labels ?? {}),
        [VM_MANAGER_MANAGED_KEY]: "true",
      },
      annotations: {
        ...(oldPv.metadata?.annotations ?? {}),
        [VM_MANAGER_ROOT_VOLUME_KEY]: newVolumeName,
      },
    },
    spec: {
      accessModes: oldPv.spec?.accessModes ?? oldPvc.spec?.accessModes,
      capacity: oldPv.spec?.capacity ?? {
        storage: root.size ?? oldPvc.spec?.resources?.requests?.storage ?? "1Gi",
      },
      claimRef: {
        namespace: oldPvc.metadata?.namespace,
        name: oldPvc.metadata?.name,
      },
      csi: {
        ...(oldPv.spec?.csi ?? {}),
        driver: LONGHORN_CSI_DRIVER,
        volumeHandle: newVolumeName,
      },
      mountOptions: oldPv.spec?.mountOptions,
      persistentVolumeReclaimPolicy: oldPv.spec?.persistentVolumeReclaimPolicy ?? "Delete",
      storageClassName: oldPv.spec?.storageClassName ?? oldPvc.spec?.storageClassName,
      volumeMode: oldPv.spec?.volumeMode ?? oldPvc.spec?.volumeMode,
    },
  };
}

export function buildRestoredPvc(
  oldPvc: KubePersistentVolumeClaim,
  newPvName: string,
): KubePersistentVolumeClaim {
  return {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: {
      name: oldPvc.metadata?.name,
      namespace: oldPvc.metadata?.namespace,
      labels: oldPvc.metadata?.labels,
    },
    spec: {
      accessModes: oldPvc.spec?.accessModes,
      resources: oldPvc.spec?.resources,
      storageClassName: oldPvc.spec?.storageClassName,
      volumeName: newPvName,
      volumeMode: oldPvc.spec?.volumeMode,
    },
  };
}

export async function deleteLonghornVolumeIfPresent(volumeName: string | undefined) {
  if (!volumeName) {
    return;
  }

  try {
    await getCustomObjectsClient().deleteNamespacedCustomObject({
      group: LONGHORN_GROUP,
      version: LONGHORN_VERSION,
      namespace: LONGHORN_NAMESPACE,
      plural: "volumes",
      name: volumeName,
    });
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
  }
}

export async function discardRollback(namespace: string, vmName: string, pvName: string) {
  const pv = await readPv(pvName);
  const matches =
    pv.metadata?.labels?.[VM_MANAGER_ROLLBACK_KEY] === "true" &&
    pv.metadata?.annotations?.[VM_MANAGER_VM_NAMESPACE_KEY] === namespace &&
    pv.metadata.annotations?.[VM_MANAGER_VM_NAME_KEY] === vmName;

  if (!matches) {
    throw new ApiError(
      404,
      `Rollback PV ${pvName} was not found for ${objectKey(namespace, vmName)}.`,
    );
  }

  const volumeName =
    pv.metadata?.annotations?.[VM_MANAGER_ROLLBACK_VOLUME_KEY] ?? pv.spec?.csi?.volumeHandle;
  await deleteLonghornVolumeIfPresent(volumeName);
  await getCoreV1Client().deletePersistentVolume({
    name: pvName,
    gracePeriodSeconds: 0,
    propagationPolicy: "Background",
    body: {
      apiVersion: "v1",
      kind: "DeleteOptions",
      gracePeriodSeconds: 0,
      propagationPolicy: "Background",
    },
  });
}

let reaperStarted = false;

export function ensureRollbackReaperStarted() {
  if (reaperStarted || process.env.NODE_ENV === "test") {
    return;
  }

  reaperStarted = true;
  reapExpiredRollbacks().catch((error: unknown) => {
    console.error("Rollback reaper failed", error);
  });
  const timer = setInterval(
    () => {
      reapExpiredRollbacks().catch((error: unknown) => {
        console.error("Rollback reaper failed", error);
      });
    },
    15 * 60 * 1000,
  );
  timer.unref?.();
}

export async function reapExpiredRollbacks(now = new Date()) {
  const rollbacks = await listRollbackPvs();
  const failures: unknown[] = [];

  for (const rollback of rollbacks) {
    if (!rollback.expiresAt) {
      continue;
    }

    let expiresAt = Date.parse(rollback.expiresAt);
    if (!Number.isFinite(expiresAt)) {
      const createdAt = rollback.createdAt ? Date.parse(rollback.createdAt) : Number.NaN;
      if (!Number.isFinite(createdAt)) {
        warnRollbackOnce(
          `${rollback.pvName}:invalid-expiration:${rollback.expiresAt}`,
          `Skipping rollback ${rollback.pvName}: invalid ${VM_MANAGER_ROLLBACK_EXPIRES_AT_KEY} value ${JSON.stringify(rollback.expiresAt)} and no valid creation timestamp.`,
        );
        continue;
      }

      expiresAt = createdAt + ROLLBACK_RETENTION_MS;
      warnRollbackOnce(
        `${rollback.pvName}:fallback-expiration:${rollback.expiresAt}`,
        `Rollback ${rollback.pvName} has invalid ${VM_MANAGER_ROLLBACK_EXPIRES_AT_KEY} value ${JSON.stringify(rollback.expiresAt)}; using creation time plus 24 hours.`,
      );
    }

    if (expiresAt > now.getTime()) {
      continue;
    }

    try {
      const pv = await readPv(rollback.pvName);
      const namespace = pv.metadata?.annotations?.[VM_MANAGER_VM_NAMESPACE_KEY];
      const vmName = pv.metadata?.annotations?.[VM_MANAGER_VM_NAME_KEY];
      if (!namespace || !vmName) {
        warnRollbackOnce(
          `${rollback.pvName}:missing-owner`,
          `Skipping rollback ${rollback.pvName}: missing ${!namespace ? VM_MANAGER_VM_NAMESPACE_KEY : VM_MANAGER_VM_NAME_KEY} annotation.`,
        );
        continue;
      }

      let vm: KubeVirtVirtualMachine | undefined;
      try {
        vm = (await getCustomObjectsClient().getNamespacedCustomObject({
          group: "kubevirt.io",
          version: "v1",
          namespace,
          plural: "virtualmachines",
          name: vmName,
        })) as KubeVirtVirtualMachine;
      } catch (error) {
        if (!isNotFound(error)) {
          throw error;
        }
      }

      if (vm && !isManagedVirtualMachine(vm)) {
        warnRollbackOnce(
          `${rollback.pvName}:unmanaged-owner`,
          `Retaining rollback ${rollback.pvName}: virtual machine ${namespace}/${vmName} is unmanaged.`,
        );
        continue;
      }

      warnedRollbackIssues.delete(`${rollback.pvName}:unmanaged-owner`);

      await deleteLonghornVolumeIfPresent(
        pv.metadata?.annotations?.[VM_MANAGER_ROLLBACK_VOLUME_KEY] ?? pv.spec?.csi?.volumeHandle,
      );
      await getCoreV1Client().deletePersistentVolume({
        name: rollback.pvName,
        gracePeriodSeconds: 0,
        propagationPolicy: "Background",
        body: {
          apiVersion: "v1",
          kind: "DeleteOptions",
          gracePeriodSeconds: 0,
          propagationPolicy: "Background",
        },
      });
    } catch (error) {
      if (!isNotFound(error)) {
        failures.push(new Error(`Failed to reap rollback ${rollback.pvName}.`, { cause: error }));
      }
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, `Failed to reap ${failures.length} rollback(s).`);
  }
}
