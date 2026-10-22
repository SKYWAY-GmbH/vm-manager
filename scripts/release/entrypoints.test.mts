import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it.each(["ci-gate", "rollout-smoke"])("loads %s under Node", (name) => {
  const entry = `scripts/release/${name}.mts`;
  const result = spawnSync(process.execPath, [entry, "--help"], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stdout).toContain(`Usage: node ${entry}\n`);
  expect(result.stderr).toBe("");
});
