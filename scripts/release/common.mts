import { pathToFileURL } from "node:url";

export interface PollDependencies {
  fetch: typeof fetch;
  sleep: (milliseconds: number) => Promise<void>;
  now: () => number;
  log: (message: string) => void;
}

export const dependencies: PollDependencies = {
  fetch: globalThis.fetch,
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now: Date.now,
  log: (message) => process.stdout.write(`${message}\n`),
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Flux's stable semver policy excludes prereleases and SHA-only dispatch builds.
export function parseVersion(version: string): bigint[] | null {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (match?.[0] !== version) return null;
  return match ? match.slice(1).map((part) => BigInt(part)) : null;
}

export function isDirectRun(url: string): boolean {
  return Boolean(process.argv[1] && pathToFileURL(process.argv[1]).href === url);
}
