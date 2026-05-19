import { describe, expect, it } from "vitest";
import {
  clearManualRuntimeAnnotations,
  manualRuntimeAnnotationsForVmi,
  manualRuntimePatchBody,
  parseManualRuntimeAnnotations,
  VM_MANAGER_MANUAL_RUNTIME_DURATION_DAYS_KEY,
  VM_MANAGER_MANUAL_RUNTIME_EXPIRES_AT_KEY,
  VM_MANAGER_MANUAL_RUNTIME_STARTED_AT_KEY,
  VM_MANAGER_MANUAL_RUNTIME_STOP_REQUESTED_AT_KEY,
  VM_MANAGER_MANUAL_RUNTIME_VMI_UID_KEY,
} from "./manual-runtime";

describe("Manual runtime annotations", () => {
  it("parses valid runtime metadata", () => {
    expect(
      parseManualRuntimeAnnotations({
        [VM_MANAGER_MANUAL_RUNTIME_STARTED_AT_KEY]: "2026-05-19T10:00:00Z",
        [VM_MANAGER_MANUAL_RUNTIME_EXPIRES_AT_KEY]: "2026-05-26T10:00:00Z",
        [VM_MANAGER_MANUAL_RUNTIME_DURATION_DAYS_KEY]: "7",
        [VM_MANAGER_MANUAL_RUNTIME_VMI_UID_KEY]: "vmi-uid-1",
        [VM_MANAGER_MANUAL_RUNTIME_STOP_REQUESTED_AT_KEY]: "2026-05-26T10:01:00Z",
      }),
    ).toEqual({
      startedAt: "2026-05-19T10:00:00Z",
      expiresAt: "2026-05-26T10:00:00Z",
      durationDays: 7,
      vmiUid: "vmi-uid-1",
      stopRequestedAt: "2026-05-26T10:01:00Z",
    });
  });

  it("ignores invalid timestamps and durations", () => {
    expect(
      parseManualRuntimeAnnotations({
        [VM_MANAGER_MANUAL_RUNTIME_STARTED_AT_KEY]: "not-a-date",
        [VM_MANAGER_MANUAL_RUNTIME_EXPIRES_AT_KEY]: "2026-05-26T10:00:00Z",
        [VM_MANAGER_MANUAL_RUNTIME_DURATION_DAYS_KEY]: "14",
      }),
    ).toEqual({
      expiresAt: "2026-05-26T10:00:00Z",
    });
  });

  it("builds timer patch payloads from VMI metadata", () => {
    expect(
      manualRuntimePatchBody(
        manualRuntimeAnnotationsForVmi(
          {
            metadata: {
              uid: "vmi-uid-1",
              creationTimestamp: "2026-05-19T10:00:00Z",
            },
          },
          3,
        ),
      ),
    ).toEqual({
      metadata: {
        annotations: {
          [VM_MANAGER_MANUAL_RUNTIME_STARTED_AT_KEY]: "2026-05-19T10:00:00.000Z",
          [VM_MANAGER_MANUAL_RUNTIME_EXPIRES_AT_KEY]: "2026-05-22T10:00:00.000Z",
          [VM_MANAGER_MANUAL_RUNTIME_DURATION_DAYS_KEY]: "3",
          [VM_MANAGER_MANUAL_RUNTIME_VMI_UID_KEY]: "vmi-uid-1",
          [VM_MANAGER_MANUAL_RUNTIME_STOP_REQUESTED_AT_KEY]: null,
        },
      },
    });
  });

  it("builds clear patch payloads", () => {
    expect(manualRuntimePatchBody(clearManualRuntimeAnnotations())).toEqual({
      metadata: {
        annotations: {
          [VM_MANAGER_MANUAL_RUNTIME_STARTED_AT_KEY]: null,
          [VM_MANAGER_MANUAL_RUNTIME_EXPIRES_AT_KEY]: null,
          [VM_MANAGER_MANUAL_RUNTIME_DURATION_DAYS_KEY]: null,
          [VM_MANAGER_MANUAL_RUNTIME_VMI_UID_KEY]: null,
          [VM_MANAGER_MANUAL_RUNTIME_STOP_REQUESTED_AT_KEY]: null,
        },
      },
    });
  });
});
