import { beforeEach, describe, expect, it, vi } from "vitest";

const service = vi.hoisted(() => ({
  createVirtualMachineRestore: vi.fn(),
  createVirtualMachineSnapshot: vi.fn(),
  getVirtualMachine: vi.fn(),
  listVirtualMachineRestores: vi.fn(),
  listVirtualMachineSnapshots: vi.fn(),
  listVirtualMachines: vi.fn(),
  performVirtualMachineAction: vi.fn(),
}));

vi.mock("@/lib/kubevirt/service", () => service);

import { POST as postAction } from "./[namespace]/[name]/actions/route";
import { POST as postRestore } from "./[namespace]/[name]/restores/route";
import { POST as postSnapshot } from "./[namespace]/[name]/snapshots/route";
import { GET as getVms } from "./route";

function context(namespace = "windows", name = "vm-01") {
  return { params: Promise.resolve({ namespace, name }) };
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

  it("creates restores from a snapshot", async () => {
    service.createVirtualMachineRestore.mockResolvedValue({ name: "restore-a" });

    const response = await postRestore(
      new Request("http://local", {
        method: "POST",
        body: JSON.stringify({ snapshotName: "baseline" }),
      }),
      context(),
    );

    expect(response.status).toBe(201);
    expect(service.createVirtualMachineRestore).toHaveBeenCalledWith(
      "windows",
      "vm-01",
      "baseline",
      undefined,
    );
  });
});
