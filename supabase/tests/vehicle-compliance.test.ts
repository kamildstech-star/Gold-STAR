import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Runs the pglite fixture for vehicle paperwork and maintenance inside the
 * normal `npx vitest run` gate. Same arrangement as `todo-items.test.ts`: the
 * `.pglite.mjs` script is the one copy of the test, executed as a child
 * process, so nothing is restated here and the gate still covers it.
 *
 * What it proves, against the real migration files in order
 * (20260928123000, 20260928124000, 20261005140000):
 *   1. the dates, the log and the new documents share one office boundary
 *      on every verb, and a van with no office is corporate / fleet.manage;
 *   2. the DOT inspection is an allowed kind; unknown kinds are not;
 *   3. a document evidences one thing, its path is its own van's, and a
 *      receipt cannot point at another van's record;
 *   4. a renewal supersedes the current document and keeps the old one;
 *   5. the private bucket reads by can_view_vehicle and writes by
 *      can_manage_vehicle;
 *   6. portal customers are denied;
 *   7. the daily sweep: expired paperwork reaches the office manager and the
 *      owner at high priority, a document in its last week only the manager,
 *      a viewer never, a rerun sends nothing new.
 */

const SCRIPT = "supabase/tests/vehicle-compliance.pglite.mjs";
const PGLITE = "node_modules/@electric-sql/pglite/dist/index.js";

describe("vehicle paperwork and maintenance", () => {
  it("office-scoped RLS, documents that supersede, a private bucket, and alerts", () => {
    if (!existsSync(PGLITE)) {
      expect.fail(
        `PGlite build not found at ${PGLITE}. Run \`npm install\` — @electric-sql/pglite is a devDependency.`,
      );
    }

    const out = execFileSync("node", [SCRIPT, PGLITE], {
      encoding: "utf8",
      timeout: 120_000,
    });

    expect(out).toMatch(/vehicle-compliance\.pglite: \d+ assertions passed/);
    const count = Number(/: (\d+) assertions/.exec(out)?.[1] ?? 0);
    expect(count).toBeGreaterThanOrEqual(55);
  }, 150_000);
});
