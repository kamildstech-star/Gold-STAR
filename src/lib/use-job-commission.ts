/**
 * Everything a job's commission is worked out FROM, read once and handed to
 * the one calculation (`src/lib/job-commission.ts`). The Commissions card and
 * the ledger strip's Referral and Commission cells both call this hook, so
 * they share these queries through the cache and cannot print two different
 * figures for the same job.
 *
 * Mark, 7 Oct: "it will pull the referring company from general ... and that
 * should be connected to the card". The referrer is the job's General-tab
 * referral (`referred_by_account_id` / `referred_by_contact_id`), its deal is
 * the referrer rule or the "Came from" rate, and the base is the job's
 * revenue from `job_running_cost` — so a new estimate or invoice moves the
 * commission the moment the running cost is re-read (`refreshJobMoney`).
 *
 * `money: false` is a viewer without `job.view_costs`: nothing is read.
 *
 * Every new column or table is optional here. Before 20261007224100 (rules)
 * or 20261007224200 (flat override) are applied the reads step down and the
 * job is worked out from what exists, exactly as before.
 */

import { useMemo } from "react";
import { useQuery, type QueryClient } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";

import { supabase } from "@/integrations/supabase/client";
import {
  commissionTotals,
  referrerLine,
  salesmanLines,
  type CommissionLine,
  type JobReferrerFacts,
  type SalesmanPayout,
} from "@/lib/job-commission";
import { parseCommissionSources } from "@/lib/job-ledger";
import { loadRulesForReferrer } from "@/lib/referral-commission-rules";
import { jobRunningCost } from "@/lib/running-cost";
import { isMissingSchema } from "@/lib/schema-fallback";

const db = () => supabase as unknown as SupabaseClient;

export type JobCommissionRow = {
  commission_source: string | null;
  commission_rate_pct: number | null;
  commission_flat_amount: number | null;
  commission_paid_on: string | null;
  commission_paid_ref: string | null;
  commission_paid_amount: number | null;
  referred_by_account_id: string | null;
  referred_by_contact_id: string | null;
  referred_by_name: string | null;
  created_at: string | null;
  /** The credit snapshot (20261110180000) — null on jobs from before it. */
  credit_rep_id: string | null;
  credit_stage_key: string | null;
  credit_requires_approval: boolean | null;
  credit_locked_at: string | null;
  /** False until 20261007224200: the flat override cannot be stored yet. */
  flatTracked: boolean;
  /** False until 20260927122000: paid status cannot be stored yet. */
  paidTracked: boolean;
};

const BASE_COLS =
  "commission_source, commission_rate_pct, referred_by_account_id, referred_by_contact_id, referred_by_name, created_at";
const PAID_COLS = "commission_paid_on, commission_paid_ref, commission_paid_amount";
const CREDIT_COLS = "credit_rep_id, credit_stage_key, credit_requires_approval, credit_locked_at";

const EMPTY_ROW: JobCommissionRow = {
  commission_source: null,
  commission_rate_pct: null,
  commission_flat_amount: null,
  commission_paid_on: null,
  commission_paid_ref: null,
  commission_paid_amount: null,
  referred_by_account_id: null,
  referred_by_contact_id: null,
  referred_by_name: null,
  created_at: null,
  credit_rep_id: null,
  credit_stage_key: null,
  credit_requires_approval: null,
  credit_locked_at: null,
  flatTracked: false,
  paidTracked: false,
};

/** The job's commission columns, stepping down past any not yet migrated. */
export async function loadJobCommissionRow(jobId: string): Promise<JobCommissionRow> {
  const attempts: { cols: string; flat: boolean; paid: boolean }[] = [
    {
      cols: `${BASE_COLS}, ${PAID_COLS}, commission_flat_amount, ${CREDIT_COLS}`,
      flat: true,
      paid: true,
    },
    { cols: `${BASE_COLS}, ${PAID_COLS}, commission_flat_amount`, flat: true, paid: true },
    { cols: `${BASE_COLS}, ${PAID_COLS}`, flat: false, paid: true },
    { cols: BASE_COLS, flat: false, paid: false },
  ];
  for (const a of attempts) {
    const { data, error } = await db().from("jobs").select(a.cols).eq("id", jobId).maybeSingle();
    if (error) {
      if (isMissingSchema(error)) continue;
      throw error;
    }
    const row = (data ?? {}) as Partial<JobCommissionRow>;
    return {
      ...EMPTY_ROW,
      ...row,
      commission_rate_pct: row.commission_rate_pct == null ? null : Number(row.commission_rate_pct),
      commission_flat_amount:
        row.commission_flat_amount == null ? null : Number(row.commission_flat_amount),
      commission_paid_amount:
        row.commission_paid_amount == null ? null : Number(row.commission_paid_amount),
      flatTracked: a.flat,
      paidTracked: a.paid,
    };
  }
  return EMPTY_ROW;
}

