import {
  VM_MANAGER_OPERATION_MESSAGE_KEY,
  VM_MANAGER_OPERATION_NAME_KEY,
  VM_MANAGER_OPERATION_PHASE_KEY,
  VM_MANAGER_OPERATION_STARTED_AT_KEY,
  VM_MANAGER_OPERATION_TYPE_KEY,
} from "./management";
import { parseManualRuntimeAnnotations } from "./manual-runtime";
import {
  formatByteQuantity,
  formatCpuQuantity,
  parseByteQuantity,
  parseCpuQuantity,
  resourcePercent,
} from "./quantity";
import { compareTimestampsDesc, firstTimestamp } from "./timestamps";
import type {
  ClusterNodeLoad,
  ClusterResourceLoad,
  KubeCondition,
  KubeNode,
  KubeNodeMetrics,
  KubeResourceRequirements,
  KubeVirtDomainSpec,
  KubeVirtGuestUser,
  KubeVirtVirtualMachine,
  KubeVirtVirtualMachineInstance,
  KubeVirtVirtualMachineRestore,
  KubeVirtVirtualMachineSnapshot,
  VirtualMachineGuestSession,
  VirtualMachineRdpSignal,
  VirtualMachineResourceProfile,
  VirtualMachineResourceSettings,
  VirtualMachineRestoreSummary,
  VirtualMachineSnapshotSummary,
  VirtualMachineSummary,
  VmOperation,
  VmPowerState,
} from "./types";
import { isTerminalVmi } from "./vmi";

function compact<T>(values: Array<T | null | undefined>): T[] {
  return values.filter((value): value is T => value !== null && value !== undefined);
}

interface ComparableResourceProfile extends VirtualMachineResourceProfile {
  cpuComparable?: number | string;
  memoryComparable?: number | string;
  diskComparable?: number | string;
}

export function objectKey(namespace: string, name: string) {
  return `${namespace}/${name}`;
}

export function normalizePowerState(
  vm: KubeVirtVirtualMachine,
  vmi?: KubeVirtVirtualMachineInstance,
): VmPowerState {
  const printable = vm.status?.printableStatus?.toLowerCase() ?? "";

  if (["running", "migrating"].some((status) => printable.includes(status))) {
    return "online";
  }

  if (["stopped", "off", "halted"].some((status) => printable.includes(status))) {
    return "offline";
  }

  if (isTerminalVmi(vmi)) {
    return "offline";
  }

  if (
    ["starting", "stopping", "terminating", "provisioning", "paused", "waiting"].some((status) =>
      printable.includes(status),
    )
  ) {
    return "transitioning";
  }

  if (vm.status?.created || vmi) {
    return "online";
  }

  if (vm.spec?.running === false || vm.spec?.runStrategy === "Halted") {
    return "offline";
  }

  if (vm.spec?.running === true) {
    return "transitioning";
  }

  return "unknown";
}

export function getVmReady(vm: KubeVirtVirtualMachine): boolean | null {
  if (typeof vm.status?.ready === "boolean") {
    return vm.status.ready;
  }

  const readyCondition = vm.status?.conditions?.find((condition) => condition.type === "Ready");
  if (!readyCondition) {
    return null;
  }

  return readyCondition.status === "True";
}

export function getRunStrategy(vm: KubeVirtVirtualMachine): string {
  if (vm.spec?.runStrategy) {
    return vm.spec.runStrategy;
  }

  if (vm.status?.runStrategy) {
    return vm.status.runStrategy;
  }

  if (vm.spec?.running === true) {
    return "Always";
  }

  if (vm.spec?.running === false) {
    return "Halted";
  }

  return "Unset";
}

export function getPrintableStatus(vm: KubeVirtVirtualMachine, powerState: VmPowerState): string {
  if (vm.status?.printableStatus) {
    return vm.status.printableStatus;
  }

  if (powerState === "online") {
    return "Running";
  }

  if (powerState === "offline") {
    return "Stopped";
  }

  if (powerState === "transitioning") {
    return "Changing";
  }

  return "Unknown";
}

export function getIpAddresses(vmi?: KubeVirtVirtualMachineInstance): string[] {
  const ips = vmi?.status?.interfaces?.flatMap((networkInterface) =>
    compact([networkInterface.ipAddress, ...(networkInterface.ipAddresses ?? [])]),
  );

  return Array.from(new Set(ips ?? [])).sort();
}

