import "server-only";

import { getCustomObjectsClient, requestKubeJson } from "./client";
import { ApiError, getErrorStatus } from "./errors";
import { isManagedVirtualMachine } from "./management";
import { objectKey, toRestoreSummary, toSnapshotSummary, toVmSummary } from "./status";
import type {
  KubeLonghornVolume,
  KubeObjectList,
  KubeStorageVolumeSnapshotContent,
  KubeVirtVirtualMachine,
  KubeVirtVirtualMachineInstance,
  KubeVirtVirtualMachineRestore,
  KubeVirtVirtualMachineSnapshot,
  KubeVirtVirtualMachineSnapshotContent,
  VirtualMachineDetail,
  VirtualMachineRestoreSummary,
  VirtualMachineSnapshotSummary,
  VirtualMachineSummary,
  VmAction,
} from "./types";
import {
  hasActiveRestore,
  snapshotNameSchema,
  validateActionForVm,
  validateRestorePreconditions,
} from "./validation";
import { getVmiPhase, isTerminalVmi } from "./vmi";

const KUBEVIRT_GROUP = "kubevirt.io";
const KUBEVIRT_VERSION = "v1";
const SNAPSHOT_GROUP = "snapshot.kubevirt.io";
const SNAPSHOT_VERSION = "v1beta1";
const STORAGE_SNAPSHOT_GROUP = "snapshot.storage.k8s.io";
const STORAGE_SNAPSHOT_VERSION = "v1";
const LONGHORN_GROUP = "longhorn.io";
const LONGHORN_VERSION = "v1beta2";
const LONGHORN_NAMESPACE = "longhorn-system";
const LONGHORN_CSI_DRIVER = "driver.longhorn.io";
const SUBRESOURCE_GROUP = "subresources.kubevirt.io";
const RESTORE_TARGET_WAIT_TIMEOUT_MS = 60_000;
const RESTORE_TARGET_WAIT_INTERVAL_MS = 1_000;

function items<T>(response: unknown): T[] {
  if (typeof response !== "object" || response === null) {
    return [];
  }

  return ((response as KubeObjectList<T>).items ?? []).filter(Boolean);
}

