import { describe, expect, it } from "vitest";
import { isManagedVirtualMachine, VM_MANAGER_MANAGED_KEY } from "./management";

describe("isManagedVirtualMachine", () => {
  it("keeps VMs managed by default", () => {
    expect(isManagedVirtualMachine({ metadata: { name: "vm-01" } })).toBe(true);
  });

  it("excludes VMs disabled by label", () => {
    expect(
      isManagedVirtualMachine({
        metadata: {
          labels: {
            [VM_MANAGER_MANAGED_KEY]: "false",
          },
        },
      }),
    ).toBe(false);
  });

  it("excludes VMs disabled by annotation", () => {
    expect(
      isManagedVirtualMachine({
        metadata: {
          annotations: {
            [VM_MANAGER_MANAGED_KEY]: "off",
          },
        },
      }),
    ).toBe(false);
  });
});
