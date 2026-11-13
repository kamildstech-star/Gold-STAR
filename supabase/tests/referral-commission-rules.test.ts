import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Runs the pglite fixture for referral_commission_rules (migration
 * 20261007224100) inside the normal `npx vitest run` gate. The `.pglite.mjs`
 * script is the one copy of the assertions.
 *
 * What it proves, against the real migration file: read is whoever can see
 * commission today (admin, finance, job.view_costs, commission.view) and
 * nobody else; write is is_privileged only, like the Commissions page's
 * setting; the restrictive trio and no anon grant; the CHECKs; one deal at a
 * time per payee; cascades; the guard function's search_path and grants.
 */

const SCRIPT = "supabase/tests/referral-commission-rules.pglite.mjs";
const PGLITE = "node_modules/@electric-sql/pglite/dist/index.js";

describe("referral_commission_rules", () => {
  it("passes every assertion in the pglite fixture", () => {
    if (!existsSync(PGLITE)) {
      expect.fail(
        `PGlite build not found at ${PGLITE}. Run \`npm install\` — @electric-sql/pglite is a devDependency.`,
      );
    }
    const out = execFileSync("node", [SCRIPT, PGLITE], { encoding: "utf8", timeout: 120_000 });
    expect(out).toMatch(/referral-commission-rules\.pglite: \d+ assertions passed/);
    const count = Number(/: (\d+) assertions/.exec(out)?.[1] ?? 0);
    expect(count).toBeGreaterThanOrEqual(40);
  }, 150_000);
});
