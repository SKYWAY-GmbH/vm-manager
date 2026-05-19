import { beforeEach, describe, expect, it, vi } from "vitest";

const service = vi.hoisted(() => ({
  createVirtualMachineBackup: vi.fn(),
  createVirtualMachineRestore: vi.fn(),
  createVirtualMachineSnapshot: vi.fn(),
  discardVirtualMachineRollback: vi.fn(),
  forceClearVirtualMachineOperation: vi.fn(),
  getVirtualMachine: vi.fn(),
  listVirtualMachineBackups: vi.fn(),
  listVirtualMachineRestores: vi.fn(),
  listVirtualMachineSnapshots: vi.fn(),
  listVirtualMachines: vi.fn(),
  performVirtualMachineAction: vi.fn(),
  resetVirtualMachineManualRuntimeTimeout: vi.fn(),
  restoreVirtualMachineBackup: vi.fn(),
  restoreVirtualMachineSnapshot: vi.fn(),
}));

vi.mock("@/lib/kubevirt/service", () => service);

import { POST as postAction } from "./[namespace]/[name]/actions/route";
import { POST as postBackup } from "./[namespace]/[name]/backups/route";
import { DELETE as deleteOperation } from "./[namespace]/[name]/operations/route";
import { POST as postRestore } from "./[namespace]/[name]/restores/route";
import { DELETE as deleteRollback } from "./[namespace]/[name]/rollbacks/[pvName]/route";
import { POST as postSnapshot } from "./[namespace]/[name]/snapshots/route";
import { PUT as putTimeout } from "./[namespace]/[name]/timeout/route";
import { GET as getVms } from "./route";

function context(namespace = "windows", name = "vm-01") {
  return { params: Promise.resolve({ namespace, name }) };
}

function rollbackContext(namespace = "windows", name = "vm-01", pvName = "pv-old") {
  return { params: Promise.resolve({ namespace, name, pvName }) };
}

describe("VM route handlers", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns listed VMs", async () => {
    service.listVirtualMachines.mockResolvedValue([{ id: "windows/vm-01" }]);

    const response = await getVms();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: [{ id: "windows/vm-01" }] });
  });

  it("validates action payloads", async () => {
    const response = await postAction(
      new Request("http://local", {
        method: "POST",
        body: JSON.stringify({ action: "delete" }),
      }),
      context(),
    );

    expect(response.status).toBe(400);
    expect(service.performVirtualMachineAction).not.toHaveBeenCalled();
  });

  it("submits valid actions", async () => {
    service.performVirtualMachineAction.mockResolvedValue({ id: "windows/vm-01" });

    const response = await postAction(
      new Request("http://local", {
        method: "POST",
        body: JSON.stringify({ action: "reboot" }),
      }),
      context(),
    );

    expect(response.status).toBe(200);
    expect(service.performVirtualMachineAction).toHaveBeenCalledWith("windows", "vm-01", "reboot");
  });

  it("submits Manual start runtime timeout", async () => {
    service.performVirtualMachineAction.mockResolvedValue({ id: "windows/vm-01" });

    const response = await postAction(
      new Request("http://local", {
        method: "POST",
        body: JSON.stringify({ action: "start", timeoutDays: 30 }),
      }),
      context(),
    );

    expect(response.status).toBe(200);
    expect(service.performVirtualMachineAction).toHaveBeenCalledWith("windows", "vm-01", "start", {
      timeoutDays: 30,
    });
  });

  it("validates action timeout durations", async () => {
    const response = await postAction(
      new Request("http://local", {
        method: "POST",
        body: JSON.stringify({ action: "start", timeoutDays: 8 }),
      }),
      context(),
    );

    expect(response.status).toBe(400);
    expect(service.performVirtualMachineAction).not.toHaveBeenCalled();
  });

  it("resets Manual runtime timeout", async () => {
    service.resetVirtualMachineManualRuntimeTimeout.mockResolvedValue({ id: "windows/vm-01" });

    const response = await putTimeout(
      new Request("http://local", {
        method: "PUT",
        body: JSON.stringify({ timeoutDays: 7 }),
      }),
      context(),
    );

    expect(response.status).toBe(200);
    expect(service.resetVirtualMachineManualRuntimeTimeout).toHaveBeenCalledWith(
      "windows",
      "vm-01",
      7,
    );
  });

  it("validates reset timeout durations", async () => {
    const response = await putTimeout(
      new Request("http://local", {
        method: "PUT",
        body: JSON.stringify({ timeoutDays: 14 }),
      }),
      context(),
    );

    expect(response.status).toBe(400);
    expect(service.resetVirtualMachineManualRuntimeTimeout).not.toHaveBeenCalled();
  });

  it("creates custom-named snapshots", async () => {
    service.createVirtualMachineSnapshot.mockResolvedValue({ name: "baseline" });

    const response = await postSnapshot(
      new Request("http://local", {
        method: "POST",
        body: JSON.stringify({ name: "baseline" }),
      }),
      context(),
    );

    expect(response.status).toBe(201);
    expect(service.createVirtualMachineSnapshot).toHaveBeenCalledWith(
      "windows",
      "vm-01",
      "baseline",
    );
  });

  it("creates custom-named backups", async () => {
    service.createVirtualMachineBackup.mockResolvedValue({ name: "backup-a" });

    const response = await postBackup(
      new Request("http://local", {
        method: "POST",
        body: JSON.stringify({ name: "backup-a", backupMode: "incremental" }),
      }),
      context(),
    );

    expect(response.status).toBe(201);
    expect(service.createVirtualMachineBackup).toHaveBeenCalledWith(
      "windows",
      "vm-01",
      "backup-a",
      "incremental",
    );
  });

  it("creates restores from a snapshot", async () => {
    service.restoreVirtualMachineSnapshot.mockResolvedValue({ name: "vm-01" });

    const response = await postRestore(
      new Request("http://local", {
        method: "POST",
        body: JSON.stringify({ sourceType: "snapshot", snapshotName: "baseline" }),
      }),
      context(),
    );

    expect(response.status).toBe(201);
    expect(service.restoreVirtualMachineSnapshot).toHaveBeenCalledWith(
      "windows",
      "vm-01",
      "baseline",
    );
  });

  it("creates restores from a backup", async () => {
    service.restoreVirtualMachineBackup.mockResolvedValue({ name: "vm-01" });

    const response = await postRestore(
      new Request("http://local", {
        method: "POST",
        body: JSON.stringify({ sourceType: "backup", backupName: "backup-a" }),
      }),
      context(),
    );

    expect(response.status).toBe(201);
    expect(service.restoreVirtualMachineBackup).toHaveBeenCalledWith(
      "windows",
      "vm-01",
      "backup-a",
    );
  });

  it("force-clears VM operation annotations", async () => {
    service.forceClearVirtualMachineOperation.mockResolvedValue({ name: "vm-01" });

    const response = await deleteOperation(new Request("http://local"), context());

    expect(response.status).toBe(200);
    expect(service.forceClearVirtualMachineOperation).toHaveBeenCalledWith("windows", "vm-01");
  });

  it("discards rollback storage", async () => {
    service.discardVirtualMachineRollback.mockResolvedValue({ name: "vm-01" });

    const response = await deleteRollback(new Request("http://local"), rollbackContext());

    expect(response.status).toBe(200);
    expect(service.discardVirtualMachineRollback).toHaveBeenCalledWith(
      "windows",
      "vm-01",
      "pv-old",
    );
  });
});
