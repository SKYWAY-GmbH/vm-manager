import { lookup } from "node:dns/promises";
import { createConnection } from "node:net";
import {
  dependencies,
  isDirectRun,
  isRecord,
  type PollDependencies,
  parseVersion,
} from "./common.mts";

interface SmokeOptions {
  baseUrl: string;
  version: string;
  commit: string;
  timeoutMs?: number;
  intervalMs?: number;
}

async function readDeployedVersion(
  options: SmokeOptions,
  deps: PollDependencies,
  deadline: number,
): Promise<{ version: string | null; commit: string | null }> {
  const response = await deps.fetch(new URL("/api/version", options.baseUrl), {
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(Math.min(10_000, deadline - deps.now())),
  });
  if (!response.ok) throw new Error(`version HTTP ${response.status}`);
  const body: unknown = await response.json();
  if (deps.now() >= deadline) throw new Error("deadline reached during version check");
  if (
    !isRecord(body) ||
    !(body.version === null || typeof body.version === "string") ||
    !(body.commit === null || typeof body.commit === "string")
  ) {
    throw new Error("invalid version JSON");
  }
  return { version: body.version, commit: body.commit };
}

function isNewerVersion(version: string | null, expected: bigint[]): boolean {
  const deployed = typeof version === "string" ? parseVersion(version) : null;
  const difference = deployed?.findIndex((part, index) => part !== expected[index]) ?? -1;
  return Boolean(deployed && difference >= 0 && deployed[difference] > expected[difference]);
}

async function checkHomepage(
  baseUrl: string,
  observed: string,
  deps: PollDependencies,
  deadline: number,
): Promise<number> {
  const remaining = deadline - deps.now();
  if (remaining <= 0) throw new Error("deadline reached before homepage check");
  const home = await deps.fetch(new URL("/", baseUrl), {
    cache: "no-store",
    redirect: "manual",
    signal: AbortSignal.timeout(Math.min(10_000, remaining)),
  });
  if (!home.ok) throw new Error(`matching ${observed}, homepage HTTP ${home.status}`);
  await home.body?.cancel();
  if (deps.now() >= deadline) throw new Error("deadline reached during homepage check");
  return home.status;
}

export async function waitForRollout(
  options: SmokeOptions,
  overrides: Partial<PollDependencies> = {},
): Promise<"match" | "superseded"> {
  const expected = parseVersion(options.version);
  if (!expected || !/^[a-f0-9]{40}$/.test(options.commit)) {
    throw new Error("Smoke check requires a stable semver tag and full commit SHA");
  }
  const deps = { ...dependencies, ...overrides };
  const deadline = deps.now() + (options.timeoutMs ?? 60 * 60_000);
  let lastState = "unavailable: no response";
  while (deps.now() < deadline) {
    try {
      const body = await readDeployedVersion(options, deps, deadline);
      const observed = `version=${JSON.stringify(body.version)}, commit=${JSON.stringify(body.commit)}`;
      if (isNewerVersion(body.version, expected)) {
        deps.log(
          `::warning::Release ${options.version} superseded by ${observed}; ending smoke check`,
        );
        return "superseded";
      }
      if (body.version === options.version && body.commit === options.commit) {
        const status = await checkHomepage(options.baseUrl, observed, deps, deadline);
        deps.log(`Rollout matched ${observed}; GET / returned ${status}`);
        return "match";
      }
      lastState = `stale: ${observed}`;
    } catch (error) {
      lastState = `unavailable: ${error instanceof Error ? error.message : "request failed"}`;
    }
    deps.log(lastState);
    await deps.sleep(Math.max(0, Math.min(options.intervalMs ?? 25_000, deadline - deps.now())));
  }
  throw new Error(
    `Rollout timed out for ${options.version}/${options.commit}; last state: ${lastState}`,
  );
}

interface PreflightDependencies extends Pick<PollDependencies, "sleep" | "now" | "log"> {
  lookup: (hostname: string) => Promise<{ address: string; family: number }>;
  connect: (
    address: { address: string; family: number },
    port: number,
    timeoutMs: number,
  ) => Promise<void>;
}

const preflightDependencies: PreflightDependencies = {
  ...dependencies,
  lookup,
  connect: (address, port, timeoutMs) =>
    new Promise<void>((resolve, reject) => {
      const socket = createConnection({ host: address.address, family: address.family, port });
      socket.setTimeout(timeoutMs);
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("timeout", () => {
        socket.destroy();
        reject(new Error("TCP connection timed out"));
      });
      socket.once("error", reject);
    }),
};

async function boundedLookup(hostname: string, timeoutMs: number, deps: PreflightDependencies) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      deps.lookup(hostname),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("DNS lookup timed out")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function preflight(
  baseUrl: string,
  options: { timeoutMs?: number; intervalMs?: number } = {},
  overrides: Partial<PreflightDependencies> = {},
): Promise<void> {
  const url = new URL(baseUrl);
  if (url.protocol !== "http:") throw new Error("Service preflight requires an HTTP URL");
  const deps = { ...preflightDependencies, ...overrides };
  const deadline = deps.now() + (options.timeoutMs ?? 150_000);
  let lastError = "unreachable";
  while (deps.now() < deadline) {
    try {
      const address = await boundedLookup(
        url.hostname,
        Math.min(5000, deadline - deps.now()),
        deps,
      );
      const remaining = deadline - deps.now();
      if (remaining <= 0) throw new Error("deadline reached during DNS lookup");
      await deps.connect(address, Number(url.port || 80), Math.min(5000, remaining));
      if (deps.now() >= deadline) throw new Error("deadline reached during TCP connection");
      deps.log(`Preflight passed: ${url.host} resolves and accepts TCP connections`);
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : "unreachable";
    }
    deps.log(`Waiting for Service reachability at ${url.host}: ${lastError}`);
    await deps.sleep(Math.max(0, Math.min(options.intervalMs ?? 5000, deadline - deps.now())));
  }
  throw new Error(
    `Service preflight failed for ${url.host}; check Service DNS, endpoints and network policies: ${lastError}`,
  );
}

async function main() {
  if (process.argv.includes("--help")) {
    process.stdout.write(
      "Usage: node scripts/release/rollout-smoke.mts\nRequires Node 24, SERVICE_URL, EXPECTED_VERSION, EXPECTED_COMMIT. Preflights DNS/TCP for up to 150 seconds, then polls for up to 60 minutes.\n",
    );
    return;
  }
  const baseUrl = process.env.SERVICE_URL;
  if (!baseUrl) throw new Error("SERVICE_URL is required");
  await preflight(baseUrl);
  await waitForRollout({
    baseUrl,
    version: process.env.EXPECTED_VERSION ?? "",
    commit: process.env.EXPECTED_COMMIT ?? "",
  });
}

if (isDirectRun(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Rollout smoke check failed");
    process.exitCode = 1;
  }
}
