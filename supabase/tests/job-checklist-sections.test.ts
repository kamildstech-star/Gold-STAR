import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Runs the pglite fixture for migration 20261013122000 inside the normal
 * `npx vitest run` gate, the same arrangement as job-task-templates.test.ts:
 * the `.pglite.mjs` script is the one copy of the test, run as a child
 * process.
 *
 * Mark, 13 Oct: "these dont show up in the job", "let him turn off drying
 * log", "also let him make a new section if he wants". What it proves:
 *   1. the migration applies over 20261006174500 and over itself;
 *   2. a job whose legacy loss_type is NULL is typed by its picked option;
 *   3. the Water switch stops new Monitoring / Pick up and keeps the old;
 *   4. sections: admin-only, never built-in, fixed behaviour, read-only
 *      built-in rows, lines must belong to one;
 *   5. the pass adds a section by its types, trigger and due rule, once;
 *   6. delete only while nothing was ever made from it;
 *   7. the standard restrictive denials, no anon grant.
 */

const SCRIPT = "supabase/tests/job-checklist-sections.pglite.mjs";
const PGLITE = "node_modules/@electric-sql/pglite/dist/index.js";

describe("job checklist sections, the Water switch and the type fallback", () => {
  it("applies cleanly and enforces every rule against the real migration", () => {
    if (!existsSync(PGLITE)) {
      expect.fail(
        `PGlite build not found at ${PGLITE}. Run \`npm install\` — @electric-sql/pglite is a devDependency.`,
      );
    }

    const out = execFileSync("node", [SCRIPT, PGLITE], {
      encoding: "utf8",
      timeout: 120_000,
    });

    expect(out).toMatch(/job-checklist-sections\.pglite: \d+ assertions passed/);
    const count = Number(/: (\d+) assertions/.exec(out)?.[1] ?? 0);
    expect(count).toBeGreaterThanOrEqual(57);
  }, 150_000);
});
