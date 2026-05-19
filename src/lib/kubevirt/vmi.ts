import type { KubeVirtVirtualMachineInstance } from "./types";

const TERMINAL_VMI_PHASES = new Set(["failed", "succeeded"]);

export function getVmiPhase(vmi?: KubeVirtVirtualMachineInstance): string | undefined {
  return vmi?.status?.phase;
}

export function isTerminalVmi(vmi?: KubeVirtVirtualMachineInstance): boolean {
  const phase = getVmiPhase(vmi)?.toLowerCase();
  return phase ? TERMINAL_VMI_PHASES.has(phase) : false;
}
