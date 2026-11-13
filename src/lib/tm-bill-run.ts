/**
 * The T&M bill's I/O half: reads the job's daily T&M forms, the rate codes
 * with their rates, and the scanned equipment; writes the draft invoice's
 * lines. The arithmetic is src/lib/tm-bill.ts.
 *
 * The lines go in through `insertInvoicePull` — the same insert Pull from job
 * and Field items use: one scope of ordinary, editable lines, nothing sent.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { EQUIPMENT_TYPE_LABEL } from "@/lib/equipment";
import { insertInvoicePull, type PullInvoice } from "@/lib/invoice-pull-run";
import { REGISTER_TO_CHARGE_KEY, type PullLine } from "@/lib/invoice-pull";
import { fetchCalculatorRates } from "@/lib/job-calculator-pricing";
import { ticketHours } from "@/lib/field-ticket-costing";
import { isMissingSchema } from "@/lib/schema-fallback";
import {
  buildTmBill,
  rangeLabel,
  tmBillInvoiceLines,
  tmBillItemizedSections,
  unitDaysInRange,
  type BillRange,
  type EquipmentInput,
  type FieldFormInput,
  type PricedCode,
  type TmBill,
} from "@/lib/tm-bill";
import {
  normaliseSignIn,
  normaliseSupplyList,
  type SignInPayload,
  type SupplyListPayload,
} from "@/lib/tm-forms";
import { loadTmBillRules, type StoredTmRules } from "@/lib/tm-bill-rules-store";
import {
  loadJobTmCostRates,
  loadJobTmRates,
  withJobCostRates,
  withJobRates,
} from "@/lib/tm-job-rates";
import { tmJobCost, type TmJobCost } from "@/lib/tm-job-cost";
import { TM_RATE_CODE_COLUMNS, loadTmRateCodes } from "@/lib/tm-rate-codes";
import { normalizeStateCode } from "@/lib/us-states";

export type TmBillJob = {
  id: string;
  account_id: string | null;
  location_id: string | null;
  region: string | null;
};

export type TmBillSource = {
  signIns: { date: string; payload: SignInPayload }[];
  supplies: { date: string; payload: SupplyListPayload }[];
  placements: { equipment_type: string | null; placed_at: string; retrieved_at: string | null }[];
  /** The job's daily field forms (TM5); [] before field_work_tickets exists. */
  fieldForms: FieldFormInput[];
  codes: PricedCode[];
  /** Charge rate per register type, per unit-day (the Pull-from-job resolver). */
  equipmentRates: Record<string, number | undefined>;
  /** False until 20261026140000 adds the rate column: every code is unpriced. */
  ratesAvailable: boolean;
  /** False until 20261027161000 adds job_tm_rates: rates are Settings' alone (TM2). */
  jobRatesAvailable: boolean;
  /** Codes whose rate is this job's own, not Settings'. */
  jobRateCodes: string[];
  /** The fee and multiplier rules: Settings, the job's override, resolved (TM3). */
  rules: StoredTmRules;
};

/**
 * Rate codes with their client rate, unit and Small Tools flag; on an older
 * database each tier falls back — the rate without the TM1 columns, then the
 * codes alone. Never the cost rate: that is loadTmCostRates, cost viewers only.
 */
