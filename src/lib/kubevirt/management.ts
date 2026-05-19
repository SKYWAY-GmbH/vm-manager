import type { KubeVirtVirtualMachine } from "./types";

export const VM_MANAGER_MANAGED_KEY = "vm-manager.skyway.tools/managed";

function isDisabledFlag(value: string): boolean {
  return ["0", "false", "no", "off"].includes(value.toLowerCase());
}

export function isManagedVirtualMachine(vm: KubeVirtVirtualMachine): boolean {
  const managedValue =
    vm.metadata?.labels?.[VM_MANAGER_MANAGED_KEY] ??
    vm.metadata?.annotations?.[VM_MANAGER_MANAGED_KEY];

  return managedValue ? !isDisabledFlag(managedValue) : true;
}
