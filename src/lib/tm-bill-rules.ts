/**
 * The T&M bill's fee and multiplier rules (TM3, 27 Oct).
 *
 * Set once in Settings (app_settings key `tm.bill_rules`) and overridable per
 * job (job_tm_settings.rules) — a job's rule wins key by key, so a job that
 * only changes its tax rate still follows Settings for everything else.
 *
 * The defaults reproduce David's sample ("Lallypak Week 1"): 9-hour days billed
 * at the straight rate (no daily overtime, no after-hours window), 3% small
 * tools, no tax. Overtime, after-hours, weekend and holiday multipliers only
 * apply once they are configured. Sat/Sun are weekend days by default, at
 * 1.5×; the sample has no weekend hours, so that default is unverified.
 *
 * Pure: values in, values out. Reading and writing are tm-bill-rules-store.ts.
 */
import { roundMoney } from "@/lib/money";
import { TM_BILL_CATEGORIES, type TmBillCategory } from "@/lib/tm-bill";

/**
 * Overtime, exactly one of four (Billing & Costs › General rules, 30 Oct):
 *   daily        hours past N in one person-day, at the OT multiplier;
 *   after_hours  hours outside the standard hours (e.g. after 5 PM), at the
 *                after-hours multiplier;
 *   weekly       a person's hours past N in one Monday–Sunday week, at the OT
 *                multiplier;
 *   none         no overtime.
 * Weekend and holiday hours bill at their own multipliers under every mode.
 *
 * `legacy` is not a choice anyone makes: it is a rule set saved before the
 * modes existed (a job override, or a Settings that had both a daily
 * threshold and a window), and it applies whatever window and threshold it
 * holds, both at once, exactly as the bill did then — so no saved job is
 * re-priced by the change.
 */
export const OVERTIME_MODES = ["daily", "after_hours", "weekly", "none"] as const;
export type OvertimeMode = (typeof OVERTIME_MODES)[number];

/** The four overtime rules (General rules), plus the pre-mode rule sets saved before them. */
export const OVERTIME_LABEL: Readonly<Record<OvertimeMode | "legacy", string>> = {
  daily: "After N hours a day",
  after_hours: "After the standard hours (after 5 PM)",
  weekly: "After N hours a week",
  none: "No overtime",
  legacy: "Saved before the modes — window and daily threshold both apply",
};

/**
 * A charge added in General rules (beyond the five standard ones, which are
 * the named keys below). What it is a percent of, or a flat amount per what.
 */
export const CHARGE_KINDS = [
  "pct_labor",
  "pct_subtotal",
  "pct_third_party",
  "flat_person_day",
  "flat_bill",
] as const;
export type ChargeKind = (typeof CHARGE_KINDS)[number];

/** Where an added charge lands: a bill category, or under the Sub Total. */
export type ChargeLanding = TmBillCategory | "other_fees";

export type CustomCharge = {
  key: string;
  name: string;
  kind: ChargeKind;
  /** Percent for pct_*, dollars for flat_*; null = not set (billed $0, named). */
  value: number | null;
  landsOn: ChargeLanding;
};

export type TmBillRules = {
  /** Small Tools: percent of each person-day's billed labor. null = the GEN-SMALLTOOLS code's rate. */
  smallToolsPercent: number | null;
  /** Per diem per person per day marked "Hotel / Per Diem" on the sign-in. null = the GEN-PERDIEM code's rate. */
  perDiemPerPersonDay: number | null;
  /** O&P: percent added to third-party bills (GEN-OP on a supply list). */
  opPercent: number;
  /** Markup on pass-through charges: Debris Removal and Hotel. */
  passThroughMarkupPercent: number;
  /** Standard working window, "HH:MM". Both blank = no after-hours premium. */
  standardStart: string;
  standardEnd: string;
  /** Which overtime rule applies (see OVERTIME_MODES); `legacy` = a pre-mode rule set. */
  overtimeMode: OvertimeMode | "legacy";
  /** Hours in one person-day before overtime (daily mode; legacy: null = none). */
  dailyOtAfterHours: number | null;
  /** Hours in one person's Monday–Sunday week before overtime (weekly mode). */
  weeklyOtAfterHours: number;
  /** 0 = Sunday … 6 = Saturday. */
  weekendDays: number[];
  /** ISO dates, YYYY-MM-DD. */
  holidays: string[];
  otMultiplier: number;
  afterHoursMultiplier: number;
  weekendMultiplier: number;
  holidayMultiplier: number;
  /** Job-level sales tax percent (e.g. 8.87). 0 = no tax line. */
  taxPercent: number;
  /** Which categories the tax applies to. */
  taxableCategories: TmBillCategory[];
  /** Off-Site Logistics / Support OH fee, percent of the Invoice Sub Total. */
  ohFeePercent: number;
  /** The labor code daily field-form crew bills at (TM5). null = not chosen. */
  fieldFormCode: string | null;
  /** Charges added in General rules, active ones only. */
  charges: CustomCharge[];
};

