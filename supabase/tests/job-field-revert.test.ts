import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Runs the pglite fixture for reverting a job's own fields inside the normal
 * `npx vitest run` gate (same arrangement as `todo-items.test.ts`).
 *
 * What it proves, against the original logger and the revert migration read
 * from their files: a stage move reverts as one edit and is logged with
 * reverts_id; twice is a no-op; another office cannot read the change and
 * crew are refused by jobs_update; a field changed again since refuses and
 * is named; money never reverts; types survive the text round trip;
 * reverts_id cannot be claimed; the functions are SECURITY INVOKER; and a
 * mutation shows the jobs policy is what refuses crew.
 */

const SCRIPT = "supabase/tests/job-field-revert.pglite.mjs";
const PGLITE = "node_modules/@electric-sql/pglite/dist/index.js";

describe("job field revert", () => {
  it("reverts within the jobs policy, refuses conflicts and never touches money", () => {
    if (!existsSync(PGLITE)) {
      expect.fail(
        `PGlite build not found at ${PGLITE}. Run \`npm install\` — @electric-sql/pglite is a devDependency.`,
      );
    }
    const out = execFileSync("node", [SCRIPT, PGLITE], { encoding: "utf8", timeout: 120_000 });
    expect(out).toMatch(/job-field-revert\.pglite: \d+ assertions passed/);
    const count = Number(/: (\d+) assertions/.exec(out)?.[1] ?? 0);
    expect(count).toBeGreaterThanOrEqual(34);
  }, 150_000);
});
