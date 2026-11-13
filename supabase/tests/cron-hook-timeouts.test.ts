import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Runs the pglite fixture for the 60-second hook timeouts (20261012120000). */
const SCRIPT = "supabase/tests/cron-hook-timeouts.pglite.mjs";
const PGLITE = "node_modules/@electric-sql/pglite/dist/index.js";

describe("database callers of app hooks wait 60 s, not pg_net's 5", () => {
  it("every kick, the automation trigger and run-automations-15min pass timeout 60000", () => {
    if (!existsSync(PGLITE))
      expect.fail(`PGlite build not found at ${PGLITE}. Run \`npm install\`.`);
    const out = execFileSync("node", [SCRIPT, PGLITE], { encoding: "utf8", timeout: 120_000 });
    expect(out).toMatch(/cron-hook-timeouts\.pglite: \d+ assertions passed/);
    expect(Number(/: (\d+) assertions/.exec(out)?.[1] ?? 0)).toBeGreaterThanOrEqual(50);
  }, 150_000);
});
