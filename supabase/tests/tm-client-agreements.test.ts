import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Runs the pglite fixture for T&M client agreements (migration
 * 20261107120000) inside the normal `npx vitest run` gate.
 *
 * What it proves: an agreement is exceptions over T&M Rates (owner/admin,
 * noted, audited); a new T&M job freezes its client's agreement and the bill
 * reads it; the office switches a job's agreement keeping rates typed for the
 * job; a job that becomes T&M picks it up; strip and archive.
 */

const SCRIPT = "supabase/tests/tm-client-agreements.pglite.mjs";
const PGLITE = "node_modules/@electric-sql/pglite/dist/index.js";

describe("T&M client agreements (pglite)", () => {
  it("prices T&M jobs from their client's agreement, frozen, switchable by the office", () => {
    if (!existsSync(PGLITE)) {
      expect.fail(
        `PGlite build not found at ${PGLITE}. Run \`npm install\` — @electric-sql/pglite is a devDependency.`,
      );
    }
    const out = execFileSync("node", [SCRIPT, PGLITE], { encoding: "utf8", timeout: 120_000 });
    expect(out).toMatch(/tm-client-agreements\.pglite: \d+ assertions passed/);
    const count = Number(/: (\d+) assertions/.exec(out)?.[1] ?? 0);
    expect(count).toBeGreaterThanOrEqual(40);
  }, 150_000);
});