function isNotFound(error: unknown): boolean {
  return getErrorStatus(error) === 404;
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
      throw new ApiError(404, `Virtual machine ${namespace}/${name} is not managed by this app.`);
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

async function listSnapshots(namespace?: string): Promise<KubeVirtVirtualMachineSnapshot[]> {
  return optionalList<KubeVirtVirtualMachineSnapshot>({
    group: SNAPSHOT_GROUP,
    version: SNAPSHOT_VERSION,
    plural: "virtualmachinesnapshots",
    namespace,
  });
}

async function listSnapshotContents(
  namespace?: string,
): Promise<KubeVirtVirtualMachineSnapshotContent[]> {
  return optionalList<KubeVirtVirtualMachineSnapshotContent>({
    group: SNAPSHOT_GROUP,
    version: SNAPSHOT_VERSION,
    plural: "virtualmachinesnapshotcontents",
    namespace,
  });
}

async function listRestores(namespace?: string): Promise<KubeVirtVirtualMachineRestore[]> {
  return optionalList<KubeVirtVirtualMachineRestore>({
    group: SNAPSHOT_GROUP,
    version: SNAPSHOT_VERSION,
    plural: "virtualmachinerestores",
    namespace,
  });
}

async function listVolumeSnapshotContents(): Promise<KubeStorageVolumeSnapshotContent[]> {
  return optionalList<KubeStorageVolumeSnapshotContent>({
    group: STORAGE_SNAPSHOT_GROUP,
    version: STORAGE_SNAPSHOT_VERSION,
    plural: "volumesnapshotcontents",
  });
}

async function listLonghornVolumes(): Promise<KubeLonghornVolume[]> {
  return optionalList<KubeLonghornVolume>({
    group: LONGHORN_GROUP,
    version: LONGHORN_VERSION,
    namespace: LONGHORN_NAMESPACE,
    plural: "volumes",
  });
}

function toVmiMap(vmis: KubeVirtVirtualMachineInstance[]) {
  return new Map(
    vmis
      .filter((vmi) => vmi.metadata?.namespace && vmi.metadata.name)
      .map((vmi) => [objectKey(vmi.metadata?.namespace ?? "", vmi.metadata?.name ?? ""), vmi]),
  );
}

function volumeSnapshotContentKey(namespace: string | undefined, name: string | undefined) {
  return namespace && name ? objectKey(namespace, name) : undefined;
}

function snapshotStorageRestoreBlockers(
  namespace: string,
  snapshotContents: KubeVirtVirtualMachineSnapshotContent[],
  volumeSnapshotContents: KubeStorageVolumeSnapshotContent[],
  longhornVolumes: KubeLonghornVolume[],
) {
  const longhornVolumeNames = new Set<string>();
  for (const volume of longhornVolumes) {
    if (volume.metadata?.name) {
      longhornVolumeNames.add(volume.metadata.name);
    }
  }

  if (longhornVolumeNames.size === 0 || volumeSnapshotContents.length === 0) {
    return new Map<string, string>();
  }

  const volumeSnapshotContentEntries: Array<readonly [string, KubeStorageVolumeSnapshotContent]> =
    [];
  for (const content of volumeSnapshotContents) {
    const key = volumeSnapshotContentKey(
      content.spec?.volumeSnapshotRef?.namespace,
      content.spec?.volumeSnapshotRef?.name,
    );
    if (key) {
      volumeSnapshotContentEntries.push([key, content]);
    }
  }
  const volumeSnapshotContentByRef = new Map(volumeSnapshotContentEntries);
  const blockers = new Map<string, string>();

  for (const content of snapshotContents) {
    const snapshotName = content.spec?.virtualMachineSnapshotName;
    if (!snapshotName || blockers.has(snapshotName)) {
      continue;
    }

    for (const backup of content.spec?.volumeBackups ?? []) {
      const volumeSnapshotContent = volumeSnapshotContentByRef.get(
        objectKey(namespace, backup.volumeSnapshotName ?? ""),
      );
      if (volumeSnapshotContent?.spec?.driver !== LONGHORN_CSI_DRIVER) {
        continue;
      }

      const sourceVolume = volumeSnapshotContent.spec.source?.volumeHandle;
      if (!sourceVolume || longhornVolumeNames.has(sourceVolume)) {
        continue;
      }

      const volumeName = backup.volumeName ?? backup.persistentVolumeClaim?.metadata?.name;
      blockers.set(
        snapshotName,
        `The underlying Longhorn volume for ${volumeName ?? "one snapshot disk"} is missing, so this snapshot cannot be restored.`,
      );
      break;
    }
  }

  return blockers;
}

function filterRestorableSnapshotSummaries(
  snapshots: VirtualMachineSnapshotSummary[],
  blockers: Map<string, string>,
): VirtualMachineSnapshotSummary[] {
  return snapshots.filter((snapshot) => !blockers.has(snapshot.name));
}

function filterSnapshotSummariesForVm(
  snapshots: KubeVirtVirtualMachineSnapshot[],
  vmName: string,
): VirtualMachineSnapshotSummary[] {
  return snapshots
    .map(toSnapshotSummary)
    .filter((snapshot) => snapshot.sourceName === vmName)
    .sort((left, right) => (right.createdAt ?? "").localeCompare(left.createdAt ?? ""));
}

function filterRestoreSummariesForVm(
  restores: KubeVirtVirtualMachineRestore[],
  vmName: string,
): VirtualMachineRestoreSummary[] {
  return restores
    .map(toRestoreSummary)
    .filter((restore) => restore.targetName === vmName)
    .sort((left, right) => (right.createdAt ?? "").localeCompare(left.createdAt ?? ""));
}

function buildRestoreName(vmName: string) {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14)
    .toLowerCase();
  const suffix = `-restore-${stamp}`;
  return `${vmName.slice(0, 253 - suffix.length)}${suffix}`;
}

function encodeSegment(value: string) {
  return encodeURIComponent(value);
}

