import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Runs the pglite fixture for delete/edit history and Restore inside the
 * normal `npx vitest run` gate. Same arrangement as `todo-items.test.ts`: the
 * `.pglite.mjs` script is the one copy of the test, executed as a child
 * process, so nothing is restated here and the gate still covers it.
 *
 * What it proves, against the real migration file: capture by trigger
 * (whole row on delete, moved columns on edit, no noise); history readable
 * only with the job and never its before-image; restore only within each
 * table's own delete/update rule; the allow-list held twice; idempotent
 * restores; conflicts refused and named; an estimate restored whole with its
 * withheld unit cost; and a mutation showing the rule is what refuses crew.
 */

const SCRIPT = "supabase/tests/record-history.pglite.mjs";
const PGLITE = "node_modules/@electric-sql/pglite/dist/index.js";

describe("record_history: delete and edit history with Restore", () => {
  it("captures, stays inside each table's rule, and restores idempotently", () => {
    if (!existsSync(PGLITE)) {
      expect.fail(
        `PGlite build not found at ${PGLITE}. Run \`npm install\` — @electric-sql/pglite is a devDependency.`,
      );
    }

    const out = execFileSync("node", [SCRIPT, PGLITE], {
      encoding: "utf8",
      timeout: 120_000,
    });

    expect(out).toMatch(/record-history\.pglite: \d+ assertions passed/);
    const count = Number(/: (\d+) assertions/.exec(out)?.[1] ?? 0);
    expect(count).toBeGreaterThanOrEqual(85);
  }, 150_000);
});