export const DEFAULT_TM_BILL_RULES: Readonly<TmBillRules> = Object.freeze<TmBillRules>({
  smallToolsPercent: null,
  perDiemPerPersonDay: null,
  opPercent: 20,
  passThroughMarkupPercent: 20,
  standardStart: "",
  standardEnd: "",
  overtimeMode: "none",
  dailyOtAfterHours: null,
  weeklyOtAfterHours: 40,
  weekendDays: [0, 6],
  holidays: [],
  otMultiplier: 1.5,
  afterHoursMultiplier: 1.5,
  weekendMultiplier: 1.5,
  holidayMultiplier: 2,
  taxPercent: 0,
  taxableCategories: ["materials", "equipment_tools"] as TmBillCategory[],
  ohFeePercent: 0,
  fieldFormCode: null,
  charges: [],
});

const num = (v: unknown, min = 0, max = 1000): number | null => {
  const n = typeof v === "string" ? Number(v.replace(/[%$,\s]/g, "")) : Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
};
const hhmm = (v: unknown): string | null =>
  typeof v === "string" && (v === "" || /^([01]\d|2[0-3]):[0-5]\d$/.test(v)) ? v : null;

/**
 * A stored rule set read back defensively: anything unknown or out of range
 * is dropped, so it falls through to the layer below. Returns only the keys
 * that are valid — a partial, ready to lay over another set.
 */
export function cleanRules(raw: unknown): Partial<TmBillRules> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const out: Partial<TmBillRules> = {};
  const nullableNum = (k: "smallToolsPercent" | "perDiemPerPersonDay" | "dailyOtAfterHours") => {
    if (!(k in r)) return;
    if (r[k] === null || r[k] === "") out[k] = null;
    else {
      const n = num(r[k], 0, k === "dailyOtAfterHours" ? 24 : 10_000);
      if (n != null) out[k] = n;
    }
  };
  nullableNum("smallToolsPercent");
  nullableNum("perDiemPerPersonDay");
  nullableNum("dailyOtAfterHours");
  for (const k of [
    "opPercent",
    "passThroughMarkupPercent",
    "taxPercent",
    "ohFeePercent",
  ] as const) {
    const n = num(r[k], 0, 100);
    if (n != null) out[k] = n;
  }
  for (const k of [
    "otMultiplier",
    "afterHoursMultiplier",
    "weekendMultiplier",
    "holidayMultiplier",
  ] as const) {
    const n = num(r[k], 1, 5);
    if (n != null) out[k] = n;
  }
  for (const k of ["standardStart", "standardEnd"] as const) {
    const t = hhmm(r[k]);
    if (t != null) out[k] = t;
  }
  if (Array.isArray(r.weekendDays)) {
    out.weekendDays = [...new Set(r.weekendDays.map(Number))]
      .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
      .sort();
  }
  if (Array.isArray(r.holidays)) {
    out.holidays = [...new Set(r.holidays.map(String))]
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
      .sort();
  }
  if (Array.isArray(r.taxableCategories)) {
    const known = new Set<string>(TM_BILL_CATEGORIES);
    out.taxableCategories = r.taxableCategories
      .map(String)
      .filter((k) => known.has(k)) as TmBillCategory[];
  }
  {
    const w = num(r.weeklyOtAfterHours, 1, 168);
    if (w != null) out.weeklyOtAfterHours = w;
  }
  if (Array.isArray(r.charges)) {
    const landings = new Set<string>([...TM_BILL_CATEGORIES, "other_fees"]);
    out.charges = r.charges.flatMap((c): CustomCharge[] => {
      if (!c || typeof c !== "object") return [];
      const o = c as Record<string, unknown>;
      const kind = o.kind as ChargeKind;
      const landsOn = String(o.landsOn) as ChargeLanding;
      if (!(CHARGE_KINDS as readonly string[]).includes(kind) || !landings.has(landsOn)) return [];
      if (kind === "pct_subtotal" && landsOn !== "other_fees") return [];
      const value =
        o.value === null || o.value === undefined
          ? null
          : num(o.value, 0, kind.startsWith("pct") ? 100 : 1_000_000);
      if (o.value != null && value == null) return [];
      return [{ key: String(o.key ?? ""), name: String(o.name ?? "Charge"), kind, value, landsOn }];
    });
  }
  if ("fieldFormCode" in r) {
    const c = typeof r.fieldFormCode === "string" ? r.fieldFormCode.trim().toUpperCase() : "";
    out.fieldFormCode = c && /^[A-Z0-9][A-Z0-9-]{0,23}$/.test(c) ? c : null;
  }
  if (
    r.overtimeMode === "legacy" ||
    (OVERTIME_MODES as readonly unknown[]).includes(r.overtimeMode)
  ) {
    out.overtimeMode = r.overtimeMode as TmBillRules["overtimeMode"];
  } else if (
    out.dailyOtAfterHours !== undefined ||
    out.standardStart !== undefined ||
    out.standardEnd !== undefined
  ) {
    // Saved before the modes: keep applying what it holds, as it did.
    out.overtimeMode = "legacy";
  }
  return out;
}

