import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Runs the real 20261026160000_equipment_add_from_scan.sql against in-memory
 * stand-in tables (PGlite) — never the project's database: an unknown plate
 * is added and audited, a normalized duplicate (or one in an office the
 * person cannot see) hands back the existing unit, crew are refused with
 * 42501, and a misread is never written. See equipment-add-from-scan.pglite.mjs.
 */
const SCRIPT = "supabase/tests/equipment-add-from-scan.pglite.mjs";
const PGLITE = "node_modules/@electric-sql/pglite/dist/index.js";
const SQL = readFileSync("supabase/migrations/20261026160000_equipment_add_from_scan.sql", "utf8");

describe("add equipment from a scan (26 Oct)", () => {
  it("applies against fixture tables", () => {
    if (!existsSync(PGLITE)) expect.fail(`PGlite build not found at ${PGLITE}. Run npm install.`);
    const out = execFileSync("node", [SCRIPT, PGLITE], { encoding: "utf8", timeout: 120_000 });
    const count = Number(/equipment add from scan: (\d+) assertions passed/.exec(out)?.[1] ?? 0);
    expect(count).toBeGreaterThanOrEqual(15);
  }, 150_000);

  it("keeps the register's own permission rule and the scanner's plate shape", () => {
    expect(SQL).toMatch(/NOT public\.can_manage_location\(v_uid, _location_id\)/);
    expect(SQL).toMatch(
      /'\^\[A-Z\]\{2,5\}-\[A-Z\]\{0,4\}\[0-9\]\{1,8\}-\[A-Z\]\{2,3\}\[0-9\]\?\$'/,
    );
    const ts = readFileSync("src/lib/equipment-scan.ts", "utf8");
    expect(ts).toContain("const TAG_SHAPE = /^[A-Z]{2,5}-[A-Z]{0,4}\\d{1,8}-[A-Z]{2,3}\\d?$/;");
  });
});
