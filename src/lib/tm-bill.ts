/**
 * The T&M bill — David's weekly T&M invoice package, written from the daily
 * T&M forms instead of retyped into T&M Pro.
 *
 * His sample ("Lallypak Week 1") is an INVOICE SUMMARY of one-line category
 * totals, backed by detail sheets: Billable Labor (one row per person per
 * day: name, title code, rate, regular + premium hours), Associated Labor
 * Fees (a 3% small-tools fee on each person-day's labor, plus per-diem / PPE /
 * lodging), Materials (the supply lists' quantities × price) and Equipment
 * (units × days on site). This file is the pure half: forms and rates in, the
 * bill out — the invoice's summary lines and the workbook's sheets both come
 * from the one `TmBill`, so the draft and the spreadsheet cannot disagree.
 *
 * WHERE THE NUMBERS COME FROM
 *   - Labor: each SIGNED row of each day's Crew Sign In/Out Sheet — the time
 *     in to time out, less the lunch break — at the rate of its Rate Code
 *     (Settings › Operations › T&M rate codes). A code with no rate, or no code
 *     at all, is billed at $0 and listed as "set a rate" — never guessed.
 *   - Signed = approved. A sign-in sheet has no approval step; the crew
 *     member's signature on the row is what attests the hours. Unsigned rows
 *     are treated as Pull from job treats unapproved hours: left out and
 *     listed, or — only when asked — included with the line saying so.
 *   - Premium hours: over PREMIUM_AFTER_HOURS in one person-day, at
 *     PREMIUM_MULTIPLIER × the rate.
 *   - Small tools: the GEN-SMALLTOOLS code's rate, read as a PERCENT of each
 *     person-day's labor (3 unless set otherwise).
 *   - Per diem: the sign-in's Hotel / Per Diem "yes" × the GEN-PERDIEM rate
 *     per person-day. No rate set: the column is $0 and the summary says so.
 *   - Materials: the supply lists' General Consumables and PPE lines,
 *     quantity × the code's rate.
 *   - Equipment & Tools: the job's scanned equipment, unit-days on site inside
 *     the bill's dates × the charge rate (the Pull-from-job resolver), plus the
 *     supply lists' Equipment and Vehicular lines × their code's rate.
 *   - General charges on a supply list: Hotel → Per-diem/Lodging; Emergency
 *     Service Fee, Debris and O&P → Reimbursables; Per Diem and Small Tools
 *     are computed above, so their supply-list boxes are not billed twice.
 *   - Benefits, Subcontractors, Management/Admin Fee, CAP credit: nothing in
 *     the system records them yet. They are lines at $0, present and editable.
 */
import type { ExportCellType, ExportSheet, ExportValue } from "@/lib/export-table";
import {
  rowSigned,
  type SignInPayload,
  type SignInRow,
  type SupplyListPayload,
} from "@/lib/tm-forms";
import type { TmRateCode, TmSection } from "@/lib/tm-rate-codes";

import { DATE_LOCALE, US_DATE } from "@/lib/date-format";
import { officeDate } from "@/lib/equipment";
import { fromCents, percentOf, roundMoney, sumMoney, toCents } from "@/lib/money";
import {
  DEFAULT_TM_BILL_RULES,
  splitAmount,
  splitHours,
  type ChargeLanding,
  type HoursSplit,
  type TmBillRules,
} from "@/lib/tm-bill-rules";
/* ------------------------------------------------------------------ */
/* Rules                                                               */
/* ------------------------------------------------------------------ */

/*
 * Premium time is no longer a fixed "over 8 hours at 1.5×" (TM3): David's
 * sample bills 9-hour days at the straight rate. Overtime, after-hours,
 * weekend and holiday multipliers are rules — Settings, overridable per job —
 * applied by splitHours (src/lib/tm-bill-rules.ts).
 */
/** The small-tools fee when the GEN-SMALLTOOLS code carries no rate. */
export const DEFAULT_SMALL_TOOLS_PERCENT = 3;

export const SMALL_TOOLS_CODE = "GEN-SMALLTOOLS";
export const PER_DIEM_CODE = "GEN-PERDIEM";
export const HOTEL_CODE = "GEN-HOTEL";
export const DEBRIS_CODE = "GEN-DEBRIS";
export const OP_CODE = "GEN-OP";

/** Integer cents, half away from zero (src/lib/money.ts); hours use the same rounding. */
const round2 = (n: number) => roundMoney(n);

/** The 3% small-tools fee on one person-day's labor: $704 → $21.12. */
export function smallToolsFee(labor: number, percent = DEFAULT_SMALL_TOOLS_PERCENT): number {
  if (!(labor > 0) || !(percent > 0)) return 0;
  return round2((labor * percent) / 100);
}

/* ------------------------------------------------------------------ */
/* Dates                                                               */
/* ------------------------------------------------------------------ */

export type BillRange = { from: string; to: string };

const isoDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const parseDay = (s: string) => new Date(`${s}T12:00:00`);

/** Monday–Sunday around a day. */
export function weekOf(day: string): BillRange {
  const d = parseDay(day);
  const back = (d.getDay() + 6) % 7; // Monday = 0
  const mon = new Date(d);
  mon.setDate(d.getDate() - back);
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 6);
  return { from: isoDay(mon), to: isoDay(sun) };
}

/**
 * The default dates: the week (Mon–Sun) of the most recent filled sign-in
 * sheet — David bills a week at a time — or this week when none is filled.
 */
export function defaultBillRange(formDays: readonly string[], today: string): BillRange {
  const latest = [...formDays]
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort()
    .pop();
  return weekOf(latest ?? today);
}

export function inRange(day: string, r: BillRange): boolean {
  return day >= r.from && day <= r.to;
}

/** A from/to the user typed, put right: swapped when backwards, today when blank. */
export function cleanRange(from: string, to: string, today: string): BillRange {
  const a = from || to || today;
  const b = to || from || today;
  return a <= b ? { from: a, to: b } : { from: b, to: a };
}

/** Calendar days a placement was on site inside the range, counted inclusively. */
/**
 * The premium column, so a printed line always adds up: the regular part is
 * rate × regular hours to the cent (as the workbook prints it), and the
 * premium is whatever is left of the line's total — never a cent off (P5).
 */
export function premiumPart(total: number, rate: number, regular: number): number {
  return fromCents(toCents(total) - toCents(roundMoney(rate * regular)));
}

export function unitDaysInRange(
  placedAt: string,
  retrievedAt: string | null,
  r: BillRange,
  today: string,
): number {
  // One equipment-day rule everywhere (P5): Eastern calendar days, the
  // drop-off day counts as day 1 — equipmentDaysOnSite and the running cost.
  const start = officeDate(placedAt);
  const end = retrievedAt ? officeDate(retrievedAt) : today;
  const from = start > r.from ? start : r.from;
  const to = end < r.to ? end : r.to;
  if (from > to) return 0;
  return Math.round((parseDay(to).getTime() - parseDay(from).getTime()) / 86_400_000) + 1;
}