function cpuCount(domain?: KubeVirtDomainSpec): number | undefined {
  const cpu = domain?.cpu;
  if (!cpu) {
    return undefined;
  }

  const sockets = cpu.sockets ?? 1;
  const cores = cpu.cores ?? 1;
  const threads = cpu.threads ?? 1;
  const count = sockets * cores * threads;
  return Number.isFinite(count) && count > 0 ? count : undefined;
}

function resourceValue(
  resources: KubeResourceRequirements | undefined,
  key: string,
): string | number | undefined {
  return resources?.requests?.[key] ?? resources?.limits?.[key];
}

function comparableQuantity(
  formatted: string | undefined,
  parsed: number | undefined,
): number | string | undefined {
  return parsed ?? formatted;
}

function vmResourceProfile(
  domain: KubeVirtDomainSpec | undefined,
  diskSize?: string,
): ComparableResourceProfile {
  const vcpus = cpuCount(domain);
  const cpuQuantity = resourceValue(domain?.resources, "cpu");
  const memoryQuantity = domain?.memory?.guest ?? resourceValue(domain?.resources, "memory");
  const diskBytes = parseByteQuantity(diskSize);
  const cpuLabel = vcpus
    ? `${vcpus} vCPU${vcpus === 1 ? "" : "s"}`
    : formatCpuQuantity(cpuQuantity);
  const memoryLabel = formatByteQuantity(memoryQuantity);
  const diskLabel = formatByteQuantity(diskSize);

  return {
    cpu: cpuLabel,
    cpuComparable: vcpus ?? comparableQuantity(cpuLabel, parseCpuQuantity(cpuQuantity)),
    memory: memoryLabel,
    memoryComparable: comparableQuantity(memoryLabel, parseByteQuantity(memoryQuantity)),
    disk: diskLabel,
    diskComparable: comparableQuantity(diskLabel, diskBytes),
  };
}

function profileForDisplay(profile: ComparableResourceProfile): VirtualMachineResourceProfile {
  return {
    cpu: profile.cpu,
    memory: profile.memory,
    disk: profile.disk,
  };
}

function resourcesDiffer(
  current: ComparableResourceProfile,
  desired: ComparableResourceProfile,
): boolean {
  return (
    current.cpuComparable !== desired.cpuComparable ||
    current.memoryComparable !== desired.memoryComparable ||
    current.diskComparable !== desired.diskComparable
  );
}

export function getVmResourceSettings(
  vm: KubeVirtVirtualMachine,
  vmi?: KubeVirtVirtualMachineInstance,
  currentRootDiskSize?: string,
  desiredRootDiskSize = currentRootDiskSize,
): VirtualMachineResourceSettings {
  const desired = vmResourceProfile(vm.spec?.template?.spec?.domain, desiredRootDiskSize);
  const current = vmi?.spec?.domain
    ? vmResourceProfile(vmi.spec.domain, currentRootDiskSize)
    : vmResourceProfile(vm.spec?.template?.spec?.domain, currentRootDiskSize);

  return {
    current: profileForDisplay(current),
    desired: profileForDisplay(desired),
    pendingRestart: resourcesDiffer(current, desired),
  };
}

export function toRdpSignal(
  powerState: VmPowerState,
  users?: KubeVirtGuestUser[],
  unavailableMessage?: string,
): VirtualMachineRdpSignal {
  if (powerState !== "online") {
    return { status: "offline", sessions: [] };
  }

  if (!users) {
    return { status: "unavailable", sessions: [], message: unavailableMessage };
  }

  const sessions = users
    .map((user): VirtualMachineGuestSession | undefined => {
      const userName = user.userName?.trim();
      if (!userName) {
        return undefined;
      }

      return {
        userName,
        domain: user.domain,
        loginTime:
          typeof user.loginTime === "number"
            ? new Date(user.loginTime * 1000).toISOString()
            : undefined,
      };
    })
    .filter((session): session is VirtualMachineGuestSession => Boolean(session));

  return {
    status: sessions.length > 0 ? "active" : "inactive",
    sessions,
  };
}

function nodeRoles(labels: Record<string, string> | undefined): string[] {
  const roles = Object.keys(labels ?? {})
    .map((key) => key.match(/^node-role\.kubernetes\.io\/(.+)$/)?.[1])
    .filter((role): role is string => Boolean(role));

  return roles.length > 0 ? roles.sort() : ["worker"];
}

function nodeReady(node: KubeNode): boolean | null {
  const condition = node.status?.conditions?.find((candidate) => candidate.type === "Ready");
  if (!condition) {
    return null;
  }

  return condition.status === "True";
}