export async function loadPricedCodes(
  client: SupabaseClient,
): Promise<{ codes: PricedCode[]; ratesAvailable: boolean }> {
  type Row = PricedCode & {
    rate: number | string | null;
    unit?: string | null;
    small_tools?: boolean | null;
  };
  const toCode = (r: Row): PricedCode => ({
    code: r.code,
    label: r.label,
    section: r.section,
    rate: r.rate == null ? null : Number(r.rate),
    ...(r.unit !== undefined ? { unit: r.unit } : {}),
    ...(r.small_tools != null ? { smallTools: r.small_tools } : {}),
  });
  // The sheet from Catalogs (20261102120000): no rate column — the bill's
  // rates come from tm_bill_rates in any case.
  const sheet = await client
    .from("tm_sheet_codes")
    .select(`${TM_RATE_CODE_COLUMNS}, unit, small_tools`);
  if (!sheet.error)
    return {
      ratesAvailable: true,
      codes: ((sheet.data ?? []) as unknown as Row[]).map((r) => toCode({ ...r, rate: null })),
    };
  if (!isMissingSchema(sheet.error)) throw sheet.error;
  for (const extra of ["rate, unit, small_tools", "rate"]) {
    const { data, error } = await client
      .from("tm_rate_codes")
      .select(`${TM_RATE_CODE_COLUMNS}, ${extra}`);
    if (!error)
      return { ratesAvailable: true, codes: ((data ?? []) as unknown as Row[]).map(toCode) };
    if (!isMissingSchema(error)) throw error;
  }
  const fallback = await loadTmRateCodes(client);
  return {
    ratesAvailable: false,
    codes: fallback.rows.map((r) => ({
      code: r.code,
      label: r.label,
      section: r.section,
      rate: null,
    })),
  };
}

/**
 * Each code's internal cost rate (TM1/TM7), through tm_rate_code_costs() —
 * which answers only finance or job.view_costs holders. null when the caller
 * may not see costs or the function is not there yet; never a guess.
 */
export async function loadTmCostRates(
  client: SupabaseClient,
): Promise<Map<string, number | null> | null> {
  const { data, error } = await client.rpc("tm_rate_code_costs" as never);
  if (error) return null;
  const rows = (data ?? []) as { code: string; cost_rate: number | string | null }[];
  return new Map(rows.map((r) => [r.code, r.cost_rate == null ? null : Number(r.cost_rate)]));
}

/**
 * Each code's cost on one job (Billing & Costs prompt 3, tm_cost_rates): the
 * job's frozen sheet, else the cost store at the job's office as it stood the
 * day the job was made — so a later publish never moves an existing job's
 * expense. null before migration 20261031120000, or for a caller who may not
 * see the job's costs (the function answers nothing then).
 */
export async function loadJobCostResolved(
  client: SupabaseClient,
  jobId: string,
): Promise<Map<string, number | null> | null> {
  const { data, error } = await client.rpc("tm_cost_rates" as never, { _job_id: jobId } as never);
  if (error) return null;
  const rows = (data ?? []) as { item_key: string; cost_rate: number | string | null }[];
  if (!rows.length) return null;
  return new Map(
    rows.map((r) => [r.item_key.toUpperCase(), r.cost_rate == null ? null : Number(r.cost_rate)]),
  );
}

type TicketRow = {
  work_date: string;
  gsr_crew_size: number | null;
  temp_crew_size: number | null;
  job_start_time: string | null;
  job_end_time: string | null;
  approved_at?: string | null;
};

/**
 * The job's daily field forms. `approved_at` arrived with a later migration;
 * on a database without it every form counts as accepted (there is no
 * approval to wait for), and without the table there are none.
 */
export async function loadFieldForms(
  client: SupabaseClient,
  jobId: string,
): Promise<FieldFormInput[]> {
  const base = "work_date, gsr_crew_size, temp_crew_size, job_start_time, job_end_time";
  type Res = { data: unknown; error: { code?: string; message: string } | null };
  let res: Res = await client
    .from("field_work_tickets")
    .select(`${base}, approved_at`)
    .eq("job_id", jobId);
  let approvalKnown = true;
  if (res.error && isMissingSchema(res.error)) {
    approvalKnown = false;
    res = await client.from("field_work_tickets").select(base).eq("job_id", jobId);
  }
  if (res.error) {
    if (isMissingSchema(res.error)) return [];
    throw res.error;
  }
  return ((res.data ?? []) as TicketRow[]).map((t) => fieldFormFromTicket(t, approvalKnown));
}

