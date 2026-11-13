import { describe, expect, it } from "vitest";

import { buildTmBill, selectCategories, tmBillInvoiceLines, type PricedCode } from "@/lib/tm-bill";
import {
  DEFAULT_TM_BILL_RULES,
  cleanRules,
  resolveRules,
  type TmBillRules,
} from "@/lib/tm-bill-rules";
import type { SignInPayload, SignInRow } from "@/lib/tm-forms";

/*
 * Billing & Costs › General rules (prompt 2): the four overtime modes and the
 * added charges, each pinned to the exact cent on a small, hand-checked week.
 * Every expected figure is worked in the comment beside it.
 *
 * The week: Mon 19 Oct – Sun 25 Oct 2026. One SCL ($88/h) crew member, Jose,
 * works 07:00–18:30 with a 30-minute lunch Monday to Friday — 11 hours a day,
 * 55 in the week. Small Tools 3% on each person-day's labor (the default).
 */
const CODES: PricedCode[] = [
  { code: "SCL", label: "Structural Cleaning Labor", section: "labor", rate: 88 },
  { code: "SPM", label: "Sr. Project Manager", section: "labor", rate: 130, smallTools: false },
];
const WEEK = { from: "2026-10-19", to: "2026-10-25" };
const DAYS = ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23"];

const row = (over: Partial<SignInRow> = {}): SignInRow => ({
  id: Math.random().toString(36).slice(2),
  userId: "jose",
  employee: "Jose Ruiz",
  rateCode: "SCL",
  timeIn: "07:00",
  lunchStart: "12:00",
  lunchEnd: "12:30",
  timeOut: "18:30",
  lodging: "",
  signature: "data:image/png;base64,AAA",
  signedAt: null,
  ...over,
});
const sheet = (date: string, rows: SignInRow[]) => ({
  date,
  payload: { jobName: "", jobLocation: "", rows, removedIds: [] } as unknown as SignInPayload,
});
const week = (rows: () => SignInRow[] = () => [row()]) => DAYS.map((d) => sheet(d, rows()));

const bill = (rules: Partial<TmBillRules>, signIns = week()) =>
  buildTmBill({
    range: WEEK,
    signIns,
    supplies: [],
    equipment: [],
    codes: CODES,
    includeUnsigned: false,
    rules: { ...DEFAULT_TM_BILL_RULES, ...rules },
  });
const labor = (b: ReturnType<typeof bill>) => b.categories.find((c) => c.key === "billable_labor")!;

describe("overtime: after N hours a day", () => {
  it("bills each day's hours past 8 at 1.5×", () => {
    const b = bill({ overtimeMode: "daily", dailyOtAfterHours: 8 });
    // a day: 8 × 88 = 704.00 + 3 × 132 = 396.00 → 1,100.00; five days 5,500.00
    expect(b.labor.map((l) => [l.regular, l.premium, l.total])).toEqual(
      DAYS.map(() => [8, 3, 1100]),
    );
    expect(labor(b).amount).toBe(5500);
    // Small Tools 3% of 1,100.00 = 33.00 a day → 165.00
    expect(b.categories.find((c) => c.key === "assoc_labor_fees")!.amount).toBe(165);
  });

  it("an odd threshold lands on the cent: 7.5 h at $88, 3.5 h at 1.5×", () => {
    const b = bill({ overtimeMode: "daily", dailyOtAfterHours: 7.5 });
    // 7.5 × 88 = 660.00 + 3.5 × 132 = 462.00 → 1,122.00 a day
    expect(b.labor[0]!.total).toBe(1122);
    expect(labor(b).amount).toBe(5610);
  });
});

describe("overtime: after the standard hours (after 5 PM)", () => {
  it("bills the hours outside 08:00–17:00 at the after-hours multiplier", () => {
    const b = bill({
      overtimeMode: "after_hours",
      standardStart: "08:00",
      standardEnd: "17:00",
      afterHoursMultiplier: 1.5,
    });
    // 07:00–18:30 = 11.5 h on site, 9 h inside the window → 2.5 h after hours;
    // worked 11 h → 8.5 regular. 8.5 × 88 = 748.00 + 2.5 × 132 = 330.00 → 1,078.00
    expect(b.labor[0]).toMatchObject({ regular: 8.5, premium: 2.5, total: 1078 });
    expect(labor(b).amount).toBe(5390);
  });

  it("does not also apply a daily threshold left over in the rules", () => {
    const b = bill({
      overtimeMode: "after_hours",
      standardStart: "08:00",
      standardEnd: "17:00",
      dailyOtAfterHours: 8,
    });
    expect(b.labor[0]!.total).toBe(1078);
  });
});

