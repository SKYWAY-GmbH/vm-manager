import type {
  KubeCondition,
  KubeVirtVirtualMachine,
  KubeVirtVirtualMachineInstance,
  KubeVirtVirtualMachineRestore,
  KubeVirtVirtualMachineSnapshot,
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

function latestConditionMessage(conditions: KubeCondition[] | undefined): string | undefined {
  return conditions?.find((condition) => condition.message)?.message;
}

function snapshotMessage(snapshot: KubeVirtVirtualMachineSnapshot): string | undefined {
  return (
    snapshot.status?.error?.message ??
    snapshot.status?.error?.reason ??
    latestConditionMessage(snapshot.status?.conditions)
  );
}

function restoreMessage(restore: KubeVirtVirtualMachineRestore): string | undefined {
  return latestConditionMessage(restore.status?.conditions);
}

function snapshotMatchesVm(snapshot: KubeVirtVirtualMachineSnapshot, vmName: string) {
  return snapshot.spec?.source?.kind === "VirtualMachine" && snapshot.spec.source.name === vmName;
}

function restoreMatchesVm(restore: KubeVirtVirtualMachineRestore, vmName: string) {
  return restore.spec?.target?.kind === "VirtualMachine" && restore.spec.target.name === vmName;
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
    createdAt: snapshot.status?.creationTime ?? snapshot.metadata?.creationTimestamp,
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
    createdAt: restore.status?.restoreTime ?? restore.metadata?.creationTimestamp,
    targetName: restore.spec?.target?.name,
    snapshotName: restore.spec?.virtualMachineSnapshotName,
    complete,
    phase,
    message: restoreMessage(restore),
    conditions: restore.status?.conditions ?? [],
  };
}

export function getActiveOperations(
  vmName: string,
  snapshots: KubeVirtVirtualMachineSnapshot[],
  restores: KubeVirtVirtualMachineRestore[],
): VmOperation[] {
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

  return [...activeSnapshots, ...activeRestores].sort((left, right) =>
    (right.createdAt ?? "").localeCompare(left.createdAt ?? ""),
  );
}

export function toVmSummary(
  vm: KubeVirtVirtualMachine,
  vmi?: KubeVirtVirtualMachineInstance,
  snapshots: KubeVirtVirtualMachineSnapshot[] = [],
  restores: KubeVirtVirtualMachineRestore[] = [],
): VirtualMachineSummary {
  const name = vm.metadata?.name ?? "unknown";
  const namespace = vm.metadata?.namespace ?? "default";
  const powerState = normalizePowerState(vm, vmi);

  return {
    id: objectKey(namespace, name),
    uid: vm.metadata?.uid,
    name,
    namespace,
    createdAt: vm.metadata?.creationTimestamp,
    powerState,
    printableStatus: getPrintableStatus(vm, powerState),
    ready: getVmReady(vm),
    nodeName: vmi?.status?.nodeName ?? vm.status?.nodeName,
    ipAddresses: getIpAddresses(vmi),
    runStrategy: getRunStrategy(vm),
    conditions: vm.status?.conditions ?? [],
    activeOperations: getActiveOperations(name, snapshots, restores),
  };
}