export function fieldFormFromTicket(t: TicketRow, approvalKnown = true): FieldFormInput {
  return {
    date: t.work_date,
    gsrCrew: Math.max(0, Number(t.gsr_crew_size ?? 0)),
    tempCrew: Math.max(0, Number(t.temp_crew_size ?? 0)),
    hours: ticketHours(t.job_start_time, t.job_end_time),
    approved: approvalKnown ? Boolean(t.approved_at) : true,
    start: t.job_start_time?.slice(0, 5) ?? undefined,
    end: t.job_end_time?.slice(0, 5) ?? undefined,
  };
}

export type ResolvedTmRate = {
  rate: number | null;
  /**
   * job = the job's own sheet; agreement = its client's T&M agreement
   * (20261107120000); office / default = Billing & Costs › T&M Rates.
   */
  source: "job" | "agreement" | "office" | "default" | "none";
};

/**
 * What every T&M code and equipment type bills at on this job, from the one
 * resolver (tm_bill_rates, migration 20261030120000): the job's own sheet,
 * else the office-aware T&M Rates as they stood at the job's office on the
 * day the job was made. Equipment types come back keyed `EQ:<type>`.
 * null = the resolver is not on this database yet (the old path is used).
 */
export async function loadResolvedTmRates(
  client: SupabaseClient,
  jobId: string,
): Promise<Map<string, ResolvedTmRate> | null> {
  const { data, error } = await client.rpc("tm_bill_rates" as never, { _job_id: jobId } as never);
  if (error) {
    if (isMissingSchema(error) || (error as { code?: string }).code === "PGRST202") return null;
    throw error;
  }
  return new Map(
    ((data ?? []) as { item_key: string; rate: number | string | null; source: string }[]).map(
      (r) => [
        r.item_key.startsWith("EQ:") ? r.item_key : r.item_key.toUpperCase(),
        {
          rate: r.rate == null ? null : Number(r.rate),
          source: r.source as ResolvedTmRate["source"],
        },
      ],
    ),
  );
}

/**
 * Each register type's T&M equipment rate per unit-day: a customer, branch or
 * state price list when one prices it (Client Agreements, prompt 4); else
 * T&M Rates' office-aware rate for the type (EQ:<type>); else the default
 * catalog / built-in rate, as before. T&M Rates was seeded from the default
 * catalog price, so until an office changes it the bill is unchanged.
 */
export function equipmentRatesFor(
  calc: { rates: { equipment: Record<string, number> }; equipmentSources?: Record<string, string> },
  resolved: ReadonlyMap<string, ResolvedTmRate> | null,
  /**
   * Prompt 5 (answer 1): a T&M bill ignores client agreements entirely on a
   * job made under billing version 5 — the job's sheet, then T&M Rates, and
   * nothing else. Older jobs keep the order they were billed by.
   */
  tmOnly = false,
): Record<string, number | undefined> {
  const out: Record<string, number | undefined> = {};
  const types = new Set([
    ...Object.keys(REGISTER_TO_CHARGE_KEY),
    ...[...(resolved?.keys() ?? [])].filter((k) => k.startsWith("EQ:")).map((k) => k.slice(3)),
  ]);
  for (const type of types) {
    const key = REGISTER_TO_CHARGE_KEY[type];
    if (tmOnly) {
      out[type] = resolved?.get(`EQ:${type}`)?.rate ?? undefined;
      continue;
    }
    const fromList = key
      ? ["account", "location", "state"].includes(calc.equipmentSources?.[key] ?? "")
      : false;
    const tm = resolved?.get(`EQ:${type}`)?.rate ?? null;
    out[type] = fromList
      ? calc.rates.equipment[key!]
      : (tm ?? (key ? calc.rates.equipment[key] : undefined));
  }
  return out;
}

