import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Runs the real 20261022160000_invoice_followups.sql against in-memory
 * stand-in tables (PGlite) — never the project's database — proving the
 * seeds, the once-per-step lock, and that paying an invoice or switching its
 * follow-ups off cancels reminders still waiting. See the .pglite.mjs file.
 */
const SCRIPT = "supabase/tests/invoice-followups.pglite.mjs";
const PGLITE = "node_modules/@electric-sql/pglite/dist/index.js";

describe("invoice follow-ups migration", () => {
  it("seeds once, locks each step, and cancels on payment or off", () => {
    if (!existsSync(PGLITE)) expect.fail(`PGlite build not found at ${PGLITE}. Run npm install.`);
    const out = execFileSync("node", [SCRIPT, PGLITE], { encoding: "utf8", timeout: 120_000 });
    const count = Number(/invoice follow-ups: (\d+) assertions passed/.exec(out)?.[1] ?? 0);
    expect(count).toBeGreaterThanOrEqual(12);
  }, 150_000);
});
