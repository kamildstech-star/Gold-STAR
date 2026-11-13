import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  TM_BILL_CATEGORIES,
  buildTmBill,
  cleanCategoryChoice,
  effortFromSignIns,
  selectCategories,
  cleanRange,
  codeIndex,
  defaultBillRange,
  inRange,
  signInHours,
  smallToolsFee,
  titleRate,
  tmBillInvoiceLines,
  tmBillWorkbook,
  unitDaysInRange,
  weekOf,
  type PricedCode,
} from "@/lib/tm-bill";
import { parseRate } from "@/lib/tm-rate-codes-admin";
import { DEFAULT_TM_BILL_RULES } from "@/lib/tm-bill-rules";
import type { SignInPayload, SignInRow, SupplyListPayload } from "@/lib/tm-forms";

/*
 * The T&M bill (David, 26 Oct — his "Lallypak Week 1" package): the invoice
 * summary's category lines and the detail sheets, from the daily T&M forms.
 */
const CODES: PricedCode[] = [
  { code: "GL", label: "General Labor", section: "labor", rate: 70 },
  { code: "SCL", label: "Structural Cleaning Labor", section: "labor", rate: 88 },
  { code: "CCF", label: "Crew Chief", section: "labor", rate: 100 },
  { code: "PS", label: "Project Supervisor", section: "labor", rate: 110 },
  { code: "PE", label: "Project Estimator", section: "labor", rate: 125 },
  { code: "SPM", label: "Sr. Project Manager", section: "labor", rate: 130 },
  { code: "PCT", label: "Project Consultant", section: "labor", rate: 165 },
  { code: "CA", label: "Carpenter", section: "labor", rate: null },
  { code: "104", label: "6 Mil Poly", section: "consumable", rate: 95 },
  { code: "205", label: "Nitrile Gloves-per box", section: "ppe", rate: 18.5 },
  { code: "346", label: "Water Extractor", section: "equipment", rate: 150 },
  { code: "401", label: "Cargo Van", section: "vehicle", rate: null },
  { code: "GEN-SMALLTOOLS", label: "Small Tools Charge", section: "general", rate: 3 },
  { code: "GEN-PERDIEM", label: "Per Diem - Per Person", section: "general", rate: 60 },
  { code: "GEN-HOTEL", label: "Hotel", section: "general", rate: 150 },
  { code: "GEN-ESF", label: "Emergency Service Fee", section: "general", rate: 250 },
];

const row = (over: Partial<SignInRow>): SignInRow => ({
  id: Math.random().toString(36).slice(2),
  userId: null,
  employee: "Jose Ruiz",
  rateCode: "SCL",
  timeIn: "07:00",
  lunchStart: "12:00",
  lunchEnd: "12:30",
  timeOut: "15:30",
  lodging: "",
  signature: "data:image/png;base64,AAA",
  signedAt: "2026-10-20T15:30:00Z",
  ...over,
});
const signIn = (rows: SignInRow[]): SignInPayload => ({
  jobName: "",
  jobLocation: "",
  rows,
  removed: [],
});
const supply = (lines: { code: string; qty: number }[]): SupplyListPayload => ({
  jobName: "",
  jobLocation: "",
  totalCrew: "",
  lines,
});
const WEEK = { from: "2026-10-19", to: "2026-10-25" };

describe("the 3% small-tools fee", () => {
  it("is 3% of each person-day's labor, to the cent", () => {
    expect(smallToolsFee(704)).toBe(21.12); // his sample: 8 h × SCL $88
    expect(smallToolsFee(1000)).toBe(30);
    expect(smallToolsFee(333.33)).toBe(10);
    expect(smallToolsFee(0)).toBe(0);
    expect(smallToolsFee(500, 5)).toBe(25);
  });

  it("is charged per person-day, on that day's labor", () => {
    const bill = buildTmBill({
      range: WEEK,
      signIns: [
        {
          date: "2026-10-20",
          payload: signIn([row({}), row({ employee: "Ana", rateCode: "CCF" })]),
        },
      ],
      supplies: [],
      equipment: [],
      codes: CODES,
      includeUnsigned: false,
    });
    expect(bill.labor.map((l) => l.total)).toEqual([704, 800]);
    expect(bill.assoc.map((a) => a.smallTools)).toEqual([21.12, 24]);
    expect(bill.categories.find((c) => c.key === "assoc_labor_fees")!.amount).toBe(45.12);
  });
});

