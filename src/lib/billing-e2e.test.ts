import { describe, expect, it } from "vitest";

import { chainToPricing } from "@/lib/price-lists";
import { planLedgerInvoice } from "@/lib/invoice-ledger-pull";
import { laborAmount, roundMoney, sumMoney } from "@/lib/money";
import { buildTmBill, tmBillInvoiceLines, type PricedCode } from "@/lib/tm-bill";
import { DEFAULT_TM_BILL_RULES, resolveRules } from "@/lib/tm-bill-rules";
import { tmJobCost, tmMargin } from "@/lib/tm-job-cost";
import type { SignInPayload, SignInRow, SupplyListPayload } from "@/lib/tm-forms";

/*
 * Billing & Costs prompt 5 — end to end, every figure asserted and worked by
 * hand beside it: field data → bill / invoice → cost → margin, through the
 * same functions the app runs. The database halves (the price chain, the
 * freeze, the resolvers) are pinned in supabase/tests/*.pglite.mjs.
 */

describe("a regular job for an agreement client (Falcon)", () => {
  // The chain's answer for Falcon at Lakewood (regular_price_book): labor and
  // gloves are Falcon's exceptions; poly follows Standard.
  const { book } = chainToPricing(
    [
      { catalog_item_id: "lab", unit_price: 60, source: "account", price_list_id: "falcon" },
      { catalog_item_id: "glv", unit_price: "21.50", source: "account", price_list_id: "falcon" },
      { catalog_item_id: "poly", unit_price: 140, source: "default", price_list_id: null },
    ],
    new Map([["falcon", "Falcon"]]),
  );
  const plan = planLedgerInvoice({
    // Field tickets: 3 days, 22.5 person-hours.
    hours: { value: 22.5, typed: false, effort: { days: 3, crew: 3, personHours: 22.5 } as never },
    labor: { rate: 60, source: "client agreement" },
    supplies: [
      { itemId: "s1", name: "Nitrile gloves", sku: "GLV", unit: "box", quantity: 3 },
      { itemId: "s2", name: "6 mil poly", sku: "POLY", unit: "roll", quantity: 2 },
    ],
    catalog: [
      { id: "glv", code: "GLV", name: "Nitrile gloves", uom: "BX", default_unit_price: 24 },
      { id: "poly", code: "POLY", name: "6 mil poly", uom: "RL", default_unit_price: 140 },
    ],
    book,
  });

  it("bills at the agreement where it speaks and Standard where it is silent", () => {
    expect(plan.lines.map((l) => [l.name, l.quantity, l.unit_price])).toEqual([
      ["Labor", 22.5, 60], // 22.5 × 60.00 = 1,350.00 (agreement)
      ["6 mil poly", 2, 140], // 2 × 140.00 = 280.00 (Standard)
      ["Nitrile gloves", 3, 21.5], // 3 × 21.50 = 64.50 (agreement)
    ]);
    // 1,350.00 + 64.50 + 280.00 = 1,694.50 — the sum of the printed lines
    expect(plan.totals.amount).toBe(1694.5);
    expect(sumMoney(plan.lines.map((l) => roundMoney(l.quantity * l.unit_price)))).toBe(1694.5);
  });

  it("costs and margins to the cent", () => {
    // Labor 22.5 h × 45.00 (crew wage) = 1,012.50; supplies 3 × 15.00 + 2 × 80.00 = 205.00
    const cost = sumMoney([laborAmount(22.5, 45), roundMoney(3 * 15), roundMoney(2 * 80)]);
    expect(cost).toBe(1217.5);
    // 1,694.50 − 1,217.50 = 477.00; 477.00 / 1,694.50 = 28.1499% → 28.1
    expect(tmMargin(plan.totals.amount, cost)).toEqual({ margin: 477, pct: 28.1 });
  });
});

