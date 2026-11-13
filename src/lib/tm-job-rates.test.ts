/**
 * TM2: each job carries its own rate sheet over Settings; the T&M bill reads
 * the job's rate first, and a code at $0 is set for the job in one click.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import { buildTmBill, type PricedCode } from "./tm-bill";
import { withJobCostRates, withJobRates } from "./tm-job-rates";

const settings: PricedCode[] = [
  { code: "SCL", label: "Structural Cleaning Labor", section: "labor", rate: 88 },
  { code: "104", label: "6 Mil Poly", section: "consumable", rate: null },
  { code: "106", label: "HEPA filter", section: "consumable", rate: 108.48 },
];

describe("withJobRates", () => {
  it("the job's rate wins; no job rate reads Settings; neither is 'none'", () => {
    const out = withJobRates(
      settings,
      new Map([
        ["SCL", 95],
        ["104", 150],
      ]),
    );
    expect(out.map((c) => [c.code, c.rate, c.rateSource])).toEqual([
      ["SCL", 95, "job"],
      ["104", 150, "job"],
      ["106", 108.48, "settings"],
    ]);
  });

  it("a database without job rates reads Settings unchanged", () => {
    expect(withJobRates(settings, null).map((c) => c.rate)).toEqual([88, null, 108.48]);
  });

  it("cost rates layer the same way", () => {
    const out = withJobCostRates(settings, new Map([["SCL", 40]]), new Map([["SCL", 45]]));
    expect(out[0]!.costRate).toBe(45);
    expect(out[1]!.costRate).toBeNull();
  });
});

describe("the bill prices from the job's sheet", () => {
  it("a code priced only for this job is billed at that price", () => {
    const codes = withJobRates(settings, new Map([["104", 150]]));
    const bill = buildTmBill({
      range: { from: "2024-11-06", to: "2024-11-06" },
      signIns: [],
      supplies: [{ date: "2024-11-06", payload: { lines: [{ code: "104", qty: 2 }] } as never }],
      equipment: [],
      codes,
      includeUnsigned: false,
    });
    expect(bill.materials[0]!.total).toBe(300);
    expect(bill.unpricedCodes).not.toContain("104");
  });
});

describe("wiring", () => {
  it("the bill's loader lays the job's rates over Settings", () => {
    const run = readFileSync("src/lib/tm-bill-run.ts", "utf8");
    expect(run).toMatch(/loadJobTmRates\(client, job\.id\)/);
    expect(run).toMatch(/withJobRates\(priced\.codes, jobRates\)/);
  });

  it("'billed at $0' offers 'Set for this job', which writes the job's sheet, not Settings", () => {
    const dialog = readFileSync("src/components/tm-bill-dialog.tsx", "utf8");
    expect(dialog).toContain("Set for this job");
    expect(dialog).toMatch(/setJobTmRate\(supabase as never, job\.id, code, raw\)/);
    expect(dialog).toMatch(/invalidateQueries\(\{ queryKey: \["tm-bill-source", job\.id\] \}\)/);
  });
});
