import { describe, expect, it, vi } from "vitest";
import { waitForMainCi } from "./ci-gate.mts";

const sha = "a".repeat(40);
const options = {
  repository: "SKYWAY-GmbH/vm-manager",
  sha,
  token: "mock-token",
  timeoutMs: 30,
  intervalMs: 10,
};

function run(overrides: Record<string, unknown> = {}) {
  return {
    id: 123,
    run_attempt: 1,
    created_at: "2026-10-21T12:00:00Z",
    head_sha: sha,
    event: "push",
    head_branch: "main",
    status: "completed",
    conclusion: "success",
    ...overrides,
  };
}

function runs(...values: unknown[]) {
  return Response.json({ total_count: values.length, workflow_runs: values });
}

function harness() {
  let now = 0;
  return {
    fetch: vi.fn<typeof fetch>(),
    sleep: vi.fn(async (milliseconds: number) => {
      now += milliseconds;
    }),
    now: () => now,
    log: vi.fn<(message: string) => void>(),
  };
}

describe("main CI release gate", () => {
  it("requires successful push CI on main for the exact SHA", async () => {
    const deps = harness();
    deps.fetch.mockResolvedValue(runs(run()));
    await expect(waitForMainCi(options, deps)).resolves.toBeUndefined();
    const url = new URL(String(deps.fetch.mock.calls[0][0]));
    expect(url.pathname).toBe("/repos/SKYWAY-GmbH/vm-manager/actions/workflows/ci.yml/runs");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      head_sha: sha,
      event: "push",
      branch: "main",
      per_page: "100",
      page: "1",
    });
    expect(deps.sleep).not.toHaveBeenCalled();
  });

  it("rejects a mismatching head SHA immediately", async () => {
    const deps = harness();
    deps.fetch.mockResolvedValue(runs(run({ head_sha: "b".repeat(40) })));
    await expect(waitForMainCi(options, deps)).rejects.toThrow("head_sha mismatch");
    expect(deps.fetch).toHaveBeenCalledTimes(1);
  });

  it("waits for a missing run, then times out", async () => {
    const deps = harness();
    deps.fetch.mockImplementation(async () => runs());
    await expect(waitForMainCi(options, deps)).rejects.toThrow("timed out: no matching CI run");
    expect(deps.now()).toBe(30);
    expect(deps.fetch).toHaveBeenCalledTimes(3);
  });

  it.each([
    "failure",
    "cancelled",
    "skipped",
    "timed_out",
    "neutral",
    "action_required",
    null,
  ])("refuses a completed run with conclusion %s", async (conclusion) => {
    const deps = harness();
    deps.fetch.mockResolvedValue(runs(run({ conclusion })));
    await expect(waitForMainCi(options, deps)).rejects.toThrow("refusing to publish");
    expect(deps.sleep).not.toHaveBeenCalled();
  });

  it("waits for an in-progress run to succeed", async () => {
    const deps = harness();
    deps.fetch
      .mockResolvedValueOnce(runs(run({ status: "in_progress", conclusion: null })))
      .mockResolvedValueOnce(runs(run()));
    await expect(waitForMainCi(options, deps)).resolves.toBeUndefined();
    expect(deps.sleep).toHaveBeenCalledTimes(1);
  });

  it("times out with the last in-progress state", async () => {
    const deps = harness();
    deps.fetch.mockImplementation(async () =>
      runs(run({ status: "in_progress", conclusion: null })),
    );
    await expect(waitForMainCi(options, deps)).rejects.toThrow("in_progress/null");
    expect(deps.now()).toBe(30);
  });

  it.each([500, 503, 429])("retries HTTP %s before succeeding", async (status) => {
    const deps = harness();
    deps.fetch
      .mockResolvedValueOnce(new Response(null, { status }))
      .mockResolvedValueOnce(runs(run()));
    await expect(waitForMainCi(options, deps)).resolves.toBeUndefined();
    expect(deps.sleep).toHaveBeenCalledTimes(1);
  });

  it.each([
    new TypeError("fetch failed"),
    new DOMException("timeout", "TimeoutError"),
  ])("retries transport errors", async (error) => {
    const deps = harness();
    deps.fetch.mockRejectedValueOnce(error).mockResolvedValueOnce(runs(run()));
    await expect(waitForMainCi(options, deps)).resolves.toBeUndefined();
    expect(deps.sleep).toHaveBeenCalledTimes(1);
  });

  it("fails closed at the deadline with the last API error", async () => {
    const deps = harness();
    deps.fetch.mockImplementation(async () => new Response(null, { status: 503 }));
    await expect(waitForMainCi(options, deps)).rejects.toThrow(
      "CI gate timed out: CI API HTTP 503",
    );
    expect(deps.now()).toBe(30);
  });

  it.each([400, 401, 403, 404])("fails immediately on HTTP %s", async (status) => {
    const deps = harness();
    deps.fetch.mockResolvedValue(new Response(null, { status }));
    await expect(waitForMainCi(options, deps)).rejects.toThrow(`CI API HTTP ${status}`);
    expect(deps.sleep).not.toHaveBeenCalled();
  });

  it.each([
    null,
    [],
    { total_count: "1", workflow_runs: [] },
    { total_count: 1, workflow_runs: [] },
    { total_count: 0, workflow_runs: [run()] },
    { total_count: 1000, workflow_runs: [] },
    { total_count: 1, workflow_runs: [run({ head_branch: "other" })] },
    { total_count: 1, workflow_runs: [run({ event: "pull_request" })] },
    { total_count: 1, workflow_runs: [run({ status: "unknown" })] },
    { total_count: 1, workflow_runs: [run({ status: "in_progress", conclusion: "success" })] },
    { total_count: 1, workflow_runs: [run({ created_at: "invalid" })] },
  ])("rejects malformed or unexpected response %#", async (body) => {
    const deps = harness();
    deps.fetch.mockResolvedValue(Response.json(body));
    await expect(waitForMainCi(options, deps)).rejects.toThrow(/Malformed/);
    expect(deps.sleep).not.toHaveBeenCalled();
  });

  it("rejects invalid JSON immediately", async () => {
    const deps = harness();
    deps.fetch.mockResolvedValue(new Response("not JSON"));
    await expect(waitForMainCi(options, deps)).rejects.toThrow("Malformed CI API JSON");
    expect(deps.sleep).not.toHaveBeenCalled();
  });

  it("uses the newest run even if an older run succeeded", async () => {
    const deps = harness();
    deps.fetch.mockResolvedValue(
      runs(run(), run({ id: 124, created_at: "2026-10-22T12:00:00Z", conclusion: "failure" })),
    );
    await expect(waitForMainCi(options, deps)).rejects.toThrow("CI run 124");
  });

  it("breaks creation-time ties by ID and attempt", async () => {
    const deps = harness();
    deps.fetch.mockResolvedValue(
      runs(run(), run({ id: 124 }), run({ id: 124, run_attempt: 2, conclusion: "failure" })),
    );
    await expect(waitForMainCi(options, deps)).rejects.toThrow("CI run 124, attempt 2");
  });

  it("accepts the newest successful re-run attempt over the previous failure", async () => {
    const deps = harness();
    deps.fetch.mockResolvedValue(runs(run({ conclusion: "failure" }), run({ run_attempt: 2 })));
    await expect(waitForMainCi(options, deps)).resolves.toBeUndefined();
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("attempt 2"));
  });

  it("checks all pages before selecting the newest run", async () => {
    const deps = harness();
    deps.fetch
      .mockResolvedValueOnce(
        Response.json({
          total_count: 101,
          workflow_runs: Array.from({ length: 100 }, () => run()),
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          total_count: 101,
          workflow_runs: [run({ created_at: "2026-10-22T12:00:00Z", conclusion: "failure" })],
        }),
      );
    await expect(waitForMainCi(options, deps)).rejects.toThrow("completed/failure");
    expect(new URL(String(deps.fetch.mock.calls[1][0])).searchParams.get("page")).toBe("2");
  });
});
