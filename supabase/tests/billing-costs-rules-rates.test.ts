import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Runs the pglite fixture for Billing & Costs prompt 2 (migration
 * 20261030120000) inside the normal `npx vitest run` gate.
 *
 * What it proves: every priced T&M code and equipment type resolves through
 * the office-aware store to exactly its old rate; office overrides, resets
 * and dates resolve as specified, the bill's resolver reads the job's office
 * as of its creation date and new jobs freeze their office's rate; General
 * rules are seeded from the old Settings with tax carried untouched; both
 * saves are admin-only, all-or-nothing and audited with their note.
 */

const SCRIPT = "supabase/tests/billing-costs-rules-rates.pglite.mjs";
const PGLITE = "node_modules/@electric-sql/pglite/dist/index.js";

describe("Billing & Costs General rules and T&M rates (pglite)", () => {
  it("carries every old rate and rule, resolves by office and date, audits every change", () => {
    if (!existsSync(PGLITE)) {
      expect.fail(
        `PGlite build not found at ${PGLITE}. Run \`npm install\` — @electric-sql/pglite is a devDependency.`,
      );
    }
    const out = execFileSync("node", [SCRIPT, PGLITE], { encoding: "utf8", timeout: 120_000 });
    expect(out).toMatch(/billing-costs-rules-rates\.pglite: \d+ assertions passed/);
    const count = Number(/: (\d+) assertions/.exec(out)?.[1] ?? 0);
    expect(count).toBeGreaterThanOrEqual(60);
  }, 150_000);
});
