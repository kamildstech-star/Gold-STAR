import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Runs the pglite fixture for migration 20261014150000 inside `npx vitest run`:
 * the live bug reproduced with the real claim_incident, then a chaser with a
 * market claiming a market-less alert, still refused another market's, and a
 * chaser with no territory unchanged.
 */
const SCRIPT = "supabase/tests/incident-market-unmarketed.pglite.mjs";
const PGLITE = "node_modules/@electric-sql/pglite/dist/index.js";

describe("incident_market_allowed: market-less alerts", () => {
  it("passes every assertion in the pglite fixture", () => {
    if (!existsSync(PGLITE)) {
      expect.fail(`PGlite build not found at ${PGLITE}. Run \`npm install\`.`);
    }
    const out = execFileSync("node", [SCRIPT, PGLITE], { encoding: "utf8", timeout: 120_000 });
    expect(out).toMatch(/incident-market-unmarketed\.pglite: \d+ assertions passed/);
    const count = Number(/: (\d+) assertions/.exec(out)?.[1] ?? 0);
    expect(count).toBeGreaterThanOrEqual(19);
  }, 150_000);
});
