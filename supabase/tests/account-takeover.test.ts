import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The security review's account-takeover guards inside `npx vitest run`: the
 * real role, membership and profile policies, the privilege-guard trigger,
 * the active-profile guard and handle_new_user, all read from the migration
 * files, attacked by a fresh signup, an approved non-admin and an admin. See
 * the .pglite.mjs script's header for the list.
 */
const SCRIPT = "supabase/tests/account-takeover.pglite.mjs";
const PGLITE = "node_modules/@electric-sql/pglite/dist/index.js";

describe("account takeover, at the database", () => {
  it("an unapproved signup reads nothing, nobody self-escalates, sessions end", () => {
    if (!existsSync(PGLITE))
      expect.fail(`PGlite build not found at ${PGLITE}. Run \`npm install\`.`);
    const out = execFileSync("node", [SCRIPT, PGLITE], { encoding: "utf8", timeout: 120_000 });
    expect(out).toMatch(/account-takeover\.pglite: \d+ assertions passed/);
    expect(Number(/: (\d+) assertions/.exec(out)?.[1] ?? 0)).toBeGreaterThanOrEqual(29);
  }, 150_000);
});
