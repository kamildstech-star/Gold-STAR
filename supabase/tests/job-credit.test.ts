import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Runs the pglite regression test for commission credit at job arrival
 * (20261110180000) inside the normal `npx vitest run` gate: the credit is
 * snapshotted from the account's rep and stage when the job arrives, locked
 * against later reassignment, paid to that rep by the engine, auto-approved
 * for Conversation Established and clients, and never clawed back.
 */
const SCRIPT = "supabase/tests/job-credit.pglite.mjs";
const PGLITE = "node_modules/@electric-sql/pglite/dist/index.js";

describe("commission credit locks at job arrival", () => {
  it("credits the account's rep, holds through reassignment, and auto-approves by stage", () => {
    if (!existsSync(PGLITE)) {
      expect.fail(
        `PGlite build not found at ${PGLITE}. Run \`npm install\` — @electric-sql/pglite is a devDependency.`,
      );
    }
    const out = execFileSync("node", [SCRIPT, PGLITE], { encoding: "utf8", timeout: 120_000 });
    expect(out).toMatch(/job-credit\.pglite: \d+ assertions passed/);
    const count = Number(/: (\d+) assertions/.exec(out)?.[1] ?? 0);
    expect(count).toBeGreaterThanOrEqual(20);
  }, 150_000);
});
