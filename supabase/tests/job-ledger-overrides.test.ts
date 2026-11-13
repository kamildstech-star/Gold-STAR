import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Runs the pglite fixture for the Job ledger's typed cells inside the normal
 * `npx vitest run` gate, the same arrangement as microsoft-connections.test.ts:
 * the `.pglite.mjs` script is the one copy of the test.
 *
 * What it proves, against the real migration file (20261007224500): effort
 * cells read by anyone on the job, money cells only by finance + view_costs;
 * only owner / admin / sales_head type, and only on a job they can see; who
 * and when stamped by the database; every change in the trail; portal and
 * anon denied; the totals, Referral and Commission are not typeable.
 */

const SCRIPT = "supabase/tests/job-ledger-overrides.pglite.mjs";
const PGLITE = "node_modules/@electric-sql/pglite/dist/index.js";

describe("job_ledger_overrides row boundary", () => {
  it("reads like the ledger, writes like job money, audits every change, denies portal and anon", () => {
    if (!existsSync(PGLITE)) {
      expect.fail(
        `PGlite build not found at ${PGLITE}. Run \`npm install\` — @electric-sql/pglite is a devDependency.`,
      );
    }
    const out = execFileSync("node", [SCRIPT, PGLITE], { encoding: "utf8", timeout: 120_000 });
    expect(out).toMatch(/job-ledger-overrides\.pglite: \d+ assertions passed/);
    const count = Number(/: (\d+) assertions/.exec(out)?.[1] ?? 0);
    expect(count).toBeGreaterThanOrEqual(60);
  }, 150_000);
});
