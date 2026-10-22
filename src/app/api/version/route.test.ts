import { afterEach, describe, expect, it, vi } from "vitest";
import { dynamic, GET, runtime } from "./route";

afterEach(() => vi.unstubAllEnvs());

describe("GET /api/version", () => {
  it("returns only runtime version and commit metadata without caching", async () => {
    vi.stubEnv("APP_VERSION", "v1.2.3");
    vi.stubEnv("APP_COMMIT", "a".repeat(40));
    const response = await GET();
    expect(await response.json()).toEqual({ version: "v1.2.3", commit: "a".repeat(40) });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(dynamic).toBe("force-dynamic");
    expect(runtime).toBe("nodejs");

    vi.stubEnv("APP_VERSION", "1.2.4");
    vi.stubEnv("APP_COMMIT", "b".repeat(40));
    expect(await (await GET()).json()).toEqual({ version: "1.2.4", commit: "b".repeat(40) });
  });

  it.each([
    undefined,
    "",
    " \t\n ",
  ])("returns null for empty or unset metadata %j", async (value) => {
    vi.stubEnv("APP_VERSION", value);
    vi.stubEnv("APP_COMMIT", value);
    expect(await (await GET()).json()).toEqual({ version: null, commit: null });
  });
});
