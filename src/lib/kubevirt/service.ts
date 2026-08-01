import "server-only";

import {
  getCoreV1Client,
  getCustomObjectsClient,
  patchNamespacedCustomObjectMergePatch,
  patchPersistentVolumeMergePatch,
  requestKubeJson,
} from "./client";
import { ApiError } from "./errors";
import {
  backupsForVm,
  buildRestoredPv,
  buildRestoredPvc,
  createLonghornBackup,
  createLonghornSnapshot,
  discardRollback,
  ensureRollbackReaperStarted,
  isNotFound,
  items,
  LONGHORN_GROUP,
  LONGHORN_NAMESPACE,
  LONGHORN_VERSION,
  listLonghornBackups,
  listLonghornBackupVolumes,
  listLonghornSnapshots,
  listLonghornVolumes,
  listRollbackPvs,
  metadataForVm,
  patchVmOperation,
  readLonghornVolume,
  reapExpiredRollbacks,
  resolveRootDisk,
  restoreVolumeName,
  rollbackMetadata,
  sanitizeLonghornName,
  sleep,
  snapshotsForVolume,
  timestampSuffix,
  withVmOperation,
} from "./longhorn";
import {
  attachVolumeForMaintenance,
  chooseMaintenanceNode,
  detachMaintenanceVolume,
  revertSnapshot,
} from "./longhorn-api";
import { isManagedVirtualMachine } from "./management";
import {
  clearManualRuntimeAnnotations,
  isAllowedManualRuntimeDays,
  type ManualRuntimeAnnotationPatch,
  manualRuntimeAnnotationsForVmi,
  manualRuntimePatchBody,
} from "./manual-runtime";
import { ensureManualRuntimeReconcilerStarted } from "./manual-runtime-reconciler";
import { objectKey, toClusterNodeLoad, toVmSummary } from "./status";
import { compareTimestampsDesc, firstTimestamp } from "./timestamps";
import type {
  ClusterNodeLoad,
  KubeLonghornBackup,
  KubeLonghornVolume,
  KubeNode,
  KubeNodeMetrics,
  KubePersistentVolumeClaim,
  KubeVirtGuestUserList,
  KubeVirtVirtualMachine,
  KubeVirtVirtualMachineInstance,
  ManualRuntimeDurationDays,
  VirtualMachineBackupSummary,
  VirtualMachineDetail,
  VirtualMachineRollbackSummary,
  VirtualMachineSnapshotSummary,
  VirtualMachineSummary,
  VmAction,
} from "./types";
import {
  createBackupSchema,
  hasActiveOperation,
  snapshotNameSchema,
  validateActionForVm,
  validateBackupRestorePreconditions,
  validateRestorePreconditions,
} from "./validation";
import { getVmiPhase, isTerminalVmi } from "./vmi";

const KUBEVIRT_GROUP = "kubevirt.io";
const KUBEVIRT_VERSION = "v1";
const SUBRESOURCE_GROUP = "subresources.kubevirt.io";
const RESTORE_TARGET_WAIT_TIMEOUT_MS = 60_000;
const RESTORE_TARGET_WAIT_INTERVAL_MS = 1_000;
const LONGHORN_WAIT_TIMEOUT_MS = 10 * 60_000;
const LONGHORN_WAIT_INTERVAL_MS = 2_000;
const PVC_WAIT_TIMEOUT_MS = 90_000;
const PVC_WAIT_INTERVAL_MS = 1_000;
const START_TIMER_VMI_WAIT_TIMEOUT_MS = 30_000;
const START_TIMER_VMI_WAIT_INTERVAL_MS = 1_000;

interface VmActionOptions {
  timeoutDays?: ManualRuntimeDurationDays;
}

async function optionalList<T>(request: {
  group: string;
  version: string;
  plural: string;
  namespace?: string;
}): Promise<T[]> {
  const client = getCustomObjectsClient();

  try {
    const response = request.namespace
      ? await client.listNamespacedCustomObject(request)
      : await client.listCustomObjectForAllNamespaces(request);
    return items<T>(response);
  } catch (error) {
    if (isNotFound(error)) {
      return [];
    }

    throw error;
  }
}

async function readOptionalNamespaced<T>(
  namespace: string,
  name: string,
  plural: string,
): Promise<T | undefined> {
  try {
    return (await getCustomObjectsClient().getNamespacedCustomObject({
      group: KUBEVIRT_GROUP,
      version: KUBEVIRT_VERSION,
      namespace,
      plural,
      name,
    })) as T;
  } catch (error) {
    if (isNotFound(error)) {
      return undefined;
    }

    throw error;
  }
}

