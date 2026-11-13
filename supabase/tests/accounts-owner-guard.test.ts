import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Runs the pglite regression test for the accounts owner-column guard inside
 * the normal `npx vitest run` gate.
 *
 * The `.pglite.mjs` scripts in this directory are standalone by design — they
 * take the PGlite build as an argument and are run by hand. That means nothing
 * in CI notices when one of them breaks. This wrapper executes the real script
 * as a child process rather than restating its assertions here, so there is
 * exactly one copy of the test and the gate covers it.
 *
 * What it proves, against the real migration file and the live `accounts_update`
 * policy, in order:
 *   1. BEFORE the guard: a rep may move their own account to another office and
 *      approve their own lead, while `assigned_rep` happens to be refused by the
 *      policy's WITH CHECK — the measurement that corrected how this bug was
 *      first reported;
 *   2. AFTER it: all six protected columns are refused with a message naming
 *      the column, including inside a SECURITY DEFINER context where RLS does
 *      not apply;
 *   3. a rep can still edit name and notes on their own account, and managers,
 *      sales heads, admins and the cron user keep working.
 */

const SCRIPT = "supabase/tests/accounts-owner-guard.pglite.mjs";
const PGLITE = "node_modules/@electric-sql/pglite/dist/index.js";

describe("a rep cannot change ownership or approval columns on their own account", () => {
  it("refuses the six protected columns and leaves every normal edit working", () => {
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
    expect(out).toMatch(/accounts-owner-guard\.pglite: \d+ assertions passed/);
    const count = Number(/: (\d+) assertions/.exec(out)?.[1] ?? 0);
    expect(count).toBeGreaterThanOrEqual(40);
  }, 150_000);
});
