import "server-only";

import {
  getCustomObjectsClient,
  patchNamespacedCustomObjectMergePatch,
  requestKubeJson,
} from "./client";
import { isNotFound, items } from "./longhorn";
import { isManagedVirtualMachine } from "./management";
import {
  clearManualRuntimeAnnotations,
  defaultManualRuntimeAnnotationsForVmi,
  MANUAL_RUNTIME_RECONCILE_INTERVAL_MS,
  MANUAL_RUNTIME_STOP_GRACE_MS,
  type ManualRuntimeAnnotationPatch,
  manualRuntimePatchBody,
  manualRuntimeTimerMatchesVmi,
  parseManualRuntimeAnnotations,
  stopRequestedManualRuntimeAnnotation,
} from "./manual-runtime";
import { getRunStrategy, normalizePowerState, objectKey } from "./status";
import type { KubeVirtVirtualMachine, KubeVirtVirtualMachineInstance } from "./types";
import { isTerminalVmi } from "./vmi";

const KUBEVIRT_GROUP = "kubevirt.io";
const KUBEVIRT_VERSION = "v1";
const SUBRESOURCE_GROUP = "subresources.kubevirt.io";

let reconcilerStarted = false;
let reconcileRunning = false;

function encodeSegment(value: string) {
  return encodeURIComponent(value);
}

async function optionalList<T>(plural: string): Promise<T[]> {
  try {
    const response = await getCustomObjectsClient().listCustomObjectForAllNamespaces({
      group: KUBEVIRT_GROUP,
      version: KUBEVIRT_VERSION,
      plural,
    });
    return items<T>(response);
  } catch (error) {
    if (isNotFound(error)) {
      return [];
    }

    throw error;
  }
}

function toVmiMap(vmis: KubeVirtVirtualMachineInstance[]) {
  return new Map(
    vmis
      .filter((vmi) => vmi.metadata?.namespace && vmi.metadata.name)
      .map((vmi) => [objectKey(vmi.metadata?.namespace ?? "", vmi.metadata?.name ?? ""), vmi]),
  );
}

async function patchManualRuntime(
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

async function requestStop(namespace: string, name: string, force: boolean) {
  await requestKubeJson(
    "PUT",
    `/apis/${SUBRESOURCE_GROUP}/${KUBEVIRT_VERSION}/namespaces/${encodeSegment(namespace)}/virtualmachines/${encodeSegment(name)}/stop`,
    {
      apiVersion: `${SUBRESOURCE_GROUP}/${KUBEVIRT_VERSION}`,
      kind: "StopOptions",
      ...(force ? { gracePeriod: 0 } : {}),
    },
  );
}

async function reconcileManualRuntimeVm(
  vm: KubeVirtVirtualMachine,
  vmi: KubeVirtVirtualMachineInstance | undefined,
  now: Date,
) {
  if (getRunStrategy(vm) !== "Manual") {
    return;
  }

  const namespace = vm.metadata?.namespace ?? "default";
  const name = vm.metadata?.name ?? "unknown";
  const runtime = parseManualRuntimeAnnotations(vm.metadata?.annotations);
  const powerState = normalizePowerState(vm, vmi);

  if (powerState === "offline" || !vmi || isTerminalVmi(vmi)) {
    if (runtime) {
      await patchManualRuntime(namespace, name, clearManualRuntimeAnnotations());
    }
    return;
  }

  if (powerState !== "online") {
    return;
  }

  let activeRuntime = runtime;
  if (!manualRuntimeTimerMatchesVmi(runtime, vmi)) {
    const annotations = defaultManualRuntimeAnnotationsForVmi(vmi);
    await patchManualRuntime(namespace, name, annotations);
    activeRuntime = parseManualRuntimeAnnotations(
      Object.fromEntries(
        Object.entries(annotations).filter((entry): entry is [string, string] => entry[1] !== null),
      ),
    );
  }

  if (!activeRuntime?.expiresAt) {
    return;
  }

  if (Date.parse(activeRuntime.expiresAt) > now.getTime()) {
    return;
  }

  if (activeRuntime.stopRequestedAt) {
    const stopRequestedAt = Date.parse(activeRuntime.stopRequestedAt);
    if (
      !Number.isNaN(stopRequestedAt) &&
      stopRequestedAt + MANUAL_RUNTIME_STOP_GRACE_MS <= now.getTime()
    ) {
      await requestStop(namespace, name, true);
    }
    return;
  }

  await requestStop(namespace, name, false);
  await patchManualRuntime(namespace, name, stopRequestedManualRuntimeAnnotation(now));
}

export async function reconcileManualRuntimeTimeouts(now = new Date()) {
  if (reconcileRunning) {
    return;
  }

  reconcileRunning = true;
  try {
    const [vms, vmis] = await Promise.all([
      optionalList<KubeVirtVirtualMachine>("virtualmachines"),
      optionalList<KubeVirtVirtualMachineInstance>("virtualmachineinstances"),
    ]);
    const vmiMap = toVmiMap(vmis);

    for (const vm of vms.filter(isManagedVirtualMachine)) {
      const namespace = vm.metadata?.namespace ?? "default";
      const name = vm.metadata?.name ?? "unknown";
      await reconcileManualRuntimeVm(vm, vmiMap.get(objectKey(namespace, name)), now);
    }
  } finally {
    reconcileRunning = false;
  }
}

export function ensureManualRuntimeReconcilerStarted() {
  if (reconcilerStarted || process.env.NODE_ENV === "test") {
    return;
  }

  reconcilerStarted = true;
  reconcileManualRuntimeTimeouts().catch((error: unknown) => {
    console.error("Manual runtime reconciler failed", error);
  });
  const timer = setInterval(() => {
    reconcileManualRuntimeTimeouts().catch((error: unknown) => {
      console.error("Manual runtime reconciler failed", error);
    });
  }, MANUAL_RUNTIME_RECONCILE_INTERVAL_MS);
  timer.unref?.();
}
