import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Runs the pglite regression test for the job-creation 403 inside the normal
 * `npx vitest run` gate.
 *
 * The `.pglite.mjs` scripts in this directory are standalone by design — they
 * take the PGlite build as an argument and are run by hand. That means nothing
 * in CI notices when one of them breaks. This wrapper executes the real script
 * as a child process rather than restating its assertions here, so there is
 * exactly one copy of the test and the gate covers it.
 *
 * What it proves, against the real migration files, in order:
 *   1. inserting a job as `authenticated` fails with "permission denied for
 *      function next_job_number" before 20260914090000, and succeeds after it;
 *   2. once `job_number_settings` has a row — which is what makes the
 *      ON CONFLICT path run at all — the insert fails with
 *      'column reference "scope_key" is ambiguous' before 20260914100000, and
 *      succeeds with an incrementing number after it;
 *   3. `next_job_number()` stays uncallable by end users throughout.
 */

const SCRIPT = "supabase/tests/job-create-grant.pglite.mjs";
const PGLITE = "node_modules/@electric-sql/pglite/dist/index.js";

describe("job creation is not blocked by the next_job_number grant", () => {
  it("inserts a job as a non-service role and gets an incrementing job_number", () => {
    // A missing PGlite build is an environment gap, not a regression — say so
    // rather than failing the suite with a confusing stack.
    if (!existsSync(PGLITE)) {
      expect.fail(
        `PGlite build not found at ${PGLITE}. Run \`npm install\` — @electric-sql/pglite is a devDependency.`,
      );
    }

    const out = execFileSync("node", [SCRIPT, PGLITE], {
      encoding: "utf8",
      timeout: 120_000,
    });

    // The script asserts internally and exits non-zero on failure, which
    // execFileSync turns into a throw. This pins the count too, so a future
    // edit that quietly drops assertions is visible.
    expect(out).toMatch(/job-create-grant\.pglite: \d+ assertions passed/);
    const count = Number(/: (\d+) assertions/.exec(out)?.[1] ?? 0);
    expect(count).toBeGreaterThanOrEqual(21);
  }, 150_000);
});
