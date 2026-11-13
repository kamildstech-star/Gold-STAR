import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Runs the pglite fixture for migration 20261027170000 inside the normal
 * vitest gate: a signed document can be filed into a folder (folder_id only),
 * and existing signed work authorizations land in each job's
 * "Work Authorizations" folder.
 */
const SCRIPT = "supabase/tests/signed-document-folders.pglite.mjs";
const PGLITE = "node_modules/@electric-sql/pglite/dist/index.js";

describe("Signed documents can be filed into folders", () => {
  it("files a signed document by folder_id alone, and backfills work authorizations", () => {
    if (!existsSync(PGLITE)) expect.fail(`PGlite build not found at ${PGLITE}.`);
    const out = execFileSync("node", [SCRIPT, PGLITE], { encoding: "utf8", timeout: 120_000 });
    expect(out).toMatch(/signed-document-folders\.pglite: \d+ assertions passed/);
    expect(Number(/: (\d+) assertions/.exec(out)?.[1] ?? 0)).toBeGreaterThanOrEqual(24);
  }, 150_000);
});
