import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Runs the pglite fixture for the job checklist templates and the retroactive
 * pass inside the normal `npx vitest run` gate. Same arrangement as
 * `todo-items.test.ts`: the `.pglite.mjs` script is the one copy of the test,
 * executed as a child process.
 *
 * What it proves, against migration 20261006174500 read from the file:
 *   1. templates and switches read by staff, written only by is_privileged
 *      (the Supply catalog's rule), never deleted, closed to portal customers;
 *   2. the ledger remembers every automatic key, so a deleted task is never
 *      put back;
 *   3. the dry run writes nothing; the real run adds the lists to open jobs
 *      only, honours the switches, skips closed jobs, inactive lines and
 *      deleted tasks, leaves done tasks done and renames open ones;
 *   4. a second run adds nothing;
 *   5. the admin screen's narrow mode only extends groups a job already has;
 *   6. only an admin (or the SQL editor) can run it.
 */

const SCRIPT = "supabase/tests/job-task-templates.pglite.mjs";
const PGLITE = "node_modules/@electric-sql/pglite/dist/index.js";

describe("job checklist templates and the retroactive pass", () => {
  it("admin-only edits, a ledger of deleted tasks, an idempotent backfill of open jobs", () => {
    if (!existsSync(PGLITE)) {
      expect.fail(
        `PGlite build not found at ${PGLITE}. Run \`npm install\` — @electric-sql/pglite is a devDependency.`,
      );
    }

    const out = execFileSync("node", [SCRIPT, PGLITE], {
      encoding: "utf8",
      timeout: 120_000,
    });

    expect(out).toMatch(/job-task-templates\.pglite: \d+ assertions passed/);
    const count = Number(/: (\d+) assertions/.exec(out)?.[1] ?? 0);
    expect(count).toBeGreaterThanOrEqual(61);
  }, 150_000);
});