describe("overtime: after 40 hours a week", () => {
  it("bills the 41st hour onward at 1.5×, per person, in date order", () => {
    const b = bill({ overtimeMode: "weekly", weeklyOtAfterHours: 40 });
    // Running total: Mon 11, Tue 22, Wed 33 — all regular. Thursday reaches 40
    // after 7 h (7 regular + 4 OT); Friday is all overtime (11 OT).
    expect(b.labor.map((l) => [l.date, l.regular, l.premium])).toEqual([
      ["2026-10-19", 11, 0],
      ["2026-10-20", 11, 0],
      ["2026-10-21", 11, 0],
      ["2026-10-22", 7, 4],
      ["2026-10-23", 0, 11],
    ]);
    // 40 × 88 = 3,520.00 + 15 × 132 = 1,980.00 → 5,500.00
    expect(labor(b).amount).toBe(5500);
    expect(b.labor[4]!.premiumNote).toBe("11 h weekly overtime at 1.5×");
  });

  it("counts each person separately and restarts on Monday", () => {
    const two = DAYS.map((d) =>
      sheet(d, [row(), row({ userId: "ana", employee: "Ana", timeOut: "15:30" })]),
    );
    const b = bill({ overtimeMode: "weekly", weeklyOtAfterHours: 40 }, two);
    // Ana: 8 h a day, 40 h — never over.
    expect(b.labor.filter((l) => l.name === "Ana").every((l) => l.premium === 0)).toBe(true);
    const next = bill({ overtimeMode: "weekly", weeklyOtAfterHours: 40 }, [
      sheet("2026-10-23", [row()]),
      sheet("2026-10-26", [row()]), // the next Monday: a new week
    ]);
    expect(next.labor.map((l) => l.premium)).toEqual([0]);
  });

  it("a bill starting mid-week counts that week's earlier hours, billing only its own days", () => {
    // Mon–Wed (33 h) were billed on an earlier bill. This bill is Thu–Fri.
    const b = buildTmBill({
      range: { from: "2026-10-22", to: "2026-10-25" },
      signIns: week(),
      supplies: [],
      equipment: [],
      codes: CODES,
      includeUnsigned: false,
      rules: { ...DEFAULT_TM_BILL_RULES, overtimeMode: "weekly", weeklyOtAfterHours: 40 },
    });
    // Thursday starts at 33 h: 7 regular + 4 OT; Friday is all OT.
    expect(b.labor.map((l) => [l.date, l.regular, l.premium])).toEqual([
      ["2026-10-22", 7, 4],
      ["2026-10-23", 0, 11],
    ]);
    // 7 × 88 = 616.00 + 15 × 132 = 1,980.00 → 2,596.00 (only Thu–Fri billed)
    expect(labor(b).amount).toBe(2596);
    // Small Tools 3%: Thu 616 + 528 = 1,144 → 34.32; Fri 1,452 → 43.56 → 77.88
    expect(b.categories.find((c) => c.key === "assoc_labor_fees")!.amount).toBe(77.88);
    // The same two days billed alone, with no earlier days: all straight time.
    const alone = buildTmBill({
      range: { from: "2026-10-22", to: "2026-10-25" },
      signIns: week().slice(3),
      supplies: [],
      equipment: [],
      codes: CODES,
      includeUnsigned: false,
      rules: { ...DEFAULT_TM_BILL_RULES, overtimeMode: "weekly", weeklyOtAfterHours: 40 },
    });
    // 22 × 88 = 1,936.00
    expect(labor(alone).amount).toBe(1936);
  });

  it("weekend hours count toward the 40 but bill at the weekend multiplier", () => {
    const withSat = [...week(), sheet("2026-10-24", [row()])];
    const b = bill(
      { overtimeMode: "weekly", weeklyOtAfterHours: 40, weekendMultiplier: 1.5 },
      withSat,
    );
    const sat = b.labor.find((l) => l.date === "2026-10-24")!;
    // Saturday's 11 h are weekend hours: 11 × 132 = 1,452.00, not weekly OT.
    expect(sat).toMatchObject({ regular: 0, premium: 11, total: 1452 });
    expect(sat.premiumNote).toBe("11 h weekend at 1.5×");
  });
});

describe("overtime: none", () => {
  it("bills every weekday hour straight", () => {
    const b = bill({
      overtimeMode: "none",
      dailyOtAfterHours: 8,
      standardStart: "08:00",
      standardEnd: "17:00",
    });
    // 11 × 88 = 968.00 a day → 4,840.00
    expect(b.labor.every((l) => l.premium === 0 && l.total === 968)).toBe(true);
    expect(labor(b).amount).toBe(4840);
  });

  it("holidays still bill at the holiday multiplier", () => {
    const b = bill({ overtimeMode: "none", holidays: ["2026-10-21"], holidayMultiplier: 2 });
    // 11 × 176 = 1,936.00 on the holiday
    expect(b.labor[2]).toMatchObject({ regular: 0, premium: 11, total: 1936 });
  });
});

