import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Runs the pglite fixture for Billing & Costs prompt 5's SQL engine
 * (migration 20261103120000): job_revenue's ladder, Eastern calendar
 * equipment days, and rejected time left out of labor cost — to the cent.
 */

const SCRIPT = "supabase/tests/billing-costs-one-engine.pglite.mjs";
const PGLITE = "node_modules/@electric-sql/pglite/dist/index.js";

describe("Billing & Costs one money engine in SQL (pglite)", () => {
  it("one revenue ladder, one equipment-day rule, rejected time uncosted", () => {
    if (!existsSync(PGLITE)) {
      expect.fail(
        `PGlite build not found at ${PGLITE}. Run \`npm install\` — @electric-sql/pglite is a devDependency.`,
      );
    }
    const out = execFileSync("node", [SCRIPT, PGLITE], { encoding: "utf8", timeout: 120_000 });
    expect(out).toMatch(/billing-costs-one-engine\.pglite: \d+ assertions passed/);
    const count = Number(/: (\d+) assertions/.exec(out)?.[1] ?? 0);
    expect(count).toBeGreaterThanOrEqual(10);
  }, 150_000);
});
