// Job cost and rep profitability. Everything here is admin/owner/sales-head
// territory: the money rule says a rep sees no figure until money is in, so
// none of these reads are wired into a rep surface. The database enforces it
// too — the RPCs return nothing unless can_view_finance() passes.

import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import type { AppRole } from "@/lib/roles";
import { toDateStr, type Range } from "@/lib/period";

export type JobCostLine = Database["public"]["Tables"]["job_cost_lines"]["Row"];
export type JobReferralCost = Database["public"]["Tables"]["job_referral_costs"]["Row"];
export type CommissionTier = Database["public"]["Tables"]["commission_tiers"]["Row"];

/** Mirrors public.can_view_finance — kept in sync deliberately. */
export const FINANCE_ROLES: AppRole[] = ["owner", "admin", "sales_head", "dev"];

export function canViewFinance(roles: AppRole[]) {
  return roles.some((r) => FINANCE_ROLES.includes(r));
}

export function money(n: number | string | null | undefined) {
  const v = Number(n ?? 0);
  return v.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

export function moneyExact(n: number | string | null | undefined) {
  return Number(n ?? 0).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

/* ---------------------------------------------------------------- */
/* Work components — a managed option list, never hardcoded          */
/* ---------------------------------------------------------------- */

export type WorkComponent = { key: string; label: string; sort_order: number };

export const WORK_COMPONENT_FALLBACK: WorkComponent[] = [
  { key: "mitigation", label: "Mitigation", sort_order: 10 },
  { key: "reconstruction", label: "Reconstruction", sort_order: 20 },
  { key: "dry_cleaning", label: "Dry Cleaning", sort_order: 30 },
];

export async function listWorkComponents(): Promise<WorkComponent[]> {
  const { data, error } = await supabase
    .from("option_list_values")
    .select("key, label, sort_order, active, option_lists!inner(key)")
    .eq("option_lists.key", "work_component")
    .eq("active", true)
    .order("sort_order");
  if (error) throw error;
  const rows = (data ?? []).map((r) => ({
    key: r.key,
    label: r.label,
    sort_order: r.sort_order ?? 0,
  }));
  return rows.length ? rows : WORK_COMPONENT_FALLBACK;
}

export function componentLabel(key: string, list: WorkComponent[]) {
  if (key === "unassigned") return "Unassigned";
  return list.find((c) => c.key === key)?.label ?? key;
}

/* ---------------------------------------------------------------- */
/* Per-job cost breakdown                                            */
/* ---------------------------------------------------------------- */

export type CostRow = {
  work_component: string;
  revenue: number;
  direct_cost: number;
  materials_cost: number;
  subcontractor_cost: number;
  equipment_cost: number;
  equipment_days: number;
  labour_cost: number;
  labour_minutes: number;
  referral_cost: number;
  total_cost: number;
  margin: number;
  margin_pct: number | null;
};

export async function jobCostBreakdown(jobId: string): Promise<CostRow[]> {
  const { data, error } = await supabase.rpc("job_cost_breakdown", { _job_id: jobId });
  if (error) throw error;
  return (data ?? []).map((r) => ({
    work_component: r.work_component,
    revenue: Number(r.revenue ?? 0),
    direct_cost: Number(r.direct_cost ?? 0),
    materials_cost: Number(r.materials_cost ?? 0),
    subcontractor_cost: Number(r.subcontractor_cost ?? 0),
    equipment_cost: Number(r.equipment_cost ?? 0),
    equipment_days: Number(r.equipment_days ?? 0),
    labour_cost: Number(r.labour_cost ?? 0),
    labour_minutes: Number(r.labour_minutes ?? 0),
    referral_cost: Number(r.referral_cost ?? 0),
    total_cost: Number(r.total_cost ?? 0),
    margin: Number(r.margin ?? 0),
    margin_pct: r.margin_pct == null ? null : Number(r.margin_pct),
  }));
}

export function totalsOf(rows: CostRow[]) {
  const sum = (pick: (r: CostRow) => number) => rows.reduce((a, r) => a + pick(r), 0);
  const revenue = sum((r) => r.revenue);
  const cost = sum((r) => r.total_cost);
  return {
    revenue,
    labour: sum((r) => r.labour_cost),
    referral: sum((r) => r.referral_cost),
    equipmentDays: sum((r) => r.equipment_days),
    cost,
    margin: revenue - cost,
    marginPct: revenue > 0 ? ((revenue - cost) / revenue) * 100 : null,
  };
}

export async function listCostLines(jobId: string): Promise<JobCostLine[]> {
  const { data, error } = await supabase
    .from("job_cost_lines")
    .select("*")
    .eq("job_id", jobId)
    .order("work_component");
  if (error) throw error;
  return data ?? [];
}

export async function upsertCostLine(input: {
  job_id: string;
  work_component: string;
  revenue: number;
  direct_cost: number;
  materials_cost: number;
  subcontractor_cost: number;
  equipment_cost: number;
  equipment_days: number;
  notes?: string | null;
}) {
  const { error } = await supabase
    .from("job_cost_lines")
    .upsert(input, { onConflict: "job_id,work_component" });
  if (error) throw error;
}

export async function deleteCostLine(id: string) {
  const { error } = await supabase.from("job_cost_lines").delete().eq("id", id);
  if (error) throw error;
}

/* ---------------------------------------------------------------- */
/* Referral cost — a line of its own, not a footnote                 */
/* ---------------------------------------------------------------- */

export type ReferralCostRow = JobReferralCost & {
  accounts?: { id: string; name: string } | null;
};

export async function listReferralCosts(jobId: string): Promise<ReferralCostRow[]> {
  const { data, error } = await supabase
    .from("job_referral_costs")
    .select("*, accounts(id, name)")
    .eq("job_id", jobId)
    .order("created_at");
  if (error) throw error;
  return (data ?? []) as ReferralCostRow[];
}

export async function addReferralCost(input: {
  job_id: string;
  work_component: string | null;
  account_id: string | null;
  source_name: string | null;
  amount: number;
  basis: string;
  rate_percent: number | null;
  paid_on: string | null;
  note: string | null;
}) {
  const { error } = await supabase.from("job_referral_costs").insert(input);
  if (error) throw error;
}

export async function deleteReferralCost(id: string) {
  const { error } = await supabase.from("job_referral_costs").delete().eq("id", id);
  if (error) throw error;
}

/* ---------------------------------------------------------------- */
/* Company money summary + rep profitability                         */
/* ---------------------------------------------------------------- */

export type MoneySummary = {
  total_revenue: number;
  received: number;
  open_claims_value: number;
  open_claims_count: number;
  direct_costs: number;
  labour_cost: number;
  referral_cost: number;
  rep_cost: number;
  net_profit: number;
};

export async function companyMoneySummary(
  range: Range,
  locationId?: string | null,
): Promise<MoneySummary> {
  const { data, error } = await supabase.rpc("company_money_summary", {
    _from: toDateStr(range.from),
    _to: toDateStr(range.to),
    _location_id: locationId ?? undefined,
  });
  if (error) throw error;
  const r = (data ?? [])[0];
  return {
    total_revenue: Number(r?.total_revenue ?? 0),
    received: Number(r?.received ?? 0),
    open_claims_value: Number(r?.open_claims_value ?? 0),
    open_claims_count: Number(r?.open_claims_count ?? 0),
    direct_costs: Number(r?.direct_costs ?? 0),
    labour_cost: Number(r?.labour_cost ?? 0),
    referral_cost: Number(r?.referral_cost ?? 0),
    rep_cost: Number(r?.rep_cost ?? 0),
    net_profit: Number(r?.net_profit ?? 0),
  };
}

export type RepProfitRow = {
  user_id: string;
  full_name: string | null;
  revenue: number;
  collected: number;
  salary_cost: number;
  commission_cost: number;
  expense_cost: number;
  total_rep_cost: number;
  net_contribution: number;
  job_count: number;
};

export async function repProfitability(
  range: Range,
  locationId?: string | null,
): Promise<RepProfitRow[]> {
  const { data, error } = await supabase.rpc("rep_profitability", {
    _from: toDateStr(range.from),
    _to: toDateStr(range.to),
    _location_id: locationId ?? undefined,
  });
  if (error) throw error;
  return (data ?? []).map((r) => ({
    user_id: r.user_id,
    full_name: r.full_name,
    revenue: Number(r.revenue ?? 0),
    collected: Number(r.collected ?? 0),
    salary_cost: Number(r.salary_cost ?? 0),
    commission_cost: Number(r.commission_cost ?? 0),
    expense_cost: Number(r.expense_cost ?? 0),
    total_rep_cost: Number(r.total_rep_cost ?? 0),
    net_contribution: Number(r.net_contribution ?? 0),
    job_count: Number(r.job_count ?? 0),
  }));
}

/* ---------------------------------------------------------------- */
/* Commission tiers — configuration, never hardcoded percentages     */
/* ---------------------------------------------------------------- */

export async function listCommissionTiers(): Promise<CommissionTier[]> {
  const { data, error } = await supabase
    .from("commission_tiers")
    .select("*")
    .order("sort_order")
    .order("work_component", { nullsFirst: true });
  if (error) throw error;
  return data ?? [];
}

export async function saveCommissionTier(row: Partial<CommissionTier> & { id?: string }) {
  if (row.id) {
    const { id, ...rest } = row;
    const { error } = await supabase.from("commission_tiers").update(rest).eq("id", id);
    if (error) throw error;
    return;
  }
  const { error } = await supabase.from("commission_tiers").insert({
    key: row.key ?? "tier",
    label: row.label ?? "Tier",
    rate_percent: row.rate_percent ?? 0,
    min_amount: row.min_amount ?? 0,
    work_component: row.work_component ?? null,
    sort_order: row.sort_order ?? 0,
    effective_from: row.effective_from ?? new Date().toISOString().slice(0, 10),
    effective_to: row.effective_to ?? null,
    note: row.note ?? null,
  });
  if (error) throw error;
}

export async function deleteCommissionTier(id: string) {
  const { error } = await supabase.from("commission_tiers").delete().eq("id", id);
  if (error) throw error;
}

/** Rate for an amount at a point in time — tiers are effective-dated, so a
 *  plan change today never recalculates a commission earned in March. */
export function tierRateFor(
  tiers: CommissionTier[],
  amount: number,
  workComponent: string | null,
  on = new Date().toISOString().slice(0, 10),
): CommissionTier | null {
  const live = tiers.filter(
    (t) =>
      t.active &&
      t.effective_from <= on &&
      (!t.effective_to || t.effective_to >= on) &&
      (t.work_component == null || t.work_component === workComponent) &&
      Number(t.min_amount) <= amount,
  );
  if (!live.length) return null;
  // Component-specific beats the catch-all; then the highest threshold met.
  live.sort((a, b) => {
    const spec = Number(b.work_component != null) - Number(a.work_component != null);
    if (spec) return spec;
    return Number(b.min_amount) - Number(a.min_amount);
  });
  return live[0];
}
