import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Runs the pglite fixture for running cost with commission (migration
 * 20261007224300) inside `npx vitest run`.
 *
 * What it proves, against the real migration files applied in order on top
 * of the definitions they replace: job_running_cost keeps its arguments,
 * SECURITY DEFINER, search_path and grants, and every old column; total_cost
 * and margin now include the referrer's commission and the salesmen's
 * (void payouts excluded), once; a new charge moves the commission; the
 * finance gate and the overview still hold; and job_referrer_commission
 * answers every shared case in referrer-commission-cases.json exactly as the
 * TypeScript calculation does (src/lib/job-commission.parity.test.ts).
 */
const SCRIPT = "supabase/tests/running-cost-commission.pglite.mjs";
const PGLITE = "node_modules/@electric-sql/pglite/dist/index.js";

describe("job_running_cost counts commission, once", () => {
  it("passes every assertion in the pglite fixture", () => {
    if (!existsSync(PGLITE)) {
      expect.fail(`PGlite build not found at ${PGLITE}. Run \`npm install\`.`);
    }
    const out = execFileSync("node", [SCRIPT, PGLITE], { encoding: "utf8", timeout: 120_000 });
    expect(out).toMatch(/running-cost-commission\.pglite: \d+ assertions passed/);
    const count = Number(/: (\d+) assertions/.exec(out)?.[1] ?? 0);
    expect(count).toBeGreaterThanOrEqual(40);
  }, 150_000);
});
