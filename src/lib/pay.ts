// People and pay setup. Everything here is configuration with effective
// dates: a commission calculated in March must still compute at March's terms
// after a June change, so terms are never edited in place — a change closes
// the old row and opens a new one.

import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";

export type SalesTypeRow = Database["public"]["Tables"]["sales_type_assignments"]["Row"];
export type PayStructure = Database["public"]["Tables"]["pay_structures"]["Row"];
export type CommissionPlan = Database["public"]["Tables"]["commission_plans"]["Row"];
export type SalesType = Database["public"]["Enums"]["sales_type"];
export type PayType = Database["public"]["Enums"]["pay_type"];

export const SALES_TYPES: string[] = ["in_house", "cold_caller", "field", "outside_referral"];
export const SALES_TYPE_LABEL: Record<string, string> = {
  in_house: "In-house",
  cold_caller: "Cold caller",
  field: "Field",
  outside_referral: "Outside / referral",
};

export const PAY_TYPES: PayType[] = ["salary", "draw", "commission", "combination"];
export const PAY_TYPE_LABEL: Record<PayType, string> = {
  salary: "Salary",
  draw: "Draw",
  commission: "Commission",
  combination: "Combination",
};

export const DRAW_PERIODS = ["weekly", "biweekly", "semimonthly", "monthly"] as const;

export const COMMISSION_BASES = ["collected", "billed", "gross_profit"] as const;
export const COMMISSION_BASIS_LABEL: Record<string, string> = {
  collected: "On cash collected",
  billed: "On amount billed",
  gross_profit: "On gross profit",
};

export function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

export function isInForce(
  row: { effective_from: string; effective_to: string | null },
  on = todayIso(),
) {
  return row.effective_from <= on && (!row.effective_to || row.effective_to >= on);
}

export function effectiveRangeLabel(row: { effective_from: string; effective_to: string | null }) {
  return row.effective_to
    ? `${row.effective_from} → ${row.effective_to}`
    : `${row.effective_from} → open`;
}

// ---------- reads ----------
export async function listSalesTypes(userId?: string): Promise<SalesTypeRow[]> {
  let q = supabase
    .from("sales_type_assignments")
    .select("*")
    .order("effective_from", { ascending: false });
  if (userId) q = q.eq("user_id", userId);
  const { data, error } = await q;
  if (error) throw error;
  return data ?? [];
}

export async function listPayStructures(userId?: string): Promise<PayStructure[]> {
  let q = supabase.from("pay_structures").select("*").order("effective_from", { ascending: false });
  if (userId) q = q.eq("user_id", userId);
  const { data, error } = await q;
  if (error) throw error;
  return data ?? [];
}

export async function listCommissionPlans(userId?: string): Promise<CommissionPlan[]> {
  let q = supabase
    .from("commission_plans")
    .select("*")
    .order("effective_from", { ascending: false });
  if (userId) q = q.eq("user_id", userId);
  const { data, error } = await q;
  if (error) throw error;
  return data ?? [];
}

// ---------- writes: supersede, never overwrite ----------
async function closeOpenRow(
  table: "sales_type_assignments" | "pay_structures" | "commission_plans",
  id: string,
  effectiveFrom: string,
) {
  const end = new Date(effectiveFrom);
  end.setDate(end.getDate() - 1);
  const { error } = await supabase
    .from(table)
    .update({ effective_to: end.toISOString().slice(0, 10) })
    .eq("id", id);
  if (error) throw error;
}

export async function setSalesType(input: {
  userId: string;
  salesType: SalesType;
  effectiveFrom: string;
  note?: string | null;
  current?: SalesTypeRow | undefined;
}) {
  if (input.current)
    await closeOpenRow("sales_type_assignments", input.current.id, input.effectiveFrom);
  const { error } = await supabase.from("sales_type_assignments").insert({
    user_id: input.userId,
    sales_type: input.salesType,
    effective_from: input.effectiveFrom,
    note: input.note ?? null,
  });
  if (error) throw error;
}

export type SalaryBasis = "annual" | "hourly";

export async function setPayStructure(input: {
  userId: string;
  payType: PayType;
  salaryBasis: SalaryBasis;
  hourlyRate: number | null;
  hoursPerWeek: number | null;
  baseSalaryAnnual: number | null;
  drawAmount: number | null;
  drawPeriod: string | null;
  drawRecoverable: boolean;
  effectiveFrom: string;
  note?: string | null;
  current?: PayStructure | undefined;
}) {
  if (input.current) await closeOpenRow("pay_structures", input.current.id, input.effectiveFrom);
  const { error } = await supabase.from("pay_structures").insert({
    user_id: input.userId,
    pay_type: input.payType,
    salary_basis: input.salaryBasis,
    hourly_rate: input.salaryBasis === "hourly" ? input.hourlyRate : null,
    hours_per_week: input.salaryBasis === "hourly" ? input.hoursPerWeek : null,
    base_salary_annual: input.salaryBasis === "annual" ? input.baseSalaryAnnual : null,
    draw_amount: input.drawAmount,
    draw_period: input.drawPeriod,
    draw_recoverable: input.drawRecoverable,
    effective_from: input.effectiveFrom,
    note: input.note ?? null,
  });
  if (error) throw error;
}

export async function setCommissionPlan(input: {
  userId: string;
  dealSource: string;
  basis: string;
  ratePercent: number | null;
  flatAmount: number | null;
  effectiveFrom: string;
  note?: string | null;
  current?: CommissionPlan | undefined;
}) {
  if (input.current) await closeOpenRow("commission_plans", input.current.id, input.effectiveFrom);
  const { error } = await supabase.from("commission_plans").insert({
    user_id: input.userId,
    deal_source: input.dealSource || "default",
    basis: input.basis,
    rate_percent: input.ratePercent,
    flat_amount: input.flatAmount,
    effective_from: input.effectiveFrom,
    note: input.note ?? null,
  });
  if (error) throw error;
}

/** Terms in force for a person on a given date — the historical-safe read. */
export async function commissionTermsOn(userId: string, source: string, on: string) {
  const { data, error } = await supabase.rpc("commission_terms_on", {
    _user_id: userId,
    _source: source,
    _on: on,
  });
  if (error) throw error;
  return data?.[0] ?? null;
}
