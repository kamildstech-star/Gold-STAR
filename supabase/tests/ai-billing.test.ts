import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Runs the Falcon AI billing kit's SQL check inside the normal `npx vitest run`
 * gate, against migration 20261111120000_ai_billing.sql read from the file:
 * marginal-tier charging, Stripe grants once per payment, warnings, auto
 * top-up, the append-only ledger, who may call what, the console bridge's
 * read shapes and replay guard, and GSR's two hooks (who may buy credits, and
 * warnings to Owners and Admins in the bell).
 */

const SCRIPT = "supabase/tests/ai-billing.pglite.mjs";
const PGLITE = "node_modules/@electric-sql/pglite/dist/index.js";

describe("AI billing (pglite)", () => {
  it("charges, grants, warns and guards exactly as the console contract says", () => {
    if (!existsSync(PGLITE)) {
      expect.fail(
        `PGlite build not found at ${PGLITE}. Run \`npm install\` — @electric-sql/pglite is a devDependency.`,
      );
    }
    const out = execFileSync("node", [SCRIPT, PGLITE], { encoding: "utf8", timeout: 120_000 });
    expect(out).toMatch(/ai-billing\.pglite: \d+ checks passed/);
  }, 130_000);
});
