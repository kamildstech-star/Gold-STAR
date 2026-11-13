import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Runs the pglite regression test for `scorecard_action_counts` (migration
 * 20260916140000) inside the normal `npx vitest run` gate, the way
 * accounts-owner-guard.test.ts does for its script: one copy of the
 * assertions, in the .mjs, and CI notices when they break.
 *
 * What the script proves: the client only passes catalogue keys and an
 * unknown key is ignored rather than raised; cold versus active-client is
 * judged at the moment of the touch; house accounts never count toward a rep
 * on any key; currency is NULL for a viewer who may not see money; the caller
 * sees only reps in offices `can_view_location` allows; and the write policy
 * on `scorecard_weights` now admits the Sales Head.
 */

const SCRIPT = "supabase/tests/scorecard-action-counts.pglite.mjs";
const PGLITE = "node_modules/@electric-sql/pglite/dist/index.js";

describe("scorecard_action_counts computes any catalogue action per rep, securely", () => {
  it("passes every assertion in the pglite fixture", () => {
    if (!existsSync(PGLITE)) {
      expect.fail(
        `PGlite build not found at ${PGLITE}. Run \`npm install\` — @electric-sql/pglite is a devDependency.`,
      );
    }

    const out = execFileSync("node", [SCRIPT, PGLITE], {
      encoding: "utf8",
      timeout: 120_000,
    });

    expect(out).toMatch(/scorecard-action-counts\.pglite: \d+ assertions passed/);
    const count = Number(/: (\d+) assertions/.exec(out)?.[1] ?? 0);
    expect(count).toBeGreaterThanOrEqual(30);
  }, 150_000);
});
