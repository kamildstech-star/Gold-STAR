import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Runs the pglite fixture for Billing & Costs prompt 4 (migration
 * 20261101120000) inside the normal `npx vitest run` gate.
 *
 * What it proves: Standard rates carry today's prices exactly; the regular
 * chain resolves level by level (job → agreement → office → state → company
 * Standard → none); agreements are exceptions that inherit Standard live;
 * new regular jobs freeze their rates; owner/admin only, noted, audited; the
 * Estimate catalog merges into Catalogs with counts that add up.
 */

const SCRIPT = "supabase/tests/billing-costs-agreements.pglite.mjs";
const PGLITE = "node_modules/@electric-sql/pglite/dist/index.js";

describe("Billing & Costs Client Agreements and the regular price chain (pglite)", () => {
  it("carries every price, resolves the chain to the cent, freezes new jobs and merges the catalog", () => {
    if (!existsSync(PGLITE)) {
      expect.fail(
        `PGlite build not found at ${PGLITE}. Run \`npm install\` — @electric-sql/pglite is a devDependency.`,
      );
    }
    const out = execFileSync("node", [SCRIPT, PGLITE], { encoding: "utf8", timeout: 120_000 });
    expect(out).toMatch(/billing-costs-agreements\.pglite: \d+ assertions passed/);
    const count = Number(/: (\d+) assertions/.exec(out)?.[1] ?? 0);
    expect(count).toBeGreaterThanOrEqual(50);
  }, 150_000);
});
