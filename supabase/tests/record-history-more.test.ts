import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Runs the pglite fixture for the second set of record_history tables inside
 * the normal `npx vitest run` gate (same arrangement as `todo-items.test.ts`).
 *
 * What it proves, against #300's, #312's and this migration read from their
 * files in order: old entries survive row_pk becoming text; a batch of photos
 * is one entry, restored together, only by a project manager, "purged" when
 * gone for good, backfilled once; crew put back regain the job; contact
 * methods and answers revert and restore within can_manage_job; drying
 * readings follow their UPDATE and DELETE rules and skip weather rows; a
 * moisture point comes back with its readings; estimates and Quick
 * Estimates still work; the live audit runs clean.
 */

const SCRIPT = "supabase/tests/record-history-more.pglite.mjs";
const PGLITE = "node_modules/@electric-sql/pglite/dist/index.js";

describe("record_history: the second set of tables", () => {
  it("photos, crew, contact methods, answers, drying and moisture readings", () => {
    if (!existsSync(PGLITE)) {
      expect.fail(
        `PGlite build not found at ${PGLITE}. Run \`npm install\` — @electric-sql/pglite is a devDependency.`,
      );
    }
    const out = execFileSync("node", [SCRIPT, PGLITE], { encoding: "utf8", timeout: 120_000 });
    expect(out).toMatch(/record-history-more\.pglite: \d+ assertions passed/);
    const count = Number(/: (\d+) assertions/.exec(out)?.[1] ?? 0);
    expect(count).toBeGreaterThanOrEqual(65);
  }, 150_000);
});
