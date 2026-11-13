import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  calculatorInvoiceLines,
  invoiceLinesTotal,
  planCalculatorInvoice,
} from "@/lib/calculator-invoice";
import {
  calculateCustomerPricing,
  defaultCalculatorRates,
  emptyEquipment,
  type JobCalculationInput,
} from "@/lib/job-calculator";

/**
 * Mark, 2026-10-06: "these need to be able to be converted to invoices" — the
 * Quick Estimate rows on a job's Billing tab. The invoice must total what the
 * row says, to the cent, so every case below checks the lines against
 * `calculateCustomerPricing`, the function that priced the saved sheet.
 *
 * `jobDate` is fixed and nothing here reads a clock.
 */
function sheet(over: Partial<JobCalculationInput> = {}): JobCalculationInput {
  return {
    jobDate: "2026-10-06",
    jobType: "water",
    customerName: "Falcon Holdings",
    contactNumber: "",
    email: "",
    address: "12 Maple Ave",
    addressLine2: "",
    locality: "Haverstraw",
    region: "NY",
    postalCode: "",
    days: 1,
    workers: 1,
    regularHours: 0,
    afterHours: 0,
    emergency: false,
    garbageFee: 0,
    miscellaneousFee: 0,
    equipment: emptyEquipment(),
    note: "",
    customLines: [],
    ...over,
  };
}

/** Mark's row: Water, $2,350. Three days, two workers, a dehu and four air movers. */
const MARKS_WATER = sheet({
  days: 3,
  workers: 2,
  regularHours: 4,
  equipment: { ...emptyEquipment(), air_mover: 4, dehumidifier: 1 },
  garbageFee: 50,
  miscellaneousFee: 0,
});

const savedPrice = (input: JobCalculationInput) => calculateCustomerPricing(input).customerPrice;

describe("a Quick Estimate as invoice lines", () => {
  it("totals the sheet's own price, to the cent", () => {
    const price = savedPrice(MARKS_WATER);
    const plan = planCalculatorInvoice(MARKS_WATER, price);
    expect(plan.ok).toBe(true);
    expect(plan.total).toBe(price);
  });

  it("itemizes it the way the calculator prices it — hours, days, units", () => {
    const lines = calculatorInvoiceLines(MARKS_WATER);
    const byName = Object.fromEntries(lines.map((l) => [l.name, l]));
    expect(byName["Labor — regular hours"]).toMatchObject({
      uom: "HR",
      quantity: 24,
      unit_price: 70,
    });
    expect(byName["Supplies — Water"]).toMatchObject({ uom: "DAY", quantity: 3, unit_price: 250 });
    expect(byName["Truck"]).toMatchObject({ uom: "DAY", quantity: 3, unit_price: 100 });
    expect(byName["Air mover"]).toMatchObject({ uom: "DAY", quantity: 4, unit_price: 45 });
    expect(byName["Dehumidifier"]).toMatchObject({ uom: "DAY", quantity: 1, unit_price: 225 });
    expect(byName["Garbage fee"]).toMatchObject({ uom: "LS", quantity: 1, unit_price: 50 });
  });

  it("leaves off what charges nothing, as the customer PDF does", () => {
    const names = calculatorInvoiceLines(MARKS_WATER).map((l) => l.name);
    expect(names).not.toContain("Labor — after hours");
    expect(names).not.toContain("Miscellaneous fee");
    expect(names).not.toContain("Emergency response");
    // A unit with no customer rate yet (the submersible pump) is not a $0 line.
    const pump = calculatorInvoiceLines(
      sheet({ equipment: { ...emptyEquipment(), submersible_pump: 2 } }),
    ).map((l) => l.name);
    expect(pump).not.toContain("Submersible pump");
  });

  it("is never taxable and never a discount — the calculator quotes no tax", () => {
    for (const l of calculatorInvoiceLines(MARKS_WATER)) {
      expect(l.taxable).toBe(false);
      expect(l.is_discount).toBe(false);
    }
  });

  it("numbers the lines in order from zero, so position is unique in the scope", () => {
    const lines = calculatorInvoiceLines(MARKS_WATER);
    expect(lines.map((l) => l.position)).toEqual(lines.map((_, i) => i));
  });

  it("carries the emergency bonus, after-hours labor and every typed-in line", () => {
    const input = sheet({
      days: 2,
      workers: 3,
      regularHours: 8,
      afterHours: 2,
      emergency: true,
      miscellaneousFee: 125.5,
      customLines: [
        { label: "Dumpster permit", amount: 85 },
        { label: "", amount: 0 },
        { label: "Plumber (sub)", amount: 640.25 },
      ],
    });
    const plan = planCalculatorInvoice(input, savedPrice(input));
    expect(plan.ok).toBe(true);
    const names = plan.lines.map((l) => l.name);
    expect(names).toContain("Emergency response");
    expect(names).toContain("Labor — after hours");
    expect(names).toContain("Dumpster permit");
    expect(names).toContain("Plumber (sub)");
    // The blank row the user added and never filled is not a line.
    expect(names.filter((n) => n === "Additional item")).toHaveLength(0);
    expect(plan.total).toBe(savedPrice(input));
  });

  it("puts a sub-cent quantity on as one lump sum at the calculator's figure", () => {
    // 1 day x 1 worker x 7.333 hours x $70 = $513.31 after the calculator
    // rounds; as a quantity the database would multiply out 513.31000.
    const input = sheet({ regularHours: 7.333 });
    const labor = calculatorInvoiceLines(input).find((l) => l.name === "Labor — regular hours")!;
    expect(labor.quantity * labor.unit_price).toBeCloseTo(513.31, 10);
    const plan = planCalculatorInvoice(input, savedPrice(input));
    expect(plan.ok).toBe(true);
    expect(plan.total).toBe(savedPrice(input));
  });

  it("matches the sheet across a spread of awkward inputs", () => {
    const cases: Partial<JobCalculationInput>[] = [
      { days: 1.5, workers: 3, regularHours: 7.25, afterHours: 1.1 },
      { days: 0.5, workers: 1, regularHours: 2.333, jobType: "fire_smoke" },
      { days: 7, workers: 4, regularHours: 10, emergency: true, jobType: "mold" },
      {
        days: 2,
        equipment: { ...emptyEquipment(), truck_mount_hour: 1.75, encapsulation_bucket: 3 },
        garbageFee: 0.1,
        miscellaneousFee: 0.2,
      },
    ];
    for (const c of cases) {
      const input = sheet(c);
      const plan = planCalculatorInvoice(input, savedPrice(input));
      expect(plan.ok, JSON.stringify(c)).toBe(true);
      expect(plan.total, JSON.stringify(c)).toBe(savedPrice(input));
    }
  });

  it("refuses rather than invoicing a different number than the row shows", () => {
    // Typed-in lines the app could not read back, or a sheet saved before a
    // rate moved: the lines no longer reach the saved price. Never balanced
    // with a made-up line — refused, with both figures in the reason.
    const plan = planCalculatorInvoice(MARKS_WATER, savedPrice(MARKS_WATER) + 85);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toMatch(/add up to \$[\d,]+\.\d\d but it was saved at/);
  });

  it("refuses a sheet that charges nothing", () => {
    const empty = sheet({ days: 0, workers: 0 });
    const plan = planCalculatorInvoice(empty, 0);
    expect(plan.ok).toBe(false);
  });

  it("totals like Postgres: round the sum, not each line", () => {
    expect(invoiceLinesTotal([{ quantity: 3, unit_price: 0.335 }])).toBe(1.01);
  });

  it("prices off the rates it is given, so a price-listed sheet still balances", () => {
    const rates = { ...defaultCalculatorRates(), regularLabor: 82.5 };
    const input = sheet({ days: 2, workers: 2, regularHours: 6 });
    const price = calculateCustomerPricing(input, rates).customerPrice;
    const plan = planCalculatorInvoice(input, price, rates);
    expect(plan.ok).toBe(true);
    expect(plan.lines.find((l) => l.name === "Labor — regular hours")?.unit_price).toBe(82.5);
  });
});

