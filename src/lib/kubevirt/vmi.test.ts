import { describe, expect, it } from "vitest";
import { isTerminalVmi } from "./vmi";

describe("VMI status helpers", () => {
  it("recognizes terminal VMI phases", () => {
    expect(isTerminalVmi({ status: { phase: "Succeeded" } })).toBe(true);
    expect(isTerminalVmi({ status: { phase: "Failed" } })).toBe(true);
  });

  it("does not treat running or unknown phases as terminal", () => {
    expect(isTerminalVmi({ status: { phase: "Running" } })).toBe(false);
    expect(isTerminalVmi({})).toBe(false);
  });
});
