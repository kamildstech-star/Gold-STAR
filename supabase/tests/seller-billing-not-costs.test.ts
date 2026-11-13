import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Runs the pglite fixture for T11 (migration 20261027130000) inside the
 * normal vitest gate: sellers get billed and paid, never labor cost, per-person
 * cost or margin, and the role matrix cannot give a seller role cost.
 */
const SCRIPT = "supabase/tests/seller-billing-not-costs.pglite.mjs";
const PGLITE = "node_modules/@electric-sql/pglite/dist/index.js";

describe("seller billing, not costs", () => {
  it("withholds cost from sellers at the data layer and keeps billed / paid", () => {
    if (!existsSync(PGLITE)) expect.fail(`PGlite build not found at ${PGLITE}.`);
    const out = execFileSync("node", [SCRIPT, PGLITE], { encoding: "utf8", timeout: 120_000 });
    expect(out).toMatch(/seller-billing-not-costs\.pglite: \d+ assertions passed/);
    expect(Number(/: (\d+) assertions/.exec(out)?.[1] ?? 0)).toBeGreaterThanOrEqual(20);
  }, 150_000);
});
