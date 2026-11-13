import { supabase } from "@/integrations/supabase/client";

/**
 * Director dashboard data.
 *
 * Everything here is gated by capabilities (`director.view`, `rep_cost.view`,
 * `affiliates.manage`) both in the database functions and in the UI. Rep cost
 * is money the rep never sees; the money rule still applies elsewhere.
 */

export type DirectorKpi = {
  user_id: string;
  full_name: string | null;
  jobs_signed_insurance: number;
  jobs_signed_cash: number;
  calls_made: number;
  stage_advances: number;
  meetings_held: number;
  proposals_sent: number;
  accounts_closed: number;
  accounts_touched: number;
};

export type KpiKey =
  "calls_made" | "meetings_held" | "stage_advances" | "accounts_touched" | "proposals_sent";

export const KPI_COLUMNS: { key: KpiKey; label: string }[] = [
  { key: "calls_made", label: "Calls made" },
  { key: "meetings_held", label: "Meetings held" },
  { key: "stage_advances", label: "Stage advances" },
  { key: "accounts_touched", label: "Accounts touched" },
  { key: "proposals_sent", label: "Proposals sent" },
];

export async function fetchDirectorKpis(from: Date, to: Date): Promise<DirectorKpi[]> {
  const { data, error } = await supabase.rpc("director_rep_kpis", {
    _from: from.toISOString(),
    _to: to.toISOString(),
  });
  if (error) throw error;
  const n = (v: unknown) => Number(v ?? 0);
  return (data ?? []).map((r: Record<string, unknown>) => ({
    user_id: r.user_id as string,
    full_name: (r.full_name as string) ?? null,
    jobs_signed_insurance: n(r.jobs_signed_insurance),
    jobs_signed_cash: n(r.jobs_signed_cash),
    calls_made: n(r.calls_made),
    stage_advances: n(r.stage_advances),
    meetings_held: n(r.meetings_held),
    proposals_sent: n(r.proposals_sent),
    accounts_closed: n(r.accounts_closed),
    accounts_touched: n(r.accounts_touched),
  }));
}

/** Team median for a column — the comparison that answers "why is this rep behind". */
export function median(values: number[]): number {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return 0;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

export type RepCost = {
  user_id: string;
  full_name: string | null;
  salary_cost: number;
  commission_paid: number;
  revenue: number;
};

export async function fetchRepCost(from: Date, to: Date): Promise<RepCost[]> {
  const d = (x: Date) => x.toISOString().slice(0, 10);
  const { data, error } = await supabase.rpc("director_rep_cost", {
    _from: d(from),
    _to: d(to),
  });
  if (error) throw error;
  return (data ?? []).map((r: Record<string, unknown>) => ({
    user_id: r.user_id as string,
    full_name: (r.full_name as string) ?? null,
    salary_cost: Number(r.salary_cost ?? 0),
    commission_paid: Number(r.commission_paid ?? 0),
    revenue: Number(r.revenue ?? 0),
  }));
}

export const totalCost = (r: RepCost) => r.salary_cost + r.commission_paid;

/* ------------------------------------------------------------------ */
/* Affiliate salespeople — outside reps, never in employee headcount   */
/* ------------------------------------------------------------------ */

export type AffiliateRep = {
  id: string;
  full_name: string;
  company: string | null;
  email: string | null;
  phone: string | null;
  location_id: string | null;
  payout_terms: string | null;
  commission_rate: number | null;
  status: string;
  notes: string | null;
};

export type AffiliateReferral = {
  id: string;
  affiliate_id: string;
  account_id: string | null;
  job_id: string | null;
  description: string | null;
  referred_on: string;
  amount_owed: number | null;
  paid_on: string | null;
  status: string;
  note: string | null;
};

export async function fetchAffiliates(): Promise<AffiliateRep[]> {
  const { data, error } = await supabase
    .from("affiliate_reps")
    .select(
      "id,full_name,company,email,phone,location_id,payout_terms,commission_rate,status,notes",
    )
    .order("full_name");
  if (error) throw error;
  return (data ?? []) as AffiliateRep[];
}

export async function fetchAffiliateReferrals(): Promise<AffiliateReferral[]> {
  const { data, error } = await supabase
    .from("affiliate_referrals")
    .select(
      "id,affiliate_id,account_id,job_id,description,referred_on,amount_owed,paid_on,status,note",
    )
    .order("referred_on", { ascending: false });
  if (error) throw error;
  return (data ?? []) as AffiliateReferral[];
}

export async function saveAffiliate(input: Partial<AffiliateRep> & { full_name: string }) {
  if (input.id) {
    const { error } = await supabase.from("affiliate_reps").update(input).eq("id", input.id);
    if (error) throw error;
    return input.id;
  }
  const { data, error } = await supabase.from("affiliate_reps").insert(input).select("id").single();
  if (error) throw error;
  return data.id as string;
}

export async function saveReferral(input: Partial<AffiliateReferral> & { affiliate_id: string }) {
  if (input.id) {
    const { error } = await supabase.from("affiliate_referrals").update(input).eq("id", input.id);
    if (error) throw error;
    return;
  }
  const { error } = await supabase.from("affiliate_referrals").insert(input);
  if (error) throw error;
}

export async function markReferralPaid(id: string) {
  const { error } = await supabase
    .from("affiliate_referrals")
    .update({ status: "paid", paid_on: new Date().toISOString().slice(0, 10) })
    .eq("id", id);
  if (error) throw error;
}

export function owedFor(affiliateId: string, rows: AffiliateReferral[]): number {
  return rows
    .filter((r) => r.affiliate_id === affiliateId && r.status !== "paid")
    .reduce((a, r) => a + Number(r.amount_owed ?? 0), 0);
}

export const money = (v: number) =>
  `$${Math.round(v).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
