import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Runs the pglite regression test for Melly's "what counts as a follow-up"
 * rule (20261110190000) inside the normal `npx vitest run` gate: a
 * hand-logged touch counts only with proof, auto-replies never count, calls
 * count at two minutes, history keeps the old rule, the pipeline still hears
 * a rep's "They responded", and only managers read the self-cleared share.
 */
const SCRIPT = "supabase/tests/followup-proof.pglite.mjs";
const PGLITE = "node_modules/@electric-sql/pglite/dist/index.js";

describe("a follow-up counts only when the client responds", () => {
  it("needs proof on a hand-logged touch and ignores auto-replies, without re-judging history", () => {
    if (!existsSync(PGLITE)) {
      expect.fail(
        `PGlite build not found at ${PGLITE}. Run \`npm install\` — @electric-sql/pglite is a devDependency.`,
      );
    }
    const out = execFileSync("node", [SCRIPT, PGLITE], { encoding: "utf8", timeout: 120_000 });
    expect(out).toMatch(/followup-proof\.pglite: \d+ assertions passed/);
    const count = Number(/: (\d+) assertions/.exec(out)?.[1] ?? 0);
    expect(count).toBeGreaterThanOrEqual(24);
  }, 150_000);
});
