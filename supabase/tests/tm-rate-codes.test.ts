import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Runs the pglite fixture for the T&M rate code catalogue inside the normal
 * `npx vitest run` gate, the same arrangement as job-task-templates.test.ts.
 *
 * What it proves, against migration 20261007230000 read from the file: the
 * seed is the Daily Supply List (157 lines, per-section counts) and survives
 * a re-run without undoing an admin's edit; staff read, only is_privileged
 * writes, nobody deletes, codes cannot be renamed; inactive profiles, anon and
 * portal customers are shut out.
 */

const SCRIPT = "supabase/tests/tm-rate-codes.pglite.mjs";
const PGLITE = "node_modules/@electric-sql/pglite/dist/index.js";

describe("T&M rate code catalogue (pglite)", () => {
  it("is the supply list, read by staff, edited by admins only, never deleted", () => {
    if (!existsSync(PGLITE)) {
      expect.fail(
        `PGlite build not found at ${PGLITE}. Run \`npm install\` — @electric-sql/pglite is a devDependency.`,
      );
    }
    const out = execFileSync("node", [SCRIPT, PGLITE], { encoding: "utf8", timeout: 120_000 });
    expect(out).toMatch(/tm-rate-codes\.pglite: \d+ assertions passed/);
    const count = Number(/: (\d+) assertions/.exec(out)?.[1] ?? 0);
    expect(count).toBeGreaterThanOrEqual(26);
  }, 150_000);
});
