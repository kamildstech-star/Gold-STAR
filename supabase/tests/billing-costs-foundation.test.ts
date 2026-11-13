import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Runs the pglite fixture for the Billing & Costs foundation (migration
 * 20261029120000) inside the normal `npx vitest run` gate, the same
 * arrangement as tm-rate-codes.test.ts.
 *
 * What it proves: the catalog seed matches the old T&M book exactly (and a
 * miss aborts the migration); units come from the line's words or are
 * flagged; catalog_save is admin-only, all-or-nothing and refuses duplicate
 * names; catalog and tm_rate_codes stay in step both ways; the money audit
 * log records every change and cannot be edited by anyone; office-aware
 * values resolve office → default by date.
 */

const SCRIPT = "supabase/tests/billing-costs-foundation.pglite.mjs";
const PGLITE = "node_modules/@electric-sql/pglite/dist/index.js";

describe("Billing & Costs foundation (pglite)", () => {
  it("seeds the catalog from the old book, audits every change, resolves office values", () => {
    if (!existsSync(PGLITE)) {
      expect.fail(
        `PGlite build not found at ${PGLITE}. Run \`npm install\` — @electric-sql/pglite is a devDependency.`,
      );
    }
    const out = execFileSync("node", [SCRIPT, PGLITE], { encoding: "utf8", timeout: 120_000 });
    expect(out).toMatch(/billing-costs-foundation\.pglite: \d+ assertions passed/);
    const count = Number(/: (\d+) assertions/.exec(out)?.[1] ?? 0);
    expect(count).toBeGreaterThanOrEqual(80);
  }, 150_000);
});