/*
 * Wiring. One writer, one bill-to rule, one invoice per sheet.
 */
const CONVERT = readFileSync("src/lib/estimate-invoice.ts", "utf8").replace(/\r\n/g, "\n");
const PANEL = readFileSync("src/components/job-billing-panel.tsx", "utf8").replace(/\r\n/g, "\n");
const MIGRATION = readFileSync(
  "supabase/migrations/20261006161000_calculator_estimate_invoices.sql",
  "utf8",
).replace(/\r\n/g, "\n");

const fn = (name: string) =>
  CONVERT.match(new RegExp(`export async function ${name}\\([\\s\\S]*?\\n}\\n`))![0];

describe("converting a Quick Estimate goes through the detailed estimate's path", () => {
  it("has exactly one place that inserts an invoice", () => {
    expect(CONVERT.match(/\.from\("invoices"\)\s*(?:\/\/[^\n]*\n\s*)*\.insert\(/g)).toHaveLength(1);
  });

  it("both conversions use that writer and the same bill-to rule", () => {
    for (const name of ["convertEstimateToInvoice", "convertCalculationToInvoice"]) {
      expect(fn(name)).toContain("writeConvertedInvoice(");
      expect(fn(name)).toContain("...invoicePayer(job");
    }
  });

  it("refuses a sheet with no job, and a plan that does not balance", () => {
    const calc = fn("convertCalculationToInvoice");
    expect(calc).toContain("if (!row.job_id)");
    // Planned at the client's rates first (13 Oct), the defaults second.
    expect(calc).toContain(
      "planCalculatorInvoiceWithRates(input, Number(row.customer_price), clientRates)",
    );
    expect(calc).toContain("if (!plan.ok)");
  });

  it("returns the existing invoice instead of making a second", () => {
    const calc = fn("convertCalculationToInvoice");
    expect(calc).toContain("if (existing) return { invoiceId: existing, existing: true };");
    expect(calc).toContain('=== "23505"');
    expect(calc).toContain("job_calculation_id: row.id");
  });

  it("is enforced by the database: one invoice per sheet", () => {
    expect(MIGRATION).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS invoices_job_calculation_id_key\s+ON public\.invoices \(job_calculation_id\)\s+WHERE job_calculation_id IS NOT NULL;/,
    );
    // The lines and note are readable since #302's grant; nothing here grants
    // a column, least of all a cost one.
    expect(MIGRATION).not.toMatch(/^GRANT/m);
  });

  it("offers Convert on a sheet only once the link column exists", () => {
    const prop = PANEL.match(/onConvertCalculation=\{[\s\S]*?\}\s*converting=/)![0];
    expect(prop).toContain("calcConvertSupported ?");
    expect(prop).toContain(": undefined");
    expect(PANEL).toContain("setCalcConvertSupported(linkSupported && !invRes.error);");
  });

  it("keeps the job type gate the detailed conversion has", () => {
    const body = PANEL.match(/const convertCalculation = async[\s\S]*?\n {2}};\n/)![0];
    expect(body).toContain("if (typeUnresolved)");
    expect(body).toContain("convertCalculationToInvoice(calculationId, app.userId)");
  });
});
