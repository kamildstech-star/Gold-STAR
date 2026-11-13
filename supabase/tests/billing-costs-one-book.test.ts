import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Runs the pglite fixture for Billing & Costs prompt 5 (migration
 * 20261102120000) inside the normal `npx vitest run` gate: the T&M sheet in
 * Catalogs with the mirror retired, the freeze proven book by book, T&M job
 * estimates priced from T&M Rates, and "Strip lines equal to Standard".
 */

const SCRIPT = "supabase/tests/billing-costs-one-book.pglite.mjs";
const PGLITE = "node_modules/@electric-sql/pglite/dist/index.js";

describe("Billing & Costs one book for the T&M sheet, and the freeze (pglite)", () => {
  it("moves the sheet into Catalogs, retires the mirror and freezes every book", () => {
    if (!existsSync(PGLITE)) {
      expect.fail(
        `PGlite build not found at ${PGLITE}. Run \`npm install\` — @electric-sql/pglite is a devDependency.`,
      );
    }
    const out = execFileSync("node", [SCRIPT, PGLITE], { encoding: "utf8", timeout: 120_000 });
    expect(out).toMatch(/billing-costs-one-book\.pglite: \d+ assertions passed/);
    const count = Number(/: (\d+) assertions/.exec(out)?.[1] ?? 0);
    expect(count).toBeGreaterThanOrEqual(25);
  }, 150_000);
});