describe("hours from the sign-in sheet", () => {
  it("is out − in − lunch", () => {
    expect(signInHours(row({}))).toEqual({ hours: 8, problem: null });
    expect(signInHours(row({ lunchStart: "", lunchEnd: "" }))).toEqual({
      hours: 8.5,
      problem: null,
    });
    expect(
      signInHours(row({ timeIn: "22:00", timeOut: "06:00", lunchStart: "", lunchEnd: "" })).hours,
    ).toBe(8);
  });

  it("names a missing time instead of inventing hours", () => {
    expect(signInHours(row({ timeOut: "" }))).toEqual({ hours: 0, problem: "no time out" });
    expect(signInHours(row({ timeIn: "" }))).toEqual({ hours: 0, problem: "no time in" });
  });

  it("bills a 9-hour day straight by default, as David's sample does (TM3)", () => {
    const bill = buildTmBill({
      range: WEEK,
      signIns: [
        { date: "2026-10-20", payload: signIn([row({ rateCode: "GL", timeOut: "17:30" })]) },
      ],
      supplies: [],
      equipment: [],
      codes: CODES,
      includeUnsigned: false,
    });
    expect(bill.labor[0]).toMatchObject({ regular: 10, premium: 0, total: 10 * 70 });
  });

  it("splits overtime past the job's threshold at its multiplier, when set", () => {
    const bill = buildTmBill({
      range: WEEK,
      signIns: [
        { date: "2026-10-20", payload: signIn([row({ rateCode: "GL", timeOut: "17:30" })]) },
      ],
      supplies: [],
      equipment: [],
      codes: CODES,
      includeUnsigned: false,
      rules: { ...DEFAULT_TM_BILL_RULES, overtimeMode: "daily", dailyOtAfterHours: 8 },
    });
    expect(bill.labor[0]).toMatchObject({ regular: 8, premium: 2, total: 8 * 70 + 2 * 105 });
  });
});

describe("title rate codes", () => {
  const idx = codeIndex(CODES);

  it("maps each of his seven title codes to its rate", () => {
    const want: Record<string, number> = {
      GL: 70,
      SCL: 88,
      CCF: 100,
      PS: 110,
      PE: 125,
      SPM: 130,
      PCT: 165,
    };
    for (const [code, rate] of Object.entries(want)) {
      expect(titleRate(code, idx)).toMatchObject({ kind: "rate", code, rate });
    }
    expect(titleRate(" ccf ", idx)).toMatchObject({ kind: "rate", code: "CCF", rate: 100 });
  });

  it("lands unmapped titles at $0 with the reason — never guessed", () => {
    expect(titleRate("", idx)).toMatchObject({
      kind: "unset",
      reason: "no rate code on the sign-in sheet",
    });
    expect(titleRate("XYZ", idx)).toMatchObject({
      kind: "unset",
      reason: "XYZ is not a T&M rate code",
    });
    expect(titleRate("CA", idx)).toMatchObject({
      kind: "unset",
      reason: "no rate set for CA — set a rate",
    });
    expect(titleRate("104", idx)).toMatchObject({
      kind: "unset",
      reason: "104 is not a labor code",
    });

    const bill = buildTmBill({
      range: WEEK,
      signIns: [
        { date: "2026-10-21", payload: signIn([row({ rateCode: "CA" }), row({ rateCode: "" })]) },
      ],
      supplies: [],
      equipment: [],
      codes: CODES,
      includeUnsigned: false,
    });
    expect(bill.labor.map((l) => [l.rate, l.total])).toEqual([
      [0, 0],
      [0, 0],
    ]);
    expect(bill.labor[0]!.unpriced).toMatch(/set a rate/);
    expect(bill.unpricedCodes).toEqual(["(no code)", "CA"]);
  });

  it("is set in Settings › T&M rate codes: blank clears, money and percent signs forgiven", () => {
    expect(parseRate("")).toBeNull();
    expect(parseRate("$88.00")).toBe(88);
    expect(parseRate("3%")).toBe(3);
    expect(parseRate("1,250")).toBe(1250);
    expect(() => parseRate("-5")).toThrow();
  });

  it("is seeded with the seven codes and the 3% fee, never over a typed rate", () => {
    const sql = readFileSync("supabase/migrations/20261026140000_tm_rate_code_rates.sql", "utf8");
    for (const pair of [
      "('GL', 70.00)",
      "('SCL', 88.00)",
      "('CCF', 100.00)",
      "('PS', 110.00)",
      "('PE', 125.00)",
      "('SPM', 130.00)",
      "('PCT', 165.00)",
      "('GEN-SMALLTOOLS', 3.00)",
    ])
      expect(sql).toContain(pair);
    expect(sql).toMatch(/AND t\.rate IS NULL/);
  });
});

