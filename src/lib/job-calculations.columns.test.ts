import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  JOB_CALCULATION_PUBLIC_COLUMNS,
  JOB_CALCULATION_SELECT,
  savedCalculationFromRow,
  type JobCalculationRow,
} from "@/lib/job-calculations";

const migration = readFileSync(
  new URL(
    "../../supabase/migrations/20260909110000_calculator_cost_visibility.sql",
    import.meta.url,
  ),
  "utf8",
);
const source = readFileSync(new URL("./job-calculations.ts", import.meta.url), "utf8");
// 20261006141500 grants custom_lines and note: they were written on save but
// never readable, so reopening an estimate loaded them empty and the next Save
// wiped them. The cost columns stay withheld; the union below must still equal
// the public list exactly.
const linesGrant = readFileSync(
  new URL(
    "../../supabase/migrations/20261006141500_calculator_lines_and_note_readable.sql",
    import.meta.url,
  ),
  "utf8",
);

const COST_COLUMNS = ["internal_cost", "equipment_profit", "overall_profit"];

/** The column list inside `GRANT SELECT ( ... ) ON public.job_calculations`, across both grants. */
function grantedColumns(): string[] {
  return [migration, linesGrant].flatMap((sql) => {
    const match = sql.match(
      /GRANT SELECT \(([^)]*)\) ON public\.job_calculations TO authenticated;/,
    );
    if (!match) throw new Error("column grant not found");
    return match[1]
      .split(",")
      .map((column) => column.trim())
      .filter(Boolean);
  });
}

describe("job_calculations cost columns are withheld from the authenticated role", () => {
  it("keeps the PostgREST select string and the public column list in step", () => {
    expect(JOB_CALCULATION_SELECT).toBe(JOB_CALCULATION_PUBLIC_COLUMNS.join(","));
  });

  it("grants exactly the public columns, and never a cost column", () => {
    expect(migration).toContain("REVOKE SELECT ON public.job_calculations FROM authenticated;");
    expect(migration).toContain("REVOKE SELECT ON public.job_calculations FROM anon;");
    expect(grantedColumns()).toEqual([...JOB_CALCULATION_PUBLIC_COLUMNS]);
    for (const column of COST_COLUMNS) {
      expect(JOB_CALCULATION_PUBLIC_COLUMNS as readonly string[]).not.toContain(column);
    }
  });

  it("reads the snapshot only through a job.view_costs-gated definer function", () => {
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.job_calculation_costs\(_calculation_id uuid\)[\s\S]*SECURITY DEFINER[\s\S]*has_permission\(auth\.uid\(\), 'job\.view_costs', c\.location_id\)/,
    );
    expect(migration).toContain(
      "REVOKE EXECUTE ON FUNCTION public.job_calculation_costs(uuid) FROM anon;",
    );
    expect(migration).toContain(
      "GRANT EXECUTE ON FUNCTION public.job_calculation_costs(uuid) TO authenticated;",
    );
  });

  it("has no select(\"*\") reader left — that now fails for everyone", () => {
    // The doc comment names the hazard; only a call site would carry the dot.
    expect(source).not.toContain('.select("*")');
    for (const column of COST_COLUMNS) {
      // The columns are still written on save; they are never selected.
      expect(source).not.toMatch(new RegExp(`select\\([^)]*${column}`));
    }
  });

  it("does not carry internal figures on the saved model the editor loads", () => {
    const row: JobCalculationRow = {
      id: "calc-1",
      location_id: "loc-1",
      job_id: null,
      job_date: "2026-09-09",
      customer_name: null,
      contact_number: null,
      email: null,
      address: null,
      address_line2: null,
      locality: null,
      region: null,
      postal_code: null,
      job_type: "water",
      days: 1,
      workers: 1,
      regular_hours: 0,
      after_hours: 0,
      emergency: false,
      garbage_fee: 0,
      miscellaneous_fee: 0,
      equipment_quantities: {},
      customer_price: 350,
      created_by: "u",
      created_at: "2026-09-09T00:00:00Z",
      updated_at: "2026-09-09T00:00:00Z",
    };
    const saved = savedCalculationFromRow(row);
    expect(saved.customerPrice).toBe(350);
    const serialized = JSON.stringify(saved);
    for (const key of [
      "internalCost",
      "overallProfit",
      "equipmentProfit",
      "internalRate",
      "internalTotal",
      "laborInternalCost",
      "truckInternalCost",
    ]) {
      expect(serialized).not.toContain(key);
    }
    // The fixture's internal cost is $300 — the same figure the QC report
    // saw. The saved model carries the $350 quote and nothing that is 300.
    expect(Object.values(saved)).not.toContain(300);
  });
});
