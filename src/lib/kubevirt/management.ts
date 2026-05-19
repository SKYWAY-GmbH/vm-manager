import type { KubeVirtVirtualMachine } from "./types";

export const VM_MANAGER_MANAGED_KEY = "vm-manager.skyway.tools/managed";
export const VM_MANAGER_OPERATION_TYPE_KEY = "vm-manager.skyway.tools/operation-type";
export const VM_MANAGER_OPERATION_NAME_KEY = "vm-manager.skyway.tools/operation-name";
export const VM_MANAGER_OPERATION_PHASE_KEY = "vm-manager.skyway.tools/operation-phase";
export const VM_MANAGER_OPERATION_STARTED_AT_KEY = "vm-manager.skyway.tools/operation-started-at";
export const VM_MANAGER_OPERATION_MESSAGE_KEY = "vm-manager.skyway.tools/operation-message";

function isDisabledFlag(value: string): boolean {
  return ["0", "false", "no", "off"].includes(value.toLowerCase());
}

export function isManagedVirtualMachine(vm: KubeVirtVirtualMachine): boolean {
  const managedValue =
    vm.metadata?.labels?.[VM_MANAGER_MANAGED_KEY] ??
    vm.metadata?.annotations?.[VM_MANAGER_MANAGED_KEY];

  return managedValue ? !isDisabledFlag(managedValue) : true;
}
