import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Runs the pglite fixture for FE12 (migration 20261028130000) in the normal gate. */
const SCRIPT = "supabase/tests/job-room-sketches.pglite.mjs";
const PGLITE = "node_modules/@electric-sql/pglite/dist/index.js";

describe("job room sketches table", () => {
  it("lets the job's people add and mark up sketches, and nobody else", () => {
    if (!existsSync(PGLITE)) expect.fail(`PGlite build not found at ${PGLITE}.`);
    const out = execFileSync("node", [SCRIPT, PGLITE], { encoding: "utf8", timeout: 120_000 });
    expect(out).toMatch(/job-room-sketches\.pglite: \d+ assertions passed/);
    expect(Number(/: (\d+) assertions/.exec(out)?.[1] ?? 0)).toBeGreaterThanOrEqual(12);
  }, 150_000);
});
