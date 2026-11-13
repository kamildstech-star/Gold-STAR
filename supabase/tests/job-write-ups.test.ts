import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Runs the pglite fixture for FE11 (migration 20261028120000) in the normal gate. */
const SCRIPT = "supabase/tests/job-write-ups.pglite.mjs";
const PGLITE = "node_modules/@electric-sql/pglite/dist/index.js";

describe("job write-ups table", () => {
  it("lets the job's people write lines as themselves, and nobody else", () => {
    if (!existsSync(PGLITE)) expect.fail(`PGlite build not found at ${PGLITE}.`);
    const out = execFileSync("node", [SCRIPT, PGLITE], { encoding: "utf8", timeout: 120_000 });
    expect(out).toMatch(/job-write-ups\.pglite: \d+ assertions passed/);
    expect(Number(/: (\d+) assertions/.exec(out)?.[1] ?? 0)).toBeGreaterThanOrEqual(12);
  }, 150_000);
});
