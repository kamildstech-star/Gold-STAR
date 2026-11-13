import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The portal security fixture stubs the staff tables it needs rather than
 * running the whole migration history. That is only a real test of the portal
 * functions if the stubs have production's column TYPES: Postgres checks a
 * SQL function's declared return type against the columns it selects when the
 * function is created, and a plpgsql RETURN QUERY at its first call.
 *
 * 2026-09-28: the fixture stubbed `photos.id` and `photo_variants.photo_id` as
 * uuid. Production has text (a ULID). So 20260928131000 passed all 129
 * assertions here and then failed on the live apply:
 *   return type mismatch in function declared to return uuid (42P13) —
 *   Actual return type is text. SQL function "portal_set_photos".
 *
 * This compares every key column the fixture stubs — `id` and `*_id` — with
 * the type production's own migrations give it, so that class of slip fails
 * CI instead of the live apply.
 */

const FIXTURE = readFileSync("supabase/tests/client-portal-security.pglite.mjs", "utf8").replace(
  /\r\n/g,
  "\n",
);
const MIG_DIR = "supabase/migrations/";
const MIGRATIONS = readdirSync(MIG_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(MIG_DIR + f, "utf8").replace(/\r\n/g, "\n"));

/** "uuid", "text", "integer"… — the base type, without modifiers or defaults. */
function baseType(decl: string): string {
  const t = decl
    .trim()
    .toLowerCase()
    .replace(/^public\./, "");
  const first = t.split(/[\s(]/)[0]!;
  const alias: Record<string, string> = { int: "integer", int4: "integer", varchar: "text" };
  return alias[first] ?? first;
}

/** Top-level comma-separated items of a CREATE TABLE body (commas inside () ignored). */
function columns(body: string): Map<string, string> {
  const out = new Map<string, string>();
  let depth = 0;
  let cur = "";
  const flush = () => {
    const line = cur.replace(/--.*$/gm, "").trim();
    cur = "";
    const m = /^"?([a-z_][a-z0-9_]*)"?\s+(.+)$/is.exec(line);
    if (!m) return;
    const name = m[1]!.toLowerCase();
    if (/^(primary|unique|foreign|check|constraint|exclude)$/.test(name)) return;
    out.set(name, baseType(m[2]!));
  };
  for (const ch of body) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) flush();
    else cur += ch;
  }
  flush();
  return out;
}

/** The body between the opening paren at `start` and its matching close. */
function parenBody(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "(") depth++;
    if (src[i] === ")" && --depth === 0) return src.slice(open + 1, i);
  }
  return "";
}

function stubTables(): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  for (const m of FIXTURE.matchAll(/CREATE TABLE public\.([a-z_]+) \(/g)) {
    out.set(m[1]!, columns(parenBody(FIXTURE, m.index! + m[0].length - 1)));
  }
  return out;
}

/** A column's type in production, as the last migration to set it left it. */
function productionType(table: string, column: string): string | null {
  let type: string | null = null;
  const create = new RegExp(`CREATE TABLE (?:IF NOT EXISTS )?public\\.${table} \\(`, "g");
  const add = new RegExp(
    `ALTER TABLE (?:ONLY )?public\\.${table}\\b[^;]*?ADD COLUMN (?:IF NOT EXISTS )?${column}\\s+([a-z_.]+)`,
    "gis",
  );
  const alter = new RegExp(
    `ALTER TABLE (?:ONLY )?public\\.${table}\\b[^;]*?ALTER COLUMN ${column}\\s+(?:SET DATA )?TYPE\\s+([a-z_.]+)`,
    "gis",
  );
  for (const sql of MIGRATIONS) {
    for (const m of sql.matchAll(create)) {
      const t = columns(parenBody(sql, m.index! + m[0].length - 1)).get(column);
      if (t) type = t;
    }
    for (const m of sql.matchAll(add)) type = baseType(m[1]!);
    for (const m of sql.matchAll(alter)) type = baseType(m[1]!);
  }
  return type;
}

describe("the portal fixture's stubs have production's key types", () => {
  const stubs = stubTables();

  it("finds the stubbed tables, photos among them", () => {
    expect(stubs.get("photos")?.get("id")).toBeDefined();
    expect(stubs.size).toBeGreaterThan(10);
  });

  it("gives every id and *_id column the type production gives it", () => {
    const wrong: string[] = [];
    for (const [table, cols] of stubs) {
      for (const [col, stubType] of cols) {
        if (col !== "id" && !col.endsWith("_id")) continue;
        const prod = productionType(table, col);
        // A column no migration defines is a stub-only helper (the fixture's
        // own staff_ledger); nothing in production to compare with.
        if (prod == null) continue;
        if (prod !== stubType) wrong.push(`${table}.${col}: stub ${stubType}, production ${prod}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("knows photo ids are text, the case that reached the live database", () => {
    expect(productionType("photos", "id")).toBe("text");
    expect(productionType("photo_variants", "photo_id")).toBe("text");
    expect(stubs.get("photos")!.get("id")).toBe("text");
  });
});
