/**
 * TM1: every T&M rate code carries a client rate and an internal cost rate,
 * seeded from David's "Lallypak Week 1" sample — never hardcoded in the app.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { LALLYPAK_RATES } from "./__fixtures__/lallypak-week1";
import { buildTmBill, type PricedCode } from "./tm-bill";

const SQL = readFileSync("supabase/migrations/20261027160000_tm_rate_catalog_costs.sql", "utf8");

describe("the catalogue migration", () => {
  it("adds cost_rate, unit and small_tools, cost starting empty", () => {
    expect(SQL).toMatch(/ADD COLUMN IF NOT EXISTS cost_rate numeric/);
    expect(SQL).toMatch(/ADD COLUMN IF NOT EXISTS unit text/);
    expect(SQL).toMatch(/ADD COLUMN IF NOT EXISTS small_tools boolean NOT NULL DEFAULT true/);
    expect(SQL).not.toMatch(/SET cost_rate\s*=/);
  });

  it("seeds every rate the sample bills, only where none is set", () => {
    const seeded = new Map(
      [...SQL.matchAll(/\('([A-Z0-9-]+)', (\d+\.\d{2})\)/g)].map((m) => [m[1]!, Number(m[2])]),
    );
    for (const [code, rate] of Object.entries(LALLYPAK_RATES)) {
      // The seven title rates were seeded on 26 Oct (20261026140000); the rest here.
      if (["GL", "SCL", "CCF", "PS", "PE", "SPM", "PCT"].includes(code)) continue;
      expect(seeded.get(code), code).toBe(rate);
    }
    expect(seeded.get("GEN-PERDIEM")).toBe(45);
    expect(SQL).toMatch(/AND t\.rate IS NULL;/);
  });

  it("adds EO, the one title the sample bills that the catalogue lacked", () => {
    expect(SQL).toMatch(/\('EO', 'labor', 'Equipment Operator', 95\)/);
  });

  it("withholds cost_rate from signed-in users and answers it to cost viewers only", () => {
    expect(SQL).toMatch(/REVOKE SELECT ON public\.tm_rate_codes FROM authenticated, anon;/);
    const grant = /GRANT SELECT \(([^)]*)\)\s+ON public\.tm_rate_codes TO authenticated/.exec(SQL)!;
    expect(grant[1]).not.toContain("cost_rate");
    expect(grant[1]).toContain("rate");
    expect(SQL).toMatch(/has_permission\(auth\.uid\(\), 'job\.view_costs', NULL\)/);
    expect(SQL).toMatch(/REVOKE ALL ON FUNCTION public\.tm_rate_code_costs\(\) FROM PUBLIC, anon;/);
  });

  it("never selects cost_rate from the table in the app", () => {
    const run = readFileSync("src/lib/tm-bill-run.ts", "utf8");
    expect(run).not.toMatch(/\.select\([^)]*cost_rate/);
    expect(run).toMatch(/rpc\("tm_rate_code_costs"/);
  });
});

describe("Small Tools follows each code's flag", () => {
  const codes: PricedCode[] = [
    {
      code: "SCL",
      label: "Structural Cleaning Labor",
      section: "labor",
      rate: 88,
      smallTools: true,
    },
    { code: "SPM", label: "Sr. Project Manager", section: "labor", rate: 130, smallTools: false },
    { code: "GEN-SMALLTOOLS", label: "Small tools", section: "general", rate: 3 },
  ];
  const row = (employee: string, rateCode: string) => ({
    employee,
    rateCode,
    timeIn: "08:00",
    timeOut: "16:00",
    lunchStart: "",
    lunchEnd: "",
    lodging: false,
    signature: "s",
  });

  it("charges 3% on field titles and nothing on management titles", () => {
    const bill = buildTmBill({
      range: { from: "2024-11-05", to: "2024-11-05" },
      signIns: [
        { date: "2024-11-05", payload: { rows: [row("A", "SCL"), row("B", "SPM")] } as never },
      ],
      supplies: [],
      equipment: [],
      codes,
      includeUnsigned: false,
    });
    expect(bill.assoc.map((a) => a.smallTools)).toEqual([21.12, 0]);
  });
});