/** Everything the bill reads. Throws on a failed read — never a silently empty bill. */
export async function loadTmBillSource(
  client: SupabaseClient,
  job: TmBillJob,
  onDate: string,
): Promise<TmBillSource> {
  const [forms, placements, priced, rates, fieldForms, jobRates, rules, resolved] =
    await Promise.all([
      client
        .from("job_tm_forms")
        .select("kind, form_date, payload")
        .eq("job_id", job.id)
        .in("kind", ["sign_in", "supply_list"]),
      client
        .from("equipment_placements")
        .select("placed_at, retrieved_at, equipment:equipment_id(equipment_type)")
        .eq("job_id", job.id),
      loadPricedCodes(client),
      fetchCalculatorRates({
        accountId: job.account_id,
        locationId: job.location_id,
        stateCode: normalizeStateCode(job.region),
        onDate,
      }),
      loadFieldForms(client, job.id),
      loadJobTmRates(client, job.id),
      loadTmBillRules(client, job.id),
      loadResolvedTmRates(client, job.id),
    ]);
  /*
   * Rates: the resolver when it is there (the job's sheet, else T&M Rates at
   * the job's office as of its creation date); before the migration, the
   * job's sheet over the old Settings column, exactly as it was.
   */
  const layered = resolved
    ? priced.codes.map((c) => {
        const r = resolved.get(c.code.toUpperCase());
        const rate = r?.rate ?? null;
        const rateSource: "job" | "settings" | "none" =
          r?.source === "job" ? "job" : rate != null ? "settings" : "none";
        return { ...c, rate, rateSource };
      })
    : withJobRates(priced.codes, jobRates);
  if (forms.error) throw forms.error;
  if (placements.error) throw placements.error;
  const rows = (forms.data ?? []) as { kind: string; form_date: string; payload: unknown }[];
  const version = await client
    .from("jobs")
    .select("billing_version")
    .eq("id", job.id)
    .maybeSingle();
  const tmOnly =
    !version.error &&
    Number((version.data as { billing_version?: number } | null)?.billing_version) >= 5;
  const equipmentRates = equipmentRatesFor(rates, resolved, tmOnly);
  return {
    signIns: rows
      .filter((r) => r.kind === "sign_in")
      .map((r) => ({ date: r.form_date, payload: normaliseSignIn(r.payload) })),
    supplies: rows
      .filter((r) => r.kind === "supply_list")
      .map((r) => ({ date: r.form_date, payload: normaliseSupplyList(r.payload) })),
    placements: (
      (placements.data ?? []) as unknown as {
        placed_at: string;
        retrieved_at: string | null;
        equipment: { equipment_type: string } | null;
      }[]
    ).map((p) => ({
      placed_at: p.placed_at,
      retrieved_at: p.retrieved_at,
      equipment_type: p.equipment?.equipment_type ?? null,
    })),
    fieldForms,
    codes: layered.map(({ rateSource: _source, ...c }) => c),
    equipmentRates,
    ratesAvailable: priced.ratesAvailable,
    jobRatesAvailable: jobRates != null,
    jobRateCodes: layered.filter((c) => c.rateSource === "job").map((c) => c.code),
    rules,
  };
}

/** Placed equipment as unit-days inside the range, one entry per type. */
export function equipmentForRange(
  source: Pick<TmBillSource, "placements" | "equipmentRates">,
  range: BillRange,
  today: string,
): EquipmentInput[] {
  const byType = new Map<string, { units: number; unitDays: number }>();
  for (const p of source.placements) {
    const days = unitDaysInRange(p.placed_at, p.retrieved_at, range, today);
    if (days <= 0) continue;
    const t = p.equipment_type || "other";
    const agg = byType.get(t) ?? { units: 0, unitDays: 0 };
    agg.units += 1;
    agg.unitDays += days;
    byType.set(t, agg);
  }
  return [...byType.entries()]
    .sort((a, b) => b[1].unitDays - a[1].unitDays)
    .map(([type, agg]) => ({
      label: EQUIPMENT_TYPE_LABEL[type] ?? type,
      units: agg.units,
      unitDays: agg.unitDays,
      rate: source.equipmentRates[type] ?? null,
    }));
}

