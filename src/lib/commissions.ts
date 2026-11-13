// Commission reads for the rep-facing page and the manager view. The
// calculation itself lives in the database (compute_job_commissions), fired by
// a trigger on jobs, so a payout always matches the job's current money and a
// rep can never be paid twice for the same deal. Everything here is a read of
// what the engine produced, through the caller's own client — RLS decides
// whether you see only your own rows or your team's.

import { supabase } from "@/integrations/supabase/client";

export type PayoutRow = {
  id: string;
  user_id: string;
  job_id: string | null;
  kind: string;
  status: string;
  amount: number;
  basis: string | null;
  basis_amount: number | null;
  rate_percent: number | null;
  split_percent: number;
  tier_key: string | null;
  period_start: string;
  period_end: string;
  expected_pay_date: string | null;
  issued_on: string | null;
  note: string | null;
  /** Null for the engine's own approval (the stage at arrival paid it). */
  approved_by?: string | null;
  jobs?: {
    job_number: string | null;
    job_name: string | null;
    address?: string | null;
    /** The account's stage when the job arrived — src/lib/job-credit.ts. */
    credit_stage_key?: string | null;
    credit_requires_approval?: boolean | null;
    accounts?: { name: string | null } | null;
  } | null;
};

export type CommissionOverview = {
  signed_volume: number;
  collected_volume: number;
  salary_period: number;
  pay_type: string | null;
};

export type TierRow = {
  key: string;
  label: string;
  rate_percent: number | null;
  min_amount: number | null;
  work_component: string | null;
};

// Typed as a plain string on purpose. PostgREST parses a literal select at
// the type level, and this one nests two levels deep; that instantiation
// tips the compiler over its depth limit here. The shape is declared by
// hand as PayoutRow, which the read below casts to, so nothing is lost.
//
// `accounts` MUST name its foreign key. A job points at accounts twice — the
// customer (jobs.account_id) and whoever is billed (jobs.bill_to_account_id,
// added 2026-08-31). Once the second one existed a bare `accounts(name)` was
// ambiguous, so PostgREST stopped answering this query with PGRST201 ("more
// than one relationship was found") and the page read the failure as an empty
// period — every rep was told they had no payouts. The customer is the name we
// want beside a commission, so pin jobs_account_id_fkey.
export const PAYOUT_SELECT: string =
  "id,user_id,job_id,kind,status,amount,basis,basis_amount,rate_percent,split_percent,tier_key,period_start,period_end,expected_pay_date,issued_on,note,approved_by,jobs(job_number,job_name,address,credit_stage_key,credit_requires_approval,accounts!jobs_account_id_fkey(name))";

/** Payouts for one person (or several, for a manager) overlapping a period. */
export async function listPayouts(opts: {
  userIds: string[];
  from?: string;
  to?: string;
}): Promise<PayoutRow[]> {
  if (opts.userIds.length === 0) return [];
  let q = supabase
    .from("commission_payouts")
    .select(PAYOUT_SELECT)
    .in("user_id", opts.userIds)
    .order("period_start", { ascending: false })
    .limit(500);
  if (opts.from) q = q.gte("period_end", opts.from);
  if (opts.to) q = q.lte("period_start", opts.to);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as unknown as PayoutRow[];
}

/** Every payout ever for a person — used for the year-to-date chart. */
export async function listPayoutsAllTime(userIds: string[]): Promise<PayoutRow[]> {
  return listPayouts({ userIds });
}

export async function fetchOverview(
  userId: string,
  from: string,
  to: string,
): Promise<CommissionOverview> {
  const { data, error } = await supabase.rpc("commission_overview", {
    _user_id: userId,
    _from: from,
    _to: to,
  });
  if (error) throw error;
  const row = (data ?? [])[0];
  return {
    signed_volume: Number(row?.signed_volume ?? 0),
    collected_volume: Number(row?.collected_volume ?? 0),
    salary_period: Number(row?.salary_period ?? 0),
    pay_type: row?.pay_type ?? null,
  };
}

export async function fetchMyTiers(): Promise<TierRow[]> {
  const { data, error } = await supabase.rpc("my_commission_tiers");
  if (error) throw error;
  return (data ?? []) as TierRow[];
}

