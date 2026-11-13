import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Runs the pglite regression test for the compliance requirement direction
 * inside the normal `npx vitest run` gate.
 *
 * The `.pglite.mjs` scripts in this directory are standalone by design — they
 * take the PGlite build as an argument and are run by hand. That means nothing
 * in CI notices when one of them breaks. This wrapper executes the real script
 * as a child process rather than restating its assertions here, so there is
 * exactly one copy of the test and the gate covers it.
 *
 * What it proves, against the real migration file:
 *   1. `direction` does not exist before 20260914120000, and every row that
 *      predates it keeps the meaning it always had (gsr_to_client);
 *   2. both directions of one requirement type can then coexist, once each;
 *   3. the correctness fix — a requirement the CLIENT owes us is never
 *      satisfied by Gold Star's OWN company credential, only by a file filed
 *      against it, so the health card cannot go green for a document nobody
 *      has chased;
 *   4. applying it twice is identical to applying it once.
 */

const SCRIPT = "supabase/tests/compliance-direction.pglite.mjs";
const PGLITE = "node_modules/@electric-sql/pglite/dist/index.js";

describe("compliance requirements carry a direction", () => {
  it("adds the direction additively and keeps our credentials off client-owed rows", () => {
    // A missing PGlite build is an environment gap, not a regression — say so
    // rather than failing the suite with a confusing stack.
    if (!existsSync(PGLITE)) {
      expect.fail(
        `PGlite build not found at ${PGLITE}. Run \`npm install\` — @electric-sql/pglite is a devDependency.`,
      );
    }

    const out = execFileSync("node", [SCRIPT, PGLITE], {
      encoding: "utf8",
      timeout: 120_000,
    });

    // The script asserts internally and exits non-zero on failure, which
    // execFileSync turns into a throw. This pins the count too, so a future
    // edit that quietly drops assertions is visible.
    expect(out).toMatch(/compliance-direction\.pglite: \d+ assertions passed/);
    const count = Number(/: (\d+) assertions/.exec(out)?.[1] ?? 0);
    expect(count).toBeGreaterThanOrEqual(22);
  }, 150_000);
});