describe("rules saved before the modes keep billing as they did", () => {
  it("a job override with a window and a threshold applies both, as before", () => {
    const r = resolveRules(
      {},
      { standardStart: "08:00", standardEnd: "17:00", dailyOtAfterHours: 8 },
    );
    expect(r.overtimeMode).toBe("legacy");
    const b = bill(r);
    // 2.5 h after hours; 8.5 left, 0.5 past 8 → 8 reg, 0.5 OT, 2.5 AH:
    // 704.00 + 66.00 + 330.00 = 1,100.00
    expect(b.labor[0]).toMatchObject({ regular: 8, premium: 3, total: 1100 });
  });

  it("an explicit mode on the job wins over the Settings mode", () => {
    const r = resolveRules({ overtimeMode: "weekly" }, { overtimeMode: "none" });
    expect(r.overtimeMode).toBe("none");
  });

  it("reads charges defensively", () => {
    expect(
      cleanRules({
        charges: [
          { key: "c_a", name: "A", kind: "pct_labor", value: 2, landsOn: "assoc_labor_fees" },
          { key: "c_b", name: "B", kind: "pct_subtotal", value: 2, landsOn: "materials" },
          { key: "c_c", name: "C", kind: "bogus", value: 2, landsOn: "materials" },
        ],
      }).charges?.map((c) => c.key),
    ).toEqual(["c_a"]);
  });
});

describe("charges added in General rules", () => {
  const charges: TmBillRules["charges"] = [
    {
      key: "c_ppe",
      name: "PPE fee",
      kind: "flat_person_day",
      value: 12.5,
      landsOn: "assoc_labor_fees",
    },
    { key: "c_sup", name: "Supervision", kind: "pct_labor", value: 2.5, landsOn: "management_fee" },
    { key: "c_admin", name: "Admin fee", kind: "pct_subtotal", value: 1.25, landsOn: "other_fees" },
    { key: "c_fuel", name: "Fuel", kind: "flat_bill", value: 35, landsOn: "other_fees" },
    { key: "c_unset", name: "Unset", kind: "flat_bill", value: null, landsOn: "materials" },
  ];
  const b = bill({ overtimeMode: "daily", dailyOtAfterHours: 8, charges });

  it("lands each charge where it was told, to the cent", () => {
    // Labor 5,500.00. Assoc: Small Tools 165.00 + PPE 5 × 12.50 = 62.50 → 227.50
    expect(b.categories.find((c) => c.key === "assoc_labor_fees")!.amount).toBe(227.5);
    // Supervision 2.5% of 5,500.00 = 137.50, in the (otherwise manual) management fee line
    const mgmt = b.categories.find((c) => c.key === "management_fee")!;
    expect(mgmt).toMatchObject({ amount: 137.5, manual: false });
    // Sub Total 5,500.00 + 227.50 + 137.50 = 5,865.00
    expect(b.totals.subtotal).toBe(5865);
    // Admin 1.25% of 5,865.00 = 73.3125 → 73.31; Fuel 35.00 → other fees 108.31
    expect(b.totals.otherFeeLines.map((l) => [l.name, l.amount])).toEqual([
      ["Admin fee", 73.31],
      ["Fuel", 35],
    ]);
    expect(b.totals.otherFees).toBe(108.31);
    expect(b.totals.totalDue).toBe(5973.31);
  });

  it("names a charge with no value instead of guessing one", () => {
    expect(b.unpricedCodes).toContain("Unset (no value set)");
  });

  it("puts the fees under the Sub Total on the customer's invoice, untaxed", () => {
    const lines = tmBillInvoiceLines(b);
    expect(lines.filter((l) => ["Admin fee", "Fuel"].includes(l.name))).toEqual([
      {
        name: "Admin fee",
        description: "Admin fee 1.25% of the Sub Total",
        uom: "EA",
        quantity: 1,
        unit_price: 73.31,
        taxable: false,
      },
      {
        name: "Fuel",
        description: "Fuel $35.00 per bill",
        uom: "EA",
        quantity: 1,
        unit_price: 35,
        taxable: false,
      },
    ]);
  });

  it("re-works a % of the Sub Total when categories are left off", () => {
    const only = selectCategories(b, ["billable_labor"]);
    // 1.25% of 5,500.00 = 68.75
    expect(only.totals.otherFeeLines[0]!.amount).toBe(68.75);
    expect(only.totals.totalDue).toBe(5500 + 68.75 + 35);
  });

  it("Small Tools never applies to a management title", () => {
    const mgmt = bill(
      { overtimeMode: "none" },
      week(() => [row({ rateCode: "SPM" })]),
    );
    expect(mgmt.assoc.every((a) => a.smallTools === 0)).toBe(true);
  });
});
