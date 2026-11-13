import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Runs the pglite regression test for the six activity goal metrics inside
 * the normal `npx vitest run` gate, the way compliance-direction.test.ts does.
 *
 * The rules live in SQL (`goal_activity_actuals`, 20260916130100), so the
 * only honest unit test of them runs the real migration file against fixture
 * tables. The `.pglite.mjs` script is the one copy of those assertions; this
 * wrapper executes it so CI notices when it breaks.
 *
 * What it proves, against the real migration files:
 *   1. a house account's touches are credited to nobody;
 *   2. a touch to a prospect is never a client reach-out and a touch to a
 *      client is never a cold call or cold email, judged at the time of the
 *      touch;
 *   3. a call logged in both touchpoints and contact_attempts counts twice,
 *      as the leaderboard's calls_made already counts it;
 *   4. inbound mail and no-account rows do not count;
 *   5. new deals, cold leads converted and fires chased follow the rule text
 *      on their GOAL_METRICS entries;
 *   6. both readers carry the six columns; the director row reads targets
 *      off `goals` by metric name; the rule function is not a public endpoint.
 */

const SCRIPT = "supabase/tests/goal-activity-actuals.pglite.mjs";
const PGLITE = "node_modules/@electric-sql/pglite/dist/index.js";

describe("goal activity actuals (Mark's six metrics)", () => {
  it("computes each actual by its stated rule, house accounts excluded", () => {
    if (!existsSync(PGLITE)) {
      expect.fail(
        `PGlite build not found at ${PGLITE}. Run \`npm install\` — @electric-sql/pglite is a devDependency.`,
      );
    }

    const out = execFileSync("node", [SCRIPT, PGLITE], {
      encoding: "utf8",
      timeout: 120_000,
    });

    expect(out).toMatch(/goal-activity-actuals\.pglite: \d+ assertions passed/);
    const count = Number(/: (\d+) assertions/.exec(out)?.[1] ?? 0);
    expect(count).toBeGreaterThanOrEqual(32);
  }, 150_000);
});