describe("the bill's dates", () => {
  it("defaults to the Mon–Sun week of the latest filled sign-in sheet", () => {
    expect(weekOf("2026-10-22")).toEqual({ from: "2026-10-19", to: "2026-10-25" }); // a Thursday
    expect(weekOf("2026-10-19")).toEqual({ from: "2026-10-19", to: "2026-10-25" }); // Monday
    expect(weekOf("2026-10-25")).toEqual({ from: "2026-10-19", to: "2026-10-25" }); // Sunday
    expect(defaultBillRange(["2026-10-12", "2026-10-22", "2026-10-14"], "2026-10-30")).toEqual(
      WEEK,
    );
    expect(defaultBillRange([], "2026-10-27")).toEqual({ from: "2026-10-26", to: "2026-11-01" });
  });

  it("puts a backwards or half-typed range right", () => {
    expect(cleanRange("2026-10-25", "2026-10-19", "x")).toEqual(WEEK);
    expect(cleanRange("2026-10-20", "", "x")).toEqual({ from: "2026-10-20", to: "2026-10-20" });
    expect(inRange("2026-10-25", WEEK)).toBe(true);
    expect(inRange("2026-10-26", WEEK)).toBe(false);
  });

  it("bills only the forms inside the dates", () => {
    const bill = buildTmBill({
      range: WEEK,
      signIns: [
        { date: "2026-10-18", payload: signIn([row({})]) },
        { date: "2026-10-20", payload: signIn([row({})]) },
        { date: "2026-10-26", payload: signIn([row({})]) },
      ],
      supplies: [{ date: "2026-10-26", payload: supply([{ code: "104", qty: 2 }]) }],
      equipment: [],
      codes: CODES,
      includeUnsigned: false,
    });
    expect(bill.labor.map((l) => l.date)).toEqual(["2026-10-20"]);
    expect(bill.materials).toEqual([]);
  });

  it("counts equipment unit-days inside the dates only", () => {
    // Placed before the week, still out: Mon..Sun = 7.
    expect(unitDaysInRange("2026-10-10T12:00:00", null, WEEK, "2026-10-30")).toBe(7);
    // Placed Wednesday, picked up Friday: 3.
    expect(unitDaysInRange("2026-10-21T12:00:00", "2026-10-23T12:00:00", WEEK, "2026-10-30")).toBe(
      3,
    );
    // Gone before the week: 0.
    expect(unitDaysInRange("2026-10-01T12:00:00", "2026-10-05T12:00:00", WEEK, "2026-10-30")).toBe(
      0,
    );
    // Still out, and today is mid-week: up to today.
    expect(unitDaysInRange("2026-10-20T12:00:00", null, WEEK, "2026-10-22")).toBe(3);
  });
});

describe("approved hours: signed rows, like Pull from job's approval", () => {
  const input = (includeUnsigned: boolean) => ({
    range: WEEK,
    signIns: [
      {
        date: "2026-10-20",
        payload: signIn([row({}), row({ employee: "Temp", signature: null })]),
      },
    ],
    supplies: [],
    equipment: [],
    codes: CODES,
    includeUnsigned,
  });

  it("leaves unsigned rows out by default, and lists them", () => {
    const bill = buildTmBill(input(false));
    expect(bill.labor.map((l) => l.name)).toEqual(["Jose Ruiz"]);
    expect(bill.unsignedExcluded).toEqual([{ date: "2026-10-20", name: "Temp", hours: 8 }]);
  });

  it("includes them only when asked, flagged", () => {
    const bill = buildTmBill(input(true));
    expect(bill.labor.map((l) => [l.name, l.unsigned])).toEqual([
      ["Jose Ruiz", false],
      ["Temp", true],
    ]);
    expect(bill.unsignedExcluded).toEqual([]);
  });
});

