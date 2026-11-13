/**
 * TM7: job costing from the same field data the T&M bill bills — internal
 * only, never on a customer document.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { buildTmBill, tmBillInvoiceLines, tmBillWorkbook, type PricedCode } from "./tm-bill";
import { COST_MULTIPLIERS, tmJobCost, tmMargin } from "./tm-job-cost";

const DAY = "2024-11-05";
const codes: PricedCode[] = [
  { code: "SCL", label: "SCL", section: "labor", rate: 88, costRate: 45 },
  { code: "106", label: "HEPA filter", section: "consumable", rate: 108.48, costRate: 60 },
  { code: "329", label: "HEPA Vacuum", section: "equipment", rate: 48.5, costRate: null },
];
const row = (employee: string) => ({
  employee,
  rateCode: "SCL",
  timeIn: "08:00",
  timeOut: "16:00",
  lunchStart: "",
  lunchEnd: "",
  lodging: false,
  signature: "s",
});
const bill = buildTmBill({
  range: { from: DAY, to: DAY },
  signIns: [{ date: DAY, payload: { rows: [row("A"), row("B")] } as never }],
  supplies: [
    {
      date: DAY,
      payload: {
        lines: [
          { code: "106", qty: 4 },
          { code: "329", qty: 6 },
          { code: "GEN-OP", qty: 1000 },
        ],
      } as never,
    },
  ],
  equipment: [],
  codes,
  includeUnsigned: false,
});

describe("tmJobCost", () => {
  const cost = tmJobCost(bill, codes);

  it("prices the same hours and quantities the bill bills, at cost", () => {
    expect(cost.labor).toBe(2 * 8 * 45);
    expect(cost.materials).toBe(4 * 60);
    // the third-party bill's own amount; the O&P on it is margin
    expect(cost.passThrough).toBe(1000);
    expect(cost.total).toBe(720 + 240 + 0 + 1000);
  });

  it("names codes with no cost rate rather than guessing — counted at $0", () => {
    expect(cost.equipment).toBe(0);
    expect(cost.missingCost).toEqual(["329"]);
  });

  it("flags the multipliers as placeholders awaiting David", () => {
    expect(COST_MULTIPLIERS.awaitingDavid).toBe(true);
    expect(cost.provisional).toBe(true);
  });

  it("margin is billed less cost, and its percent of billed", () => {
    expect(tmMargin(2000, 1500)).toEqual({ margin: 500, pct: 25 });
    expect(tmMargin(0, 100)).toEqual({ margin: -100, pct: null });
  });
});

describe("costs never enter client-facing output", () => {
  it("the customer copy and the workbook are the same with or without cost rates", () => {
    const noCosts = buildTmBill({
      range: { from: DAY, to: DAY },
      signIns: [{ date: DAY, payload: { rows: [row("A"), row("B")] } as never }],
      supplies: [
        {
          date: DAY,
          payload: {
            lines: [
              { code: "106", qty: 4 },
              { code: "329", qty: 6 },
              { code: "GEN-OP", qty: 1000 },
            ],
          } as never,
        },
      ],
      equipment: [],
      codes: codes.map(({ costRate: _c, ...c }) => c),
      includeUnsigned: false,
    });
    expect(tmBillInvoiceLines(bill)).toEqual(tmBillInvoiceLines(noCosts));
    expect(JSON.stringify(tmBillWorkbook(bill, { jobNumber: "1", customer: "X" }))).toEqual(
      JSON.stringify(tmBillWorkbook(noCosts, { jobNumber: "1", customer: "X" })),
    );
  });

  it("no bill or workbook code reads a cost rate", () => {
    const src = readFileSync("src/lib/tm-bill.ts", "utf8");
    const out = src.slice(src.indexOf("/* Out: the draft invoice's lines"));
    expect(out).not.toMatch(/costRate|cost_rate/);
  });

  it("the job page shows it only inside the cost viewer's Amounts card", () => {
    const page = readFileSync("src/routes/_authenticated/jobs.$id.tsx", "utf8");
    const at = page.indexOf("<TmJobCostRows");
    expect(at).toBeGreaterThan(-1);
    // 3 Nov: the cost viewer's branch opens before the card it renders.
    const branch = page.slice(page.lastIndexOf("{showMoney ? (", at), at);
    expect(branch).toContain(">Amounts<");
    expect(branch).not.toMatch(/\) : /);
    const run = readFileSync("src/lib/tm-bill-run.ts", "utf8");
    expect(run).toMatch(/if \(!settingsCosts && !jobCosts\) return null;/);
  });
});
