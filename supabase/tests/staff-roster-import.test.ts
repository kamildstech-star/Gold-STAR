import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Runs the real 20261022120000_staff_roster_import.sql against in-memory
 * stand-in tables (PGlite) — never the project's database — and proves the
 * import matches by email case-insensitively, keeps admin/dev, creates only
 * the missing offices, creates no sign-in account from SQL, and that a
 * second run changes nothing. See staff-roster-import.pglite.mjs.
 */
const SCRIPT = "supabase/tests/staff-roster-import.pglite.mjs";
const PGLITE = "node_modules/@electric-sql/pglite/dist/index.js";
const SQL = readFileSync("supabase/migrations/20261022120000_staff_roster_import.sql", "utf8");
const code = SQL.replace(/--[^\n]*/g, "");

describe("staff roster import (22 Oct)", () => {
  it("applies idempotently against fixture tables", () => {
    if (!existsSync(PGLITE)) expect.fail(`PGlite build not found at ${PGLITE}. Run npm install.`);
    const out = execFileSync("node", [SCRIPT, PGLITE], { encoding: "utf8", timeout: 120_000 });
    const count = Number(/staff roster import: (\d+) assertions passed/.exec(out)?.[1] ?? 0);
    expect(count).toBeGreaterThanOrEqual(18);
  }, 150_000);

  it("never writes auth tables, and never removes admin or dev", () => {
    expect(code).not.toMatch(/INSERT INTO auth\./i);
    expect(code).not.toMatch(/UPDATE auth\./i);
    expect(code).not.toMatch(/DELETE FROM auth\./i);
    expect(code).toMatch(/ur\.role NOT IN \('admin', 'dev'\)/);
  });

  it("lists all 37 people, each email once and lower-case", () => {
    const emails = [...code.matchAll(/^\s+\('([^']+@[^']+)',/gm)].map((m) => m[1]!);
    expect(emails).toHaveLength(37);
    expect(new Set(emails).size).toBe(37);
    for (const e of emails) expect(e).toBe(e.toLowerCase());
  });

  it("holds the shared mailbox", () => {
    expect(code).toMatch(/\('bo@goldstarrestoration\.com',[^\n]*'hold'/);
  });
});
