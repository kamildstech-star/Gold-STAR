import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The security review's section 1 inside the normal `npx vitest run` gate:
 * a Postgres carrying Supabase's own default privileges, the two real sweep
 * migrations, and anon attacking every table, function, sequence and bucket
 * shape production has — including a function created AFTER the sweep, which
 * must start closed. The .pglite.mjs script is the one copy of the test.
 */
const SCRIPT = "supabase/tests/anon-surface.pglite.mjs";
const PGLITE = "node_modules/@electric-sql/pglite/dist/index.js";

describe("anonymous access, at the database", () => {
  it("anon reads, writes and executes nothing; signed-in users lose nothing", () => {
    if (!existsSync(PGLITE))
      expect.fail(`PGlite build not found at ${PGLITE}. Run \`npm install\`.`);
    const out = execFileSync("node", [SCRIPT, PGLITE], { encoding: "utf8", timeout: 120_000 });
    expect(out).toMatch(/anon-surface\.pglite: \d+ assertions passed/);
    expect(Number(/: (\d+) assertions/.exec(out)?.[1] ?? 0)).toBeGreaterThanOrEqual(29);
  }, 150_000);
});