/** Defaults ← Settings ← the job. */
export function resolveRules(settings: unknown, job: unknown): TmBillRules {
  return { ...DEFAULT_TM_BILL_RULES, ...cleanRules(settings), ...cleanRules(job) };
}

/* ------------------------------------------------------------------ */
/* Premium time                                                        */
/* ------------------------------------------------------------------ */

const minutes = (t: string): number | null => {
  const m = /^(\d{2}):(\d{2})$/.exec(t);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

export type HoursSplit = {
  regular: number;
  /** Premium hours by multiplier — e.g. { 1.5: 2 } is two hours at time-and-a-half. */
  premium: { multiplier: number; hours: number; reason: string }[];
};

/** Hours to the hundredth; money goes through roundMoney (integer cents). */
const round2 = (n: number) => roundMoney(n);

/**
 * One person-day's worked hours split into regular and premium:
 *   1. a holiday: every hour at the holiday multiplier;
 *   2. a weekend day: every hour at the weekend multiplier;
 *   3. otherwise the overtime mode decides (see OVERTIME_MODES):
 *      daily — hours past the daily threshold at the OT multiplier;
 *      after_hours — hours outside the standard hours, when the day's times
 *        are known, at the after-hours multiplier;
 *      weekly — hours past the weekly threshold, counting `weekBefore` (the
 *        person's hours earlier in the same Monday–Sunday week, weekend and
 *        holiday hours included), at the OT multiplier;
 *      none — every hour regular;
 *      legacy — after-hours first, then the daily threshold on what is left.
 * An hour is never paid twice.
 */
export function splitHours(
  day: string,
  worked: number,
  rules: TmBillRules,
  times?: { timeIn: string; timeOut: string },
  weekBefore = 0,
): HoursSplit {
  const hours = round2(Math.max(0, worked));
  if (hours === 0) return { regular: 0, premium: [] };
  if (rules.holidays.includes(day)) {
    return {
      regular: 0,
      premium: [{ multiplier: rules.holidayMultiplier, hours, reason: "holiday" }],
    };
  }
  const dow = new Date(`${day}T12:00:00`).getDay();
  if (rules.weekendDays.includes(dow)) {
    return {
      regular: 0,
      premium: [{ multiplier: rules.weekendMultiplier, hours, reason: "weekend" }],
    };
  }
  const mode = rules.overtimeMode;
  const afterHoursOf = (): number => {
    const ws = minutes(rules.standardStart);
    const we = minutes(rules.standardEnd);
    if (ws == null || we == null || we <= ws || !times) return 0;
    const tin = minutes(times.timeIn);
    let tout = minutes(times.timeOut);
    if (tin == null || tout == null) return 0;
    if (tout < tin) tout += 24 * 60;
    const inside = Math.max(0, Math.min(tout, we) - Math.max(tin, ws));
    const span = tout - tin;
    // Lunch is taken inside the standard day.
    const outside = Math.max(0, span - inside);
    return round2(Math.min(hours, outside / 60));
  };
  const afterHours = mode === "after_hours" || mode === "legacy" ? afterHoursOf() : 0;
  let rest = round2(hours - afterHours);
  let overtime = 0;
  if ((mode === "daily" || mode === "legacy") && rules.dailyOtAfterHours != null) {
    if (rest > rules.dailyOtAfterHours) {
      overtime = round2(rest - rules.dailyOtAfterHours);
      rest = rules.dailyOtAfterHours;
    }
  } else if (mode === "weekly") {
    const left = Math.max(0, rules.weeklyOtAfterHours - Math.max(0, weekBefore));
    if (rest > left) {
      overtime = round2(rest - left);
      rest = round2(left);
    }
  }
  const premium: HoursSplit["premium"] = [];
  if (afterHours > 0)
    premium.push({
      multiplier: rules.afterHoursMultiplier,
      hours: afterHours,
      reason: "after hours",
    });
  if (overtime > 0)
    premium.push({
      multiplier: rules.otMultiplier,
      hours: overtime,
      reason: mode === "weekly" ? "weekly overtime" : "overtime",
    });
  return { regular: round2(rest), premium };
}

/** What one person-day bills at `rate` under a split. */
export function splitAmount(rate: number, split: HoursSplit): number {
  return roundMoney(
    rate * split.regular + split.premium.reduce((s, p) => s + rate * p.multiplier * p.hours, 0),
  );
}
