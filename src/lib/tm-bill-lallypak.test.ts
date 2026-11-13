/**
 * TM9 — verification: David's "Lallypak Week 1" T&M Pro invoice, rebuilt
 * inside the system from its own inputs (the sample's rates, the four days'
 * signed sign-in hours and the supply quantities), must reproduce the
 * workbook's numbers.
 *
 * The inputs are the fixture generated from the sample workbook
 * (src/lib/__fixtures__/lallypak-week1.ts — crew names anonymized). Each
 * labor row becomes a signed sign-in row from 08:00 for its hours; each
 * Materials and Equipment row a supply-list line of its code and quantity.
 * The codes carry the rates the sample bills and the Small Tools flag TM1
 * seeds (none on management titles), with the default bill rules.
 */
import { describe, expect, it } from "vitest";

import {
  LALLYPAK_EQUIPMENT,
  LALLYPAK_INVOICE,
  LALLYPAK_LABOR,
  LALLYPAK_MATERIALS,
  LALLYPAK_RATES,
} from "./__fixtures__/lallypak-week1";
import {
  buildTmBill,
  tmBillInvoiceLines,
  tmBillItemizedSections,
  withCategoryAmounts,
  type PricedCode,
} from "./tm-bill";
import type { SignInRow } from "./tm-forms";

const round2 = (n: number) => Math.round(n * 100) / 100;
const sum = (xs: readonly number[]) => round2(xs.reduce((s, x) => s + x, 0));

const section = (code: string): PricedCode["section"] =>
  /^[A-Z]/.test(code)
    ? "labor"
    : code.startsWith("1")
      ? "consumable"
      : code.startsWith("2")
        ? "ppe"
        : code.startsWith("3")
          ? "equipment"
          : "vehicle";
const MANAGEMENT = new Set(["SPM", "PCT", "PE"]);
const CODES: PricedCode[] = [
  ...Object.entries(LALLYPAK_RATES).map(([code, rate]) => ({
    code,
    label: code,
    section: section(code),
    rate,
    smallTools: !MANAGEMENT.has(code),
  })),
  { code: "GEN-SMALLTOOLS", label: "Small Tools", section: "general", rate: 3 },
];

const hhmm = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
const signRow = (l: (typeof LALLYPAK_LABOR)[number]): SignInRow =>
  ({
    employee: l.name,
    rateCode: l.code,
    timeIn: "08:00",
    timeOut: hhmm(8 * 60 + Math.round(l.hours * 60)),
    lunchStart: "",
    lunchEnd: "",
    lodging: false,
    signature: "signed",
  }) as unknown as SignInRow;

const days = [
  ...new Set([...LALLYPAK_LABOR, ...LALLYPAK_MATERIALS, ...LALLYPAK_EQUIPMENT].map((r) => r.date)),
].sort();
const build = (from = days[0]!, to = days[days.length - 1]!) =>
  buildTmBill({
    range: { from, to },
    signIns: days.map((date) => ({
      date,
      payload: { rows: LALLYPAK_LABOR.filter((l) => l.date === date).map(signRow) } as never,
    })),
    supplies: days.map((date) => ({
      date,
      payload: {
        lines: [...LALLYPAK_MATERIALS, ...LALLYPAK_EQUIPMENT]
          .filter((i) => i.date === date)
          .map((i) => ({ code: i.code, qty: i.qty })),
      } as never,
    })),
    equipment: [],
    codes: CODES,
    includeUnsigned: false,
  });

const bill = build();
const cat = (k: string) => bill.categories.find((c) => c.key === k)!.amount;

