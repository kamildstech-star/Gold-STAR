import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Runs the pglite regression test for `job_running_cost` (migration
 * 20260918100000) inside the normal `npx vitest run` gate, the way
 * scorecard-action-counts.test.ts does for its script: one copy of the
 * assertions, in the .mjs, and CI notices when they break.
 *
 * What the script proves: on a job carrying one of every cost source, each
 * source lands in its own column; the total is the sum of the counted
 * columns and the calculator projection is not among them; labour is deduped
 * by day the way rollUpLabour() does it; a typed cost line adds to the
 * derived figures rather than replacing them; the revenue ladder picks the
 * newest PRICED estimate over empty drafts; a rep gets no row at all; and the
 * overview reports the same figure as the job.
 */

const SCRIPT = "supabase/tests/running-cost-all-sources.pglite.mjs";
const PGLITE = "node_modules/@electric-sql/pglite/dist/index.js";

describe("job_running_cost adds up every source of cost on a job", () => {
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

    expect(out).toMatch(/running-cost-all-sources\.pglite: \d+ assertions passed/);
    const count = Number(/: (\d+) assertions/.exec(out)?.[1] ?? 0);
    expect(count).toBeGreaterThanOrEqual(40);
  }, 150_000);
});