function sleep(milliseconds: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
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

    if (isTerminalVmi(vmi)) {
      if (!deletedTerminalVmi) {
        await deleteTerminalVmi(namespace, name);
        deletedTerminalVmi = true;
      }
    }

    await sleep(RESTORE_TARGET_WAIT_INTERVAL_MS);
  }

  throw new ApiError(
    409,
    `The VM is stopped, but Kubernetes still reports an existing instance${lastPhase ? ` in ${lastPhase} phase` : ""}. Try restoring again in a moment.`,
  );
}

async function getVirtualMachineSummary(
  namespace: string,
  name: string,
): Promise<VirtualMachineSummary> {
  const [vm, vmi, snapshots, restores] = await Promise.all([
    readVirtualMachine(namespace, name),
    readOptionalNamespaced<KubeVirtVirtualMachineInstance>(
      namespace,
      name,
      "virtualmachineinstances",
    ),
    listSnapshots(namespace),
    listRestores(namespace),
  ]);

  return toVmSummary(vm, vmi, snapshots, restores);
}

export async function listVirtualMachines(): Promise<VirtualMachineSummary[]> {
  const [vmResponse, vmis, snapshots, restores] = await Promise.all([
    getCustomObjectsClient().listCustomObjectForAllNamespaces({
      group: KUBEVIRT_GROUP,
      version: KUBEVIRT_VERSION,
      plural: "virtualmachines",
    }),
    listVirtualMachineInstances(),
    listSnapshots(),
    listRestores(),
  ]);
  const vmiMap = toVmiMap(vmis);

  return items<KubeVirtVirtualMachine>(vmResponse)
    .filter(isManagedVirtualMachine)
    .map((vm) => {
      const namespace = vm.metadata?.namespace ?? "default";
      const name = vm.metadata?.name ?? "unknown";
      return toVmSummary(vm, vmiMap.get(objectKey(namespace, name)), snapshots, restores);
    })
    .sort(
      (left, right) =>
        left.namespace.localeCompare(right.namespace) || left.name.localeCompare(right.name),
    );
}

export async function getVirtualMachine(
  namespace: string,
  name: string,
): Promise<VirtualMachineDetail> {
  const [vm, vmi, snapshots, restores] = await Promise.all([
    readVirtualMachine(namespace, name),
    readOptionalNamespaced<KubeVirtVirtualMachineInstance>(
      namespace,
      name,
      "virtualmachineinstances",
    ),
    listSnapshots(namespace),
    listRestores(namespace),
  ]);
  const summary = toVmSummary(vm, vmi, snapshots, restores);
  let snapshotRestoreBlockers = new Map<string, string>();

  if (!hasActiveRestore(summary)) {
    const [snapshotContents, volumeSnapshotContents, longhornVolumes] = await Promise.all([
      listSnapshotContents(namespace),
      listVolumeSnapshotContents(),
      listLonghornVolumes(),
    ]);
    snapshotRestoreBlockers = snapshotStorageRestoreBlockers(
      namespace,
      snapshotContents,
      volumeSnapshotContents,
      longhornVolumes,
    );
  }

  return {
    ...summary,
    snapshots: filterRestorableSnapshotSummaries(
      filterSnapshotSummariesForVm(snapshots, name),
      snapshotRestoreBlockers,
    ),
    restores: filterRestoreSummariesForVm(restores, name),
  };
}

