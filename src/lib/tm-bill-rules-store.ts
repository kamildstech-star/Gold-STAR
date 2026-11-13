/**
 * Reading and writing the T&M bill's rules. Since Billing & Costs prompt 2
 * the company's rules live in Billing & Costs › General rules —
 * `billing_general_rules` (time rules) and `billing_charges` (the five
 * standard charges and any added) — seeded from the old app_settings
 * `tm.bill_rules`, which is no longer written. A job's override stays in
 * job_tm_settings (who bills the job writes), laid over the company's key by
 * key. The arithmetic is tm-bill-rules.ts.
 *
 * Before migration 20261030120000 is applied the old app_settings row is
 * read instead, so a bill never comes out different for want of the store.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { isMissingSchema } from "@/lib/schema-fallback";
import {
  cleanRules,
  resolveRules,
  type ChargeKind,
  type CustomCharge,
  type TmBillRules,
} from "@/lib/tm-bill-rules";

export const TM_BILL_RULES_SETTING = "tm.bill_rules";

export type StoredTmRules = {
  /** Settings' rule set as stored (partial). */
  settings: Partial<TmBillRules>;
  /** This job's override (partial); {} when it has none. */
  job: Partial<TmBillRules>;
  /** False until 20261027162000 adds job_tm_settings: no per-job override. */
  jobOverrideAvailable: boolean;
  resolved: TmBillRules;
};

/** One row of billing_general_rules, as PostgREST returns it. */
export type GeneralRulesRow = {
  standard_start: string;
  standard_end: string;
  overtime_mode: "daily" | "after_hours" | "weekly" | "none" | "legacy_both";
  daily_ot_after_hours: number | string | null;
  weekly_ot_after_hours: number | string;
  weekend_days: number[];
  holidays: string[];
  ot_multiplier: number | string;
  after_hours_multiplier: number | string;
  weekend_multiplier: number | string;
  holiday_multiplier: number | string;
  field_form_code: string | null;
  legacy_tax_percent: number | string | null;
  legacy_taxable_categories: string[] | null;
  updated_at: string;
};

export const GENERAL_RULES_COLUMNS =
  "standard_start, standard_end, overtime_mode, daily_ot_after_hours, weekly_ot_after_hours, weekend_days, holidays, ot_multiplier, after_hours_multiplier, weekend_multiplier, holiday_multiplier, field_form_code, legacy_tax_percent, legacy_taxable_categories, updated_at";

export type ChargeRow = {
  key: string;
  name: string;
  kind: ChargeKind | "pct_pass_through";
  value: number | string | null;
  lands_on: string;
  system: boolean;
  active: boolean;
  archived_at: string | null;
  sort_order: number;
};

export const CHARGE_COLUMNS =
  "key, name, kind, value, lands_on, system, active, archived_at, sort_order";

/** The five standard charges' keys, and the rule each one sets. */
export const STANDARD_CHARGE_RULE = {
  small_tools: "smallToolsPercent",
  per_diem: "perDiemPerPersonDay",
  op: "opPercent",
  pass_through: "passThroughMarkupPercent",
  oh_fee: "ohFeePercent",
} as const;

const n = (v: number | string | null | undefined): number | null =>
  v == null || v === "" ? null : Number(v);

/**
 * The store's rows as a rule set. Tax is carried from the old Settings into
 * the legacy columns and handed on unchanged; nothing here edits it.
 */
export function rulesFromStore(
  row: GeneralRulesRow | null,
  charges: readonly ChargeRow[],
): Partial<TmBillRules> {
  const raw: Record<string, unknown> = {};
  if (row) {
    Object.assign(raw, {
      standardStart: row.standard_start,
      standardEnd: row.standard_end,
      overtimeMode: row.overtime_mode === "legacy_both" ? "legacy" : row.overtime_mode,
      dailyOtAfterHours: n(row.daily_ot_after_hours),
      weeklyOtAfterHours: n(row.weekly_ot_after_hours),
      weekendDays: row.weekend_days,
      holidays: row.holidays,
      otMultiplier: n(row.ot_multiplier),
      afterHoursMultiplier: n(row.after_hours_multiplier),
      weekendMultiplier: n(row.weekend_multiplier),
      holidayMultiplier: n(row.holiday_multiplier),
      fieldFormCode: row.field_form_code,
    });
    if (row.legacy_tax_percent != null) raw.taxPercent = n(row.legacy_tax_percent);
    if (row.legacy_taxable_categories != null)
      raw.taxableCategories = row.legacy_taxable_categories;
  }
  const added: CustomCharge[] = [];
  for (const c of charges) {
    const rule = STANDARD_CHARGE_RULE[c.key as keyof typeof STANDARD_CHARGE_RULE];
    if (c.system && rule) {
      // A standard charge switched off bills nothing; Per Diem may be unset.
      raw[rule] = !c.active ? 0 : c.key === "per_diem" ? n(c.value) : (n(c.value) ?? 0);
      continue;
    }
    if (c.system || !c.active || c.archived_at || c.kind === "pct_pass_through") continue;
    added.push({
      key: c.key,
      name: c.name,
      kind: c.kind,
      value: n(c.value),
      landsOn: c.lands_on as CustomCharge["landsOn"],
    });
  }
  raw.charges = added;
  return cleanRules(raw);
}