async function readVirtualMachine(
  namespace: string,
  name: string,
): Promise<KubeVirtVirtualMachine> {
  try {
    const vm = (await getCustomObjectsClient().getNamespacedCustomObject({
      group: KUBEVIRT_GROUP,
      version: KUBEVIRT_VERSION,
      namespace,
      plural: "virtualmachines",
      name,
    })) as KubeVirtVirtualMachine;
    if (!isManagedVirtualMachine(vm)) {
      throw new ApiError(404, `Virtual machine ${namespace}/${name} was not found.`);
    }

    return vm;
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }

    if (isNotFound(error)) {
      throw new ApiError(404, `Virtual machine ${namespace}/${name} was not found.`);
    }

    throw error;
  }
}

async function listVirtualMachineInstances(): Promise<KubeVirtVirtualMachineInstance[]> {
  return optionalList<KubeVirtVirtualMachineInstance>({
    group: KUBEVIRT_GROUP,
    version: KUBEVIRT_VERSION,
    plural: "virtualmachineinstances",
  });
}

function toVmiMap(vmis: KubeVirtVirtualMachineInstance[]) {
  return new Map(
    vmis
      .filter((vmi) => vmi.metadata?.namespace && vmi.metadata.name)
      .map((vmi) => [objectKey(vmi.metadata?.namespace ?? "", vmi.metadata?.name ?? ""), vmi]),
  );
}

function encodeSegment(value: string) {
  return encodeURIComponent(value);
}

