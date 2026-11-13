import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Runs the pglite fixture for TM1 + TM2 (migrations 20261027160000 and
 * 20261027161000) inside the normal vitest gate: the catalogue's cost rate is
 * withheld; a job snapshots its rates and keeps them; only a cost viewer sets
 * a job's rate.
 */
const SCRIPT = "supabase/tests/tm-rates-job-sheet.pglite.mjs";
const PGLITE = "node_modules/@electric-sql/pglite/dist/index.js";

describe("T&M rate catalogue and per-job rate sheets", () => {
  it("withholds cost, snapshots job rates, keeps them job-sticky", () => {
    if (!existsSync(PGLITE)) expect.fail(`PGlite build not found at ${PGLITE}.`);
    const out = execFileSync("node", [SCRIPT, PGLITE], { encoding: "utf8", timeout: 120_000 });
    expect(out).toMatch(/tm-rates-job-sheet\.pglite: \d+ assertions passed/);
    expect(Number(/: (\d+) assertions/.exec(out)?.[1] ?? 0)).toBeGreaterThanOrEqual(24);
  }, 150_000);
});
