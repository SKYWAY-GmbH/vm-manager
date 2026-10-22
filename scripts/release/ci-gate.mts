import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import {
  dependencies,
  isDirectRun,
  isRecord,
  type PollDependencies,
  parseVersion,
} from "./common.mts";

class TransientApiError extends Error {}

interface Run {
  id: number;
  run_attempt: number;
  created_at: string;
  head_sha: string;
  status: string;
  conclusion: string | null;
}

interface GateOptions {
  repository: string;
  sha: string;
  token: string;
  apiUrl?: string;
  timeoutMs?: number;
  intervalMs?: number;
}

function parseRun(value: unknown, sha: string): Run {
  if (!isRecord(value)) throw new Error("Malformed CI run");
  if (value.head_sha !== sha) throw new Error("CI head_sha mismatch; refusing to publish");
  if (
    !Number.isSafeInteger(value.id) ||
    Number(value.id) <= 0 ||
    !Number.isSafeInteger(value.run_attempt) ||
    Number(value.run_attempt) <= 0 ||
    typeof value.created_at !== "string" ||
    !Number.isFinite(Date.parse(value.created_at)) ||
    value.event !== "push" ||
    value.head_branch !== "main" ||
    typeof value.status !== "string" ||
    !["queued", "in_progress", "completed", "waiting", "requested", "pending"].includes(
      value.status,
    ) ||
    !(value.conclusion === null || typeof value.conclusion === "string") ||
    (value.status !== "completed" && value.conclusion !== null)
  ) {
    throw new Error("Malformed CI run or unexpected event/branch; refusing to publish");
  }
  return value as unknown as Run;
}

async function newestRun(
  options: GateOptions,
  deps: PollDependencies,
  deadline: number,
): Promise<Run | undefined> {
  const runs: Run[] = [];
  let pages = 1;
  let total: number | undefined;
  for (let page = 1; page <= pages; page++) {
    const remaining = deadline - deps.now();
    if (remaining <= 0) throw new Error("CI gate timed out while listing runs");
    const url = new URL(
      `/repos/${options.repository}/actions/workflows/ci.yml/runs`,
      options.apiUrl ?? "https://api.github.com",
    );
    url.search = new URLSearchParams({
      head_sha: options.sha,
      event: "push",
      branch: "main",
      per_page: "100",
      page: String(page),
    }).toString();
    let response: Response;
    try {
      response = await deps.fetch(url, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${options.token}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.timeout(Math.min(10_000, remaining)),
      });
    } catch {
      throw new TransientApiError("CI API network error or request timeout");
    }
    if (!response.ok) {
      const message = `CI API HTTP ${response.status}`;
      if (response.status === 429 || response.status >= 500) {
        throw new TransientApiError(message);
      }
      throw new Error(`${message}; refusing to publish`);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error("Malformed CI API JSON; refusing to publish");
      }
      throw new TransientApiError("CI API response interrupted or timed out");
    }
    if (
      !isRecord(body) ||
      !Number.isSafeInteger(body.total_count) ||
      Number(body.total_count) < 0 ||
      Number(body.total_count) >= 1000 ||
      !Array.isArray(body.workflow_runs) ||
      body.workflow_runs.length > 100 ||
      body.workflow_runs.length > Number(body.total_count)
    ) {
      throw new Error("Malformed or truncated CI API response; refusing to publish");
    }
    if (page === 1) {
      total = Number(body.total_count);
      pages = Math.max(1, Math.ceil(total / 100));
    }
    if (body.total_count !== total) {
      throw new Error("CI run list changed during pagination; refusing to publish");
    }
    runs.push(...body.workflow_runs.map((run) => parseRun(run, options.sha)));
  }
  if (runs.length !== total) {
    throw new Error("Malformed or incomplete CI API response; refusing to publish");
  }
  // Newest creation wins, then run ID, then attempt. Re-runs replace that run's state.
  return runs.sort(
    (a, b) =>
      Date.parse(b.created_at) - Date.parse(a.created_at) ||
      b.id - a.id ||
      b.run_attempt - a.run_attempt,
  )[0];
}

export async function waitForMainCi(
  options: GateOptions,
  overrides: Partial<PollDependencies> = {},
): Promise<void> {
  if (!/^[a-f0-9]{40}$/.test(options.sha) || !/^[\w.-]+\/[\w.-]+$/.test(options.repository)) {
    throw new Error("Invalid commit SHA or repository");
  }
  if (!options.token) throw new Error("GITHUB_TOKEN is required");
  const deps = { ...dependencies, ...overrides };
  const deadline = deps.now() + (options.timeoutMs ?? 30 * 60_000);
  let lastState = "no matching CI run";
  while (deps.now() < deadline) {
    try {
      const run = await newestRun(options, deps, deadline);
      lastState = "no matching CI run";
      if (run) {
        lastState = `CI run ${run.id}, attempt ${run.run_attempt}: ${run.status}/${run.conclusion}`;
        if (run.status === "completed" && run.conclusion !== "success") {
          throw new Error(`${lastState}; refusing to publish`);
        }
        if (run.status === "completed" && deps.now() < deadline) {
          deps.log(`${lastState}; main push CI passed for exact commit ${options.sha}`);
          return;
        }
      }
    } catch (error) {
      if (!(error instanceof TransientApiError)) throw error;
      lastState = error.message;
    }
    deps.log(`Waiting for main push CI for ${options.sha}: ${lastState}`);
    await deps.sleep(Math.max(0, Math.min(options.intervalMs ?? 25_000, deadline - deps.now())));
  }
  throw new Error(`CI gate timed out: ${lastState}; refusing to publish`);
}

async function main() {
  if (process.argv.includes("--help")) {
    process.stdout.write(
      "Usage: node scripts/release/ci-gate.mts\nRequires Node 24, GitHub Actions env and GITHUB_TOKEN. Waits up to 30 minutes for main push CI.\n",
    );
    return;
  }
  const sha = execFileSync("git", ["rev-parse", "HEAD^{commit}"], { encoding: "utf8" }).trim();
  const isTag = process.env.GITHUB_EVENT_NAME === "push" && process.env.GITHUB_REF_TYPE === "tag";
  if (!isTag && process.env.GITHUB_EVENT_NAME !== "workflow_dispatch") {
    throw new Error("Expected a tag push or workflow_dispatch");
  }
  const version = isTag ? process.env.GITHUB_REF_NAME : `sha-${sha.slice(0, 7)}`;
  if (!version || /[\r\n]/.test(version)) throw new Error("Invalid release version");
  await waitForMainCi({
    repository: process.env.GITHUB_REPOSITORY ?? "",
    sha,
    token: process.env.GITHUB_TOKEN ?? "",
    apiUrl: process.env.GITHUB_API_URL,
  });
  if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required");
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `version=${version}\ncommit=${sha}\ndeployable=${isTag && parseVersion(version) !== null}\n`,
  );
}

if (isDirectRun(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "CI gate failed");
    process.exitCode = 1;
  });
}