describe("Lallypak Week 1, rebuilt", () => {
  it("bills every labor row the workbook bills, at its rate and hours", () => {
    expect(bill.labor).toHaveLength(LALLYPAK_LABOR.length);
    for (const l of LALLYPAK_LABOR) {
      const got = bill.labor.find((b) => b.name === l.name && b.date === l.date)!;
      expect(got, `${l.name} ${l.date}`).toMatchObject({
        code: l.code,
        rate: l.rate,
        total: l.total,
      });
    }
  });

  it("each day's labor matches the workbook's day total", () => {
    for (const day of new Set(LALLYPAK_LABOR.map((l) => l.date))) {
      expect(sum(bill.labor.filter((l) => l.date === day).map((l) => l.total)), day).toBe(
        sum(LALLYPAK_LABOR.filter((l) => l.date === day).map((l) => l.total)),
      );
    }
  });

  it("one day in full: 10 × 8 h × $88 of SCL and the day's materials and equipment", () => {
    const one = build("2024-11-05", "2024-11-05");
    const scl = one.labor.filter((l) => l.code === "SCL");
    expect(scl).toHaveLength(10);
    expect(sum(scl.map((l) => l.total))).toBe(10 * 8 * 88);
    expect(one.categories.find((c) => c.key === "materials")!.amount).toBe(
      sum(LALLYPAK_MATERIALS.filter((m) => m.date === "2024-11-05").map((m) => m.total)),
    );
    expect(one.categories.find((c) => c.key === "equipment_tools")!.amount).toBe(
      sum(LALLYPAK_EQUIPMENT.filter((m) => m.date === "2024-11-05").map((m) => m.total)),
    );
    // Small Tools is 3% of that day's billed field labor — exactly the workbook's.
    expect(sum(one.assoc.map((a) => a.smallTools))).toBe(
      sum(LALLYPAK_LABOR.filter((l) => l.date === "2024-11-05").map((l) => l.smallTools)),
    );
  });

  it("matches the INVOICE sheet's category subtotals", () => {
    expect(cat("billable_labor")).toBe(LALLYPAK_INVOICE["Billable Labor"]);
    expect(cat("materials")).toBe(LALLYPAK_INVOICE["Materials and Consumables"]);
    expect(cat("equipment_tools")).toBe(LALLYPAK_INVOICE["Equipment and Tools"]);
    for (const [k, label] of [
      ["prevailing_wage_benefits", "Prevailing Wage Benefits"],
      ["lodging_hotel", "Billable Lodging / Hotel"],
      ["specialty_items", "Specialty Items (SF) LxW"],
      ["vehicles_mileage", "Equipment Assigned Vehicles and Mileage"],
      ["subcontractors", "Subcontractors and Vendors"],
      ["management_fee", "Labor Management Fee"],
      ["reimbursables", "Reimbursable Items"],
      ["cap_credit", "Billing CAP Credit"],
      ["equipment_term_discount", "Equipment Term Discount"],
    ] as const) {
      expect(cat(k), label).toBe(LALLYPAK_INVOICE[label]);
    }
    expect(bill.totals.tax).toBe(LALLYPAK_INVOICE["Tax Total"]);
  });

  it("Small Tools is the workbook's on every day but one hand-entered SPM day", () => {
    // 11/05, 11/06, 11/08: identical to the cent.
    for (const day of ["2024-11-05", "2024-11-06", "2024-11-08"]) {
      expect(sum(bill.assoc.filter((a) => a.date === day).map((a) => a.smallTools)), day).toBe(
        sum(LALLYPAK_LABOR.filter((l) => l.date === day).map((l) => l.smallTools)),
      );
    }
    // The workbook charged 3% on the Sr. Project Manager's 11/04 day ($520 →
    // $15.60) and on no other SPM day; the rule (no Small Tools on
    // management titles) does not. That is the whole difference.
    const spm1104 = LALLYPAK_LABOR.find((l) => l.code === "SPM" && l.date === "2024-11-04")!;
    expect(spm1104.smallTools).toBe(15.6);
    expect(round2(LALLYPAK_INVOICE["Associated Labor Fees"]! - cat("assoc_labor_fees"))).toBe(15.6);
    expect(round2(LALLYPAK_INVOICE["Invoice Total Amount Due"]! - bill.totals.totalDue)).toBe(15.6);
  });

  it("the customer copy carries the four non-zero categories, nothing at $0", () => {
    expect(tmBillInvoiceLines(bill).map((l) => l.name)).toEqual([
      "Billable Labor",
      "Associated Labor Fees",
      "Materials and Consumables",
      "Equipment and Tools",
    ]);
  });
});

