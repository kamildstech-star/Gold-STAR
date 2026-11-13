import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { CABINET_KINDS, OPENING_KINDS } from "../../src/lib/room-takeoff";

/**
 * Runs the pglite fixture for field capture's tables inside the normal
 * `npx vitest run` gate, the same arrangement as `job-photo-day-counts.test.ts`:
 * the `.pglite.mjs` script is the one copy of the test, executed as a child
 * process, so nothing is restated here.
 *
 * What it proves, against the real migration files: the new tables carry
 * job_rooms' policies clause for clause (so office scoping on every verb), a
 * door cannot claim a room on another job, a room's doors and cabinets go with
 * it, portal customers and anon are refused, and the file re-runs cleanly.
 */

const SCRIPT = "supabase/tests/room-field-capture.pglite.mjs";
const PGLITE = "node_modules/@electric-sql/pglite/dist/index.js";
const MIGRATION = "supabase/migrations/20261006140000_room_field_capture.sql";

describe("field capture's tables are scoped exactly like job_rooms", () => {
  it("passes the pglite fixture", () => {
    if (!existsSync(PGLITE)) {
      expect.fail(
        `PGlite build not found at ${PGLITE}. Run \`npm install\` — @electric-sql/pglite is a devDependency.`,
      );
    }
    const out = execFileSync("node", [SCRIPT, PGLITE], { encoding: "utf8", timeout: 120_000 });
    expect(out).toMatch(/room-field-capture\.pglite: \d+ assertions passed/);
    const count = Number(/: (\d+) assertions/.exec(out)?.[1] ?? 0);
    expect(count).toBeGreaterThanOrEqual(40);
  }, 150_000);

  it("allows exactly the kinds the app offers", () => {
    // The SQL cannot import the TypeScript lists, so the two are held together
    // here: a kind on the screen the database refuses would fail every save.
    const sql = readFileSync(MIGRATION, "utf8").replace(/--[^\n]*/g, "");
    const kinds = (column: string, table: string) => {
      const create = sql.slice(sql.indexOf(`CREATE TABLE IF NOT EXISTS public.${table}`));
      const check = new RegExp(`${column} text NOT NULL CHECK \\(${column} IN \\(([^)]*)\\)`).exec(
        create,
      )![1]!;
      return [...check.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    };
    expect(kinds("kind", "job_room_openings")).toEqual(OPENING_KINDS.map((k) => k.value).sort());
    expect(kinds("kind", "job_room_cabinets")).toEqual(CABINET_KINDS.map((k) => k.value).sort());
  });
});