export function billFromSource(
  source: TmBillSource,
  range: BillRange,
  includeUnsigned: boolean,
  today: string,
  opts?: { fieldFormCode?: string | null },
): TmBill {
  return buildTmBill({
    range,
    signIns: source.signIns,
    supplies: source.supplies,
    equipment: equipmentForRange(source, range, today),
    codes: source.codes,
    includeUnsigned,
    fieldForms: source.fieldForms,
    fieldFormCode: opts?.fieldFormCode ?? null,
    rules: source.rules.resolved,
  });
}

/**
 * The bill onto a draft invoice as ordinary lines. Sends nothing.
 *
 * "itemized" (the default since the 3 Nov meeting) writes one section per
 * category with a line per person-day or item on its date
 * (tmBillItemizedSections); "summary" writes the one-line-per-category copy.
 */
export type TmBillLayout = "itemized" | "summary";

export async function insertTmBill(
  client: SupabaseClient,
  invoice: Pick<PullInvoice, "id">,
  bill: TmBill,
  layout: TmBillLayout = "itemized",
): Promise<number> {
  const lines: PullLine[] = tmBillInvoiceLines(bill).map((l) => ({ kind: "supply", ...l }));
  // The job's tax rate onto the draft, so the invoice works out the same tax
  // the bill showed, on the same lines (TM3/TM4). Never cleared by a bill
  // with no tax rule: an invoice's own rate stands then.
  if (bill.taxPercent > 0) {
    const { error } = await client
      .from("invoices")
      .update({ tax_rate: Math.round(bill.taxPercent * 1000) / 100000 } as never)
      .eq("id", invoice.id);
    if (error) throw error;
  }
  if (layout === "summary") {
    return insertInvoicePull(client, {
      invoiceId: invoice.id,
      scopeCount: 0,
      lines,
      scopeName: `T&M bill ${rangeLabel(bill.range)}`,
    });
  }
  let written = 0;
  const sections = tmBillItemizedSections(bill).filter((sec) => sec.lines.length > 0);
  for (const [i, sec] of sections.entries()) {
    written += await insertInvoicePull(client, {
      invoiceId: invoice.id,
      scopeCount: i,
      lines: sec.lines.map((l) => ({ kind: "supply", ...l })),
      scopeName: `${sec.name} · ${rangeLabel(bill.range)}`,
    });
  }
  return written;
}

/**
 * The job's internal cost from its T&M data, start to today (TM7). Null for
 * a caller who may not see costs (both cost RPCs answer nothing) — the job
 * page shows nothing then. Never part of the bill or its customer copy.
 */
export async function loadTmJobCost(
  client: SupabaseClient,
  job: TmBillJob,
  today: string,
): Promise<{ cost: TmJobCost; billedOnForms: number } | null> {
  const [source, resolved] = await Promise.all([
    loadTmBillSource(client, job, today),
    loadJobCostResolved(client, job.id),
  ]);
  // Before 20261031120000: Settings' single cost per code, under the job's sheet.
  const [settingsCosts, jobCosts] = resolved
    ? [null, resolved]
    : await Promise.all([loadTmCostRates(client), loadJobTmCostRates(client, job.id)]);
  if (!settingsCosts && !jobCosts) return null;
  const days = [
    ...source.signIns.map((s) => s.date),
    ...source.supplies.map((s) => s.date),
    ...source.fieldForms.map((f) => f.date),
  ].sort();
  if (!days.length) return null;
  const range = {
    from: days[0]!,
    to: today > days[days.length - 1]! ? today : days[days.length - 1]!,
  };
  const bill = billFromSource(source, range, false, today);
  return {
    cost: tmJobCost(bill, withJobCostRates(source.codes, settingsCosts, jobCosts)),
    billedOnForms: bill.totals.subtotal,
  };
}
