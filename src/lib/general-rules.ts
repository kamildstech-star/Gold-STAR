/**
 * BILLING & COSTS › GENERAL RULES — the draft, its checks and its save
 * (prompt 2). The screen collects edits; nothing saves until Save, and then
 * everything goes in one billing_rules_save call (one transaction, one note,
 * every field audited). The database repeats every check here.
 *
 * No tax: the old Settings' tax is carried in legacy columns the screen never
 * shows, and a job's own tax override is untouched (src/lib/tm-bill-rules.ts).
 */
import { TM_BILL_CATEGORIES, TM_CATEGORY_LABEL, type TmBillCategory } from "@/lib/tm-bill";
import { CHARGE_KINDS, type ChargeKind, type OvertimeMode } from "@/lib/tm-bill-rules";
import type { ChargeRow, GeneralRulesRow } from "@/lib/tm-bill-rules-store";

export const CHARGE_KIND_LABEL: Readonly<Record<ChargeKind | "pct_pass_through", string>> = {
  pct_labor: "% of labor",
  pct_subtotal: "% of the Sub Total",
  pct_third_party: "% of third-party bills",
  flat_person_day: "$ per person-day",
  flat_bill: "$ per bill",
  pct_pass_through: "% on Debris and Hotel",
};

export const isPercentKind = (k: string) => k.startsWith("pct");

export type Landing = TmBillCategory | "other_fees" | "oh_fee" | "item";

export const LANDING_LABEL = (l: string): string =>
  l === "other_fees"
    ? "Under the Sub Total (Other / Additional Fees)"
    : l === "oh_fee"
      ? "Under the Sub Total (OH Fee line)"
      : l === "item"
        ? "On the Debris / Hotel line itself"
        : (TM_CATEGORY_LABEL[l as TmBillCategory] ?? l);

/** Where an added charge of each kind may land. */
export function landingsFor(kind: ChargeKind): Landing[] {
  if (kind === "pct_subtotal") return ["other_fees"];
  return [
    ...TM_BILL_CATEGORIES.filter((c) => c !== "cap_credit" && c !== "equipment_term_discount"),
    "other_fees",
  ];
}

/** What the standard charges do, in words, beside their row. */
export const STANDARD_CHARGE_HELP: Readonly<Record<string, string>> = {
  small_tools:
    "Each field person-day's labor. Never on management titles (set per title in T&M Rates).",
  per_diem: "Each person-day marked Hotel / Per Diem on the sign-in sheet. Blank = not set.",
  op: "Added to third-party bills (O&P on a supply list).",
  pass_through: "Added to Debris Removal and Hotel receipts.",
  oh_fee: "Off-site Logistics / Support OH, on the Invoice Sub Total.",
};

// ------------------------------------------------------------------ the draft

export type RulesDraft = {
  standard_start?: string;
  standard_end?: string;
  overtime_mode?: OvertimeMode;
  daily_ot_after_hours?: string;
  weekly_ot_after_hours?: string;
  weekend_days?: number[];
  /** ISO dates. */
  holidays?: string[];
  ot_multiplier?: string;
  after_hours_multiplier?: string;
  weekend_multiplier?: string;
  holiday_multiplier?: string;
  field_form_code?: string | null;
  minimum_margin_percent?: string;
};

export type ChargeEdit = { name?: string; value?: string; active?: boolean; archived?: boolean };
export type NewCharge = {
  tempId: string;
  name: string;
  kind: ChargeKind | "";
  value: string;
  lands_on: Landing | "";
};

export type GeneralDraft = {
  rules: RulesDraft;
  charges: Readonly<Record<string, ChargeEdit>>;
  creates: readonly NewCharge[];
};

export const EMPTY_GENERAL_DRAFT: GeneralDraft = { rules: {}, charges: {}, creates: [] };

export function generalDraftSize(d: GeneralDraft): number {
  return Object.keys(d.rules).length + Object.keys(d.charges).length + d.creates.length;
}

