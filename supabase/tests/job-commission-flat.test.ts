import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Runs the pglite fixture for the per-job flat-fee override (migration
 * 20261007224200) inside `npx vitest run`: the column, its CHECKs (no
 * negative fee, never a percent and a flat override together), and that it
 * applies twice cleanly.
 */
const SCRIPT = "supabase/tests/job-commission-flat.pglite.mjs";
const PGLITE = "node_modules/@electric-sql/pglite/dist/index.js";

describe("jobs.commission_flat_amount", () => {
  it("passes every assertion in the pglite fixture", () => {
    if (!existsSync(PGLITE)) {
      expect.fail(`PGlite build not found at ${PGLITE}. Run \`npm install\`.`);
    }
    const out = execFileSync("node", [SCRIPT, PGLITE], { encoding: "utf8", timeout: 120_000 });
    expect(out).toMatch(/job-commission-flat\.pglite: \d+ assertions passed/);
    const count = Number(/: (\d+) assertions/.exec(out)?.[1] ?? 0);
    expect(count).toBeGreaterThanOrEqual(7);
  }, 150_000);
});
