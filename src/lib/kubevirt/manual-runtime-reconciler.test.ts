import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const customClient = vi.hoisted(() => ({
  listCustomObjectForAllNamespaces: vi.fn(),
}));
const patchNamespacedCustomObjectMergePatch = vi.hoisted(() => vi.fn());
const requestKubeJson = vi.hoisted(() => vi.fn());

vi.mock("./client", () => ({
  getCustomObjectsClient: () => customClient,
  patchNamespacedCustomObjectMergePatch,
  requestKubeJson,
}));

import { VM_MANAGER_MANAGED_KEY } from "./management";
import {
  VM_MANAGER_MANUAL_RUNTIME_DURATION_DAYS_KEY,
  VM_MANAGER_MANUAL_RUNTIME_EXPIRES_AT_KEY,
  VM_MANAGER_MANUAL_RUNTIME_STARTED_AT_KEY,
  VM_MANAGER_MANUAL_RUNTIME_STOP_REQUESTED_AT_KEY,
  VM_MANAGER_MANUAL_RUNTIME_VMI_UID_KEY,
} from "./manual-runtime";
import { reconcileManualRuntimeTimeouts } from "./manual-runtime-reconciler";
import type { KubeVirtVirtualMachine, KubeVirtVirtualMachineInstance } from "./types";

function manualVm(
  annotations: Record<string, string> = {},
  status: KubeVirtVirtualMachine["status"] = { printableStatus: "Running", created: true },
): KubeVirtVirtualMachine {
  return {
    metadata: {
      name: "vm-01",
      namespace: "windows",
      labels: { [VM_MANAGER_MANAGED_KEY]: "true" },
      annotations,
    },
    spec: { runStrategy: "Manual" },
    status,
  };
}

function alwaysVm(annotations: Record<string, string> = {}): KubeVirtVirtualMachine {
  return {
    metadata: {
      name: "vm-01",
      namespace: "windows",
      labels: { [VM_MANAGER_MANAGED_KEY]: "true" },
      annotations,
    },
    spec: { runStrategy: "Always" },
    status: { printableStatus: "Running", created: true },
  };
}

const vmi: KubeVirtVirtualMachineInstance = {
  metadata: {
    name: "vm-01",
    namespace: "windows",
    uid: "vmi-uid-1",
    creationTimestamp: "2026-05-19T10:00:00Z",
  },
  status: { phase: "Running" },
};

function setupLists(vm: KubeVirtVirtualMachine, vmiObject: KubeVirtVirtualMachineInstance = vmi) {
  customClient.listCustomObjectForAllNamespaces.mockImplementation(
    ({ plural }: { plural: string }) => {
      if (plural === "virtualmachines") {
        return Promise.resolve({ items: [vm] });
      }

      if (plural === "virtualmachineinstances") {
        return Promise.resolve({ items: [vmiObject] });
      }

      return Promise.resolve({ items: [] });
    },
  );
}