async function deleteTerminalVmi(namespace: string, name: string) {
  try {
    await getCustomObjectsClient().deleteNamespacedCustomObject({
      group: KUBEVIRT_GROUP,
      version: KUBEVIRT_VERSION,
      namespace,
      plural: "virtualmachineinstances",
      name,
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
      throw error;
    }
  }
}

async function waitForRestoreTargetVmiToDisappear(namespace: string, name: string) {
  const deadline = Date.now() + RESTORE_TARGET_WAIT_TIMEOUT_MS;
  let deletedTerminalVmi = false;
  let lastPhase: string | undefined;

  while (Date.now() <= deadline) {
    const vmi = await readOptionalNamespaced<KubeVirtVirtualMachineInstance>(
      namespace,
      name,
      "virtualmachineinstances",
    );

    if (!vmi) {
      return;
    }

    lastPhase = getVmiPhase(vmi);

    if (isTerminalVmi(vmi) && !deletedTerminalVmi) {
      await deleteTerminalVmi(namespace, name);
      deletedTerminalVmi = true;
    }

    await sleep(RESTORE_TARGET_WAIT_INTERVAL_MS);
  }

  throw new ApiError(
    409,
    `The VM is stopped, but Kubernetes still reports an existing instance${lastPhase ? ` in ${lastPhase} phase` : ""}. Try restoring again in a moment.`,
  );
}

async function waitForManualRuntimeVmi(
  namespace: string,
  name: string,
): Promise<KubeVirtVirtualMachineInstance> {
  const deadline = Date.now() + START_TIMER_VMI_WAIT_TIMEOUT_MS;

  while (Date.now() <= deadline) {
    const vmi = await readOptionalNamespaced<KubeVirtVirtualMachineInstance>(
      namespace,
      name,
      "virtualmachineinstances",
    );

    if (vmi?.metadata?.uid && !isTerminalVmi(vmi)) {
      return vmi;
    }

    await sleep(START_TIMER_VMI_WAIT_INTERVAL_MS);
  }

  throw new ApiError(
    504,
    `Timed out waiting for ${namespace}/${name} to report a running instance for runtime timer setup.`,
  );
}

async function patchVirtualMachineManualRuntime(
  namespace: string,
  name: string,
  annotations: ManualRuntimeAnnotationPatch,
) {
  await patchNamespacedCustomObjectMergePatch({
    group: KUBEVIRT_GROUP,
    version: KUBEVIRT_VERSION,
    namespace,
    plural: "virtualmachines",
    name,
    body: manualRuntimePatchBody(annotations),
  });
}

async function waitForPvcDeleted(namespace: string, name: string) {
  const deadline = Date.now() + PVC_WAIT_TIMEOUT_MS;

  while (Date.now() <= deadline) {
    try {
      await getCoreV1Client().readNamespacedPersistentVolumeClaim({ namespace, name });
    } catch (error) {
      if (isNotFound(error)) {
        return;
      }

      throw error;
    }

    await sleep(PVC_WAIT_INTERVAL_MS);
  }

  throw new ApiError(409, `PVC ${namespace}/${name} was not deleted in time.`);
}

async function waitForPvcBound(namespace: string, name: string) {
  const deadline = Date.now() + PVC_WAIT_TIMEOUT_MS;

  while (Date.now() <= deadline) {
    const pvc = (await getCoreV1Client().readNamespacedPersistentVolumeClaim({
      namespace,
      name,
    })) as KubePersistentVolumeClaim;

    if (pvc.status?.phase === "Bound") {
      return;
    }

    await sleep(PVC_WAIT_INTERVAL_MS);
  }

  throw new ApiError(409, `PVC ${namespace}/${name} was not bound in time.`);
}

async function waitForLonghornVolume(
  name: string,
  predicate: (volume: KubeLonghornVolume) => boolean,
  description: string,
): Promise<KubeLonghornVolume> {
  const deadline = Date.now() + LONGHORN_WAIT_TIMEOUT_MS;
  let lastState: string | undefined;

  while (Date.now() <= deadline) {
    let volume: KubeLonghornVolume;
    try {
      volume = await readLonghornVolume(name);
    } catch (error) {
      if (isNotFound(error)) {
        await sleep(LONGHORN_WAIT_INTERVAL_MS);
        continue;
      }

      throw error;
    }

    lastState = volume.status?.state;

    if (predicate(volume)) {
      return volume;
    }

    await sleep(LONGHORN_WAIT_INTERVAL_MS);
  }

  throw new ApiError(
    409,
    `Longhorn volume ${name} did not become ${description}${lastState ? ` (last state: ${lastState})` : ""}.`,
  );
}

async function waitForSnapshotReady(snapshotName: string): Promise<VirtualMachineSnapshotSummary> {
  const deadline = Date.now() + LONGHORN_WAIT_TIMEOUT_MS;

  while (Date.now() <= deadline) {
    const snapshots = await listLonghornSnapshots();
    const snapshot = snapshots.find((candidate) => candidate.metadata?.name === snapshotName);
    if (snapshot?.status?.error) {
      throw new ApiError(409, snapshot.status.error);
    }

    if (snapshot?.status?.readyToUse === true) {
      return (
        snapshotsForVolume(snapshots, snapshot.spec?.volume ?? "").find(
          (candidate) => candidate.name === snapshotName,
        ) ?? {
          name: snapshotName,
          namespace: LONGHORN_NAMESPACE,
          readyToUse: true,
          phase: "Ready",
          conditions: [],
        }
      );
    }

    await sleep(LONGHORN_WAIT_INTERVAL_MS);
  }

  throw new ApiError(409, `Longhorn snapshot ${snapshotName} did not become ready in time.`);
}

async function waitForBackupComplete(backupName: string): Promise<VirtualMachineBackupSummary> {
  const deadline = Date.now() + LONGHORN_WAIT_TIMEOUT_MS;

  while (Date.now() <= deadline) {
    const backups = await listLonghornBackups();
    const backup = backups.find((candidate) => candidate.metadata?.name === backupName);
    if (backup?.status?.state === "Error") {
      throw new ApiError(409, backup.status.error ?? `Longhorn backup ${backupName} failed.`);
    }

    if (backup?.status?.state === "Completed") {
      return {
        name: backup.metadata?.name ?? backupName,
        namespace: backup.metadata?.namespace ?? LONGHORN_NAMESPACE,
        volumeName: backup.status.volumeName,
        createdAt: firstTimestamp(
          backup.status.backupCreatedAt,
          backup.metadata?.creationTimestamp,
        ),
        snapshotName: backup.status.snapshotName ?? backup.spec?.snapshotName,
        readyToUse: true,
        phase: "Completed",
        progress: backup.status.progress,
        backupMode: backup.spec?.backupMode,
        size: backup.status.size,
        volumeSize: backup.status.volumeSize,
        labels: backup.status.labels ?? backup.spec?.labels ?? backup.metadata?.labels,
      };
    }

    await sleep(LONGHORN_WAIT_INTERVAL_MS);
  }

  throw new ApiError(409, `Longhorn backup ${backupName} did not complete in time.`);
}

async function freezeVmi(namespace: string, name: string): Promise<boolean> {
  const path = `/apis/${SUBRESOURCE_GROUP}/${KUBEVIRT_VERSION}/namespaces/${encodeSegment(namespace)}/virtualmachineinstances/${encodeSegment(name)}`;

  try {
    await requestKubeJson("PUT", `${path}/freeze`, {
      apiVersion: `${SUBRESOURCE_GROUP}/${KUBEVIRT_VERSION}`,
      kind: "FreezeUnfreezeTimeout",
      unfreezeTimeout: "120s",
    });
    return true;
  } catch (error) {
    console.warn(`Continuing without guest-agent freeze for ${namespace}/${name}`, error);
    return false;
  }
}

async function unfreezeVmi(namespace: string, name: string) {
  const path = `/apis/${SUBRESOURCE_GROUP}/${KUBEVIRT_VERSION}/namespaces/${encodeSegment(namespace)}/virtualmachineinstances/${encodeSegment(name)}`;
  await requestKubeJson("PUT", `${path}/unfreeze`);
}

async function startVm(namespace: string, name: string) {
  const path = `/apis/${SUBRESOURCE_GROUP}/${KUBEVIRT_VERSION}/namespaces/${encodeSegment(namespace)}/virtualmachines/${encodeSegment(name)}/start`;
  await requestKubeJson("PUT", path, {
    apiVersion: `${SUBRESOURCE_GROUP}/${KUBEVIRT_VERSION}`,
    kind: "StartOptions",
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Guest session status is unavailable.";
}

async function readGuestUsers(
  namespace: string,
  name: string,
  powerState: VirtualMachineSummary["powerState"],
): Promise<{ users?: KubeVirtGuestUserList["items"]; error?: string }> {
  if (powerState !== "online") {
    return { users: [] };
  }

  try {
    const path = `/apis/${SUBRESOURCE_GROUP}/${KUBEVIRT_VERSION}/namespaces/${encodeSegment(namespace)}/virtualmachineinstances/${encodeSegment(name)}/userlist`;
    const response = (await requestKubeJson("GET", path)) as KubeVirtGuestUserList;
    return { users: response.items ?? [] };
  } catch (error) {
    return { error: errorMessage(error) };
  }
}

async function attachRootVolumeForMaintenance(volumeName: string): Promise<boolean> {
  const current = await readLonghornVolume(volumeName);
  if (current.status?.state === "attached") {
    if (current.status.frontendDisabled === true) {
      return false;
    }

    throw new ApiError(
      409,
      `Longhorn volume ${volumeName} is still attached with its frontend enabled.`,
    );
  }

  if (current.status?.state !== "detached") {
    await waitForLonghornVolume(
      volumeName,
      (volume) => volume.status?.state === "detached",
      "detached",
    );
  }

  const nodeName = await chooseMaintenanceNode();
  await attachVolumeForMaintenance(volumeName, nodeName);
  await waitForLonghornVolume(
    volumeName,
    (volume) => volume.status?.state === "attached" && volume.status.frontendDisabled === true,
    "attached in maintenance mode",
  );
  return true;
}

async function detachRootVolumeFromMaintenance(volumeName: string, attachedHere: boolean) {
  if (!attachedHere) {
    return;
  }

  await detachMaintenanceVolume(volumeName);
  await waitForLonghornVolume(
    volumeName,
    (volume) => volume.status?.state === "detached",
    "detached",
  );
}

async function getVirtualMachineSummary(
  namespace: string,
  name: string,
): Promise<VirtualMachineSummary> {
  const [vm, vmi] = await Promise.all([
    readVirtualMachine(namespace, name),
    readOptionalNamespaced<KubeVirtVirtualMachineInstance>(
      namespace,
      name,
      "virtualmachineinstances",
    ),
  ]);

  return toVmSummary(vm, vmi);
}

export async function listVirtualMachines(): Promise<VirtualMachineSummary[]> {
  ensureRollbackReaperStarted();
  ensureManualRuntimeReconcilerStarted();

  const [vmResponse, vmis] = await Promise.all([
    getCustomObjectsClient().listCustomObjectForAllNamespaces({
      group: KUBEVIRT_GROUP,
      version: KUBEVIRT_VERSION,
      plural: "virtualmachines",
    }),
    listVirtualMachineInstances(),
  ]);
  const vmiMap = toVmiMap(vmis);

  return items<KubeVirtVirtualMachine>(vmResponse)
    .filter(isManagedVirtualMachine)
    .map((vm) => {
      const namespace = vm.metadata?.namespace ?? "default";
      const name = vm.metadata?.name ?? "unknown";
      return toVmSummary(vm, vmiMap.get(objectKey(namespace, name)));
    })
    .sort(
      (left, right) =>
        left.namespace.localeCompare(right.namespace) || left.name.localeCompare(right.name),
    );
}

export async function listClusterNodeMetrics(): Promise<ClusterNodeLoad[]> {
  const [nodeResponse, nodeMetrics] = await Promise.all([
    getCoreV1Client().listNode({}),
    optionalList<KubeNodeMetrics>({
      group: "metrics.k8s.io",
      version: "v1beta1",
      plural: "nodes",
    }).catch(() => []),
  ]);
  const metricsMap = new Map(
    nodeMetrics
      .filter((metric) => metric.metadata?.name)
      .map((metric) => [metric.metadata?.name ?? "", metric]),
  );

  return items<KubeNode>(nodeResponse)
    .map((node) => toClusterNodeLoad(node, metricsMap.get(node.metadata?.name ?? "")))
    .filter((node): node is ClusterNodeLoad => Boolean(node))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export async function getVirtualMachine(
  namespace: string,
  name: string,
): Promise<VirtualMachineDetail> {
  ensureRollbackReaperStarted();
  ensureManualRuntimeReconcilerStarted();

  const [vm, vmi] = await Promise.all([
    readVirtualMachine(namespace, name),
    readOptionalNamespaced<KubeVirtVirtualMachineInstance>(
      namespace,
      name,
      "virtualmachineinstances",
    ),
  ]);
  const baseSummary = toVmSummary(vm, vmi);
  const guestUsersPromise = readGuestUsers(namespace, name, baseSummary.powerState);

  try {
    const root = await resolveRootDisk(vm);
    const [snapshots, backups, _backupVolumes, rollbacks, guestUsers] = await Promise.all([
      listLonghornSnapshots(),
      listLonghornBackups(),
      listLonghornBackupVolumes().catch(() => []),
      listRollbackPvs(namespace, name),
      guestUsersPromise,
    ]);

    return {
      ...toVmSummary(
        vm,
        vmi,
        [],
        [],
        root.summary.currentSize ?? root.summary.size,
        root.summary.desiredSize ?? root.summary.size,
        guestUsers.users,
        guestUsers.error,
      ),
      rootDisk: root.summary,
      snapshots: snapshotsForVolume(snapshots, root.summary.volumeName),
      backups: backupsForVm(backups, root.summary, namespace, name),
      rollbacks,
      restores: [],
    };
  } catch (error) {
    if (error instanceof ApiError) {
      const guestUsers = await guestUsersPromise;
      let protectionError = error.message;
      let rollbacks: VirtualMachineRollbackSummary[] = [];
      try {
        rollbacks = await listRollbackPvs(namespace, name);
      } catch (rollbackError) {
        const message =
          rollbackError instanceof Error
            ? rollbackError.message
            : "Unknown rollback inventory error.";
        console.error(`Failed to list rollbacks for ${namespace}/${name}`, rollbackError);
        protectionError = `${protectionError} Rollback inventory unavailable: ${message}`;
      }

      return {
        ...toVmSummary(vm, vmi, [], [], undefined, undefined, guestUsers.users, guestUsers.error),
        protectionError,
        snapshots: [],
        backups: [],
        rollbacks,
        restores: [],
      };
    }

    throw error;
  }
}

export async function performVirtualMachineAction(
  namespace: string,
  name: string,
  action: VmAction,
  options: VmActionOptions = {},
): Promise<VirtualMachineDetail> {
  const vm = await getVirtualMachineSummary(namespace, name);
  const validation = validateActionForVm(action, vm);
  if (!validation.ok) {
    throw new ApiError(409, validation.reason ?? "VM action is not allowed.");
  }

  if (options.timeoutDays !== undefined && action !== "start") {
    throw new ApiError(400, "Runtime timeout can only be set when starting a VM.");
  }

  if (action === "start" && vm.runStrategy === "Manual" && options.timeoutDays === undefined) {
    throw new ApiError(400, "Manual VM starts require a runtime timeout.");
  }

  if (action === "start" && vm.runStrategy !== "Manual" && options.timeoutDays !== undefined) {
    throw new ApiError(409, "Runtime timeout only applies to Manual VMs.");
  }

  if (options.timeoutDays !== undefined && !isAllowedManualRuntimeDays(options.timeoutDays)) {
    throw new ApiError(400, "Runtime timeout must be 1-7 days or 30 days.");
  }

  const encodedNamespace = encodeSegment(namespace);
  const encodedName = encodeSegment(name);
  const basePath = `/apis/${SUBRESOURCE_GROUP}/${KUBEVIRT_VERSION}/namespaces/${encodedNamespace}/virtualmachines/${encodedName}`;

  if (action === "start") {
    await requestKubeJson("PUT", `${basePath}/start`, {
      apiVersion: `${SUBRESOURCE_GROUP}/${KUBEVIRT_VERSION}`,
      kind: "StartOptions",
    });

    if (vm.runStrategy === "Manual") {
      const vmi = await waitForManualRuntimeVmi(namespace, name);
      await patchVirtualMachineManualRuntime(
        namespace,
        name,
        manualRuntimeAnnotationsForVmi(vmi, options.timeoutDays ?? 7),
      );
    }
  }

  if (action === "stop" || action === "force-stop") {
    await requestKubeJson("PUT", `${basePath}/stop`, {
      apiVersion: `${SUBRESOURCE_GROUP}/${KUBEVIRT_VERSION}`,
      kind: "StopOptions",
      ...(action === "force-stop" ? { gracePeriod: 0 } : {}),
    });

    if (vm.runStrategy === "Manual") {
      await patchVirtualMachineManualRuntime(namespace, name, clearManualRuntimeAnnotations());
    }
  }

  if (action === "reboot") {
    await requestKubeJson("PUT", `${basePath}/restart`, {
      apiVersion: `${SUBRESOURCE_GROUP}/${KUBEVIRT_VERSION}`,
      kind: "RestartOptions",
    });
  }

  return getVirtualMachine(namespace, name);
}

export async function resetVirtualMachineManualRuntimeTimeout(
  namespace: string,
  name: string,
  timeoutDays: ManualRuntimeDurationDays,
): Promise<VirtualMachineDetail> {
  if (!isAllowedManualRuntimeDays(timeoutDays)) {
    throw new ApiError(400, "Runtime timeout must be 1-7 days or 30 days.");
  }

  const [vm, vmi] = await Promise.all([
    readVirtualMachine(namespace, name),
    readOptionalNamespaced<KubeVirtVirtualMachineInstance>(
      namespace,
      name,
      "virtualmachineinstances",
    ),
  ]);
  const summary = toVmSummary(vm, vmi);

  if (summary.runStrategy !== "Manual") {
    throw new ApiError(409, "Runtime timeout only applies to Manual VMs.");
  }

  if (summary.powerState !== "online" || !vmi?.metadata?.uid || isTerminalVmi(vmi)) {
    throw new ApiError(409, "Only running Manual VMs can reset their runtime timeout.");
  }

  await patchVirtualMachineManualRuntime(
    namespace,
    name,
    manualRuntimeAnnotationsForVmi(vmi, timeoutDays, new Date().toISOString()),
  );

  return getVirtualMachine(namespace, name);
}

export async function listVirtualMachineSnapshots(
  namespace: string,
  name: string,
): Promise<VirtualMachineSnapshotSummary[]> {
  const vm = await readVirtualMachine(namespace, name);
  const root = await resolveRootDisk(vm);
  return snapshotsForVolume(await listLonghornSnapshots(), root.summary.volumeName);
}

export async function listVirtualMachineBackups(
  namespace: string,
  name: string,
): Promise<VirtualMachineBackupSummary[]> {
  const vm = await readVirtualMachine(namespace, name);
  const root = await resolveRootDisk(vm);
  return backupsForVm(await listLonghornBackups(), root.summary, namespace, name);
}

export async function listVirtualMachineRollbacks(
  namespace: string,
  name: string,
): Promise<VirtualMachineRollbackSummary[]> {
  await readVirtualMachine(namespace, name);
  return listRollbackPvs(namespace, name);
}

export async function createVirtualMachineSnapshot(
  namespace: string,
  vmName: string,
  snapshotName: string,
): Promise<VirtualMachineSnapshotSummary> {
  const name = snapshotNameSchema.parse(snapshotName);
  const vm = await readVirtualMachine(namespace, vmName);
  const summary = toVmSummary(
    vm,
    await readOptionalNamespaced<KubeVirtVirtualMachineInstance>(
      namespace,
      vmName,
      "virtualmachineinstances",
    ),
  );

  if (hasActiveOperation(summary)) {
    throw new ApiError(409, "A VM storage operation is already in progress.");
  }

  const root = await resolveRootDisk(vm);

  return withVmOperation(vm, "snapshot", name, "Creating Longhorn rootdisk snapshot.", async () => {
    let frozen = false;
    let attachedHere = false;

    try {
      if (summary.powerState === "online") {
        frozen = await freezeVmi(namespace, vmName);
      } else {
        attachedHere = await attachRootVolumeForMaintenance(root.summary.volumeName);
      }

      await createLonghornSnapshot(namespace, vmName, root.summary, name);
      return waitForSnapshotReady(name);
    } finally {
      if (frozen) {
        await unfreezeVmi(namespace, vmName).catch((error: unknown) => {
          console.error(`Failed to unfreeze ${namespace}/${vmName}`, error);
        });
      }

      await detachRootVolumeFromMaintenance(root.summary.volumeName, attachedHere);
    }
  });
}

export async function createVirtualMachineBackup(
  namespace: string,
  vmName: string,
  backupName: string,
  backupMode = "incremental",
): Promise<VirtualMachineBackupSummary> {
  const parsed = createBackupSchema.parse({ name: backupName, backupMode });
  const vm = await readVirtualMachine(namespace, vmName);
  const vmi = await readOptionalNamespaced<KubeVirtVirtualMachineInstance>(
    namespace,
    vmName,
    "virtualmachineinstances",
  );
  const summary = toVmSummary(vm, vmi);

  if (hasActiveOperation(summary)) {
    throw new ApiError(409, "A VM storage operation is already in progress.");
  }

  const root = await resolveRootDisk(vm);

  return withVmOperation(
    vm,
    "backup",
    parsed.name,
    "Creating Longhorn rootdisk backup.",
    async () => {
      let frozen = false;
      let attachedHere = false;
      const snapshotName = sanitizeLonghornName(`${parsed.name}-snapshot-${timestampSuffix()}`);

      try {
        if (summary.powerState === "online") {
          frozen = await freezeVmi(namespace, vmName);
        } else {
          attachedHere = await attachRootVolumeForMaintenance(root.summary.volumeName);
        }

        await createLonghornSnapshot(namespace, vmName, root.summary, snapshotName);
        await waitForSnapshotReady(snapshotName);
      } finally {
        if (frozen) {
          await unfreezeVmi(namespace, vmName).catch((error: unknown) => {
            console.error(`Failed to unfreeze ${namespace}/${vmName}`, error);
          });
        }

        await detachRootVolumeFromMaintenance(root.summary.volumeName, attachedHere);
      }

      await createLonghornBackup(
        namespace,
        vmName,
        root.summary,
        parsed.name,
        snapshotName,
        parsed.backupMode,
      );
      return waitForBackupComplete(parsed.name);
    },
  );
}

export async function restoreVirtualMachineSnapshot(
  namespace: string,
  vmName: string,
  snapshotName: string,
): Promise<VirtualMachineDetail> {
  const safeSnapshotName = snapshotNameSchema.parse(snapshotName);
  const vm = await readVirtualMachine(namespace, vmName);
  const detail = await getVirtualMachine(namespace, vmName);
  const snapshot = detail.snapshots.find((candidate) => candidate.name === safeSnapshotName);
  const validation = validateRestorePreconditions(detail, snapshot);

  if (!validation.ok) {
    throw new ApiError(409, validation.reason ?? "Snapshot restore is not allowed.");
  }

  const root = await resolveRootDisk(vm);

  await withVmOperation(
    vm,
    "restore",
    safeSnapshotName,
    "Restoring Longhorn rootdisk snapshot.",
    async () => {
      await waitForRestoreTargetVmiToDisappear(namespace, vmName);
      const attachedHere = await attachRootVolumeForMaintenance(root.summary.volumeName);

      try {
        await revertSnapshot(root.summary.volumeName, safeSnapshotName);
      } finally {
        await detachRootVolumeFromMaintenance(root.summary.volumeName, attachedHere);
      }

      await startVm(namespace, vmName);
    },
  );

  return getVirtualMachine(namespace, vmName);
}

async function createRestoredLonghornVolume(
  namespace: string,
  vmName: string,
  backup: KubeLonghornBackup,
  oldVolume: KubeLonghornVolume,
  root: Awaited<ReturnType<typeof resolveRootDisk>>,
) {
  const backupUrl = backup.status?.url;
  const volumeSize = backup.status?.volumeSize;
  if (!backupUrl || !volumeSize) {
    throw new ApiError(
      409,
      `Backup ${backup.metadata?.name ?? "unknown"} is missing restore data.`,
    );
  }

  const requestedVolumeName = restoreVolumeName(root.summary.volumeName);
  const metadata = metadataForVm(namespace, vmName, root.summary);
  const existingVolume = (await listLonghornVolumes())
    .filter((volume) => {
      const annotations = volume.metadata?.annotations ?? {};
      const matchesMetadata = Object.entries(metadata.annotations).every(
        ([key, value]) => annotations[key] === value,
      );

      return (
        matchesMetadata &&
        volume.spec?.fromBackup === backupUrl &&
        !volume.status?.kubernetesStatus?.pvName &&
        Boolean(volume.metadata?.name)
      );
    })
    .sort((left, right) =>
      compareTimestampsDesc(left.metadata?.creationTimestamp, right.metadata?.creationTimestamp),
    )[0];

  if (existingVolume?.metadata?.name) {
    return waitForLonghornVolume(
      existingVolume.metadata.name,
      (volume) => volume.status?.state === "detached" && volume.status.restoreRequired === false,
      "restored and detached",
    );
  }

  const createdVolume = (await getCustomObjectsClient().createNamespacedCustomObject({
    group: LONGHORN_GROUP,
    version: LONGHORN_VERSION,
    namespace: LONGHORN_NAMESPACE,
    plural: "volumes",
    body: {
      apiVersion: `${LONGHORN_GROUP}/${LONGHORN_VERSION}`,
      kind: "Volume",
      metadata: {
        name: requestedVolumeName,
        namespace: LONGHORN_NAMESPACE,
        labels: metadata.labels,
        annotations: metadata.annotations,
      },
      spec: {
        size: volumeSize,
        fromBackup: backupUrl,
        frontend: oldVolume.spec?.frontend || "blockdev",
        numberOfReplicas: oldVolume.spec?.numberOfReplicas,
        accessMode: oldVolume.spec?.accessMode,
        migratable: oldVolume.spec?.migratable,
        encrypted: oldVolume.spec?.encrypted,
        diskSelector: oldVolume.spec?.diskSelector,
        nodeSelector: oldVolume.spec?.nodeSelector,
        dataEngine: oldVolume.spec?.dataEngine || "v1",
        backupTargetName: oldVolume.spec?.backupTargetName,
      },
    },
  })) as KubeLonghornVolume;
  const volumeName = createdVolume.metadata?.name ?? requestedVolumeName;

  return waitForLonghornVolume(
    volumeName,
    (volume) => volume.status?.state === "detached" && volume.status.restoreRequired === false,
    "restored and detached",
  );
}

export async function restoreVirtualMachineBackup(
  namespace: string,
  vmName: string,
  backupName: string,
): Promise<VirtualMachineDetail> {
  const safeBackupName = snapshotNameSchema.parse(backupName);
  const vm = await readVirtualMachine(namespace, vmName);
  const detail = await getVirtualMachine(namespace, vmName);
  const backupSummary = detail.backups.find((candidate) => candidate.name === safeBackupName);
  const validation = validateBackupRestorePreconditions(detail, backupSummary);

  if (!validation.ok) {
    throw new ApiError(409, validation.reason ?? "Backup restore is not allowed.");
  }

  const root = await resolveRootDisk(vm);
  const backups = await listLonghornBackups();
  const backup = backups.find((candidate) => candidate.metadata?.name === safeBackupName);
  if (!backup) {
    throw new ApiError(404, `Backup ${safeBackupName} was not found.`);
  }

  await withVmOperation(
    vm,
    "restore",
    safeBackupName,
    "Restoring Longhorn rootdisk backup.",
    async () => {
      await waitForRestoreTargetVmiToDisappear(namespace, vmName);
      const restoredVolume = await createRestoredLonghornVolume(
        namespace,
        vmName,
        backup,
        root.volume,
        root,
      );
      const restoredVolumeName = restoredVolume.metadata?.name;
      if (!restoredVolumeName) {
        throw new ApiError(500, "Longhorn restored volume has no name.");
      }

      const rollback = rollbackMetadata(namespace, vmName, root.summary);
      await patchPersistentVolumeMergePatch({
        name: root.summary.pvName,
        body: {
          metadata: {
            labels: rollback.labels,
            annotations: rollback.annotations,
          },
          spec: {
            persistentVolumeReclaimPolicy: "Retain",
          },
        },
      });
      await patchNamespacedCustomObjectMergePatch({
        group: LONGHORN_GROUP,
        version: LONGHORN_VERSION,
        namespace: LONGHORN_NAMESPACE,
        plural: "volumes",
        name: root.summary.volumeName,
        body: {
          metadata: {
            labels: rollback.labels,
            annotations: rollback.annotations,
          },
        },
      });

      await getCoreV1Client().deleteNamespacedPersistentVolumeClaim({
        namespace,
        name: root.summary.pvcName,
        gracePeriodSeconds: 0,
        propagationPolicy: "Background",
        body: {
          apiVersion: "v1",
          kind: "DeleteOptions",
          gracePeriodSeconds: 0,
          propagationPolicy: "Background",
        },
      });
      await waitForPvcDeleted(namespace, root.summary.pvcName);

      const newPvName = sanitizeLonghornName(`${root.summary.pvName}-restore-${timestampSuffix()}`);
      await getCoreV1Client().createPersistentVolume({
        body: buildRestoredPv(root.pv, root.pvc, root.summary, newPvName, restoredVolumeName),
      });
      await getCoreV1Client().createNamespacedPersistentVolumeClaim({
        namespace,
        body: buildRestoredPvc(root.pvc, newPvName),
      });
      await waitForPvcBound(namespace, root.summary.pvcName);
      await startVm(namespace, vmName);
    },
  );

  return getVirtualMachine(namespace, vmName);
}

export async function listVirtualMachineRestores(): Promise<[]> {
  return [];
}

export async function createVirtualMachineRestore(
  namespace: string,
  vmName: string,
  snapshotName: string,
): Promise<VirtualMachineDetail> {
  return restoreVirtualMachineSnapshot(namespace, vmName, snapshotName);
}

export async function forceClearVirtualMachineOperation(namespace: string, name: string) {
  await readVirtualMachine(namespace, name);
  await patchVmOperation(namespace, name, null);
  return getVirtualMachine(namespace, name);
}

export async function discardVirtualMachineRollback(
  namespace: string,
  name: string,
  pvName: string,
) {
  await readVirtualMachine(namespace, name);
  await discardRollback(namespace, name, pvName);
  return getVirtualMachine(namespace, name);
}

export async function reapVirtualMachineRollbacks() {
  await reapExpiredRollbacks();
}