describe("the category lines", () => {
  const bill = buildTmBill({
    range: WEEK,
    signIns: [
      {
        date: "2026-10-20",
        payload: signIn([row({ lodging: "yes" }), row({ employee: "Ana", rateCode: "PS" })]),
      },
    ],
    supplies: [
      {
        date: "2026-10-20",
        payload: supply([
          { code: "104", qty: 2 },
          { code: "205", qty: 4 },
          { code: "346", qty: 1 },
          { code: "401", qty: 1 },
          { code: "GEN-HOTEL", qty: 1 },
          { code: "GEN-ESF", qty: 1 },
          { code: "GEN-PERDIEM", qty: 9 },
          { code: "GEN-SMALLTOOLS", qty: 9 },
        ]),
      },
    ],
    equipment: [{ label: "Air mover", units: 4, unitDays: 20, rate: 30 }],
    codes: CODES,
    includeUnsigned: false,
  });
  const cat = (k: string) => bill.categories.find((c) => c.key === k)!;

  it("has every category of his summary, in his order", () => {
    expect(bill.categories.map((c) => c.key)).toEqual([...TM_BILL_CATEGORIES]);
    // The INVOICE sheet of David's sample, line for line (TM4).
    expect(bill.categories.map((c) => c.label)).toEqual([
      "Billable Labor",
      "Associated Labor Fees",
      "Prevailing Wage Benefits",
      "Billable Lodging / Hotel",
      "Specialty Items (SF) LxW",
      "Materials and Consumables",
      "Equipment and Tools",
      "Equipment Assigned Vehicles and Mileage",
      "Subcontractors and Vendors",
      "Labor Management Fee",
      "Reimbursable Items",
      "Billing CAP Credit",
      "Equipment Term Discount",
    ]);
  });

  it("totals each from its detail", () => {
    expect(cat("billable_labor").amount).toBe(704 + 880);
    // small tools 47.52 + per diem 1 "yes" × $60 — per diem is an
    // Associated Labor Fee in the sample (TM4)
    expect(cat("assoc_labor_fees").amount).toBe(107.52);
    // hotel 1 × $150 passed through plus 20% (TM3)
    expect(cat("lodging_hotel").amount).toBe(180);
    expect(cat("materials").amount).toBe(2 * 95 + 4 * 18.5);
    // air movers 20 × $30, extractor 1 × $150, van unpriced $0
    expect(cat("equipment_tools").amount).toBe(750);
    expect(cat("reimbursables").amount).toBe(250);
    expect(bill.subtotal).toBe(
      bill.categories.reduce((s, c) => Math.round((s + c.amount) * 100) / 100, 0),
    );
  });

  it("does not bill the supply list's per diem or small tools boxes twice", () => {
    expect(bill.reimbursables.map((r) => r.description)).toEqual(["Emergency Service Fee"]);
  });

  it("keeps the categories with no data as $0 manual lines", () => {
    for (const k of [
      "prevailing_wage_benefits",
      "specialty_items",
      "vehicles_mileage",
      "subcontractors",
      "management_fee",
      "cap_credit",
      "equipment_term_discount",
    ]) {
      expect(cat(k)).toMatchObject({ amount: 0, manual: true });
    }
  });

  it("says per diem needs a rate when none is set, rather than billing a guess", () => {
    const noRate = buildTmBill({
      range: WEEK,
      signIns: [{ date: "2026-10-20", payload: signIn([row({ lodging: "yes" })]) }],
      supplies: [],
      equipment: [],
      codes: CODES.filter((c) => c.code !== "GEN-PERDIEM"),
      includeUnsigned: false,
    });
    const pd = noRate.categories.find((c) => c.key === "assoc_labor_fees")!;
    expect(noRate.assoc[0]!.perDiem).toBe(0);
    expect(pd.detail).toMatch(/no per-diem rate set/);
  });

  it("becomes one invoice line per category WITH an amount — $0 categories stay off the customer copy", () => {
    const lines = tmBillInvoiceLines(bill);
    expect(lines.map((l) => l.name)).toEqual(
      bill.categories.filter((c) => c.amount !== 0).map((c) => c.label),
    );
    expect(lines[0]).toMatchObject({
      name: "Billable Labor",
      quantity: 1,
      unit_price: 1584,
      uom: "EA",
      taxable: false,
    });
    expect(lines.find((l) => l.name === "Prevailing Wage Benefits")).toBeUndefined();
    expect(lines.find((l) => l.name === "Materials and Consumables")?.taxable).toBe(true);
  });

  it("and a workbook in his layout, totals on top", () => {
    const sheets = tmBillWorkbook(bill, { jobNumber: "2610141", customer: "Lallypak" });
    expect(sheets.map((s) => s.name)).toEqual([
      "INVOICE",
      "Billable Labor",
      "Assoc Labor Fees",
      "Hotel",
      "Materials - Supplies",
      "Equipment - Tools",
      "Reimbursable's",
    ]);
    expect(sheets[0]!.totals?.[0]).toBe("Invoice Total Amount Due");
    for (const s of sheets.slice(1)) expect(s.totals?.[0]).toBe("Total");
    const labor = sheets[1]!;
    // The sample's Billable Labor columns.
    expect(labor.headers.slice(0, 9)).toEqual([
      "Name",
      "Title",
      "Hourly Rate",
      "Date",
      "Reg. Hours",
      "PR Hours",
      "Reg. Rate",
      "PR Rate",
      "Total",
    ]);
    expect(labor.types?.[3]).toBe("date");
    expect(labor.rows.map((r) => r[0])).toEqual(["Jose Ruiz", "Ana"]);
    expect(sheets[2]!.rows[0]!.slice(2, 4)).toEqual([21.12, 60]);
  });
});