/*
 * 3 Nov meeting: "the itemized breakdown in the T&M invoice is missing." The
 * draft invoice now carries the bill day by day — and must still come to the
 * same money as the one-line-per-category copy.
 */
describe("Lallypak Week 1, itemized on the invoice", () => {
  const sections = tmBillItemizedSections(bill);
  const total = (ls: readonly { quantity: number; unit_price: number }[]) =>
    sum(ls.map((l) => l.quantity * l.unit_price));

  it("comes to exactly what the summary copy does", () => {
    expect(total(sections.flatMap((s) => s.lines))).toBe(total(tmBillInvoiceLines(bill)));
  });

  it("lists billable labor one person-day per line, dated MM/DD/YYYY, with code, hours and rate", () => {
    const labor = sections.find((s) => s.name === bill.categories[0]!.label)!;
    expect(labor.lines.length).toBe(bill.labor.filter((l) => l.total !== 0).length);
    const first = labor.lines[0]!;
    expect(first.name).toMatch(/^\d{2}\/\d{2}\/\d{4} · /);
    expect(first.description).toMatch(/ h @ \$[\d,]+\.\d{2}\/h/);
  });

  it("keeps a category's single line when its rows do not add up to it", () => {
    for (const s of sections) {
      const cat = bill.categories.find((c) => c.label === s.name);
      if (!cat) continue;
      expect(round2(total(s.lines))).toBe(round2(cat.amount));
    }
  });
});

describe("an item entered with no rate still shows on the itemized invoice (4 Nov)", () => {
  it("keeps the unpriced consumable on its date, at $0, saying it needs a price", () => {
    const priced = { ...bill, materials: [...bill.materials] };
    priced.materials.push({
      date: days[0]!,
      code: "",
      description: "Unknown code ZZ-NEW",
      qty: 3,
      unit: "EA",
      price: 0,
      total: 0,
      unpriced: true,
    });
    const mat = tmBillItemizedSections(priced).find((s) =>
      s.lines.some((l) => l.name.includes("Unknown code ZZ-NEW")),
    );
    expect(mat, "the unpriced item is on the invoice").toBeTruthy();
    const ln = mat!.lines.find((l) => l.name.includes("Unknown code ZZ-NEW"))!;
    expect(ln.unit_price).toBe(0);
    expect(ln.description).toContain("No rate set — price this line");
  });
});

describe("an item line with nothing to add has a blank description (10 Nov)", () => {
  it("does not repeat qty @ price in the description", () => {
    const lines = tmBillItemizedSections(bill).flatMap((s) => s.lines);
    // Only labor keeps a rate in its description ("8 h @ $45.00/h").
    for (const l of lines)
      if (!l.description.endsWith("/h")) expect(l.description).not.toContain(" @ $");
    expect(lines.filter((l) => l.description === "").length).toBeGreaterThan(0);
  });
});

describe("a category amount typed by hand (4 Nov)", () => {
  it("replaces the computed amount and the totals follow", () => {
    const key = bill.categories[2]!.key; // a $0 'enter by hand' line in the sample
    const typedBill = withCategoryAmounts(bill, { [key]: 250 });
    expect(typedBill.categories.find((c) => c.key === key)!.amount).toBe(250);
    expect(round2(typedBill.subtotal - bill.subtotal)).toBe(
      round2(250 - bill.categories[2]!.amount),
    );
    // On the itemized invoice it goes on as one line of the typed amount.
    const sec = tmBillItemizedSections(typedBill).find(
      (s) => s.name === bill.categories[2]!.label,
    )!;
    expect(sec.lines).toHaveLength(1);
    expect(sec.lines[0]!.unit_price).toBe(250);
  });

  it("changes nothing when nothing is typed", () => {
    expect(withCategoryAmounts(bill, {})).toBe(bill);
  });
});
