import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Runs the pglite fixture for the Add payment dialog's split save inside the
 * normal `npx vitest run` gate (same arrangement as `job-field-revert.test.ts`).
 *
 * What it proves, against invoice_payments' own table, policies, rollup and
 * payment trail read from their migration files: one insert of several rows
 * is all or none under the caller's RLS; the rollup moves every invoice in
 * the split; the rows share created_at/created_by (what "split across" reads);
 * the trail still records a corrected or removed row; and, as a mutation, a
 * row-at-a-time loop leaves a half-recorded payment.
 */

const SCRIPT = "supabase/tests/add-payment-split.pglite.mjs";
const PGLITE = "node_modules/@electric-sql/pglite/dist/index.js";

describe("Add payment: a split payment is one all-or-none insert", () => {
  it("records every invoice's share or none, under the write policy, through the rollup", () => {
    if (!existsSync(PGLITE)) {
      expect.fail(
        `PGlite build not found at ${PGLITE}. Run \`npm install\` — @electric-sql/pglite is a devDependency.`,
      );
    }
    const out = execFileSync("node", [SCRIPT, PGLITE], { encoding: "utf8", timeout: 120_000 });
    expect(out).toMatch(/add-payment-split\.pglite: \d+ assertions passed/);
    const count = Number(/: (\d+) assertions/.exec(out)?.[1] ?? 0);
    expect(count).toBeGreaterThanOrEqual(24);
  }, 150_000);
});