/** "12/25/2026" → "2026-12-25"; null when it is not a real date. */
export function usDateToIso(raw: string): string | null {
  const m = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*$/.exec(raw);
  if (!m) return null;
  const [mo, d, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d)
    return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function isoToUsDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${m}/${d}/${y}`;
}

const numIn = (raw: string, min: number, max: number): number | null => {
  const t = raw.replace(/[%$,×x\s]/gi, "");
  if (t === "") return null;
  const v = Number(t);
  return Number.isFinite(v) && v >= min && v <= max ? v : null;
};

// ---------------------------------------------------------------- validation

export type GeneralProblems = ReadonlyMap<string, string>;

/**
 * Plain-words problems keyed by field (`rules.<column>`, `charge.<key>.<field>`
 * or `new.<tempId>.<field>`). Any problem blocks Save.
 */
export function validateGeneralDraft(
  row: GeneralRulesRow,
  charges: readonly ChargeRow[],
  draft: GeneralDraft,
): GeneralProblems {
  const p = new Map<string, string>();
  const r = draft.rules;
  const val = <K extends keyof RulesDraft>(k: K, current: RulesDraft[K]) =>
    (k in r ? r[k] : current) as RulesDraft[K];
  const mode = val("overtime_mode", row.overtime_mode as OvertimeMode);
  const start = val("standard_start", row.standard_start) ?? "";
  const end = val("standard_end", row.standard_end) ?? "";
  if ((start === "") !== (end === ""))
    p.set("rules.standard_end", "Give both a start and an end, or neither.");
  else if (start && end && end <= start)
    p.set("rules.standard_end", "The day has to end after it starts.");
  if (mode === "after_hours" && !(start && end)) {
    p.set("rules.overtime_mode", "After-hours overtime needs the standard hours set.");
  }
  const daily =
    val(
      "daily_ot_after_hours",
      row.daily_ot_after_hours == null ? "" : String(row.daily_ot_after_hours),
    ) ?? "";
  if (mode === "daily" && numIn(daily, 0.25, 24) == null) {
    p.set("rules.daily_ot_after_hours", "Enter the hours a day before overtime (up to 24).");
  }
  const weekly = val("weekly_ot_after_hours", String(row.weekly_ot_after_hours)) ?? "";
  if (numIn(weekly, 1, 168) == null)
    p.set("rules.weekly_ot_after_hours", "Enter 1 to 168 hours a week.");
  for (const k of [
    "ot_multiplier",
    "after_hours_multiplier",
    "weekend_multiplier",
    "holiday_multiplier",
  ] as const) {
    if (k in r && numIn(r[k] ?? "", 1, 5) == null)
      p.set(`rules.${k}`, "A multiplier from 1 to 5, like 1.5.");
  }
  if ("minimum_margin_percent" in r && numIn(r.minimum_margin_percent ?? "", 0, 100) == null) {
    p.set("rules.minimum_margin_percent", "A percentage from 0 to 100.");
  }

  const names = new Map<string, string>();
  for (const c of charges) names.set(c.name.trim().toLowerCase(), c.key);
  for (const c of charges) {
    const e = draft.charges[c.key];
    if (!e) continue;
    if (e.name !== undefined) {
      const name = e.name.trim();
      if (!name) p.set(`charge.${c.key}.name`, "Give the charge a name.");
      else {
        const other = [...charges].find(
          (o) =>
            o.key !== c.key &&
            (draft.charges[o.key]?.name ?? o.name).trim().toLowerCase() === name.toLowerCase(),
        );
        if (other) p.set(`charge.${c.key}.name`, `"${name}" already exists.`);
      }
    }
    if (e.value !== undefined) {
      const msg = valueProblem(c.kind, e.value, c.key === "per_diem");
      if (msg) p.set(`charge.${c.key}.value`, msg);
    }
  }
  for (const n of draft.creates) {
    const name = n.name.trim();
    if (!name) p.set(`new.${n.tempId}.name`, "Give the charge a name.");
    else if (
      names.has(name.toLowerCase()) ||
      draft.creates.some(
        (o) => o.tempId !== n.tempId && o.name.trim().toLowerCase() === name.toLowerCase(),
      )
    ) {
      p.set(`new.${n.tempId}.name`, `"${name}" already exists.`);
    }
    if (!n.kind) p.set(`new.${n.tempId}.kind`, "Choose what it is charged on.");
    else {
      const msg = valueProblem(n.kind, n.value, false);
      if (msg) p.set(`new.${n.tempId}.value`, msg);
      if (!n.lands_on) p.set(`new.${n.tempId}.lands_on`, "Choose where it lands on the bill.");
      else if (!landingsFor(n.kind).includes(n.lands_on))
        p.set(`new.${n.tempId}.lands_on`, "A % of the Sub Total lands under the Sub Total.");
    }
  }
  return p;
}

function valueProblem(kind: string, raw: string, blankOk: boolean): string | null {
  if (raw.trim() === "") return blankOk ? null : "Enter a value.";
  if (isPercentKind(kind)) return numIn(raw, 0, 100) == null ? "A percentage from 0 to 100." : null;
  const v = numIn(raw, 0, 1_000_000);
  if (v == null) return "An amount of $0 or more.";
  return Math.round(v * 100) / 100 === v ? null : "Dollars and cents only.";
}

// --------------------------------------------------------------------- save

const NUM_RULES = new Set([
  "daily_ot_after_hours",
  "weekly_ot_after_hours",
  "ot_multiplier",
  "after_hours_multiplier",
  "weekend_multiplier",
  "holiday_multiplier",
  "minimum_margin_percent",
]);

/** The draft as billing_rules_save's two arguments. */
export function generalDraftToSave(draft: GeneralDraft): {
  rules: Record<string, unknown>;
  charges: Record<string, unknown>[];
} {
  const rules: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(draft.rules)) {
    rules[k] = NUM_RULES.has(k) ? (v === "" || v == null ? null : numIn(String(v), 0, 1000)) : v;
  }
  const charges: Record<string, unknown>[] = [];
  for (const n of draft.creates) {
    charges.push({
      op: "create",
      name: n.name.trim(),
      kind: n.kind,
      value: n.value.trim() === "" ? null : numIn(n.value, 0, 1_000_000),
      lands_on: n.lands_on,
    });
  }
  for (const key of Object.keys(draft.charges).sort()) {
    const e = draft.charges[key]!;
    const c: Record<string, unknown> = { op: "update", key };
    if (e.name !== undefined) c.name = e.name.trim();
    if (e.value !== undefined)
      c.value = e.value.trim() === "" ? null : numIn(e.value, 0, 1_000_000);
    if (e.active !== undefined) c.active = e.active;
    if (e.archived !== undefined) c.archived = e.archived;
    charges.push(c);
  }
  return { rules, charges };
}

export { CHARGE_KINDS };
