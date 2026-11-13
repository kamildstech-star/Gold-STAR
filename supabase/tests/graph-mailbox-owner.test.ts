import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Runs the pglite fixture for graph_mailboxes.owner_user_id (20261007210000). */
const SCRIPT = "supabase/tests/graph-mailbox-owner.pglite.mjs";
const PGLITE = "node_modules/@electric-sql/pglite/dist/index.js";

describe("graph_mailboxes.owner_user_id", () => {
  it("nullable, re-runnable, cleared when the owner goes, no policy or grant change", () => {
    if (!existsSync(PGLITE))
      expect.fail(`PGlite build not found at ${PGLITE}. Run \`npm install\`.`);
    const out = execFileSync("node", [SCRIPT, PGLITE], { encoding: "utf8", timeout: 120_000 });
    expect(out).toMatch(/graph-mailbox-owner\.pglite: \d+ assertions passed/);
    expect(Number(/: (\d+) assertions/.exec(out)?.[1] ?? 0)).toBeGreaterThanOrEqual(7);
  }, 150_000);
});
