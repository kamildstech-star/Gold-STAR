import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Runs the pglite fixture for the data-only migration 20261012090000 inside
 * the normal `npx vitest run` gate: five free government sources arrive
 * switched off and pinned to their areas, a re-run changes nothing, the
 * Lakewood area leaves CAT's placeholder point (unless an admin already
 * moved it), and no schema object changes.
 */

const SCRIPT = "supabase/tests/fire-feed-government-sources.pglite.mjs";
const PGLITE = "node_modules/@electric-sql/pglite/dist/index.js";

describe("fire feed government sources, data-only migration (pglite)", () => {
  it("adds the five sources switched off and fixes the Lakewood centre", () => {
    if (!existsSync(PGLITE)) {
      expect.fail(
        `PGlite build not found at ${PGLITE}. Run \`npm install\` — @electric-sql/pglite is a devDependency.`,
      );
    }
    const out = execFileSync("node", [SCRIPT, PGLITE], { encoding: "utf8", timeout: 120_000 });
    expect(out).toMatch(/fire-feed-government-sources.pglite: \d+ assertions passed/);
    const count = Number(/: (\d+) assertions/.exec(out)?.[1] ?? 0);
    expect(count).toBeGreaterThanOrEqual(19);
  }, 150_000);
});
