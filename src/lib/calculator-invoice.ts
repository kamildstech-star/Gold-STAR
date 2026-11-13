/**
 * A Quick Estimate (a Job Calculator sheet) as invoice lines.
 *
 * Mark, 2026-10-06, of the Water calculator row on a job's Billing tab: "these
 * need to be able to be converted to invoices."
 *
 * WHY THIS WAS OFF. Convert to invoice was deliberately left off calculator
 * rows when the two lists merged on 16 Sep ("No Versions or Convert on a
 * sheet; those are the document's"). The conversion copies an `estimates`
 * document's scopes and lines onto an invoice, and a calculator sheet has
 * none of that: it stores INPUTS (days, workers, hours, equipment counts,
 * fees) and one total, `customer_price`. There were no lines to copy, no
 * record of which invoice a sheet became (so nothing to stop it being billed
 * twice), and a sheet can exist with no job at all — while an invoice is
 * raised against the job's carrier.
 *
 * HOW THAT IS HANDLED, not bypassed:
 *
 *  - Lines. This module turns the sheet into the lines its own arithmetic is
 *    made of — labour at the hourly rate, supplies and truck per day, each
 *    piece of equipment at its unit rate, the two fees and every typed-in line
 *    — using `calculateCustomerPricing`, the same function that priced the
 *    sheet when it was saved. Nothing is re-priced.
 *  - To the cent. Postgres totals an invoice as ROUND(SUM(quantity *
 *    unit_price), 2), and the calculator rounds each component as it goes, so
 *    a line whose quantity times rate is not a whole number of cents (7.333
 *    hours at $70) would drift. Such a line goes on as one lump sum at the
 *    calculator's own rounded figure, with the hours and rate in the
 *    description. Then the whole set is checked against the stored
 *    `customer_price`; if they disagree the conversion is refused, never
 *    "fixed" with a balancing line.
 *  - Tax. The calculator quotes no tax, so every line is non-taxable: the
 *    invoice totals exactly what the sheet said. Someone can tick a line
 *    taxable on the invoice afterwards, as on any invoice.
 *  - Once. `invoices.job_calculation_id` records the sheet an invoice came
 *    from, with a unique index, exactly as `estimate_id` does for documents.
 *  - Bill-to. The invoice is written by the same code as a detailed
 *    estimate's (`lib/estimate-invoice.ts`), so the carrier, claim, adjuster
 *    and account come off the job by the same rule. A sheet with no job is
 *    refused.
 *
 * Pure, so the arithmetic is tested without a database.
 */
import {
  JOB_CALCULATOR_TYPE_LABEL,
  calculateCustomerPricing,
  defaultCalculatorRates,
  type CalculatorRates,
  type CustomerPricing,
  type JobCalculationInput,
} from "@/lib/job-calculator";
import {
  CALCULATOR_RATE_CODES,
  CALCULATOR_SUPPLY_CODES,
  equipmentCode,
} from "@/lib/job-calculator-pricing";

/** One invoice line, in the shape `invoice_lines` takes it. */
export type CalculatorInvoiceLine = {
  position: number;
  code: string | null;
  name: string;
  description: string | null;
  uom: string;
  quantity: number;
  unit_price: number;
  taxable: false;
  is_discount: false;
};

const toCents = (n: number) => Math.round(n * 100);

/** Quantities are stored as typed; four places is more than anyone types. */
const tidyQuantity = (n: number) => Math.round(n * 10_000) / 10_000;

const money = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

type Draft = Omit<CalculatorInvoiceLine, "position" | "taxable" | "is_discount"> & {
  /** What the calculator itself charged for this line, already rounded. */
  amount: number;
};

/**
 * Quantity x rate when that lands on a whole cent equal to what the calculator
 * charged; otherwise one lump sum at the calculator's figure.
 */
function priced(draft: Draft): Omit<Draft, "amount"> {
  const quantity = tidyQuantity(draft.quantity);
  const exact = quantity * draft.unit_price * 100;
  const wholeCents = Math.abs(exact - Math.round(exact)) < 1e-6;
  if (wholeCents && Math.round(exact) === toCents(draft.amount)) {
    return { ...draft, quantity };
  }
  const how = `${quantity} ${draft.uom.toLowerCase()} × ${money(draft.unit_price)}`;
  return {
    code: draft.code,
    name: draft.name,
    description: draft.description ? `${draft.description} (${how})` : how,
    uom: "LS",
    quantity: 1,
    unit_price: draft.amount,
  };
}

/**
 * The sheet's lines, in the order the calculator prints them. Lines that
 * charge nothing are left off, as they are on the customer PDF.
 */