export async function setPayoutStatus(id: string, status: string): Promise<void> {
  const { error } = await supabase.rpc("set_commission_payout_status", {
    _id: id,
    _status: status,
  });
  if (error) throw error;
}

/** Rebuild payouts from the jobs as they stand — safe, never touches paid rows. */
export async function recomputeAll(): Promise<number> {
  const { data, error } = await supabase.rpc("recompute_all_commissions");
  if (error) throw error;
  return Number(data ?? 0);
}

export type TierProgress = {
  current: TierRow | null;
  next: TierRow | null;
  volume: number;
  gap: number;
  upliftOnCurrentVolume: number;
};

/**
 * Where the rep sits on the ladder and what the next rung is worth on the
 * volume they have already signed — the number that actually motivates.
 */
export function tierProgress(tiers: TierRow[], volume: number): TierProgress {
  const ladder = [...tiers].sort((a, b) => Number(a.min_amount ?? 0) - Number(b.min_amount ?? 0));
  const current = [...ladder].filter((t) => Number(t.min_amount ?? 0) <= volume).pop() ?? null;
  const next = ladder.find((t) => Number(t.min_amount ?? 0) > volume) ?? null;
  const gap = next ? Math.max(0, Number(next.min_amount ?? 0) - volume) : 0;
  const uplift = next
    ? ((Number(next.rate_percent ?? 0) - Number(current?.rate_percent ?? 0)) / 100) * volume
    : 0;
  return {
    current,
    next,
    volume,
    gap,
    upliftOnCurrentVolume: Math.max(0, Math.round(uplift)),
  };
}

/**
 * What the payouts table should show.
 *
 * A failed read and a genuinely quiet period look identical once you only look
 * at the row count, and this page printed "No payouts in this period" for both.
 * That is the worst possible wording for a failure: a rep reads it as "I am
 * owed nothing" and stops asking. Keep the two apart so the error can say it is
 * an error and offer a retry.
 */
export type PayoutsView = "loading" | "error" | "empty" | "rows";

export function payoutsView(q: {
  isLoading: boolean;
  isError: boolean;
  rowCount: number;
}): PayoutsView {
  if (q.isLoading) return "loading";
  if (q.isError) return "error";
  return q.rowCount === 0 ? "empty" : "rows";
}

/**
 * Whether the tier ladder may be claimed at all.
 *
 * Tiers arrive from `my_commission_tiers` and the plan from `commission_plans`
 * — two reads that can disagree. They did: the page announced "Top tier reached
 * — $26,533 signed" and "Platinum · 12.5%" directly beside "No commission plan
 * is in force", with $0 in every tile. A tier is a term of a plan, so when no
 * plan is in force there is no tier to report and the claim must not render.
 */
export type TierClaim = "loading" | "no-plan" | "no-ladder" | "ladder";

export function tierClaim(a: {
  planLoading: boolean;
  hasPlan: boolean;
  tierCount: number;
}): TierClaim {
  if (a.planLoading) return "loading";
  if (!a.hasPlan) return "no-plan";
  return a.tierCount === 0 ? "no-ladder" : "ladder";
}

export const PAYOUT_STATUS_LABEL: Record<string, string> = {
  pending: "Pending",
  approved: "Approved",
  paid: "Paid",
  void: "Declined",
};

/** Monthly totals for the YTD chart, paid vs everything still owed. */
export function monthlySeries(
  payouts: PayoutRow[],
  year: number,
): { month: string; paid: number; pending: number }[] {
  const months = Array.from({ length: 12 }, (_, i) => ({
    month: new Date(year, i, 1).toLocaleString("en-US", { month: "short" }),
    paid: 0,
    pending: 0,
  }));
  for (const p of payouts) {
    const iso = p.period_start ?? "";
    if (!iso.startsWith(String(year))) continue;
    const idx = Number(iso.slice(5, 7)) - 1;
    const bucket = months[idx];
    if (!bucket) continue;
    if (p.status === "paid") bucket.paid += Number(p.amount ?? 0);
    else if (p.status !== "void") bucket.pending += Number(p.amount ?? 0);
  }
  return months;
}
