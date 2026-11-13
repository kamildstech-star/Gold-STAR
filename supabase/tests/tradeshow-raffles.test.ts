import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Runs the pglite regression test for trade show raffles (20261110210000)
 * inside the normal `npx vitest run` gate: one entry per email while open,
 * only a manager draws, prizes fill to their quantity, nobody wins twice, the
 * disqualified are skipped, and a forfeited slot can be drawn again.
 */
const SCRIPT = "supabase/tests/tradeshow-raffles.pglite.mjs";
const PGLITE = "node_modules/@electric-sql/pglite/dist/index.js";

describe("trade show raffles", () => {
  it("enters once per email, draws fairly, never twice, and keeps forfeits", () => {
    if (!existsSync(PGLITE)) {
      expect.fail(
        `PGlite build not found at ${PGLITE}. Run \`npm install\` — @electric-sql/pglite is a devDependency.`,
      );
    }
    const out = execFileSync("node", [SCRIPT, PGLITE], { encoding: "utf8", timeout: 120_000 });
    expect(out).toMatch(/tradeshow-raffles\.pglite: \d+ assertions passed/);
    const count = Number(/: (\d+) assertions/.exec(out)?.[1] ?? 0);
    expect(count).toBeGreaterThanOrEqual(33);
  }, 150_000);
});
