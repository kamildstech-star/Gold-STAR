import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  EQUIPMENT_COST_COLUMNS,
  EQUIPMENT_PUBLIC_COLUMNS,
  EQUIPMENT_SELECT,
  SUPPLY_ITEM_COST_COLUMNS,
  SUPPLY_ITEM_PUBLIC_COLUMNS,
  SUPPLY_ITEM_SELECT,
} from "@/lib/cost-columns";

const migration = readFileSync(
  new URL("../../supabase/migrations/20261027150000_cost_columns_withheld.sql", import.meta.url),
  "utf8",
);

/** The column list inside `GRANT SELECT ( ... ) ON public.<table> TO authenticated`. */
function grantedColumns(table: string): string[] {
  const match = migration.match(
    new RegExp(`GRANT SELECT \\(([^)]*)\\) ON public\\.${table} TO authenticated;`),
  );
  if (!match) throw new Error(`column grant for ${table} not found`);
  return match[1]
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
}

/** The guard's list of every column of a table (public + withheld). */
function guardedColumns(table: string): string[] {
  const match = migration.match(
    new RegExp(`table_name = '${table}'\\s*AND column_name <> ALL \\(ARRAY\\[([^\\]]*)\\]\\)`),
  );
  if (!match) throw new Error(`guard for ${table} not found`);
  return [...match[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

describe("supply_items.unit_cost and equipment cost columns are withheld", () => {
  it("keeps each PostgREST select string and its public column list in step", () => {
    expect(SUPPLY_ITEM_SELECT).toBe(SUPPLY_ITEM_PUBLIC_COLUMNS.join(", "));
    expect(EQUIPMENT_SELECT).toBe(EQUIPMENT_PUBLIC_COLUMNS.join(", "));
  });

  it("revokes the table-wide read and grants exactly the public columns", () => {
    for (const t of ["supply_items", "equipment"]) {
      expect(migration).toContain(`REVOKE SELECT ON public.${t} FROM authenticated;`);
      expect(migration).toContain(`REVOKE SELECT ON public.${t} FROM anon;`);
    }
    expect(grantedColumns("supply_items")).toEqual([...SUPPLY_ITEM_PUBLIC_COLUMNS]);
    expect(grantedColumns("equipment")).toEqual([...EQUIPMENT_PUBLIC_COLUMNS]);
  });

  it("never grants a cost column, and the guard lists public + cost = every column", () => {
    for (const c of SUPPLY_ITEM_COST_COLUMNS) {
      expect(SUPPLY_ITEM_PUBLIC_COLUMNS as readonly string[]).not.toContain(c);
    }
    for (const c of EQUIPMENT_COST_COLUMNS) {
      expect(EQUIPMENT_PUBLIC_COLUMNS as readonly string[]).not.toContain(c);
    }
    expect(guardedColumns("supply_items").sort()).toEqual(
      [...SUPPLY_ITEM_PUBLIC_COLUMNS, ...SUPPLY_ITEM_COST_COLUMNS].sort(),
    );
    expect(guardedColumns("equipment").sort()).toEqual(
      [...EQUIPMENT_PUBLIC_COLUMNS, ...EQUIPMENT_COST_COLUMNS].sort(),
    );
  });

  it("reads cost only through job.view_costs-gated definer functions", () => {
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.supply_item_costs\(\)[\s\S]*?SECURITY DEFINER[\s\S]*?has_permission\(auth\.uid\(\), 'job\.view_costs', NULL\)/,
    );
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.equipment_costs\(_ids uuid\[\] DEFAULT NULL\)[\s\S]*?SECURITY DEFINER[\s\S]*?can_view_location\(auth\.uid\(\), e\.location_id\)[\s\S]*?has_permission\(auth\.uid\(\), 'job\.view_costs', e\.location_id\)/,
    );
    for (const sig of ["supply_item_costs()", "equipment_costs(uuid[])"]) {
      expect(migration).toContain(`REVOKE ALL ON FUNCTION public.${sig} FROM PUBLIC, anon;`);
      expect(migration).toContain(
        `GRANT EXECUTE ON FUNCTION public.${sig} TO authenticated, service_role;`,
      );
    }
  });

  it("no browser reader of either table selects * or names a cost column", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(name) && !/\.test\.|\.server\.ts$|types\.ts$/.test(name)) {
          files.push(p);
        }
      }
    };
    walk("src");
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      // Direct reads: from("supply_items") / from("equipment") … .select(…)
      for (const m of src.matchAll(
        /from\("(supply_items|equipment)"\)\s*\.select\(\s*([^)]*)\)/g,
      )) {
        const cols = m[2];
        const cost = m[1] === "supply_items" ? SUPPLY_ITEM_COST_COLUMNS : EQUIPMENT_COST_COLUMNS;
        if (/"\*"/.test(cols) || cost.some((c) => cols.includes(c))) {
          offenders.push(`${f}: ${m[0].slice(0, 120)}`);
        }
      }
      // Embeds: equipment:equipment_id(…) / supply_items(…) / item:item_id(…)
      for (const m of src.matchAll(/(?:equipment:equipment_id|supply_items)\(([^)]*)\)/g)) {
        if (/\*|unit_cost|daily_rate_cents|purchase_cost_cents/.test(m[1])) {
          offenders.push(`${f}: ${m[0]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
