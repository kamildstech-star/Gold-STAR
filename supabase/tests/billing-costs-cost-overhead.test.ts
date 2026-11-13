import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Runs the pglite fixture for Billing & Costs prompt 3 (migration
 * 20261031120000) inside the normal `npx vitest run` gate.
 *
 * What it proves: every cost on file is carried; the overhead engine's Wage
 * is the field crew's labour_rates history; a publish sums the components and
 * auto-fills every field labor code from its date (back-dated publishes
 * reach later fills); old and frozen jobs keep their labor cost through any
 * publish; the engine is owner/admin only and needs a note; cost_save never
 * types a field labor cost; equipment types are added, renamed and archived
 * with an audit trail.
 */

const SCRIPT = "supabase/tests/billing-costs-cost-overhead.pglite.mjs";
const PGLITE = "node_modules/@electric-sql/pglite/dist/index.js";

describe("Billing & Costs Cost tab and overhead engine (pglite)", () => {
  it("carries every cost, composes the engine, auto-fills labor and keeps old jobs frozen", () => {
    if (!existsSync(PGLITE)) {
      expect.fail(
        `PGlite build not found at ${PGLITE}. Run \`npm install\` — @electric-sql/pglite is a devDependency.`,
      );
    }
    const out = execFileSync("node", [SCRIPT, PGLITE], { encoding: "utf8", timeout: 120_000 });
    expect(out).toMatch(/billing-costs-cost-overhead\.pglite: \d+ assertions passed/);
    const count = Number(/: (\d+) assertions/.exec(out)?.[1] ?? 0);
    expect(count).toBeGreaterThanOrEqual(80);
  }, 150_000);
});
