import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Runs the pglite regression test for the annual-meeting cadence filter inside
 * the normal `npx vitest run` gate.
 *
 * The `.pglite.mjs` scripts in this directory are standalone by design — they
 * take the PGlite build as an argument and are run by hand. That means nothing
 * in CI notices when one of them breaks. This wrapper executes the real script
 * as a child process rather than restating its assertions here, so there is
 * exactly one copy of the test and the gate covers it.
 *
 * What it proves, against the real trigger and the real migration:
 *   1. `tg_touchpoint_cadence` really does set counts_toward_cadence = false
 *      for a calendar meeting marked not-held — the premise, not assumed;
 *   2. before 20260914140000 that cancelled meeting was the account's
 *      `last_in_person_at`, so the annual clock read as satisfied;
 *   3. after it, the last REAL visit is what the clock sees, while a meeting
 *      that did happen — including a manually logged one with no flag ticked —
 *      still resets it;
 *   4. `security_invoker` survives the DROP/CREATE, and `last_touch_at` is
 *      deliberately left unfiltered.
 *
 * The TypeScript half of the same fix is in src/lib/cadence-sweep.test.ts.
 */

const SCRIPT = "supabase/tests/annual-meeting-cadence.pglite.mjs";
const PGLITE = "node_modules/@electric-sql/pglite/dist/index.js";

describe("a cancelled meeting does not satisfy the annual visit", () => {
  it("filters last_in_person_at by counts_toward_cadence", () => {
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
    expect(out).toMatch(/annual-meeting-cadence\.pglite: \d+ assertions passed/);
    const count = Number(/: (\d+) assertions/.exec(out)?.[1] ?? 0);
    expect(count).toBeGreaterThanOrEqual(12);
  }, 150_000);
});