function resourceLoad({
  used,
  capacity,
  parse,
  format,
}: {
  used?: string;
  capacity?: string;
  parse: (value?: string) => number | undefined;
  format: (value?: string | number) => string | undefined;
}): ClusterResourceLoad {
  const parsedUsed = parse(used);
  const parsedCapacity = parse(capacity);

  return {
    used: format(used),
    capacity: format(capacity),
    percent: resourcePercent(parsedUsed, parsedCapacity),
  };
}

export function toClusterNodeLoad(
  node: KubeNode,
  metrics?: KubeNodeMetrics,
): ClusterNodeLoad | undefined {
  const name = node.metadata?.name;
  if (!name) {
    return undefined;
  }

  const allocatable = node.status?.allocatable ?? {};
  const capacity = node.status?.capacity ?? {};
  const usage = metrics?.usage ?? {};

  return {
    name,
    roles: nodeRoles(node.metadata?.labels),
    ready: nodeReady(node),
    cpu: resourceLoad({
      used: usage.cpu,
      capacity: allocatable.cpu ?? capacity.cpu,
      parse: parseCpuQuantity,
      format: formatCpuQuantity,
    }),
    memory: resourceLoad({
      used: usage.memory,
      capacity: allocatable.memory ?? capacity.memory,
      parse: parseByteQuantity,
      format: formatByteQuantity,
    }),
    storage: resourceLoad({
      used: usage["ephemeral-storage"],
      capacity: allocatable["ephemeral-storage"] ?? capacity["ephemeral-storage"],
      parse: parseByteQuantity,
      format: formatByteQuantity,
    }),
    updatedAt: metrics?.timestamp,
  };
}

function latestConditionMessage(conditions: KubeCondition[] | undefined): string | undefined {
  return conditions?.find((condition) => condition.message)?.message;
}

function conditionText(condition: KubeCondition | undefined): string | undefined {
  return condition?.message ?? condition?.reason;
}

function snapshotMessage(snapshot: KubeVirtVirtualMachineSnapshot): string | undefined {
  return (
    snapshot.status?.error?.message ??
    snapshot.status?.error?.reason ??
    latestConditionMessage(snapshot.status?.conditions)
  );
}

function restoreMessage(restore: KubeVirtVirtualMachineRestore): string | undefined {
  const conditions = restore.status?.conditions;
  const failedCondition = conditions?.find(
    (condition) => condition.type === "Failure" && condition.status === "True",
  );
  const blockingReadyCondition = conditions?.find(
    (condition) => condition.type === "Ready" && condition.status === "False",
  );

  return (
    conditionText(failedCondition) ??
    conditionText(blockingReadyCondition) ??
    latestConditionMessage(conditions)
  );
}

function snapshotMatchesVm(snapshot: KubeVirtVirtualMachineSnapshot, vmName: string) {
  return snapshot.spec?.source?.kind === "VirtualMachine" && snapshot.spec.source.name === vmName;
}

function restoreMatchesVm(restore: KubeVirtVirtualMachineRestore, vmName: string) {
  return restore.spec?.target?.kind === "VirtualMachine" && restore.spec.target.name === vmName;
}

const operationTypes = new Set<VmOperation["type"]>([
  "snapshot",
  "backup",
  "restore",
  "cleanup",
  "restore-recovery",
]);

function activeOperationFromAnnotations(
  annotations: Record<string, string> | undefined,
): VmOperation | undefined {
  const type = annotations?.[VM_MANAGER_OPERATION_TYPE_KEY];
  if (!type || !operationTypes.has(type as VmOperation["type"])) {
    return undefined;
  }

  return {
    type: type as VmOperation["type"],
    name: annotations?.[VM_MANAGER_OPERATION_NAME_KEY] ?? type,
    phase: annotations?.[VM_MANAGER_OPERATION_PHASE_KEY] ?? "Running",
    createdAt: annotations?.[VM_MANAGER_OPERATION_STARTED_AT_KEY],
    message: annotations?.[VM_MANAGER_OPERATION_MESSAGE_KEY],
  };
}

function restoredPersistentVolumeClaims(restore: KubeVirtVirtualMachineRestore): Set<string> {
  return new Set(
    (restore.status?.restores ?? [])
      .map((volumeRestore) => volumeRestore.persistentVolumeClaim)
      .filter((name): name is string => Boolean(name)),
  );
}

function vmPersistentVolumeClaims(vm: KubeVirtVirtualMachine): Set<string> {
  return new Set(
    (vm.spec?.template?.spec?.volumes ?? [])
      .map((volume) => volume.persistentVolumeClaim?.claimName)
      .filter((claimName): claimName is string => Boolean(claimName)),
  );
}