describe("Manual runtime reconciler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    patchNamespacedCustomObjectMergePatch.mockResolvedValue({});
    requestKubeJson.mockResolvedValue({});
  });

  it("defaults externally started Manual VMs to seven days from VMI creation", async () => {
    setupLists(manualVm());

    await reconcileManualRuntimeTimeouts(new Date("2026-05-19T11:00:00Z"));

    expect(patchNamespacedCustomObjectMergePatch).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: "windows",
        name: "vm-01",
        body: {
          metadata: {
            annotations: {
              [VM_MANAGER_MANUAL_RUNTIME_STARTED_AT_KEY]: "2026-05-19T10:00:00.000Z",
              [VM_MANAGER_MANUAL_RUNTIME_EXPIRES_AT_KEY]: "2026-05-26T10:00:00.000Z",
              [VM_MANAGER_MANUAL_RUNTIME_DURATION_DAYS_KEY]: "7",
              [VM_MANAGER_MANUAL_RUNTIME_VMI_UID_KEY]: "vmi-uid-1",
              [VM_MANAGER_MANUAL_RUNTIME_STOP_REQUESTED_AT_KEY]: null,
            },
          },
        },
      }),
    );
    expect(requestKubeJson).not.toHaveBeenCalled();
  });

  it("replaces stale VMI UID metadata with the current VMI timer", async () => {
    setupLists(
      manualVm({
        [VM_MANAGER_MANUAL_RUNTIME_STARTED_AT_KEY]: "2026-05-19T09:00:00Z",
        [VM_MANAGER_MANUAL_RUNTIME_EXPIRES_AT_KEY]: "2026-06-18T09:00:00Z",
        [VM_MANAGER_MANUAL_RUNTIME_DURATION_DAYS_KEY]: "30",
        [VM_MANAGER_MANUAL_RUNTIME_VMI_UID_KEY]: "old-vmi-uid",
      }),
    );

    await reconcileManualRuntimeTimeouts(new Date("2026-05-19T11:00:00Z"));

    expect(patchNamespacedCustomObjectMergePatch).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          metadata: {
            annotations: expect.objectContaining({
              [VM_MANAGER_MANUAL_RUNTIME_EXPIRES_AT_KEY]: "2026-05-26T10:00:00.000Z",
              [VM_MANAGER_MANUAL_RUNTIME_DURATION_DAYS_KEY]: "7",
              [VM_MANAGER_MANUAL_RUNTIME_VMI_UID_KEY]: "vmi-uid-1",
            }),
          },
        }),
      }),
    );
  });

  it("requests graceful stop when expiresAt is equal to now", async () => {
    setupLists(
      manualVm({
        [VM_MANAGER_MANUAL_RUNTIME_STARTED_AT_KEY]: "2026-05-19T10:00:00Z",
        [VM_MANAGER_MANUAL_RUNTIME_EXPIRES_AT_KEY]: "2026-05-20T10:00:00Z",
        [VM_MANAGER_MANUAL_RUNTIME_DURATION_DAYS_KEY]: "1",
        [VM_MANAGER_MANUAL_RUNTIME_VMI_UID_KEY]: "vmi-uid-1",
      }),
    );

    await reconcileManualRuntimeTimeouts(new Date("2026-05-20T10:00:00Z"));

    expect(requestKubeJson).toHaveBeenCalledWith(
      "PUT",
      "/apis/subresources.kubevirt.io/v1/namespaces/windows/virtualmachines/vm-01/stop",
      expect.objectContaining({ kind: "StopOptions" }),
    );
    expect(patchNamespacedCustomObjectMergePatch).toHaveBeenCalledWith(
      expect.objectContaining({
        body: {
          metadata: {
            annotations: {
              [VM_MANAGER_MANUAL_RUNTIME_STOP_REQUESTED_AT_KEY]: "2026-05-20T10:00:00.000Z",
            },
          },
        },
      }),
    );
  });

  it("force-stops when the graceful stop request is twelve hours old", async () => {
    setupLists(
      manualVm({
        [VM_MANAGER_MANUAL_RUNTIME_STARTED_AT_KEY]: "2026-05-19T10:00:00Z",
        [VM_MANAGER_MANUAL_RUNTIME_EXPIRES_AT_KEY]: "2026-05-20T10:00:00Z",
        [VM_MANAGER_MANUAL_RUNTIME_DURATION_DAYS_KEY]: "1",
        [VM_MANAGER_MANUAL_RUNTIME_VMI_UID_KEY]: "vmi-uid-1",
        [VM_MANAGER_MANUAL_RUNTIME_STOP_REQUESTED_AT_KEY]: "2026-05-20T10:00:00Z",
      }),
    );

    await reconcileManualRuntimeTimeouts(new Date("2026-05-20T22:00:00Z"));

    expect(requestKubeJson).toHaveBeenCalledWith(
      "PUT",
      "/apis/subresources.kubevirt.io/v1/namespaces/windows/virtualmachines/vm-01/stop",
      expect.objectContaining({ gracePeriod: 0 }),
    );
    expect(patchNamespacedCustomObjectMergePatch).not.toHaveBeenCalled();
  });

  it("clears timer annotations after a Manual VM becomes offline", async () => {
    setupLists(
      manualVm(
        {
          [VM_MANAGER_MANUAL_RUNTIME_STARTED_AT_KEY]: "2026-05-19T10:00:00Z",
          [VM_MANAGER_MANUAL_RUNTIME_EXPIRES_AT_KEY]: "2026-05-20T10:00:00Z",
          [VM_MANAGER_MANUAL_RUNTIME_DURATION_DAYS_KEY]: "1",
          [VM_MANAGER_MANUAL_RUNTIME_VMI_UID_KEY]: "vmi-uid-1",
        },
        { printableStatus: "Stopped", created: false },
      ),
    );

    await reconcileManualRuntimeTimeouts(new Date("2026-05-20T10:00:00Z"));

    expect(patchNamespacedCustomObjectMergePatch).toHaveBeenCalledWith(
      expect.objectContaining({
        body: {
          metadata: {
            annotations: {
              [VM_MANAGER_MANUAL_RUNTIME_STARTED_AT_KEY]: null,
              [VM_MANAGER_MANUAL_RUNTIME_EXPIRES_AT_KEY]: null,
              [VM_MANAGER_MANUAL_RUNTIME_DURATION_DAYS_KEY]: null,
              [VM_MANAGER_MANUAL_RUNTIME_VMI_UID_KEY]: null,
              [VM_MANAGER_MANUAL_RUNTIME_STOP_REQUESTED_AT_KEY]: null,
            },
          },
        },
      }),
    );
  });

  it("ignores non-Manual VMs even when timeout annotations exist", async () => {
    setupLists(
      alwaysVm({
        [VM_MANAGER_MANUAL_RUNTIME_STARTED_AT_KEY]: "2026-05-19T10:00:00Z",
        [VM_MANAGER_MANUAL_RUNTIME_EXPIRES_AT_KEY]: "2026-05-20T10:00:00Z",
        [VM_MANAGER_MANUAL_RUNTIME_DURATION_DAYS_KEY]: "1",
        [VM_MANAGER_MANUAL_RUNTIME_VMI_UID_KEY]: "vmi-uid-1",
      }),
    );

    await reconcileManualRuntimeTimeouts(new Date("2026-05-20T10:00:00Z"));

    expect(patchNamespacedCustomObjectMergePatch).not.toHaveBeenCalled();
    expect(requestKubeJson).not.toHaveBeenCalled();
  });

  it("does not enforce runtime timers for unlabeled VMs", async () => {
    const managedVm = manualVm({
      [VM_MANAGER_MANUAL_RUNTIME_STARTED_AT_KEY]: "2026-05-19T10:00:00Z",
      [VM_MANAGER_MANUAL_RUNTIME_EXPIRES_AT_KEY]: "2026-05-20T10:00:00Z",
      [VM_MANAGER_MANUAL_RUNTIME_DURATION_DAYS_KEY]: "1",
      [VM_MANAGER_MANUAL_RUNTIME_VMI_UID_KEY]: "vmi-uid-1",
    });
    setupLists({
      ...managedVm,
      metadata: { ...managedVm.metadata, labels: undefined },
    });

    await reconcileManualRuntimeTimeouts(new Date("2026-05-20T10:00:00Z"));

    expect(patchNamespacedCustomObjectMergePatch).not.toHaveBeenCalled();
    expect(requestKubeJson).not.toHaveBeenCalled();
  });
});
