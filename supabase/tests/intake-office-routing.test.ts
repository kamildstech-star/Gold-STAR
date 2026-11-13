import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Runs the pglite fixture for intake office routing inside the normal
 * `npx vitest run` gate, the same arrangement as `todo-items.test.ts`: the
 * `.pglite.mjs` script is the one copy of the test, executed as a child
 * process, so nothing is restated here.
 *
 * What it proves, against the real migration files (20260903223000,
 * 20261006170000, 20261006171000): the state / ZIP rules are readable by any signed-in user
 * and writable only by privileged staff, hold only a state code or a 3–5
 * digit ZIP prefix with one office each, vanish with their office, are closed
 * to portal customers; the reason column holds only the code's reasons; and a
 * waiting general-link form can be re-routed by a privileged user but not
 * pulled across offices by a manager; and the intake card's quick switch moves
 * a form only between offices the caller manages, is stamped with the caller
 * and the time by the database, and is never matched by the re-route again.
 */

const SCRIPT = "supabase/tests/intake-office-routing.pglite.mjs";
const PGLITE = "node_modules/@electric-sql/pglite/dist/index.js";

describe("intake office rules in the database", () => {
  it("rules RLS, rule shape, reasons, the re-route boundary, and the hand-set office", () => {
    if (!existsSync(PGLITE)) {
      expect.fail(
        `PGlite build not found at ${PGLITE}. Run \`npm install\` — @electric-sql/pglite is a devDependency.`,
      );
    }
    const out = execFileSync("node", [SCRIPT, PGLITE], { encoding: "utf8", timeout: 120_000 });
    expect(out).toMatch(/intake-office-routing\.pglite: \d+ assertions passed/);
    const count = Number(/: (\d+) assertions/.exec(out)?.[1] ?? 0);
    expect(count).toBeGreaterThanOrEqual(34);
  }, 150_000);
});
