import { describe, expect, it, vi } from "vitest";
import { isManagedVirtualMachine, VM_MANAGER_MANAGED_KEY } from "./management";

describe("isManagedVirtualMachine", () => {
  it("excludes unlabeled VMs by default", () => {
    expect(isManagedVirtualMachine({ metadata: { name: "vm-01" } })).toBe(false);
  });

  it("includes VMs enabled by label", () => {
    expect(
      isManagedVirtualMachine({
        metadata: {
          labels: {
            [VM_MANAGER_MANAGED_KEY]: "true",
          },
        },
      }),
    ).toBe(true);
  });

  it("includes VMs enabled by annotation", () => {
    expect(
      isManagedVirtualMachine({
        metadata: {
          annotations: {
            [VM_MANAGER_MANAGED_KEY]: "true",
          },
        },
      }),
    ).toBe(true);
  });

  it.each(["1", "yes", "on"])("includes VMs enabled with legacy truthy value %s", (value) => {
    expect(
      isManagedVirtualMachine({
        metadata: {
          annotations: { [VM_MANAGER_MANAGED_KEY]: value },
        },
      }),
    ).toBe(true);
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

  it("warns once and excludes VMs with unrecognized managed values", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const invalidVm = {
        metadata: {
          name: "invalid-marker",
          namespace: "windows",
          labels: {
            [VM_MANAGER_MANAGED_KEY]: "enabled",
          },
        },
      };

      expect(isManagedVirtualMachine(invalidVm)).toBe(false);
      expect(isManagedVirtualMachine(invalidVm)).toBe(false);
      expect(
        isManagedVirtualMachine({
          ...invalidVm,
          metadata: {
            ...invalidVm.metadata,
            labels: { [VM_MANAGER_MANAGED_KEY]: "still-invalid" },
          },
        }),
      ).toBe(false);
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenNthCalledWith(
        1,
        `Ignoring windows/invalid-marker: ${VM_MANAGER_MANAGED_KEY} has invalid value "enabled".`,
      );
      expect(warn).toHaveBeenNthCalledWith(
        2,
        `Ignoring windows/invalid-marker: ${VM_MANAGER_MANAGED_KEY} has invalid value "still-invalid".`,
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("warns and excludes VMs with empty managed values", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(
        isManagedVirtualMachine({
          metadata: {
            name: "empty-marker",
            namespace: "windows",
            annotations: { [VM_MANAGER_MANAGED_KEY]: "" },
          },
        }),
      ).toBe(false);
      expect(warn).toHaveBeenCalledWith(
        `Ignoring windows/empty-marker: ${VM_MANAGER_MANAGED_KEY} has invalid value "".`,
      );
    } finally {
      warn.mockRestore();
    }
  });
});
