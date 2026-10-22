import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it("recognizes a symlinked entry point without treating its import as direct", () => {
  const directory = mkdtempSync(join(tmpdir(), "release-entry-"));
  try {
    const entry = join(directory, "entry.mts");
    const link = join(directory, "link.mts");
    const commonUrl = new URL("./common.mts", import.meta.url).href;
    writeFileSync(
      entry,
      `import { isDirectRun } from ${JSON.stringify(commonUrl)};
process.stdout.write(JSON.stringify([isDirectRun(import.meta.url), isDirectRun(${JSON.stringify(commonUrl)})]));
`,
    );
    symlinkSync(entry, link);
    expect(execFileSync(process.execPath, [link], { encoding: "utf8", timeout: 1000 })).toBe(
      "[true,false]",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