function vmiPersistentVolumeClaims(vmi: KubeVirtVirtualMachineInstance | undefined): Set<string> {
  return new Set(
    (vmi?.status?.volumeStatus ?? [])
      .map((volume) => volume.persistentVolumeClaimInfo?.claimName)
      .filter((claimName): claimName is string => Boolean(claimName)),
  );
}

function setsIntersect(left: Set<string>, right: Set<string>) {
  for (const value of left) {
    if (right.has(value)) {
      return true;
    }
  }

  return false;
}

function latestCompletedRestoreForVm(
  vmName: string,
  restores: KubeVirtVirtualMachineRestore[],
): KubeVirtVirtualMachineRestore | undefined {
  return restores
    .filter((restore) => restoreMatchesVm(restore, vmName))
    .filter((restore) => restore.status?.complete === true)
    .sort((left, right) =>
      compareTimestampsDesc(
        firstTimestamp(left.status?.restoreTime, left.metadata?.creationTimestamp),
        firstTimestamp(right.status?.restoreTime, right.metadata?.creationTimestamp),
      ),
    )[0];
}

function isStartingAfterRestore(
  vm: KubeVirtVirtualMachine,
  vmi: KubeVirtVirtualMachineInstance | undefined,
) {
  const printableStatus = vm.status?.printableStatus?.toLowerCase() ?? "";
  const vmiPhase = vmi?.status?.phase?.toLowerCase();

  return (
    ["starting", "provisioning", "waiting"].some((status) => printableStatus.includes(status)) ||
    (vmiPhase !== undefined && vmiPhase !== "running" && vmiPhase !== "succeeded")
  );
}

function restoreRecoveryOperation(
  vm: KubeVirtVirtualMachine,
  vmi: KubeVirtVirtualMachineInstance | undefined,
  restores: KubeVirtVirtualMachineRestore[],
): VmOperation | undefined {
  const vmName = vm.metadata?.name ?? "unknown";
  const latestRestore = latestCompletedRestoreForVm(vmName, restores);
  if (!latestRestore) {
    return undefined;
  }

  const restoredPvcs = restoredPersistentVolumeClaims(latestRestore);
  if (restoredPvcs.size === 0) {
    return undefined;
  }

  const currentVmPvcs = vmPersistentVolumeClaims(vm);
  const currentVmiPvcs = vmiPersistentVolumeClaims(vmi);
  if (!setsIntersect(restoredPvcs, currentVmPvcs) && !setsIntersect(restoredPvcs, currentVmiPvcs)) {
    return undefined;
  }

  const restoreSummary = toRestoreSummary(latestRestore);
  if (vmi?.status?.phase?.toLowerCase() === "failed") {
    return {
      type: "restore-recovery",
      name: restoreSummary.name,
      phase: "Startup failed",
      createdAt: restoreSummary.createdAt,
      message: "Restore completed, but the restored VM failed while attaching or starting.",
      snapshotName: restoreSummary.snapshotName,
    };
  }

  if (isStartingAfterRestore(vm, vmi)) {
    return {
      type: "restore-recovery",
      name: restoreSummary.name,
      phase: "Starting",
      createdAt: restoreSummary.createdAt,
      message: "Restore completed. Waiting for the restored VM to attach volumes and become ready.",
      snapshotName: restoreSummary.snapshotName,
    };
  }

  if (vmi && vm.status?.ready !== true) {
    return {
      type: "restore-recovery",
      name: restoreSummary.name,
      phase: "Not ready",
      createdAt: restoreSummary.createdAt,
      message: "Restore completed. Waiting for the restored VM to report ready.",
      snapshotName: restoreSummary.snapshotName,
    };
  }

  return undefined;
}

export function toSnapshotSummary(
  snapshot: KubeVirtVirtualMachineSnapshot,
): VirtualMachineSnapshotSummary {
  const name = snapshot.metadata?.name ?? "unknown";
  const namespace = snapshot.metadata?.namespace ?? "default";
  const readyToUse =
    typeof snapshot.status?.readyToUse === "boolean" ? snapshot.status.readyToUse : null;
  const phase = snapshot.status?.phase ?? (readyToUse ? "Ready" : "Pending");

  return {
    name,
    namespace,
    createdAt: firstTimestamp(snapshot.status?.creationTime, snapshot.metadata?.creationTimestamp),
    sourceName: snapshot.spec?.source?.name,
    readyToUse,
    phase,
    message: snapshotMessage(snapshot),
    conditions: snapshot.status?.conditions ?? [],
  };
}

