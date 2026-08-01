import type { KubeVirtVirtualMachine } from "./types";

export const VM_MANAGER_MANAGED_KEY = "vm-manager.skyway.tools/managed";
export const VM_MANAGER_OPERATION_TYPE_KEY = "vm-manager.skyway.tools/operation-type";
export const VM_MANAGER_OPERATION_NAME_KEY = "vm-manager.skyway.tools/operation-name";
export const VM_MANAGER_OPERATION_PHASE_KEY = "vm-manager.skyway.tools/operation-phase";
export const VM_MANAGER_OPERATION_STARTED_AT_KEY = "vm-manager.skyway.tools/operation-started-at";
export const VM_MANAGER_OPERATION_MESSAGE_KEY = "vm-manager.skyway.tools/operation-message";

function isEnabledFlag(value: string): boolean {
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function isDisabledFlag(value: string): boolean {
  return ["0", "false", "no", "off"].includes(value.toLowerCase());
}

const warnedInvalidManagedValues = new Set<string>();
const MAX_MANAGED_VALUE_WARNINGS = 500;

export function isManagedVirtualMachine(vm: KubeVirtVirtualMachine): boolean {
  const managedValue =
    vm.metadata?.labels?.[VM_MANAGER_MANAGED_KEY] ??
    vm.metadata?.annotations?.[VM_MANAGER_MANAGED_KEY];

  if (managedValue === undefined || isDisabledFlag(managedValue)) {
    return false;
  }

  if (isEnabledFlag(managedValue)) {
    return true;
  }

  const namespace = vm.metadata?.namespace ?? "default";
  const name = vm.metadata?.name ?? "unknown";
  const warningKey = `${namespace}/${name}:${managedValue}`;
  if (!warnedInvalidManagedValues.has(warningKey)) {
    if (warnedInvalidManagedValues.size >= MAX_MANAGED_VALUE_WARNINGS) {
      warnedInvalidManagedValues.clear();
    }
    warnedInvalidManagedValues.add(warningKey);
    console.warn(
      `Ignoring ${namespace}/${name}: ${VM_MANAGER_MANAGED_KEY} has invalid value ${JSON.stringify(managedValue)}.`,
    );
  }

  return false;
}
