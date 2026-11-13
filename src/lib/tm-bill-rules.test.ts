/**
 * TM3: the T&M bill's fee and multiplier rules — Settings, overridable per
 * job — applied in the bill.
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { buildTmBill, type PricedCode } from "./tm-bill";
import {
  DEFAULT_TM_BILL_RULES,
  cleanRules,
  resolveRules,
  splitAmount,
  splitHours,
  type TmBillRules,
} from "./tm-bill-rules";

const R = (over: Partial<TmBillRules> = {}): TmBillRules => ({ ...DEFAULT_TM_BILL_RULES, ...over });
const TUE = "2024-11-05";
const SAT = "2024-11-09";

describe("splitHours", () => {
  it("by default bills every hour straight on a weekday (the sample's 9-hour days)", () => {
    expect(splitHours(TUE, 9, R())).toEqual({ regular: 9, premium: [] });
  });

  it("weekend and holiday hours are all premium", () => {
    expect(splitHours(SAT, 8, R()).premium).toEqual([
      { multiplier: 1.5, hours: 8, reason: "weekend" },
    ]);
    expect(splitHours(TUE, 8, R({ holidays: [TUE] })).premium).toEqual([
      { multiplier: 2, hours: 8, reason: "holiday" },
    ]);
  });

  it("hours outside the standard window are after-hours, the rest past the threshold overtime", () => {
    // A rule set saved before the overtime modes: window and threshold both apply.
    const rules = R({
      overtimeMode: "legacy",
      standardStart: "09:00",
      standardEnd: "17:00",
      dailyOtAfterHours: 8,
    });
    // 07:00–19:00, 12 h: 4 h after hours, 8 h inside — no overtime left
    const s = splitHours(TUE, 12, rules, { timeIn: "07:00", timeOut: "19:00" });
    expect(s.regular).toBe(8);
    expect(s.premium).toEqual([{ multiplier: 1.5, hours: 4, reason: "after hours" }]);
    // 09:00–19:00 with an 8 h threshold: 2 h after hours, 8 h regular
    expect(
      splitHours(TUE, 10, R({ overtimeMode: "daily", dailyOtAfterHours: 8 }), {
        timeIn: "09:00",
        timeOut: "19:00",
      }),
    ).toEqual({ regular: 8, premium: [{ multiplier: 1.5, hours: 2, reason: "overtime" }] });
  });

  it("prices a split at the rate", () => {
    expect(
      splitAmount(88, { regular: 8, premium: [{ multiplier: 1.5, hours: 2, reason: "x" }] }),
    ).toBe(8 * 88 + 2 * 132);
  });
});

describe("the rules' layers", () => {
  it("reads stored rules defensively — junk dropped, never thrown", () => {
    expect(
      cleanRules({
        taxPercent: "8.87%",
        weekendDays: [6, 0, 9, "x"],
        holidays: ["2024-11-28", "nope"],
        otMultiplier: 99,
        fieldFormCode: " gl ",
        standardStart: "25:00",
      }),
    ).toEqual({
      taxPercent: 8.87,
      weekendDays: [0, 6],
      holidays: ["2024-11-28"],
      fieldFormCode: "GL",
    });
    expect(cleanRules("nope")).toEqual({});
  });

  it("job overrides Settings key by key; Settings overrides the defaults", () => {
    const r = resolveRules({ taxPercent: 6.625, perDiemPerPersonDay: 50 }, { taxPercent: 8.87 });
    expect(r.taxPercent).toBe(8.87);
    expect(r.perDiemPerPersonDay).toBe(50);
    expect(r.opPercent).toBe(20);
  });
});

describe("the fees in the bill", () => {
  const codes: PricedCode[] = [
    { code: "SCL", label: "SCL", section: "labor", rate: 88 },
    { code: "106", label: "HEPA filter", section: "consumable", rate: 108.48 },
    { code: "GEN-PERDIEM", label: "Per Diem", section: "general", rate: 45 },
  ];
  const signRow = (lodging: boolean) => ({
    employee: "A",
    rateCode: "SCL",
    timeIn: "08:00",
    timeOut: "16:00",
    lunchStart: "",
    lunchEnd: "",
    lodging,
    signature: "s",
  });
  const bill = (rules: Partial<TmBillRules>, lines = [] as { code: string; qty: number }[]) =>
    buildTmBill({
      range: { from: TUE, to: TUE },
      signIns: [
        {
          date: TUE,
          payload: { rows: [signRow(true), { ...signRow(false), employee: "B" }] } as never,
        },
      ],
      supplies: [{ date: TUE, payload: { lines } as never }],
      equipment: [],
      codes,
      includeUnsigned: false,
      rules: R(rules),
    });

  it("Small Tools is 3% of billed labor; Per Diem $45 per person-day marked on the sign-in", () => {
    const b = bill({});
    expect(b.assoc.map((a) => a.smallTools)).toEqual([21.12, 21.12]);
    expect(b.assoc.map((a) => a.perDiem)).toEqual([45, 0]);
  });

  it("O&P is 20% on a third-party bill, under Subcontractors and Vendors", () => {
    const b = bill({}, [{ code: "GEN-OP", qty: 1000 }]);
    expect(b.categories.find((c) => c.key === "subcontractors")!.amount).toBe(1200);
  });

  it("Debris Removal is passed through plus 20%", () => {
    const b = bill({}, [{ code: "GEN-DEBRIS", qty: 500 }]);
    expect(b.categories.find((c) => c.key === "reimbursables")!.amount).toBe(600);
  });

  it("the job's tax applies to the taxable lines only", () => {
    const b = bill({ taxPercent: 8.87 }, [{ code: "106", qty: 10 }]);
    // materials 1084.80 taxable; labor is not
    expect(b.tax).toBe(Math.round(1084.8 * 8.87) / 100);
  });
});

describe("wiring", () => {
  it("the bill reads Settings and the job's override, and passes the rules in", () => {
    const run = readFileSync("src/lib/tm-bill-run.ts", "utf8");
    expect(run).toMatch(/loadTmBillRules\(client, job\.id\)/);
    expect(run).toMatch(/rules: source\.rules\.resolved/);
  });

  it("T&M / Cost Rules edit the company's rules; the bill dialog edits one job's", () => {
    // Billing & Costs, prompt 2: the old T&M rate codes card is retired.
    expect(readFileSync("src/components/billing-costs/rules-panel.tsx", "utf8")).toContain(
      "saveGeneralRules(supabase as never,",
    );
    // Prompt 5: the old codes page is gone; its codes are Catalogs items.
    expect(existsSync("src/components/tm-rate-codes-admin.tsx")).toBe(false);
    expect(readFileSync("src/components/tm-bill-dialog.tsx", "utf8")).toContain(
      "saveJobTmRules(supabase as never, job.id, next)",
    );
  });
});
