import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Runs the pglite fixture for TM8 (migration 20261027150000) inside the
 * normal vitest gate: supply_items.unit_cost and equipment.daily_rate_cents /
 * purchase_cost_cents are withheld from the authenticated role, and only a
 * job.view_costs holder reads them, through supply_item_costs() /
 * equipment_costs().
 */
const SCRIPT = "supabase/tests/cost-columns-withheld.pglite.mjs";
const PGLITE = "node_modules/@electric-sql/pglite/dist/index.js";

describe("cost columns withheld", () => {
  it("keeps sellers off the cost columns and hands cost holders the RPC", () => {
    if (!existsSync(PGLITE)) expect.fail(`PGlite build not found at ${PGLITE}.`);
    const out = execFileSync("node", [SCRIPT, PGLITE], { encoding: "utf8", timeout: 120_000 });
    expect(out).toMatch(/cost-columns-withheld\.pglite: \d+ assertions passed/);
    expect(Number(/: (\d+) assertions/.exec(out)?.[1] ?? 0)).toBeGreaterThanOrEqual(25);
  }, 150_000);
});
