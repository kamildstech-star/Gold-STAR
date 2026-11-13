import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Runs the pglite fixture for the app_base_url setting and its callers (20261012150000). */
const SCRIPT = "supabase/tests/app-base-url.pglite.mjs";
const PGLITE = "node_modules/@electric-sql/pglite/dist/index.js";

describe("every database caller of an app hook reads one base URL", () => {
  it("nothing moves on apply; one UPDATE moves them all; only the service role may change it", () => {
    if (!existsSync(PGLITE))
      expect.fail(`PGlite build not found at ${PGLITE}. Run \`npm install\`.`);
    const out = execFileSync("node", [SCRIPT, PGLITE], { encoding: "utf8", timeout: 120_000 });
    expect(out).toMatch(/app-base-url\.pglite: \d+ assertions passed/);
    expect(Number(/: (\d+) assertions/.exec(out)?.[1] ?? 0)).toBeGreaterThanOrEqual(90);
  }, 150_000);
});
