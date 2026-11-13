import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Runs the pglite fixture for the email transport columns, claim and kick (20261012100000). */
const SCRIPT = "supabase/tests/email-transport-retry.pglite.mjs";
const PGLITE = "node_modules/@electric-sql/pglite/dist/index.js";

describe("parked email is retried by the sweep, safely", () => {
  it("backfill, claim, Resend, guard, kick and grants", () => {
    if (!existsSync(PGLITE))
      expect.fail(`PGlite build not found at ${PGLITE}. Run \`npm install\`.`);
    const out = execFileSync("node", [SCRIPT, PGLITE], { encoding: "utf8", timeout: 120_000 });
    expect(out).toMatch(/email-transport-retry\.pglite: \d+ assertions passed/);
    expect(Number(/: (\d+) assertions/.exec(out)?.[1] ?? 0)).toBeGreaterThanOrEqual(35);
  }, 150_000);
});