export function toRestoreSummary(
  restore: KubeVirtVirtualMachineRestore,
): VirtualMachineRestoreSummary {
  const name = restore.metadata?.name ?? "unknown";
  const namespace = restore.metadata?.namespace ?? "default";
  const complete = typeof restore.status?.complete === "boolean" ? restore.status.complete : null;
  const failed = restore.status?.conditions?.some(
    (condition) => condition.type === "Failure" && condition.status === "True",
  );
  const phase = failed ? "Failed" : complete ? "Complete" : "Running";

  return {
    name,
    namespace,
    createdAt: firstTimestamp(restore.status?.restoreTime, restore.metadata?.creationTimestamp),
    targetName: restore.spec?.target?.name,
    snapshotName: restore.spec?.virtualMachineSnapshotName,
    complete,
    phase,
    message: restoreMessage(restore),
    conditions: restore.status?.conditions ?? [],
  };
}

export function getActiveOperations(
  vm: KubeVirtVirtualMachine,
  vmi: KubeVirtVirtualMachineInstance | undefined,
  snapshots: KubeVirtVirtualMachineSnapshot[],
  restores: KubeVirtVirtualMachineRestore[],
): VmOperation[] {
  const annotationOperation = activeOperationFromAnnotations(vm.metadata?.annotations);
  if (annotationOperation) {
    return [annotationOperation];
  }

  const vmName = vm.metadata?.name ?? "unknown";
  const activeSnapshots = snapshots
    .filter((snapshot) => snapshotMatchesVm(snapshot, vmName))
    .filter((snapshot) => snapshot.status?.readyToUse !== true)
    .map((snapshot) => {
      const summary = toSnapshotSummary(snapshot);
      return {
        type: "snapshot" as const,
        name: summary.name,
        phase: summary.phase,
        createdAt: summary.createdAt,
        message: summary.message,
      };
    });

  const activeRestores = restores
    .filter((restore) => restoreMatchesVm(restore, vmName))
    .filter((restore) => restore.status?.complete !== true)
    .map((restore) => {
      const summary = toRestoreSummary(restore);
      return {
        type: "restore" as const,
        name: summary.name,
        phase: summary.phase,
        createdAt: summary.createdAt,
        message: summary.message,
        snapshotName: summary.snapshotName,
      };
    });

  const recoveryOperation = restoreRecoveryOperation(vm, vmi, restores);

  return [
    ...activeSnapshots,
    ...activeRestores,
    ...(recoveryOperation ? [recoveryOperation] : []),
  ].sort((left, right) => compareTimestampsDesc(left.createdAt, right.createdAt));
}

export function toVmSummary(
  vm: KubeVirtVirtualMachine,
  vmi?: KubeVirtVirtualMachineInstance,
  snapshots: KubeVirtVirtualMachineSnapshot[] = [],
  restores: KubeVirtVirtualMachineRestore[] = [],
  rootDiskCurrentSize?: string,
  rootDiskDesiredSize?: string,
  guestUsers?: KubeVirtGuestUser[],
  guestUserError?: string,
): VirtualMachineSummary {
  const name = vm.metadata?.name ?? "unknown";
  const namespace = vm.metadata?.namespace ?? "default";
  const powerState = normalizePowerState(vm, vmi);
  const runStrategy = getRunStrategy(vm);
  const runningSince =
    vmi && !isTerminalVmi(vmi) ? firstTimestamp(vmi.metadata?.creationTimestamp) : undefined;

  return {
    id: objectKey(namespace, name),
    uid: vm.metadata?.uid,
    name,
    namespace,
    createdAt: firstTimestamp(vm.metadata?.creationTimestamp),
    powerState,
    printableStatus: getPrintableStatus(vm, powerState),
    ready: getVmReady(vm),
    nodeName: vmi?.status?.nodeName ?? vm.status?.nodeName,
    ipAddresses: getIpAddresses(vmi),
    runStrategy,
    runningSince,
    manualRuntime:
      runStrategy === "Manual"
        ? parseManualRuntimeAnnotations(vm.metadata?.annotations)
        : undefined,
    resources: getVmResourceSettings(vm, vmi, rootDiskCurrentSize, rootDiskDesiredSize),
    rdp: toRdpSignal(powerState, guestUsers, guestUserError),
    conditions: vm.status?.conditions ?? [],
    activeOperations: getActiveOperations(vm, vmi, snapshots, restores),
  };
}
