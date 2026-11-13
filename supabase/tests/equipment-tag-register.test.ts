import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Runs the real 20261026120000_equipment_tag_register.sql against in-memory
 * stand-in tables (PGlite) — never the project's database — and proves the
 * 5,640 pre-printed plates land once each, existing units update rather than
 * duplicate (matched dash/case-insensitively), ambiguous ties are skipped, a
 * unit on a job keeps its status, CAT1/CAT2 go to the CAT location, and a
 * second run changes nothing. See equipment-tag-register.pglite.mjs.
 */
const SCRIPT = "supabase/tests/equipment-tag-register.pglite.mjs";
const PGLITE = "node_modules/@electric-sql/pglite/dist/index.js";
const SQL = readFileSync("supabase/migrations/20261026120000_equipment_tag_register.sql", "utf8");

describe("pre-printed equipment tag register (26 Oct)", () => {
  it("applies idempotently against fixture tables", () => {
    if (!existsSync(PGLITE)) expect.fail(`PGlite build not found at ${PGLITE}. Run npm install.`);
    const out = execFileSync("node", [SCRIPT, PGLITE], { encoding: "utf8", timeout: 240_000 });
    const count = Number(/equipment tag register: (\d+) assertions passed/.exec(out)?.[1] ?? 0);
    expect(count).toBeGreaterThanOrEqual(55);
  }, 300_000);

  it("never places a unit on a job or changes a unit's status", () => {
    const code = SQL.replace(/--[^\n]*/g, "");
    expect(code).not.toMatch(/equipment_placements/);
    expect(code).not.toMatch(/SET[\s\S]{0,200}\bstatus\s*=/);
  });
});
