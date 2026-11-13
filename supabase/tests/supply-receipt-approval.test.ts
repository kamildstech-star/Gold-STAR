import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Runs the receipt approval fixture inside the normal `npx vitest run` gate.
 * Same arrangement as `todo-items.test.ts`: the `.pglite.mjs` script is the
 * one copy of the test and runs as a child process against the real
 * migration files, so nothing is restated here.
 *
 * Mark, 5 Oct: "...need to get approved just to add to purchase tracking."
 * An approval the browser enforces is decoration, so what this proves is the
 * database's answer: crew cannot approve or write purchase tracking, an
 * uploader cannot approve their own receipt, and approve_supply_receipt is
 * the only way a receipt's lines reach supply_purchases.
 */

const SCRIPT = "supabase/tests/supply-receipt-approval.pglite.mjs";
const PGLITE = "node_modules/@electric-sql/pglite/dist/index.js";

describe("a receipt reaches purchase tracking only through an approval", () => {
  it("separation of duties, approver authority, and the one door into supply_purchases", () => {
    if (!existsSync(PGLITE)) {
      expect.fail(
        `PGlite build not found at ${PGLITE}. Run \`npm install\` — @electric-sql/pglite is a devDependency.`,
      );
    }

    const out = execFileSync("node", [SCRIPT, PGLITE], {
      encoding: "utf8",
      timeout: 120_000,
    });

    expect(out).toMatch(/supply-receipt-approval\.pglite: \d+ assertions passed/);
    const count = Number(/: (\d+) assertions/.exec(out)?.[1] ?? 0);
    expect(count).toBeGreaterThanOrEqual(70);
  }, 150_000);
});
