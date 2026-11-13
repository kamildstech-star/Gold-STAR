import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Runs the pglite fixture for Microsoft 365 delegated connections inside the
 * normal `npx vitest run` gate, the same arrangement as todo-items.test.ts:
 * the `.pglite.mjs` script is the one copy of the test.
 *
 * What it proves, against the real migration file: anon has nothing; a
 * person reads only their own connection row and writes none; the encrypted
 * refresh token is unreadable to every client role, even after a stray
 * grant; a deactivated person loses their row; portal_customer is denied
 * restrictively; one Microsoft account per Recovery Hub user; cascades.
 */

const SCRIPT = "supabase/tests/microsoft-connections.pglite.mjs";
const PGLITE = "node_modules/@electric-sql/pglite/dist/index.js";

describe("microsoft_connections row boundary", () => {
  it("own-row metadata, no client can read a token, portal and anon denied", () => {
    if (!existsSync(PGLITE)) {
      expect.fail(
        `PGlite build not found at ${PGLITE}. Run \`npm install\` — @electric-sql/pglite is a devDependency.`,
      );
    }
    const out = execFileSync("node", [SCRIPT, PGLITE], { encoding: "utf8", timeout: 120_000 });
    expect(out).toMatch(/microsoft-connections\.pglite: \d+ assertions passed/);
    const count = Number(/: (\d+) assertions/.exec(out)?.[1] ?? 0);
    expect(count).toBeGreaterThanOrEqual(30);
  }, 150_000);
});
