import { afterEach, describe, expect, it, vi } from "vitest";
import { parseVersion } from "./common.mts";
import { preflight, waitForRollout } from "./rollout-smoke.mts";

const commit = "a".repeat(40);
const options = {
  baseUrl: "http://vm-manager.vm-manager.svc.cluster.local:3000",
  version: "1.2.3",
  commit,
  timeoutMs: 30,
  intervalMs: 10,
};

function version(value: string | null = options.version, sha: string | null = commit) {
  return Response.json({ version: value, commit: sha });
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

afterEach(() => vi.useRealTimers());

describe("Flux rollout smoke check", () => {
  it("accepts an immediate version/commit match and successful homepage", async () => {
    const deps = harness();
    deps.fetch.mockResolvedValueOnce(version()).mockResolvedValueOnce(new Response("ok"));
    await expect(waitForRollout(options, deps)).resolves.toBe("match");
    expect(deps.fetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      "/api/version",
      "/",
    ]);
    expect(deps.fetch.mock.calls[0][1]).toMatchObject({ cache: "no-store", redirect: "error" });
    expect(deps.fetch.mock.calls[1][1]).toMatchObject({ redirect: "manual" });
    expect(deps.sleep).not.toHaveBeenCalled();
  });

  it("waits through a stale version until the new version and commit match", async () => {
    const deps = harness();
    deps.fetch
      .mockResolvedValueOnce(version("1.2.2"))
      .mockResolvedValueOnce(version())
      .mockResolvedValueOnce(new Response("ok"));
    await expect(waitForRollout(options, deps)).resolves.toBe("match");
    expect(deps.sleep).toHaveBeenCalledTimes(1);
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("stale:"));
  });

  it.each([
    "1.2.4",
    "1.3.0",
    "2.0.0",
    "v1.2.4",
    "99999999999999999999.0.0",
    "1.10.0",
  ])("warns and succeeds when superseded by %s", async (deployed) => {
    const deps = harness();
    deps.fetch.mockResolvedValueOnce(version(deployed, "b".repeat(40)));
    await expect(waitForRollout(options, deps)).resolves.toBe("superseded");
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("::warning::"));
    expect(deps.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["1.2.3", "b".repeat(40)],
    ["v1.2.3", commit],
    [null, null],
    ["", ""],
    [" \t", " "],
    ["1.2.2", commit],
    ["0.10.0", commit],
  ])("keeps stale metadata %j/%j waiting until timeout", async (value, sha) => {
    const deps = harness();
    deps.fetch.mockImplementation(async () => version(value, sha));
    await expect(waitForRollout(options, deps)).rejects.toThrow("last state: stale:");
    expect(deps.now()).toBe(30);
    expect(deps.fetch).toHaveBeenCalledTimes(3);
  });

  it.each([
    "throws",
    "503",
    "bad JSON",
    "wrong schema",
  ])("recovers when version is unavailable: %s", async (failure) => {
    const deps = harness();
    if (failure === "throws") deps.fetch.mockRejectedValueOnce(new TypeError("fetch failed"));
    else if (failure === "503")
      deps.fetch.mockResolvedValueOnce(new Response(null, { status: 503 }));
    else if (failure === "bad JSON") deps.fetch.mockResolvedValueOnce(new Response("not JSON"));
    else deps.fetch.mockResolvedValueOnce(Response.json({ version: 123 }));
    deps.fetch.mockResolvedValueOnce(version()).mockResolvedValueOnce(new Response("ok"));
    await expect(waitForRollout(options, deps)).resolves.toBe("match");
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("unavailable:"));
  });

  it("retries a matching version with a failing homepage", async () => {
    const deps = harness();
    deps.fetch
      .mockResolvedValueOnce(version())
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(version())
      .mockResolvedValueOnce(new Response("ok"));
    await expect(waitForRollout(options, deps)).resolves.toBe("match");
    expect(deps.sleep).toHaveBeenCalledTimes(1);
  });

  it.each([302, 500])("times out on homepage HTTP %s with the last state", async (status) => {
    const deps = harness();
    deps.fetch.mockImplementation(async (url) =>
      new URL(String(url)).pathname === "/api/version" ? version() : new Response(null, { status }),
    );
    await expect(waitForRollout(options, deps)).rejects.toThrow(`homepage HTTP ${status}`);
    expect(deps.now()).toBe(30);
  });

  it("rejects a prerelease expectation before fetching", async () => {
    const deps = harness();
    await expect(waitForRollout({ ...options, version: "1.2.3-rc.1" }, deps)).rejects.toThrow(
      "stable semver",
    );
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it("reports the last unavailable state at timeout", async () => {
    const deps = harness();
    deps.fetch.mockRejectedValue(new Error("connection refused"));
    await expect(waitForRollout(options, deps)).rejects.toThrow(
      "last state: unavailable: connection refused",
    );
  });
});

describe("stable Flux tag filtering", () => {
  it.each(["0.0.0", "1.2.3", "v1.2.3", "123.456.789"])("accepts %s", (tag) => {
    expect(parseVersion(tag)).not.toBeNull();
  });

  it.each([
    "1.2.3-rc.1",
    "v1.2.3-beta",
    "1.2.3+build",
    "latest",
    "sha-abcdef0",
    "1.2",
    "01.2.3",
    "1.2.3\n",
    "",
  ])("skips %j", (tag) => {
    expect(parseVersion(tag)).toBeNull();
  });
});

describe("Service reachability preflight", () => {
  function preflightHarness() {
    return {
      ...harness(),
      lookup: vi.fn(async () => ({ address: "192.0.2.1", family: 4 })),
      connect: vi.fn(async () => {}),
    };
  }

  it("checks DNS and TCP before polling", async () => {
    const deps = preflightHarness();
    await preflight(options.baseUrl, options, deps);
    expect(deps.lookup).toHaveBeenCalledWith("vm-manager.vm-manager.svc.cluster.local");
    expect(deps.connect).toHaveBeenCalledWith({ address: "192.0.2.1", family: 4 }, 3000, 30);
    expect(deps.sleep).not.toHaveBeenCalled();
  });

  it("retries DNS failures, then TCP failures, before succeeding", async () => {
    const deps = preflightHarness();
    deps.lookup.mockRejectedValueOnce(new Error("EAI_AGAIN"));
    deps.connect.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await preflight(options.baseUrl, options, deps);
    expect(deps.lookup).toHaveBeenCalledTimes(3);
    expect(deps.connect).toHaveBeenCalledTimes(2);
    expect(deps.now()).toBe(20);
  });

  it.each([
    "DNS",
    "TCP",
  ])("fails with a clear message after bounded %s retries", async (failure) => {
    const deps = preflightHarness();
    if (failure === "DNS") deps.lookup.mockRejectedValue(new Error("EAI_AGAIN"));
    else deps.connect.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(preflight(options.baseUrl, options, deps)).rejects.toThrow(
      /Service preflight failed.*check Service DNS, endpoints and network policies: (EAI_AGAIN|ECONNREFUSED)/,
    );
    expect(deps.now()).toBe(30);
  });

  it("bounds a hanging DNS lookup", async () => {
    vi.useFakeTimers();
    const deps = preflightHarness();
    deps.now = Date.now;
    deps.lookup.mockImplementation(() => new Promise(() => {}));
    const result = expect(preflight(options.baseUrl, { timeoutMs: 30 }, deps)).rejects.toThrow(
      "DNS lookup timed out",
    );
    await vi.advanceTimersByTimeAsync(30);
    await result;
    expect(deps.connect).not.toHaveBeenCalled();
  });
});
