import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Runs the pglite fixture for emailed info-request replies inside the normal
 * `npx vitest run` gate, the same arrangement as account-proposals.test.ts.
 *
 * What it proves, against migration 20261013121500 read from the file: the
 * new columns default existing rows to 'form', one suggestion per Graph
 * message, the review can record decisions but never rewrite the source,
 * RLS still decides who may decide, and the guards and grants are intact.
 */

const SCRIPT = "supabase/tests/intake-submission-email-replies.pglite.mjs";
const PGLITE = "node_modules/@electric-sql/pglite/dist/index.js";

describe("intake submission email replies (pglite)", () => {
  it("suggestions from email replies: shape, one per message, fixed source, access", () => {
    if (!existsSync(PGLITE)) {
      expect.fail(
        `PGlite build not found at ${PGLITE}. Run \`npm install\` — @electric-sql/pglite is a devDependency.`,
      );
    }
    const out = execFileSync("node", [SCRIPT, PGLITE], { encoding: "utf8", timeout: 120_000 });
    expect(out).toMatch(/intake-submission-email-replies\.pglite: \d+ assertions passed/);
    const count = Number(/: (\d+) assertions/.exec(out)?.[1] ?? 0);
    expect(count).toBeGreaterThanOrEqual(19);
  }, 150_000);
});