export function calculatorInvoiceLines(
  input: JobCalculationInput,
  rates: CalculatorRates = defaultCalculatorRates(),
  pricing: CustomerPricing = calculateCustomerPricing(input, rates),
): CalculatorInvoiceLine[] {
  const days = Math.max(0, Number(input.days) || 0);
  const workers = Math.max(0, Number(input.workers) || 0);
  const crew = `${plural(workers, "worker")} × ${plural(days, "day")}`;
  const drafts: Draft[] = [];

  drafts.push({
    code: CALCULATOR_RATE_CODES.regularLabor,
    name: "Labor — regular hours",
    description: `${crew} × ${Math.max(0, input.regularHours)} hr`,
    uom: "HR",
    quantity: days * workers * Math.max(0, input.regularHours),
    unit_price: rates.regularLabor,
    amount: pricing.regularLaborPrice,
  });
  drafts.push({
    code: CALCULATOR_RATE_CODES.afterHoursLabor,
    name: "Labor — after hours",
    description: `${crew} × ${Math.max(0, input.afterHours)} hr`,
    uom: "HR",
    quantity: days * workers * Math.max(0, input.afterHours),
    unit_price: rates.afterHoursLabor,
    amount: pricing.afterHoursLaborPrice,
  });
  if (input.emergency) {
    drafts.push({
      code: CALCULATOR_RATE_CODES.emergencyBonusPerWorker,
      name: "Emergency response",
      description: "Per worker",
      uom: "EA",
      quantity: workers,
      unit_price: rates.emergencyBonusPerWorker,
      amount: pricing.emergencyWorkerBonuses,
    });
  }
  drafts.push({
    code: CALCULATOR_SUPPLY_CODES[input.jobType],
    name: `Supplies — ${JOB_CALCULATOR_TYPE_LABEL[input.jobType]}`,
    description: null,
    uom: "DAY",
    quantity: days,
    unit_price: rates.suppliesPerDay[input.jobType],
    amount: pricing.supplyCost,
  });
  drafts.push({
    code: CALCULATOR_RATE_CODES.truckCustomerPerDay,
    name: "Truck",
    description: null,
    uom: "DAY",
    quantity: days,
    unit_price: rates.truckCustomerPerDay,
    amount: pricing.truckCustomerPrice,
  });
  for (const item of pricing.equipment) {
    drafts.push({
      code: equipmentCode(item.key),
      name: item.label,
      description: null,
      // The calculator's units ("day", "each", "bucket") are words; the
      // invoice's are codes. The three that map, map; the rest are each.
      uom: item.unit === "day" ? "DAY" : item.unit === "hour" ? "HR" : "EA",
      quantity: item.quantity,
      unit_price: item.customerRate,
      amount: item.customerTotal,
    });
  }
  const garbage = Math.max(0, Number(input.garbageFee) || 0);
  drafts.push({
    code: null,
    name: "Garbage fee",
    description: null,
    uom: "LS",
    quantity: 1,
    unit_price: garbage,
    amount: garbage,
  });
  const misc = Math.max(0, Number(input.miscellaneousFee) || 0);
  drafts.push({
    code: null,
    name: "Miscellaneous fee",
    description: null,
    uom: "LS",
    quantity: 1,
    unit_price: misc,
    amount: misc,
  });
  for (const line of pricing.customLines) {
    drafts.push({
      code: null,
      name: line.label || "Additional item",
      description: null,
      uom: "LS",
      quantity: 1,
      unit_price: line.amount,
      amount: line.amount,
    });
  }

  return drafts
    .filter((d) => toCents(d.amount) > 0)
    .map(priced)
    .map((line, i) => ({ ...line, position: i, taxable: false, is_discount: false }));
}

/** What Postgres will total these lines to: ROUND(SUM(quantity * unit_price), 2). */
export function invoiceLinesTotal(
  lines: readonly Pick<CalculatorInvoiceLine, "quantity" | "unit_price">[],
) {
  return toCents(lines.reduce((sum, l) => sum + l.quantity * l.unit_price, 0)) / 100;
}

export type CalculatorInvoicePlan =
  | { ok: true; lines: CalculatorInvoiceLine[]; total: number }
  | { ok: false; lines: CalculatorInvoiceLine[]; total: number; reason: string };

/**
 * The lines, checked against the price the sheet was saved at. `savedPrice`
 * is `job_calculations.customer_price` — the figure on the Billing row.
 */
export function planCalculatorInvoice(
  input: JobCalculationInput,
  savedPrice: number,
  rates: CalculatorRates = defaultCalculatorRates(),
): CalculatorInvoicePlan {
  const lines = calculatorInvoiceLines(input, rates);
  const total = invoiceLinesTotal(lines);
  const saved = toCents(Number(savedPrice) || 0) / 100;
  if (lines.length === 0) {
    return {
      ok: false,
      lines,
      total,
      reason: "This estimate charges nothing, so there is nothing to invoice.",
    };
  }
  if (toCents(total) !== toCents(saved)) {
    return {
      ok: false,
      lines,
      total,
      reason: `Its lines add up to ${money(total)} but it was saved at ${money(saved)}. Open it in the calculator, check it and save it again, then convert.`,
    };
  }
  return { ok: true, lines, total };
}

/**
 * The plan for a saved sheet, priced the way it was priced when saved.
 *
 * David, 13 Oct: billing must charge the selected client's prices. A sheet is
 * saved at the rates on screen — the customer's price list when they have one
 * (job-calculations.ts) — so conversion tries those first. A sheet saved
 * before that, at the defaults, still converts: the defaults are the second
 * candidate. The saved total must still match to the cent either way, so a
 * conversion never bills a different amount from the one that was quoted.
 */
export function planCalculatorInvoiceWithRates(
  input: JobCalculationInput,
  savedPrice: number,
  candidates: readonly CalculatorRates[],
): CalculatorInvoicePlan {
  let first: CalculatorInvoicePlan | null = null;
  for (const rates of [...candidates, defaultCalculatorRates()]) {
    const plan = planCalculatorInvoice(input, savedPrice, rates);
    if (plan.ok) return plan;
    first ??= plan;
  }
  return first!;
}
