import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Runs the pglite fixture for the public-record cache inside the normal
 * `npx vitest run` gate, the same arrangement as account-proposals.test.ts.
 *
 * What it proves, against migration 20261014160000 read from the file: no
 * column can hold phone or email, SELECT follows incidents visibility (and
 * keeps following it), signed-in users cannot write, anon holds nothing, the
 * restrictive guards are on, and deleting an incident deletes its record.
 */

const SCRIPT = "supabase/tests/incident-public-records.pglite.mjs";
const PGLITE = "node_modules/@electric-sql/pglite/dist/index.js";

describe("incident public records (pglite)", () => {
  it("cache table: shape, visibility via incidents, read-only to users, guards", () => {
    if (!existsSync(PGLITE)) {
      expect.fail(
        `PGlite build not found at ${PGLITE}. Run \`npm install\` — @electric-sql/pglite is a devDependency.`,
      );
    }
    const out = execFileSync("node", [SCRIPT, PGLITE], { encoding: "utf8", timeout: 120_000 });
    expect(out).toMatch(/incident-public-records\.pglite: \d+ assertions passed/);
    const count = Number(/: (\d+) assertions/.exec(out)?.[1] ?? 0);
    expect(count).toBeGreaterThanOrEqual(24);
  }, 150_000);
});