describe("wiring", () => {
  it("is its own button on a T&M job's Billing, opening the bill dialog", () => {
    const panel = readFileSync("src/components/job-billing-panel.tsx", "utf8");
    expect(panel).toMatch(/\{isTmJob\(jobType\) && \(\s*<Button[\s\S]{0,600}data-tm-bill/);
    // The bill's layout (itemized day by day, or category totals) rides along — 3 Nov.
    expect(panel).toMatch(
      /onCreateDraft=\{\(bill, layout\) => void newInvoice\(\{ tmBill: bill, tmBillLayout: layout \}\)\}/,
    );
  });

  it("drafts through the same insert as Pull from job, and downloads through the export gate", () => {
    expect(readFileSync("src/lib/tm-bill-run.ts", "utf8")).toMatch(
      /return insertInvoicePull\(client, \{/,
    );
    const dialog = readFileSync("src/components/tm-bill-dialog.tsx", "utf8");
    expect(dialog).toMatch(/exportGate\.runExport\(\{\s*surface: "tm-bill"/);
  });
});

describe("a different set of categories per customer's bill (26 Oct)", () => {
  const full = buildTmBill({
    range: WEEK,
    signIns: [{ date: "2026-10-20", payload: signIn([row({})]) }],
    supplies: [{ date: "2026-10-20", payload: supply([{ code: "104", qty: 2 }]) }],
    equipment: [{ label: "Air mover", units: 2, unitDays: 10, rate: 30 }],
    codes: CODES,
    includeUnsigned: false,
  });

  it("three on one bill, two on another, all on a third", () => {
    const three = selectCategories(full, ["billable_labor", "materials", "equipment_tools"]);
    expect(three.categories.map((c) => c.key)).toEqual([
      "billable_labor",
      "materials",
      "equipment_tools",
    ]);
    expect(three.subtotal).toBe(704 + 190 + 300);
    expect(tmBillInvoiceLines(three)).toHaveLength(3);

    const two = selectCategories(full, ["equipment_tools", "billable_labor"]);
    expect(two.categories.map((c) => c.key)).toEqual(["billable_labor", "equipment_tools"]); // summary order
    expect(tmBillInvoiceLines(two)).toHaveLength(2);

    expect(selectCategories(full, [...TM_BILL_CATEGORIES]).subtotal).toBe(full.subtotal);
  });

  it("the workbook carries only the chosen categories' sheets", () => {
    const two = selectCategories(full, ["billable_labor", "equipment_tools"]);
    expect(tmBillWorkbook(two, { jobNumber: "1", customer: "X" }).map((s) => s.name)).toEqual([
      "INVOICE",
      "Billable Labor",
      "Equipment - Tools",
    ]);
  });

  it("reads a saved choice back safely — unknown keys dropped, nothing saved means all", () => {
    expect(cleanCategoryChoice(["materials", "junk", "billable_labor"])).toEqual([
      "billable_labor",
      "materials",
    ]);
    expect(cleanCategoryChoice(null)).toEqual([...TM_BILL_CATEGORIES]);
    // A choice saved before TM4 keeps meaning the same lines.
    expect(cleanCategoryChoice(["benefits", "per_diem_lodging"])).toEqual([
      "prevailing_wage_benefits",
      "lodging_hotel",
    ]);
    expect(cleanCategoryChoice([])).toEqual([...TM_BILL_CATEGORIES]);
  });
});

describe("the job ledger's days, guys and hours on a T&M job (26 Oct)", () => {
  it("come from the signed sign-in sheets when there are no field tickets", () => {
    expect(
      effortFromSignIns([
        { date: "2026-10-20", payload: signIn([row({}), row({ employee: "Ana" })]) },
        {
          date: "2026-10-21",
          payload: signIn([row({}), row({ employee: "Temp", signature: null })]),
        },
        { date: "2026-10-22", payload: signIn([row({ signature: null })]) },
      ]),
    ).toEqual({ days: 2, crew: 2, personHours: 24 });
    expect(effortFromSignIns([])).toEqual({ days: 0, crew: 0, personHours: 0 });
  });

  it("are read by the ledger and the Job ledger report", () => {
    expect(readFileSync("src/lib/invoice-ledger-pull.ts", "utf8")).toMatch(
      /return combinedEffort\(rows, sheets\);/,
    );
    expect(readFileSync("src/lib/job-ledger-report.ts", "utf8")).toMatch(/: effortFromSignIns\(/);
  });
});

describe("daily field forms reach the T&M bill (TM5)", () => {
  const range = { from: "2026-10-05", to: "2026-10-11" };
  const codes = [
    { code: "GL", label: "General Labor", section: "labor" as const, rate: 70 },
    { code: "GEN-SMALLTOOLS", label: "Small tools", section: "general" as const, rate: 3 },
  ];
  const form = (date: string, approved = true) => ({
    date,
    gsrCrew: 2,
    tempCrew: 1,
    hours: 8,
    approved,
  });

  it("bills each crew member of an approved field form as a person-day at the chosen code", () => {
    const bill = buildTmBill({
      range,
      signIns: [],
      supplies: [],
      equipment: [],
      codes,
      includeUnsigned: false,
      fieldForms: [form("2026-10-06")],
      fieldFormCode: "GL",
    });
    expect(bill.labor).toHaveLength(3);
    expect(bill.labor.every((l) => l.rate === 70 && l.regular === 8)).toBe(true);
    expect(bill.categories[0]!.amount).toBe(1680);
  });

  it("names field-form crew as unpriced until a code is chosen — never guessed", () => {
    const bill = buildTmBill({
      range,
      signIns: [],
      supplies: [],
      equipment: [],
      codes,
      includeUnsigned: false,
      fieldForms: [form("2026-10-06")],
    });
    expect(bill.labor.every((l) => l.total === 0 && l.unpriced)).toBe(true);
    expect(bill.unpricedCodes).toContain("field-form crew");
  });

  it("never double-bills a day that has a sign-in sheet, and holds unapproved forms back", () => {
    const bill = buildTmBill({
      range,
      signIns: [
        {
          date: "2026-10-06",
          payload: {
            rows: [
              {
                employee: "A",
                rateCode: "GL",
                timeIn: "08:00",
                timeOut: "16:00",
                lunchStart: "",
                lunchEnd: "",
                lodging: false,
                signature: "s",
              },
            ],
          } as never,
        },
      ],
      supplies: [],
      equipment: [],
      codes,
      includeUnsigned: false,
      fieldForms: [form("2026-10-06"), form("2026-10-07", false)],
      fieldFormCode: "GL",
    });
    expect(bill.labor.map((l) => l.name)).toEqual(["A"]);
    expect(bill.unsignedExcluded).toHaveLength(3);
  });

  it("the bill's loader reads the job's field forms (wiring)", () => {
    const run = readFileSync("src/lib/tm-bill-run.ts", "utf8");
    expect(run).toMatch(/loadFieldForms\(client, job\.id\)/);
    expect(run).toMatch(/fieldForms: source\.fieldForms/);
  });
});