/** The office's calendar day of an instant — gsr_local_date() in the SQL twin. */
export function officeDate(at: string | null): string | null {
  if (!at) return null;
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

async function loadReferrer(accountId: string | null, contactId: string | null) {
  const [acct, person, rules] = await Promise.all([
    accountId
      ? supabase.from("accounts").select("name").eq("id", accountId).maybeSingle()
      : Promise.resolve({ data: null }),
    contactId
      ? supabase.from("contacts").select("full_name").eq("id", contactId).maybeSingle()
      : Promise.resolve({ data: null }),
    loadRulesForReferrer({ accountId, contactId }),
  ]);
  return {
    accountName: (acct.data as { name?: string } | null)?.name ?? null,
    contactName: (person.data as { full_name?: string } | null)?.full_name ?? null,
    rules: rules.rules,
    rulesAvailable: rules.available,
  };
}

/** The rep commission engine's payouts for this job, with the reps' names. */
export async function loadSalesmanPayouts(
  jobId: string,
): Promise<{ payouts: SalesmanPayout[]; names: Record<string, string> }> {
  const { data, error } = await db()
    .from("commission_payouts")
    .select("user_id, amount, status, basis, basis_amount, rate_percent, paid_at, issued_on")
    .eq("job_id", jobId)
    .eq("kind", "commission");
  if (error) {
    if (isMissingSchema(error)) return { payouts: [], names: {} };
    throw error;
  }
  const payouts = ((data ?? []) as SalesmanPayout[]).map((p) => ({
    ...p,
    amount: Number(p.amount),
    basis_amount: p.basis_amount == null ? null : Number(p.basis_amount),
  }));
  const ids = [...new Set(payouts.map((p) => p.user_id))];
  const names: Record<string, string> = {};
  if (ids.length) {
    const { data: people } = await supabase
      .from("profiles")
      .select("user_id, full_name")
      .in("user_id", ids);
    for (const p of people ?? []) if (p.full_name) names[p.user_id] = p.full_name;
  }
  return { payouts, names };
}

export async function loadCommissionRates() {
  const { data } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "commission_rates")
    .maybeSingle();
  return parseCommissionSources(data?.value);
}

/**
 * After anything that moves a job's money — an estimate or invoice line, a
 * payment — re-read the running cost (the commission's base) and the
 * invoices. "Auto calculate as the charges get added" is this.
 */
export function refreshJobMoney(qc: QueryClient, jobId: string | null | undefined) {
  if (!jobId) return;
  void qc.invalidateQueries({ queryKey: ["job-running-cost", jobId] });
  void qc.invalidateQueries({ queryKey: ["job-ledger-invoices", jobId] });
  void qc.invalidateQueries({ queryKey: ["job-salesman-payouts", jobId] });
}

/** After the referral, the deal or the override changes. */
export function refreshJobCommission(qc: QueryClient, jobId: string) {
  void qc.invalidateQueries({ queryKey: ["job-commission", jobId] });
  void qc.invalidateQueries({ queryKey: ["job-referrer"] });
  void qc.invalidateQueries({ queryKey: ["commissions-report"] });
}

export function useJobCommission(jobId: string, opts: { money: boolean } = { money: true }) {
  const money = opts.money;
  const costQ = useQuery({
    queryKey: ["job-running-cost", jobId],
    queryFn: () => jobRunningCost(jobId),
    enabled: money,
  });
  const jobQ = useQuery({
    queryKey: ["job-commission", jobId],
    queryFn: () => loadJobCommissionRow(jobId),
    enabled: money,
  });
  const ratesQ = useQuery({
    queryKey: ["commission-rates"],
    queryFn: loadCommissionRates,
    enabled: money,
  });
  const accountId = jobQ.data?.referred_by_account_id ?? null;
  const contactId = jobQ.data?.referred_by_contact_id ?? null;
  const referrerQ = useQuery({
    queryKey: ["job-referrer", accountId, contactId],
    queryFn: () => loadReferrer(accountId, contactId),
    enabled: money && !!jobQ.data,
  });
  const payoutsQ = useQuery({
    queryKey: ["job-salesman-payouts", jobId],
    queryFn: () => loadSalesmanPayouts(jobId),
    enabled: money,
  });

  const sources = useMemo(() => ratesQ.data ?? [], [ratesQ.data]);
  const job = jobQ.data ?? null;
  const facts = useMemo<JobReferrerFacts | null>(() => {
    if (!job) return null;
    return {
      accountId: job.referred_by_account_id,
      contactId: job.referred_by_contact_id,
      sourceKey: job.commission_source,
      overridePct: job.commission_rate_pct,
      overrideFlat: job.commission_flat_amount,
      rules: referrerQ.data?.rules ?? [],
      sources,
      on: officeDate(job.created_at),
      contactName: referrerQ.data?.contactName ?? null,
      accountName: referrerQ.data?.accountName ?? null,
      referredByName: job.referred_by_name,
      paidOn: job.paidTracked ? job.commission_paid_on : null,
      paidAmount: job.commission_paid_amount,
    };
  }, [job, referrerQ.data, sources]);

  const base = costQ.data ? costQ.data.revenue : null;
  const referrer = useMemo(() => (facts ? referrerLine(facts, base) : null), [facts, base]);
  const salesmen = useMemo<CommissionLine[]>(
    () => (payoutsQ.data ? salesmanLines(payoutsQ.data.payouts, payoutsQ.data.names) : []),
    [payoutsQ.data],
  );
  const lines = useMemo(() => [...(referrer ? [referrer] : []), ...salesmen], [referrer, salesmen]);
  const totals = useMemo(() => commissionTotals(lines), [lines]);

  return {
    job,
    facts,
    sources,
    referrer,
    salesmen,
    lines,
    totals,
    base,
    rulesAvailable: referrerQ.data?.rulesAvailable ?? true,
    costQ,
    jobQ,
    loading: money && (costQ.isLoading || jobQ.isLoading),
  };
}
