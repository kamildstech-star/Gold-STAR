import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Runs the pglite fixture for the to-do list's row boundary inside the normal
 * `npx vitest run` gate. Same arrangement as `job-create-grant.test.ts`: the
 * `.pglite.mjs` script is the one copy of the test and is executed as a child
 * process, so nothing is restated here and the gate still covers it.
 *
 * What it proves, against the real migration file:
 *   1. a rep sees and changes their own rows and nobody else's, on all four
 *      verbs, and cannot file a row as somebody else;
 *   2. deleting a task deletes its pins; deleting a job leaves the quick
 *      item under "No job";
 *   3. a quick item needs a title, one pin per task per person, two people
 *      can pin the same task;
 *   4. `promote_todo_item` writes the task and the pin in one transaction —
 *      the second write failing rolls the first back — and a replay with
 *      the same task id files no second task.
 */

const SCRIPT = "supabase/tests/todo-items.pglite.mjs";
const PGLITE = "node_modules/@electric-sql/pglite/dist/index.js";

describe("todo_items is a personal list", () => {
  it("owner-only RLS, the cascades, and an atomic promote-to-task", () => {
    if (!existsSync(PGLITE)) {
      expect.fail(
        `PGlite build not found at ${PGLITE}. Run \`npm install\` — @electric-sql/pglite is a devDependency.`,
      );
    }

    const out = execFileSync("node", [SCRIPT, PGLITE], {
      encoding: "utf8",
      timeout: 120_000,
    });

    expect(out).toMatch(/todo-items\.pglite: \d+ assertions passed/);
    const count = Number(/: (\d+) assertions/.exec(out)?.[1] ?? 0);
    expect(count).toBeGreaterThanOrEqual(40);
  }, 150_000);
});