export async function performVirtualMachineAction(
  namespace: string,
  name: string,
  action: VmAction,
): Promise<VirtualMachineDetail> {
  const vm = await getVirtualMachineSummary(namespace, name);
  const validation = validateActionForVm(action, vm);
  if (!validation.ok) {
    throw new ApiError(409, validation.reason ?? "VM action is not allowed.");
  }

  const encodedNamespace = encodeSegment(namespace);
  const encodedName = encodeSegment(name);
  const basePath = `/apis/${SUBRESOURCE_GROUP}/${KUBEVIRT_VERSION}/namespaces/${encodedNamespace}/virtualmachines/${encodedName}`;

  if (action === "start") {
    await requestKubeJson("PUT", `${basePath}/start`, {
      apiVersion: `${SUBRESOURCE_GROUP}/${KUBEVIRT_VERSION}`,
      kind: "StartOptions",
    });
  }

  if (action === "stop" || action === "force-stop") {
    await requestKubeJson("PUT", `${basePath}/stop`, {
      apiVersion: `${SUBRESOURCE_GROUP}/${KUBEVIRT_VERSION}`,
      kind: "StopOptions",
      ...(action === "force-stop" ? { gracePeriod: 0 } : {}),
    });
  }

  if (action === "reboot") {
    await requestKubeJson("PUT", `${basePath}/restart`, {
      apiVersion: `${SUBRESOURCE_GROUP}/${KUBEVIRT_VERSION}`,
      kind: "RestartOptions",
    });
  }

  return getVirtualMachine(namespace, name);
}

export async function listVirtualMachineSnapshots(
  namespace: string,
  name: string,
): Promise<VirtualMachineSnapshotSummary[]> {
  return filterSnapshotSummariesForVm(await listSnapshots(namespace), name);
}

export async function createVirtualMachineSnapshot(
  namespace: string,
  vmName: string,
  snapshotName: string,
): Promise<VirtualMachineSnapshotSummary> {
  const name = snapshotNameSchema.parse(snapshotName);
  const vm = await getVirtualMachineSummary(namespace, vmName);
  if (hasActiveRestore(vm)) {
    throw new ApiError(
      409,
      "A restore is in progress. Wait until it finishes before creating a snapshot.",
    );
  }

  const response = (await getCustomObjectsClient().createNamespacedCustomObject({
    group: SNAPSHOT_GROUP,
    version: SNAPSHOT_VERSION,
    namespace,
    plural: "virtualmachinesnapshots",
    body: {
      apiVersion: `${SNAPSHOT_GROUP}/${SNAPSHOT_VERSION}`,
      kind: "VirtualMachineSnapshot",
      metadata: {
        name,
        namespace,
      },
      spec: {
        source: {
          apiGroup: KUBEVIRT_GROUP,
          kind: "VirtualMachine",
          name: vmName,
        },
      },
    },
  })) as KubeVirtVirtualMachineSnapshot;

  return toSnapshotSummary(response);
}

export async function listVirtualMachineRestores(
  namespace: string,
  name: string,
): Promise<VirtualMachineRestoreSummary[]> {
  return filterRestoreSummariesForVm(await listRestores(namespace), name);
}

export async function createVirtualMachineRestore(
  namespace: string,
  vmName: string,
  snapshotName: string,
  requestedRestoreName?: string,
): Promise<VirtualMachineRestoreSummary> {
  const safeSnapshotName = snapshotNameSchema.parse(snapshotName);
  const safeRestoreName = snapshotNameSchema.parse(
    requestedRestoreName ?? buildRestoreName(vmName),
  );
  const detail = await getVirtualMachine(namespace, vmName);
  const snapshot = detail.snapshots.find((candidate) => candidate.name === safeSnapshotName);
  const validation = validateRestorePreconditions(detail, snapshot);

  if (!validation.ok) {
    throw new ApiError(409, validation.reason ?? "Snapshot restore is not allowed.");
  }

  await waitForRestoreTargetVmiToDisappear(namespace, vmName);

  const response = (await getCustomObjectsClient().createNamespacedCustomObject({
    group: SNAPSHOT_GROUP,
    version: SNAPSHOT_VERSION,
    namespace,
    plural: "virtualmachinerestores",
    body: {
      apiVersion: `${SNAPSHOT_GROUP}/${SNAPSHOT_VERSION}`,
      kind: "VirtualMachineRestore",
      metadata: {
        name: safeRestoreName,
        namespace,
      },
      spec: {
        target: {
          apiGroup: KUBEVIRT_GROUP,
          kind: "VirtualMachine",
          name: vmName,
        },
        virtualMachineSnapshotName: safeSnapshotName,
      },
    },
  })) as KubeVirtVirtualMachineRestore;

  return toRestoreSummary(response);
}
