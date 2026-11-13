import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { PAYMENT_ATTACHMENT_DOC_TYPE } from "../../src/lib/documents";

/**
 * Runs the pglite fixture for `job_photo_day_counts` inside the normal
 * `npx vitest run` gate, the same arrangement as `todo-items.test.ts`: the
 * `.pglite.mjs` script is the one copy of the test, executed as a child
 * process, so nothing is restated here.
 *
 * What it proves, against the real migration file: per-folder per-day counts
 * in the viewer's zone, the page's own rules for what counts as a picture,
 * that it counts through the caller's RLS, that anon cannot run it, that a bad
 * zone raises, and that the keyset index matches the page order.
 */

const SCRIPT = "supabase/tests/job-photo-day-counts.pglite.mjs";
const PGLITE = "node_modules/@electric-sql/pglite/dist/index.js";
const MIGRATION = "supabase/migrations/20261005191500_job_photo_day_counts.sql";

describe("job_photo_day_counts is the Pictures tab's count", () => {
  it("counts per folder per day, as the caller, by the page's rules", () => {
    if (!existsSync(PGLITE)) {
      expect.fail(
        `PGlite build not found at ${PGLITE}. Run \`npm install\` — @electric-sql/pglite is a devDependency.`,
      );
    }
    const out = execFileSync("node", [SCRIPT, PGLITE], { encoding: "utf8", timeout: 120_000 });
    expect(out).toMatch(/job-photo-day-counts\.pglite: \d+ assertions passed/);
    const count = Number(/: (\d+) assertions/.exec(out)?.[1] ?? 0);
    expect(count).toBeGreaterThanOrEqual(13);
  }, 150_000);

  it("leaves out the same document type the gallery does", () => {
    // The SQL cannot import the TypeScript constant, so the two literals are
    // held together here: a cheque photo must not be counted on a header the
    // gallery would then fail to fill.
    const sql = readFileSync(MIGRATION, "utf8").replace(/--[^\n]*/g, "");
    const excluded = sql.match(/d\.doc_type <> '([a-z_]+)'/);
    expect(excluded![1]).toBe(PAYMENT_ATTACHMENT_DOC_TYPE);
  });
});