/* ------------------------------------------------------------------ */
/* Hours                                                               */
/* ------------------------------------------------------------------ */

const minutesOf = (hhmm: string): number | null => {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/**
 * One sign-in row's worked hours: out − in − lunch. A shift past midnight
 * (out earlier than in) wraps. No time in or out: no hours, and why.
 */
export function signInHours(
  row: Pick<SignInRow, "timeIn" | "timeOut" | "lunchStart" | "lunchEnd">,
): {
  hours: number;
  problem: string | null;
} {
  const tin = minutesOf(row.timeIn);
  const tout = minutesOf(row.timeOut);
  if (tin == null || tout == null) {
    return { hours: 0, problem: tin == null ? "no time in" : "no time out" };
  }
  let worked = tout - tin;
  if (worked < 0) worked += 24 * 60;
  const ls = minutesOf(row.lunchStart);
  const le = minutesOf(row.lunchEnd);
  if (ls != null && le != null && le > ls) worked -= le - ls;
  return { hours: round2(Math.max(0, worked) / 60), problem: null };
}

/** Premium hours in a split, summed — the workbook's "PR Hours". */
export function premiumHours(split: HoursSplit): number {
  return round2(split.premium.reduce((s, p) => s + p.hours, 0));
}

/** "2 h after hours at 1.5×; 1 h overtime at 1.5×". */
export function premiumNote(split: HoursSplit): string | null {
  if (!split.premium.length) return null;
  return split.premium.map((p) => `${p.hours} h ${p.reason} at ${p.multiplier}×`).join("; ");
}

/**
 * Days, guys and hours from a T&M job's daily sign-in sheets — the job
 * ledger's effort when the job has no field work tickets (26 Oct: on T&M jobs
 * the crew signs the sign-in sheet, so the ledger read zero everywhere).
 * Signed rows only, the T&M bill's own "approved" rule. Crew is the LARGEST
 * signed crew on any one day, as the tickets count it.
 */
export function effortFromSignIns(sheets: readonly { date: string; payload: SignInPayload }[]): {
  days: number;
  crew: number;
  personHours: number;
} {
  let days = 0;
  let crew = 0;
  let personHours = 0;
  for (const sheet of sheets) {
    const signed = sheet.payload.rows.filter(
      (r) => rowSigned(r) && (r.employee.trim() || r.timeIn || r.timeOut),
    );
    if (signed.length === 0) continue;
    days += 1;
    crew = Math.max(crew, signed.length);
    personHours += signed.reduce((sum, r) => sum + signInHours(r).hours, 0);
  }
  return { days, crew, personHours: round2(personHours) };
}

/* ------------------------------------------------------------------ */
/* Rates                                                               */
/* ------------------------------------------------------------------ */

/** A rate code with what it bills at (null = not set). */
export type PricedCode = Pick<TmRateCode, "code" | "label" | "section"> & {
  rate: number | null;
  /** hr / day / each / pct / person_day (TM1); undefined before the column exists. */
  unit?: string | null;
  /** Labor codes: Small Tools applies to this title (TM1). Undefined = yes. */
  smallTools?: boolean;
  /** Internal cost per unit — only ever loaded for a cost viewer (TM7). */
  costRate?: number | null;
};

export type TitleRate =
  | { kind: "rate"; code: string; title: string; rate: number }
  /** Unmapped: no code on the row, a code we do not know, or a code with no rate. */
  | { kind: "unset"; code: string; title: string; reason: string };

/**
 * The rate for a sign-in row's Rate Code. Case and spaces are forgiven ("ccf"
 * is CCF); anything else that does not resolve to a labor code with a rate is
 * "unset" — billed at $0 with the reason, never guessed from the name.
 */
export function titleRate(rawCode: string, codes: ReadonlyMap<string, PricedCode>): TitleRate {
  const code = rawCode.trim().toUpperCase().replace(/\s+/g, "");
  if (!code)
    return { kind: "unset", code: "", title: "", reason: "no rate code on the sign-in sheet" };
  const c = codes.get(code);
  if (!c) return { kind: "unset", code, title: "", reason: `${code} is not a T&M rate code` };
  if (c.section !== "labor")
    return { kind: "unset", code, title: c.label, reason: `${code} is not a labor code` };
  if (c.rate == null || !(c.rate > 0))
    return { kind: "unset", code, title: c.label, reason: `no rate set for ${code} — set a rate` };
  return { kind: "rate", code, title: c.label, rate: c.rate };
}

export function codeIndex(rows: readonly PricedCode[]): Map<string, PricedCode> {
  return new Map(rows.map((r) => [r.code.toUpperCase(), r]));
}

/* ------------------------------------------------------------------ */
/* The bill                                                            */
/* ------------------------------------------------------------------ */

export type LaborRow = {
  date: string;
  name: string;
  code: string;
  title: string;
  rate: number;
  regular: number;
  /** Premium hours (overtime, after hours, weekend, holiday) — see premiumNote. */
  premium: number;
  /** What the premium hours bill at in all, multipliers applied. */
  premiumAmount: number;
  premiumNote: string | null;
  total: number;
  /** No rate: billed $0 — the reason. */
  unpriced: string | null;
  /** Unsigned, included only because asked. */
  unsigned: boolean;
  /** No time in or out. */
  problem: string | null;
};

export type AssocRow = {
  date: string;
  name: string;
  labor: number;
  smallTools: number;
  perDiem: number;
  ppe: number;
  lodging: number;
  total: number;
};

export type ItemRow = {
  /** The supply list's day; "" for equipment counted over the whole period. */
  date: string;
  code: string;
  description: string;
  qty: number;
  unit: string;
  price: number;
  total: number;
  unpriced: boolean;
};

/**
 * The invoice summary's categories, in the order of David's sample ("Lallypak
 * Week 1", T&M Pro's INVOICE sheet) — TM4. Below them come the Invoice Sub
 * Total, the Off-Site Logistics / Support OH Fee, Other / Additional Fees,
 * Tax, Previous Payments / Credits and the Invoice Total Amount Due
 * (`TmBillTotals`).
 */
export const TM_BILL_CATEGORIES = [
  "billable_labor",
  "assoc_labor_fees",
  "prevailing_wage_benefits",
  "lodging_hotel",
  "specialty_items",
  "materials",
  "equipment_tools",
  "vehicles_mileage",
  "subcontractors",
  "management_fee",
  "reimbursables",
  "cap_credit",
  "equipment_term_discount",
] as const;
export type TmBillCategory = (typeof TM_BILL_CATEGORIES)[number];

export const TM_CATEGORY_LABEL: Readonly<Record<TmBillCategory, string>> = {
  billable_labor: "Billable Labor",
  assoc_labor_fees: "Associated Labor Fees",
  prevailing_wage_benefits: "Prevailing Wage Benefits",
  lodging_hotel: "Billable Lodging / Hotel",
  specialty_items: "Specialty Items (SF) LxW",
  materials: "Materials and Consumables",
  equipment_tools: "Equipment and Tools",
  vehicles_mileage: "Equipment Assigned Vehicles and Mileage",
  subcontractors: "Subcontractors and Vendors",
  management_fee: "Labor Management Fee",
  reimbursables: "Reimbursable Items",
  cap_credit: "Billing CAP Credit",
  equipment_term_discount: "Equipment Term Discount",
};

/** Keys saved by the bill before TM4, read as their new category. */
const LEGACY_CATEGORY: Readonly<Record<string, TmBillCategory>> = {
  benefits: "prevailing_wage_benefits",
  per_diem_lodging: "lodging_hotel",
};

/** Under the categories, as the sample's INVOICE sheet prints them. */
export type TmBillTotals = {
  subtotal: number;
  /** Off-Site Logistics / Support OH Fee: the OH % of the Sub Total. */
  ohFee: number;
  /** Other / Additional Fees: the General rules charges that land under the Sub Total. */
  otherFees: number;
  /** Each of those charges, for the invoice's lines and the workbook. */
  otherFeeLines: { key: string; name: string; amount: number; detail: string }[];
  tax: number;
  /** Previous Payments / Credits — set by hand on the invoice. */
  previousPayments: number;
  totalDue: number;
};

/** What the General rules charges are worked out on, kept on the bill (see chargeAmount). */
export type ChargeBases = { labor: number; thirdParty: number; personDays: number };

const NO_BASES: ChargeBases = { labor: 0, thirdParty: 0, personDays: 0 };

/**
 * One added charge's amount and the words for it. A charge with no value is
 * $0 and says so — never guessed.
 */
export function chargeAmount(
  charge: TmBillRules["charges"][number],
  bases: ChargeBases,
  subtotal: number,
): { amount: number; detail: string } {
  const v = charge.value;
  if (v == null) return { amount: 0, detail: `${charge.name}: no value set` };
  switch (charge.kind) {
    case "pct_labor":
      return { amount: percentOf(bases.labor, v), detail: `${charge.name} ${v}% of labor` };
    case "pct_subtotal":
      return { amount: percentOf(subtotal, v), detail: `${charge.name} ${v}% of the Sub Total` };
    case "pct_third_party":
      return {
        amount: percentOf(bases.thirdParty, v),
        detail: `${charge.name} ${v}% of third-party bills`,
      };
    case "flat_person_day":
      return {
        amount: roundMoney(bases.personDays * v),
        detail: `${charge.name} ${bases.personDays} person-day${bases.personDays === 1 ? "" : "s"} × $${v.toFixed(2)}`,
      };
    case "flat_bill":
      return { amount: roundMoney(v), detail: `${charge.name} $${v.toFixed(2)} per bill` };
  }
}

export function billTotals(
  categories: readonly CategoryLine[],
  rules: TmBillRules,
  bases: ChargeBases = NO_BASES,
): TmBillTotals {
  const subtotal = sumMoney(categories.map((c) => c.amount));
  const ohFee = percentOf(subtotal, rules.ohFeePercent);
  const otherFeeLines = (rules.charges ?? [])
    .filter((c) => c.landsOn === "other_fees")
    .map((c) => ({ key: c.key, name: c.name, ...chargeAmount(c, bases, subtotal) }));
  const otherFees = sumMoney(otherFeeLines.map((l) => l.amount));
  const tax = taxOn(categories, rules);
  return {
    subtotal,
    ohFee,
    otherFees,
    otherFeeLines,
    tax,
    previousPayments: 0,
    totalDue: sumMoney([subtotal, ohFee, otherFees, tax]),
  };
}

export type CategoryLine = {
  key: TmBillCategory;
  label: string;
  amount: number;
  /** One line of what is in it, for the invoice line's description. */
  detail: string;
  /** Nothing in the system feeds it: a $0 line to fill in by hand. */
  manual: boolean;
};

export type EquipmentInput = {
  /** Register type label, e.g. "Air mover". */
  label: string;
  /** Unit-days inside the bill's dates. */
  unitDays: number;
  units: number;
  /** Charge rate per unit-day; null = none on file. */
  rate: number | null;
};

export type TmBill = {
  range: BillRange;
  labor: LaborRow[];
  assoc: AssocRow[];
  materials: ItemRow[];
  equipment: ItemRow[];
  lodging: ItemRow[];
  reimbursables: ItemRow[];
  /** Third-party bills and the O&P on them (TM3). */
  subcontractors: ItemRow[];
  /** Fuel surcharges and mileage (TM4). */
  vehicles: ItemRow[];
  categories: CategoryLine[];
  subtotal: number;
  /** Unsigned person-days left out (when not included). */
  unsignedExcluded: { date: string; name: string; hours: number }[];
  /** Codes billed at $0 for want of a rate. */
  unpricedCodes: string[];
  smallToolsPercent: number;
  perDiemRate: number | null;
  includeUnsigned: boolean;
  /** The rules the bill was worked out under (TM3). */
  rules: TmBillRules;
  /** What the General rules charges were worked out on (labor, third-party, person-days). */
  chargeBases: ChargeBases;
  /** Charges added in General rules that landed in a category, with their amounts. */
  addedCharges: {
    key: string;
    name: string;
    landsOn: ChargeLanding;
    amount: number;
    detail: string;
  }[];
  /** Job tax: percent, and the amount on the taxable categories (TM3). */
  taxPercent: number;
  tax: number;
  /** Sub Total → OH fee → other fees → tax → previous payments → Total Due (TM4). */
  totals: TmBillTotals;
  /**
   * The categories this bill carries (26 Oct: "every bill with different
   * settings — 3 on one, 2 on another, all on some"). Unset = all of them.
   */
  included?: readonly TmBillCategory[];
};

/**
 * The bill as chosen for this customer: only the ticked categories, the Sub
 * Total over them, and the detail sheets that belong to them. The arithmetic
 * of each category is untouched — a line left out is not billed at all.
 */
export function selectCategories(bill: TmBill, keys: readonly TmBillCategory[]): TmBill {
  const keep = new Set(keys);
  const categories = bill.categories.filter((c) => keep.has(c.key));
  const totals = billTotals(categories, bill.rules, bill.chargeBases);
  return {
    ...bill,
    categories,
    subtotal: totals.subtotal,
    tax: totals.tax,
    totals,
    included: TM_BILL_CATEGORIES.filter((k) => keep.has(k)),
  };
}

/**
 * A category's amount typed in by hand (4 Nov: "they want to change those
 * rates" — and the lines that say "enter by hand" had nowhere to enter it).
 * The typed amount replaces the computed one; the Sub Total, OH fee, tax and
 * Total Due are worked out again from it. On the itemized invoice a changed
 * category no longer adds up from its rows, so it goes on as one line.
 */
export type CategoryAmounts = Partial<Record<TmBillCategory, number>>;

export function withCategoryAmounts(bill: TmBill, amounts: CategoryAmounts): TmBill {
  const keys = Object.keys(amounts) as TmBillCategory[];
  if (keys.length === 0) return bill;
  const categories = bill.categories.map((c) => {
    const typed = amounts[c.key];
    if (typed == null || !Number.isFinite(typed)) return c;
    return { ...c, amount: round2(typed), detail: `Entered by hand (was $${c.amount.toFixed(2)})` };
  });
  const totals = billTotals(categories, bill.rules, bill.chargeBases);
  return { ...bill, categories, subtotal: totals.subtotal, tax: totals.tax, totals };
}

/** The job's tax on the taxable categories present (TM3). 0 when no rate is set. */
export function taxOn(categories: readonly CategoryLine[], rules: TmBillRules): number {
  if (!(rules.taxPercent > 0)) return 0;
  const taxable = new Set(rules.taxableCategories);
  const base = categories.filter((c) => taxable.has(c.key)).reduce((s, c) => s + c.amount, 0);
  return round2((base * rules.taxPercent) / 100);
}

/** A saved choice read back defensively: known keys only, in summary order; none = all. */
export function cleanCategoryChoice(raw: unknown): TmBillCategory[] {
  const list = (Array.isArray(raw) ? raw.map(String) : []).map((k) => LEGACY_CATEGORY[k] ?? k);
  const picked = TM_BILL_CATEGORIES.filter((k) => list.includes(k));
  return picked.length ? picked : [...TM_BILL_CATEGORIES];
}

/**
 * Vehicle DAY charges stay in Equipment and Tools — the sample bills its
 * Cargo Van and Personal Company Vehicle there. Fuel surcharges and mileage
 * are Equipment Assigned Vehicles and Mileage.
 */
const VEHICLE_MILEAGE_CODES = new Set(["402", "403"]);
const isMileage = (code: string, label: string) =>
  VEHICLE_MILEAGE_CODES.has(code) || /\bmileage\b/i.test(label);

const SUPPLY_SECTION_BUCKET: Record<TmSection, "materials" | "equipment" | "general" | null> = {
  labor: null,
  consumable: "materials",
  ppe: "materials",
  equipment: "equipment",
  vehicle: "equipment",
  general: "general",
};

/**
 * A daily field form (field work ticket) as the bill reads it. TM5: a job
 * whose crew filled field forms instead of T&M sign-in sheets billed no labor
 * at all — the bill only read sign-in sheets. A field form records a crew
 * size and the job's start / end, not names or title codes, so each crew
 * member is one person-day at the form's hours, at `fieldFormCode`.
 */
export type FieldFormInput = {
  date: string;
  gsrCrew: number;
  tempCrew: number;
  /** Hours on site from the form's start and end times. */
  hours: number;
  /** The office accepted the form — the field form's "signed". */
  approved: boolean;
  /** "HH:MM" start / end on the form, for the after-hours rule (TM3). */
  start?: string;
  end?: string;
};

/**
 * For the weekly overtime rule: each billed person-day's hours already worked
 * by the same person earlier in the same Monday–Sunday week. Keyed
 * `s:<date>:<row>` for a sign-in row, `f:<date>:<crew>:<n>` for a field-form
 * crew member. A person is their login when they have one, else their name.
 * A bill that starts mid-week passes that week's earlier sheets too (P3
 * answer 5): they count toward the threshold, but only the bill's own days
 * are billed, so the premium lands only on hours inside the period.
 */
function weeklyHoursBefore(
  signIns: readonly { date: string; payload: SignInPayload }[],
  forms: readonly FieldFormInput[],
  includeUnsigned: boolean,
): Map<string, number> {
  const entries: { id: string; person: string; date: string; hours: number }[] = [];
  for (const sheet of signIns) {
    for (const [i, row] of sheet.payload.rows.entries()) {
      const name = row.employee.trim();
      if (!name && !row.timeIn && !row.timeOut) continue;
      if (!rowSigned(row) && !includeUnsigned) continue;
      entries.push({
        id: `s:${sheet.date}:${i}`,
        person: row.userId ?? `name:${name.toLowerCase()}`,
        date: sheet.date,
        hours: signInHours(row).hours,
      });
    }
  }
  for (const form of forms) {
    if (!form.approved && !includeUnsigned) continue;
    for (const [group, n] of [
      ["GSR crew", form.gsrCrew],
      ["Temp crew", form.tempCrew],
    ] as const) {
      for (let i = 1; i <= Math.max(0, Math.floor(n)); i++) {
        entries.push({
          id: `f:${form.date}:${group}:${i}`,
          person: `form:${group}:${i}`,
          date: form.date,
          hours: form.hours,
        });
      }
    }
  }
  entries.sort((a, b) => a.date.localeCompare(b.date));
  const running = new Map<string, number>();
  const before = new Map<string, number>();
  for (const e of entries) {
    const key = `${e.person}|${weekOf(e.date).from}`;
    const sofar = running.get(key) ?? 0;
    before.set(e.id, sofar);
    running.set(key, round2(sofar + e.hours));
  }
  return before;
}

export function buildTmBill(input: {
  range: BillRange;
  signIns: readonly { date: string; payload: SignInPayload }[];
  supplies: readonly { date: string; payload: SupplyListPayload }[];
  equipment: readonly EquipmentInput[];
  codes: readonly PricedCode[];
  includeUnsigned: boolean;
  /** Daily field forms; a day that has a sign-in sheet is billed from the sheet. */
  fieldForms?: readonly FieldFormInput[];
  /** The labor code field-form crew bills at; null = not chosen (billed $0, named). */
  fieldFormCode?: string | null;
  /** Fee and multiplier rules (TM3); the defaults reproduce David's sample. */
  rules?: TmBillRules;
}): TmBill {
  const rules = input.rules ?? DEFAULT_TM_BILL_RULES;
  const idx = codeIndex(input.codes);
  const pct =
    rules.smallToolsPercent ?? idx.get(SMALL_TOOLS_CODE)?.rate ?? DEFAULT_SMALL_TOOLS_PERCENT;
  const perDiemRate = rules.perDiemPerPersonDay ?? idx.get(PER_DIEM_CODE)?.rate ?? null;
  const fieldFormCode = input.fieldFormCode ?? rules.fieldFormCode;
  const unpriced = new Set<string>();

  const labor: LaborRow[] = [];
  const assoc: AssocRow[] = [];
  const unsignedExcluded: TmBill["unsignedExcluded"] = [];

  const signIns = input.signIns
    .filter((s) => inRange(s.date, input.range))
    .sort((a, b) => a.date.localeCompare(b.date));
  // Field forms, for the days no sign-in sheet covers.
  const sheetDays = new Set(
    signIns
      .filter((s) => s.payload.rows.some((r) => r.employee.trim() || r.timeIn || r.timeOut))
      .map((s) => s.date),
  );
  const forms = (input.fieldForms ?? [])
    .filter((f) => inRange(f.date, input.range) && !sheetDays.has(f.date))
    .sort((a, b) => a.date.localeCompare(b.date));
  // The same week's days before the bill's first day count toward the
  // weekly threshold; they are never billed here.
  const weekStart = weekOf(input.range.from).from;
  const isPrior = (d: string) => d >= weekStart && d < input.range.from;
  const priorSignIns = input.signIns.filter((s) => isPrior(s.date));
  const priorSheetDays = new Set(
    priorSignIns
      .filter((s) => s.payload.rows.some((r) => r.employee.trim() || r.timeIn || r.timeOut))
      .map((s) => s.date),
  );
  const priorForms = (input.fieldForms ?? []).filter(
    (f) => isPrior(f.date) && !priorSheetDays.has(f.date),
  );
  const weekBefore = weeklyHoursBefore(
    [...priorSignIns, ...signIns],
    [...priorForms, ...forms],
    input.includeUnsigned,
  );
  for (const sheet of signIns) {
    for (const [rowIndex, row] of sheet.payload.rows.entries()) {
      const name = row.employee.trim();
      if (!name && !row.timeIn && !row.timeOut) continue;
      const { hours, problem } = signInHours(row);
      const unsigned = !rowSigned(row);
      if (unsigned && !input.includeUnsigned) {
        unsignedExcluded.push({ date: sheet.date, name: name || "(no name)", hours });
        continue;
      }
      const t = titleRate(row.rateCode, idx);
      const rate = t.kind === "rate" ? t.rate : 0;
      if (t.kind === "unset") unpriced.add(t.code || "(no code)");
      // Lunch is taken inside the standard day, so only the in/out times matter.
      const split = splitHours(
        sheet.date,
        hours,
        rules,
        { timeIn: row.timeIn, timeOut: row.timeOut },
        weekBefore.get(`s:${sheet.date}:${rowIndex}`) ?? 0,
      );
      const total = splitAmount(rate, split);
      labor.push({
        date: sheet.date,
        name: name || "(no name)",
        code: t.code,
        title: t.title,
        rate,
        regular: split.regular,
        premium: premiumHours(split),
        premiumAmount: premiumPart(total, rate, split.regular),
        premiumNote: premiumNote(split),
        total,
        unpriced: t.kind === "unset" ? t.reason : null,
        unsigned,
        problem,
      });
      // Management titles carry no Small Tools fee (TM1: per code, from the sample).
      const tools = idx.get(t.code)?.smallTools === false ? 0 : smallToolsFee(total, pct);
      const perDiem = row.lodging && perDiemRate && perDiemRate > 0 ? perDiemRate : 0;
      assoc.push({
        date: sheet.date,
        name: name || "(no name)",
        labor: total,
        smallTools: tools,
        perDiem,
        ppe: 0,
        lodging: 0,
        total: round2(tools + perDiem),
      });
    }
  }

  for (const form of forms) {
    const crew: { name: string; n: number }[] = [
      { name: "GSR crew", n: Math.max(0, Math.floor(form.gsrCrew)) },
      { name: "Temp crew", n: Math.max(0, Math.floor(form.tempCrew)) },
    ];
    for (const group of crew) {
      for (let i = 1; i <= group.n; i++) {
        const name = `${group.name} ${i} (field form)`;
        if (!form.approved && !input.includeUnsigned) {
          unsignedExcluded.push({ date: form.date, name, hours: form.hours });
          continue;
        }
        const t = fieldFormCode
          ? titleRate(fieldFormCode, idx)
          : ({
              kind: "unset",
              code: "",
              title: "",
              reason: "field-form crew has no rate code — choose one for this job",
            } as const);
        const rate = t.kind === "rate" ? t.rate : 0;
        if (t.kind === "unset") unpriced.add(t.code || "field-form crew");
        const split = splitHours(
          form.date,
          form.hours,
          rules,
          form.start && form.end ? { timeIn: form.start, timeOut: form.end } : undefined,
          weekBefore.get(`f:${form.date}:${group.name}:${i}`) ?? 0,
        );
        const total = splitAmount(rate, split);
        labor.push({
          date: form.date,
          name,
          code: t.code,
          title: t.title,
          rate,
          regular: split.regular,
          premium: premiumHours(split),
          premiumAmount: premiumPart(total, rate, split.regular),
          premiumNote: premiumNote(split),
          total,
          unpriced: t.kind === "unset" ? t.reason : null,
          unsigned: !form.approved,
          problem: form.hours > 0 ? null : "no start or end time on the field form",
        });
        const tools = idx.get(t.code)?.smallTools === false ? 0 : smallToolsFee(total, pct);
        assoc.push({
          date: form.date,
          name,
          labor: total,
          smallTools: tools,
          perDiem: 0,
          ppe: 0,
          lodging: 0,
          total: tools,
        });
      }
    }
  }
  labor.sort((a, b) => a.date.localeCompare(b.date));
  assoc.sort((a, b) => a.date.localeCompare(b.date));

  const materials: ItemRow[] = [];
  const equipment: ItemRow[] = [];
  const lodging: ItemRow[] = [];
  const reimbursables: ItemRow[] = [];
  const supplies = input.supplies
    .filter((s) => inRange(s.date, input.range))
    .sort((a, b) => a.date.localeCompare(b.date));
  const subcontractors: ItemRow[] = [];
  const vehicles: ItemRow[] = [];
  let thirdParty = 0;
  const markup = 1 + rules.passThroughMarkupPercent / 100;
  for (const sheet of supplies) {
    for (const line of sheet.payload.lines) {
      const code = line.code.trim().toUpperCase();
      // Computed from the sign-in and the labor; never billed twice.
      if (code === PER_DIEM_CODE || code === SMALL_TOOLS_CODE) continue;
      /*
       * TM3: the money general charges. On these the supply list's quantity
       * box is the receipt's dollar amount. Debris Removal and Hotel are passed
       * through plus the markup (20%); O&P is the third-party bill passed
       * through plus O&P (20%) on it, under Subcontractors and Vendors.
       */
      if (code === HOTEL_CODE || code === DEBRIS_CODE) {
        // With a rate on the code (a night's hotel) the box is a count;
        // without one it is the receipt's amount.
        const unitRate = idx.get(code)?.rate;
        const base = round2(unitRate && unitRate > 0 ? line.qty * unitRate : line.qty);
        const item: ItemRow = {
          date: sheet.date,
          code: "",
          description: `${code === HOTEL_CODE ? "Hotel" : "Debris Removal"} — pass-through $${base.toFixed(2)} + ${rules.passThroughMarkupPercent}%`,
          qty: base,
          unit: "$",
          price: markup,
          total: round2(base * markup),
          unpriced: false,
        };
        (code === HOTEL_CODE ? lodging : reimbursables).push(item);
        continue;
      }
      if (code === OP_CODE) {
        thirdParty = sumMoney([thirdParty, line.qty]);
        subcontractors.push(
          {
            date: sheet.date,
            code: "",
            description: "Third-party bill — pass-through",
            qty: line.qty,
            unit: "$",
            price: 1,
            total: round2(line.qty),
            unpriced: false,
          },
          {
            date: sheet.date,
            code: "",
            description: `O&P ${rules.opPercent}% of the third-party bill`,
            qty: line.qty,
            unit: "$",
            price: rules.opPercent / 100,
            total: round2((line.qty * rules.opPercent) / 100),
            unpriced: false,
          },
        );
        continue;
      }
      const c = idx.get(code);
      const bucket = c ? SUPPLY_SECTION_BUCKET[c.section] : "materials";
      if (bucket == null) continue;
      const price = c?.rate ?? 0;
      if (!(price > 0)) unpriced.add(code);
      const item: ItemRow = {
        date: sheet.date,
        code: c && c.section !== "general" ? code : "",
        description: c?.label ?? `Unknown code ${code}`,
        qty: line.qty,
        unit: "EA",
        price,
        total: round2(line.qty * price),
        unpriced: !(price > 0),
      };
      if (bucket === "materials") materials.push(item);
      else if (bucket === "equipment" && c && isMileage(code, c.label)) vehicles.push(item);
      else if (bucket === "equipment") equipment.push(item);
      else if (code === HOTEL_CODE) lodging.push(item);
      else reimbursables.push(item);
    }
  }
  for (const e of input.equipment) {
    if (e.unitDays <= 0) continue;
    const price = e.rate ?? 0;
    if (!(price > 0)) unpriced.add(e.label);
    equipment.push({
      // Spread over the period, not one day's: no date of its own.
      date: "",
      code: "",
      description: `${e.label} — ${e.units} unit${e.units === 1 ? "" : "s"} on site`,
      qty: e.unitDays,
      unit: "DAY",
      price,
      total: round2(e.unitDays * price),
      unpriced: !(price > 0),
    });
  }

  const sum = (xs: readonly { total: number }[]) => sumMoney(xs.map((x) => x.total));
  const laborTotal = sum(labor);
  const hours = round2(labor.reduce((s, l) => s + l.regular + l.premium, 0));
  const toolsTotal = sumMoney(assoc.map((a) => a.smallTools));
  const perDiemTotal = sumMoney(assoc.map((a) => a.perDiem));
  const perDiemDays = assoc.filter((a) => a.perDiem > 0).length;
  const hotelYes = signIns.reduce(
    (n, s) =>
      n + s.payload.rows.filter((r) => r.lodging && (rowSigned(r) || input.includeUnsigned)).length,
    0,
  );
  const personDays = labor.length;

  const line = (
    key: TmBillCategory,
    amount: number,
    detail: string,
    manual = false,
  ): CategoryLine => ({
    key,
    label: TM_CATEGORY_LABEL[key],
    amount: round2(amount),
    detail,
    manual,
  });
  const MANUAL = "Not recorded in the system yet — enter by hand.";

  const assocParts = [
    `Small tools ${pct}% of each field person-day's labor (not on management titles)`,
    perDiemRate && perDiemRate > 0
      ? `per diem ${perDiemDays} person-day${perDiemDays === 1 ? "" : "s"} × $${perDiemRate.toFixed(2)}`
      : hotelYes
        ? `${hotelYes} per diem "yes" on the sign-in — no per-diem rate set`
        : null,
  ].filter(Boolean);

  const categories: CategoryLine[] = [
    line(
      "billable_labor",
      laborTotal,
      personDays
        ? `${hours} h over ${personDays} person-day${personDays === 1 ? "" : "s"} from the signed sign-in sheets${forms.length ? " and the daily field forms" : ""}`
        : "No signed sign-in or approved field-form hours in these dates.",
    ),
    // The sample's Assoc Labor Fees sheet: Small Tools, Per Diem, PPE, … per person-day.
    line("assoc_labor_fees", round2(toolsTotal + perDiemTotal), assocParts.join("; ")),
    line("prevailing_wage_benefits", 0, MANUAL, true),
    line(
      "lodging_hotel",
      sum(lodging),
      lodging.length
        ? `Hotel from the supply lists, passed through plus ${rules.passThroughMarkupPercent}%`
        : MANUAL,
      lodging.length === 0,
    ),
    line("specialty_items", 0, MANUAL, true),
    line(
      "materials",
      sum(materials),
      materials.length
        ? `${materials.length} supply-list line${materials.length === 1 ? "" : "s"}, quantity × price`
        : "No consumables or PPE on the supply lists in these dates.",
    ),
    line(
      "equipment_tools",
      sum(equipment),
      equipment.length
        ? "Scanned equipment unit-days × charge rate, plus supply-list equipment and vehicles"
        : "No equipment on site or on the supply lists in these dates.",
    ),
    line(
      "vehicles_mileage",
      sum(vehicles),
      vehicles.length ? "Fuel surcharges and mileage from the supply lists" : MANUAL,
      vehicles.length === 0,
    ),
    line(
      "subcontractors",
      sum(subcontractors),
      subcontractors.length
        ? `Third-party bills passed through, plus O&P ${rules.opPercent}%`
        : MANUAL,
      subcontractors.length === 0,
    ),
    line("management_fee", 0, MANUAL, true),
    line(
      "reimbursables",
      sum(reimbursables),
      reimbursables.length ? "General charges from the supply lists" : MANUAL,
      reimbursables.length === 0,
    ),
    line("cap_credit", 0, "Enter as a negative amount if a CAP applies.", true),
    line(
      "equipment_term_discount",
      0,
      "Enter as a negative amount if a term discount applies.",
      true,
    ),
  ];

  const chargeBases: ChargeBases = { labor: laborTotal, thirdParty, personDays };
  const addedCharges: TmBill["addedCharges"] = [];
  for (const charge of rules.charges ?? []) {
    if (charge.landsOn === "other_fees") continue;
    const { amount, detail } = chargeAmount(charge, chargeBases, 0);
    if (charge.value == null) unpriced.add(`${charge.name} (no value set)`);
    addedCharges.push({
      key: charge.key,
      name: charge.name,
      landsOn: charge.landsOn,
      amount,
      detail,
    });
    const cat = categories.find((c) => c.key === charge.landsOn);
    if (!cat || amount === 0) continue;
    cat.amount = sumMoney([cat.amount, amount]);
    cat.detail = cat.manual ? detail : `${cat.detail}; ${detail}`;
    cat.manual = false;
  }
  for (const c of rules.charges ?? []) {
    if (c.landsOn === "other_fees" && c.value == null) unpriced.add(`${c.name} (no value set)`);
  }
  const totals = billTotals(categories, rules, chargeBases);
  return {
    range: input.range,
    labor,
    assoc,
    materials,
    equipment,
    vehicles,
    lodging,
    reimbursables,
    subcontractors,
    categories,
    subtotal: totals.subtotal,
    rules,
    chargeBases,
    addedCharges,
    taxPercent: rules.taxPercent,
    tax: totals.tax,
    totals,
    unsignedExcluded,
    unpricedCodes: [...unpriced].sort(),
    smallToolsPercent: pct,
    perDiemRate,
    includeUnsigned: input.includeUnsigned,
  };
}

/* ------------------------------------------------------------------ */
/* Out: the draft invoice's lines                                      */
/* ------------------------------------------------------------------ */

export type TmBillInvoiceLine = {
  name: string;
  description: string;
  uom: "EA";
  quantity: number;
  unit_price: number;
  /** From the job's rules (TM3): the invoice's own tax rate is applied to these. */
  taxable: boolean;
};

export function rangeLabel(r: BillRange): string {
  const f = (s: string) => parseDay(s).toLocaleDateString(DATE_LOCALE, US_DATE);
  return r.from === r.to ? f(r.from) : `${f(r.from)} – ${f(r.to)}`;
}

/**
 * The CUSTOMER copy's lines (TM4): one per category with an amount, in the
 * summary's order — a $0 category is left off what the customer sees (the
 * dialog keeps every category and its tick). The OH fee follows when there is
 * one. Tax is not a line: the draft invoice takes the job's tax rate and each
 * line's taxable flag, and the invoice works the tax out itself.
 */
export function tmBillInvoiceLines(bill: TmBill): TmBillInvoiceLine[] {
  const taxable = new Set(bill.rules.taxableCategories);
  const lines: TmBillInvoiceLine[] = bill.categories
    .filter((c) => c.amount !== 0)
    .map((c) => ({
      name: c.label,
      description: c.detail,
      uom: "EA",
      quantity: 1,
      unit_price: c.amount,
      taxable: taxable.has(c.key),
    }));
  for (const fee of bill.totals.otherFeeLines ?? []) {
    if (fee.amount === 0) continue;
    lines.push({
      name: fee.name,
      description: fee.detail,
      uom: "EA",
      quantity: 1,
      unit_price: fee.amount,
      taxable: false,
    });
  }
  if (bill.totals.ohFee !== 0) {
    lines.push({
      name: "Off-Site Logistics / Support OH Fee",
      description: `${bill.rules.ohFeePercent}% of the Invoice Sub Total`,
      uom: "EA",
      quantity: 1,
      unit_price: bill.totals.ohFee,
      taxable: false,
    });
  }
  return lines;
}

/**
 * The invoice ITEMIZED, day by day (meeting 3 Nov: "the itemized breakdown in
 * the T&M invoice is missing" — the customer copy carried one line per
 * category, and the person-by-day detail lived only in the workbook).
 *
 * One section per category, in the summary's order, each line a person-day
 * or an item on its date: who, title code, regular and premium hours at the
 * rate; small tools, per diem, PPE and lodging per person-day; materials,
 * equipment, vehicles, hotel, subcontractors and reimbursables by date ×
 * quantity × price. A category whose rows do not add up to its amount to the
 * cent (a General-rules charge landed on it, say) keeps its single summary
 * line instead — the invoice's total can never move. The OH fee and other
 * fees follow as they do on the summary copy.
 */
export type TmBillSection = { name: string; lines: TmBillInvoiceLine[] };

export function tmBillItemizedSections(bill: TmBill): TmBillSection[] {
  const taxable = new Set(bill.rules.taxableCategories);
  const period = rangeLabel(bill.range);
  const day = (d: string) => (d ? parseDay(d).toLocaleDateString(DATE_LOCALE, US_DATE) : period);
  const money = (n: number) =>
    `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const line = (
    key: TmBillCategory,
    name: string,
    description: string,
    quantity: number,
    unit_price: number,
  ): TmBillInvoiceLine => ({
    name,
    description,
    uom: "EA",
    quantity,
    unit_price,
    taxable: taxable.has(key),
  });

  const laborLines = (key: TmBillCategory) =>
    bill.labor.map((l) =>
      line(
        key,
        `${day(l.date)} · ${l.name}`,
        [
          [l.code, l.title].filter(Boolean).join(" "),
          `${round2(l.regular)} h @ ${money(l.rate)}/h`,
          l.premium > 0
            ? `+ ${round2(l.premium)} h premium${l.premiumNote ? ` (${l.premiumNote})` : ""} = ${money(l.premiumAmount)}`
            : null,
          l.unpriced ? `No rate — ${l.unpriced}` : null,
          l.unsigned ? "Unsigned on the sign-in sheet" : null,
        ]
          .filter(Boolean)
          .join(" · "),
        1,
        l.total,
      ),
    );
  const assocLines = (key: TmBillCategory) =>
    bill.assoc.map((a) =>
      line(
        key,
        `${day(a.date)} · ${a.name}`,
        [
          a.smallTools ? `Small tools ${money(a.smallTools)}` : null,
          a.perDiem ? `Per diem ${money(a.perDiem)}` : null,
          a.ppe ? `PPE ${money(a.ppe)}` : null,
          a.lodging ? `Lodging ${money(a.lodging)}` : null,
        ]
          .filter(Boolean)
          .join(" · "),
        1,
        a.total,
      ),
    );
  const itemLines = (key: TmBillCategory, rows: readonly ItemRow[]) =>
    rows.map((r) =>
      line(
        key,
        `${day(r.date)} · ${r.description || r.code}`,
        // Blank unless there is something to say. "1 EA @ $100.00" only
        // repeated the Qty and Price columns; David (10 Nov): "if there's no
        // description, then it shouldn't say this either. It should be blank."
        r.unpriced ? "No rate set — price this line" : "",
        r.qty,
        r.price,
      ),
    );
  const rowsFor: Partial<Record<TmBillCategory, () => TmBillInvoiceLine[]>> = {
    billable_labor: () => laborLines("billable_labor"),
    assoc_labor_fees: () => assocLines("assoc_labor_fees"),
    lodging_hotel: () => itemLines("lodging_hotel", bill.lodging),
    materials: () => itemLines("materials", bill.materials),
    equipment_tools: () => itemLines("equipment_tools", bill.equipment),
    vehicles_mileage: () => itemLines("vehicles_mileage", bill.vehicles),
    subcontractors: () => itemLines("subcontractors", bill.subcontractors),
    reimbursables: () => itemLines("reimbursables", bill.reimbursables),
  };
  const cents = (ls: readonly TmBillInvoiceLine[]) =>
    ls.reduce((s, l) => s + toCents(l.quantity * l.unit_price), 0);

  /*
   * 4 Nov ("adding line items but not showing in the T&M"): an item entered on
   * a form whose code has no rate bills at $0 — and a $0 line, or a category
   * that comes to $0, used to be left off, so the items looked lost. Every
   * line entered (quantity > 0) is kept on its date; the unpriced ones say so
   * and are priced on the draft before it is sent. They add $0, so the total
   * still equals the summary's.
   */
  const sections: TmBillSection[] = [];
  for (const c of bill.categories) {
    const detail =
      rowsFor[c.key]?.().filter(
        (l) => l.quantity !== 0 && (l.unit_price !== 0 || l.quantity > 0),
      ) ?? [];
    if (c.amount === 0 && detail.length === 0) continue;
    const adds = detail.length > 0 && cents(detail) === toCents(c.amount);
    sections.push({
      name: c.label,
      lines: adds ? detail : [line(c.key, c.label, c.detail, 1, c.amount)],
    });
  }
  // The fees after the Sub Total, as on the summary copy.
  const fees = tmBillInvoiceLines(bill).filter(
    (l) => !bill.categories.some((c) => c.label === l.name),
  );
  if (fees.length) sections.push({ name: "Fees", lines: fees });
  return sections;
}

/* ------------------------------------------------------------------ */
/* Out: the detail workbook                                            */
/* ------------------------------------------------------------------ */

const sheet = (
  name: string,
  headers: string[],
  types: (ExportCellType | undefined)[],
  rows: ExportValue[][],
  totals: ExportValue[] | null,
): ExportSheet => ({ name, headers, types, rows, totals });

/**
 * The detail workbook, mirroring the sample's T&M Pro workbook (TM4): an
 * INVOICE summary with every category in his order (zeros included, as his
 * prints them) and the totals beneath, then one detail sheet per category
 * that has detail — Billable Labor by person / date / title / rate / hours,
 * Assoc Labor Fees per person-day, and Materials, Equipment, Vehicles,
 * Hotel, Subcontractors and Reimbursables by item / date / qty × price.
 * Dates are date cells, shown MM/DD/YYYY.
 */
export function tmBillWorkbook(
  bill: TmBill,
  job: { jobNumber: string | null; customer: string | null },
): ExportSheet[] {
  const period = rangeLabel(bill.range);
  const t = bill.totals;
  const summary = sheet(
    "INVOICE",
    ["Description", "Amount", "Notes"],
    ["text", "money", "text"],
    [
      ...bill.categories.map((c) => [c.label, c.amount, c.detail] as ExportValue[]),
      ["Invoice Sub Total", t.subtotal, null],
      [
        "Off-Site Logistics / Support OH Fee",
        t.ohFee,
        bill.rules.ohFeePercent ? `${bill.rules.ohFeePercent}%` : null,
      ],
      [
        "Other / Additional Fees",
        t.otherFees,
        (t.otherFeeLines ?? [])
          .filter((l) => l.amount !== 0)
          .map((l) => l.detail)
          .join("; ") || null,
      ],
      ["Tax Total", t.tax, bill.taxPercent ? `${bill.taxPercent}% on taxable lines` : null],
      ["Previous Payments / Credits", t.previousPayments, null],
      ["Job", null, [job.jobNumber, job.customer].filter(Boolean).join(" · ")],
      ["Period", null, period],
      [
        "Unsigned hours",
        null,
        bill.includeUnsigned
          ? "Included — rows say so"
          : bill.unsignedExcluded.length
            ? `${bill.unsignedExcluded.length} unsigned person-day(s) left out`
            : "None",
      ],
    ],
    ["Invoice Total Amount Due", t.totalDue, period],
  );
  const labor = sheet(
    "Billable Labor",
    [
      "Name",
      "Title",
      "Hourly Rate",
      "Date",
      "Reg. Hours",
      "PR Hours",
      "Reg. Rate",
      "PR Rate",
      "Total",
      "Note",
    ],
    ["text", "text", "money", "date", "number", "number", "money", "money", "money", "text"],
    bill.labor.map((l) => [
      l.name,
      l.code,
      l.rate,
      l.date,
      l.regular,
      l.premium,
      round2(l.rate * l.regular),
      l.premiumAmount,
      l.total,
      [l.unpriced, l.problem, l.premiumNote, l.unsigned ? "not signed" : null]
        .filter(Boolean)
        .join("; "),
    ]),
    [
      "Total",
      null,
      null,
      null,
      round2(bill.labor.reduce((s, l) => s + l.regular, 0)),
      round2(bill.labor.reduce((s, l) => s + l.premium, 0)),
      round2(bill.labor.reduce((s, l) => s + l.rate * l.regular, 0)),
      round2(bill.labor.reduce((s, l) => s + l.premiumAmount, 0)),
      round2(bill.labor.reduce((s, l) => s + l.total, 0)),
      bill.rules.dailyOtAfterHours != null
        ? `Overtime after ${bill.rules.dailyOtAfterHours} h/day at ${bill.rules.otMultiplier}×`
        : "Premium hours per the job's rules",
    ],
  );
  const assoc = sheet(
    "Assoc Labor Fees",
    [
      "Name",
      "Date",
      `Small Tools ${bill.smallToolsPercent}%`,
      "Per Diem",
      "PPE",
      "Lodging",
      "Total",
    ],
    ["text", "date", "money", "money", "money", "money", "money"],
    bill.assoc.map((a) => [a.name, a.date, a.smallTools, a.perDiem, a.ppe, a.lodging, a.total]),
    [
      "Total",
      null,
      round2(bill.assoc.reduce((s, a) => s + a.smallTools, 0)),
      round2(bill.assoc.reduce((s, a) => s + a.perDiem, 0)),
      0,
      0,
      round2(bill.assoc.reduce((s, a) => s + a.total, 0)),
    ],
  );
  const items = (name: string, rows: readonly ItemRow[]) =>
    sheet(
      name,
      ["Item Description", "Date", "Code", "Unit", "Quantity", "Price", "Total", "Note"],
      ["text", "date", "text", "text", "number", "money", "money", "text"],
      rows.map((r) => [
        r.description,
        r.date || null,
        r.code,
        r.unit,
        r.qty,
        r.price,
        r.total,
        r.unpriced ? "no rate set — priced at $0" : "",
      ]),
      ["Total", null, null, null, null, null, round2(rows.reduce((s, r) => s + r.total, 0)), null],
    );
  // Only the detail sheets of the categories on this bill, and only with rows.
  const on = (k: TmBillCategory) => !bill.included || bill.included.includes(k);
  const detail = (k: TmBillCategory, name: string, rows: readonly ItemRow[]) =>
    on(k) && rows.length ? [items(name, rows)] : [];
  return [
    summary,
    ...(on("billable_labor") ? [labor] : []),
    ...(on("assoc_labor_fees") ? [assoc] : []),
    ...detail("lodging_hotel", "Hotel", bill.lodging),
    ...(on("materials") ? [items("Materials - Supplies", bill.materials)] : []),
    ...(on("equipment_tools") ? [items("Equipment - Tools", bill.equipment)] : []),
    ...detail("vehicles_mileage", "Vehicles - Mileage", bill.vehicles),
    ...detail("subcontractors", "Subcontractor - Vendor", bill.subcontractors),
    ...detail("reimbursables", "Reimbursable's", bill.reimbursables),
  ];
}