describe("a T&M job with a per-job favour, overtime and an added charge", () => {
  const CODES: PricedCode[] = [
    { code: "SCL", label: "Structural Cleaning Labor", section: "labor", rate: 88, costRate: 49.5 },
    { code: "104", label: "6 Mil Poly", section: "consumable", rate: 150, costRate: 80 },
  ];
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
  const day = (date: string) => ({
    date,
    payload: {
      jobName: "",
      jobLocation: "",
      rows: [row()],
      removedIds: [],
    } as unknown as SignInPayload,
  });
  // Company: daily overtime after 8 h at 1.5×, Small Tools 3%, a $35 fuel
  // charge per bill. This job's favour: Small Tools 5%.
  const rules = resolveRules(
    {
      ...DEFAULT_TM_BILL_RULES,
      overtimeMode: "daily",
      dailyOtAfterHours: 8,
      smallToolsPercent: 3,
      charges: [
        { key: "c_fuel", name: "Fuel", kind: "flat_bill", value: 35, landsOn: "other_fees" },
      ],
    },
    { smallToolsPercent: 5 },
  );
  const bill = buildTmBill({
    range: { from: "2026-10-19", to: "2026-10-20" },
    signIns: [day("2026-10-19"), day("2026-10-20")],
    supplies: [
      {
        date: "2026-10-19",
        payload: {
          jobName: "",
          jobLocation: "",
          totalCrew: "",
          lines: [{ code: "104", qty: 2 }],
        } as SupplyListPayload,
      },
    ],
    equipment: [{ label: "Air mover", unitDays: 3, units: 1, rate: 45 }],
    codes: CODES,
    includeUnsigned: false,
    rules,
  });
  const cat = (k: string) => bill.categories.find((c) => c.key === k)?.amount ?? 0;

  it("bills every category to the cent", () => {
    // A day: 8 × 88.00 = 704.00 + 3 × 132.00 = 396.00 → 1,100.00; two days 2,200.00
    expect(bill.labor.map((l) => [l.regular, l.premium, l.total])).toEqual([
      [8, 3, 1100],
      [8, 3, 1100],
    ]);
    expect(cat("billable_labor")).toBe(2200);
    // The printed regular + premium add up to the line: 704.00 + 396.00
    expect(
      bill.labor.every((l) => roundMoney(l.rate * l.regular) + l.premiumAmount === l.total),
    ).toBe(true);
    // The job's favour: Small Tools 5% of 1,100.00 = 55.00 a day → 110.00
    expect(cat("assoc_labor_fees")).toBe(110);
    // Poly 2 × 150.00 = 300.00; air movers 3 unit-days × 45.00 = 135.00
    expect(cat("materials")).toBe(300);
    expect(cat("equipment_tools")).toBe(135);
    // Sub Total 2,200.00 + 110.00 + 300.00 + 135.00 = 2,745.00; fuel 35.00 → 2,780.00
    expect(bill.totals.subtotal).toBe(2745);
    expect(bill.totals.otherFees).toBe(35);
    expect(bill.totals.totalDue).toBe(2780);
  });

  it("puts on the invoice exactly what the bill totals", () => {
    const lines = tmBillInvoiceLines(bill);
    expect(sumMoney(lines.map((l) => roundMoney(l.quantity * l.unit_price)))).toBe(2780);
  });

  it("costs and margins to the cent", () => {
    const cost = tmJobCost(bill, CODES, {
      premiumLabor: 1,
      supplies: 1,
      equipment: 1,
      awaitingDavid: true,
    });
    // Labor 22 h × 49.50 = 1,089.00; poly 2 × 80.00 = 160.00; scanned
    // equipment carries no code cost on the bill → 0 → 1,249.00
    expect(cost).toMatchObject({ labor: 1089, materials: 160, equipment: 0, total: 1249 });
    // 2,780.00 − 1,249.00 = 1,531.00; 1,531.00 / 2,780.00 = 55.07% → 55.1
    expect(tmMargin(bill.totals.totalDue, cost.total)).toEqual({ margin: 1531, pct: 55.1 });
  });
});
