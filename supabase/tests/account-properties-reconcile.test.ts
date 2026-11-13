import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Runs the pglite fixture for the account_properties reconcile inside the
 * normal `npx vitest run` gate, the same arrangement as
 * `room-field-capture.test.ts`: the `.pglite.mjs` script is the one copy of the
 * test, executed as a child process, so nothing is restated here.
 *
 * What it proves, against the real migration files: a fresh replay (our
 * 20260903090500 and Lovable's 20260907164530 both ran) and live (only
 * Lovable's) end in the same shape after 20261007090000, with no duplicate
 * policy, index or trigger; writing a building needs the office's manager or
 * the account's rep, as 20260903090500 intended; a contact from another
 * company cannot be put on a building; portal customers and anon are refused.
 */

const SCRIPT = "supabase/tests/account-properties-reconcile.pglite.mjs";
const PGLITE = "node_modules/@electric-sql/pglite/dist/index.js";

describe("account_properties is reconciled to 20260903090500's design", () => {
  it("passes the pglite fixture on a replay and on live", () => {
    if (!existsSync(PGLITE)) {
      expect.fail(
        `PGlite build not found at ${PGLITE}. Run \`npm install\` — @electric-sql/pglite is a devDependency.`,
      );
    }
    const out = execFileSync("node", [SCRIPT, PGLITE], { encoding: "utf8", timeout: 120_000 });
    expect(out).toMatch(/account-properties-reconcile\.pglite: \d+ assertions passed/);
    const count = Number(/: (\d+) assertions/.exec(out)?.[1] ?? 0);
    expect(count).toBeGreaterThanOrEqual(70);
  }, 150_000);
});