export type GeneralRulesStore = {
  /** False until 20261030120000: the rules are the old app_settings row's. */
  fromStore: boolean;
  row: GeneralRulesRow | null;
  charges: ChargeRow[];
};

export async function loadGeneralRules(client: SupabaseClient): Promise<GeneralRulesStore> {
  const [rowQ, chargesQ] = await Promise.all([
    client.from("billing_general_rules").select(GENERAL_RULES_COLUMNS).maybeSingle(),
    client.from("billing_charges").select(CHARGE_COLUMNS).order("sort_order"),
  ]);
  if (rowQ.error || chargesQ.error) {
    const err = rowQ.error ?? chargesQ.error;
    if (isMissingSchema(err)) return { fromStore: false, row: null, charges: [] };
    throw err;
  }
  return {
    fromStore: true,
    row: (rowQ.data as GeneralRulesRow | null) ?? null,
    charges: (chargesQ.data ?? []) as ChargeRow[],
  };
}

/** The company's rules: General rules, or the old Settings row before the migration. */
export async function loadSettingsTmRules(client: SupabaseClient): Promise<Partial<TmBillRules>> {
  const store = await loadGeneralRules(client);
  if (store.fromStore) return rulesFromStore(store.row, store.charges);
  const { data, error } = await client
    .from("app_settings")
    .select("value")
    .eq("key", TM_BILL_RULES_SETTING)
    .maybeSingle();
  if (error) {
    if (isMissingSchema(error)) return {};
    throw error;
  }
  return cleanRules((data as { value?: unknown } | null)?.value);
}

/** General rules' one Save (billing_rules_save): rules, charges and a note, audited. */
export async function saveGeneralRules(
  client: SupabaseClient,
  rules: Record<string, unknown>,
  charges: readonly Record<string, unknown>[],
  note: string,
): Promise<number> {
  const { data, error } = await client.rpc(
    "billing_rules_save" as never,
    {
      _rules: rules,
      _charges: charges,
      _note: note.trim() || null,
    } as never,
  );
  if (error) throw error;
  return Number(data ?? 0);
}

export async function loadTmBillRules(
  client: SupabaseClient,
  jobId: string,
): Promise<StoredTmRules> {
  const [company, jobRow, frozenRow] = await Promise.all([
    loadSettingsTmRules(client),
    client.from("job_tm_settings").select("rules").eq("job_id", jobId).maybeSingle(),
    // Prompt 5: a job made after 20261102120000 keeps the General rules and
    // charges of its day; one made before reads today's, as it always did.
    client.from("job_frozen_rules").select("rules, charges").eq("job_id", jobId).maybeSingle(),
  ]);
  const frozen = frozenRow.error
    ? null
    : (frozenRow.data as { rules: GeneralRulesRow; charges: ChargeRow[] } | null);
  const settings = frozen ? rulesFromStore(frozen.rules, frozen.charges ?? []) : company;
  let job: Partial<TmBillRules> = {};
  let jobOverrideAvailable = true;
  if (jobRow.error) {
    if (!isMissingSchema(jobRow.error)) throw jobRow.error;
    jobOverrideAvailable = false;
  } else {
    job = cleanRules((jobRow.data as { rules?: unknown } | null)?.rules);
  }
  return { settings, job, jobOverrideAvailable, resolved: resolveRules(settings, job) };
}

/** A job's override, whole: a key left out follows Settings. */
export async function saveJobTmRules(
  client: SupabaseClient,
  jobId: string,
  rules: Partial<TmBillRules>,
): Promise<void> {
  const { error } = await client
    .from("job_tm_settings")
    .upsert({ job_id: jobId, rules: cleanRules(rules) } as never, { onConflict: "job_id" });
  if (error) throw error;
}
