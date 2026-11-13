// Rep expenses and company cards. Under the threshold a charge goes through;
// above it the Sales Head has to say yes first — and the rep is standing in a
// restaurant, so the request and the answer both have to work on a phone.

import { supabase } from "@/integrations/supabase/client";
import { LARGE_LOSS_KINDS } from "@/lib/large-loss-expenses";
import type { Database } from "@/integrations/supabase/types";
import { TONE } from "@/lib/tone";

export type Expense = Database["public"]["Tables"]["expenses"]["Row"];
export type ExpenseRequest = Database["public"]["Tables"]["expense_requests"]["Row"];
export type ExpenseThreshold = Database["public"]["Tables"]["expense_thresholds"]["Row"];
export type ExpenseKind = Database["public"]["Enums"]["expense_kind"];
export type ExpenseRequestStatus = Database["public"]["Enums"]["expense_request_status"];

export const EXPENSE_KINDS: string[] = [
  "car_payment",
  "auto_stipend",
  "gas_card",
  "company_card",
  "general",
  "reimbursement",
];

export const EXPENSE_KIND_LABEL: Record<string, string> = {
  car_payment: "Car payment",
  auto_stipend: "Auto stipend",
  gas_card: "Gas card",
  company_card: "Company card",
  general: "General expense",
  reimbursement: "Reimbursement",
};

export const REQUEST_STATUS_LABEL: Record<ExpenseRequestStatus, string> = {
  pending: "Awaiting approval",
  approved: "Approved",
  declined: "Declined",
  auto_approved: "Auto-approved",
  cancelled: "Canceled",
};

export const REQUEST_STATUS_TONE: Record<ExpenseRequestStatus, string> = {
  pending: TONE.warning,
  approved: TONE.success,
  declined: TONE.danger,
  auto_approved: TONE.success,
  cancelled: TONE.neutral,
};

/** Car allowances and phone plans repeat; a one-off charge does not. Both
 *  feed Total Rep Cost, so frequency is part of the record, not a convention. */
export const RECURRENCES = [
  "one_off",
  "weekly",
  "biweekly",
  "monthly",
  "quarterly",
  "yearly",
] as const;
export type RecurrenceFreq = (typeof RECURRENCES)[number];

export const RECURRENCE_LABEL: Record<RecurrenceFreq, string> = {
  one_off: "One-off",
  weekly: "Weekly",
  biweekly: "Every 2 weeks",
  monthly: "Monthly",
  quarterly: "Quarterly",
  yearly: "Yearly",
};

/** Calendar date in the browser's own timezone. `toISOString()` is UTC, which
 *  put a rep east of Greenwich on yesterday's date before breakfast and a rep
 *  in the US on tomorrow's after dinner — wrong month boundary on the 1st. */
export function localDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function monthStartLocal(now: Date = new Date()): string {
  return localDateStr(new Date(now.getFullYear(), now.getMonth(), 1));
}

/** What the rep is told after tapping the button. The insert trigger routes
 *  under-threshold requests to `auto_approved`, never `approved`, so the
 *  status the row comes back with is the only source of truth here. */
export function requestOutcomeMessage(status: ExpenseRequestStatus, threshold: number): string {
  if (status === "auto_approved" || status === "approved") {
    return `Under ${money(threshold)} — approved automatically, go ahead.`;
  }
  return "Sent to the Sales Head. You'll get the answer here.";
}

export function money(n: number | string | null | undefined) {
  const v = Number(n ?? 0);
  return v.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
}

export async function myThreshold(userId: string): Promise<number> {
  const { data, error } = await supabase.rpc("expense_threshold_for", { _user_id: userId });
  if (error) throw error;
  return Number(data ?? 50);
}

export async function listExpenses(opts: { userId?: string; from?: string }): Promise<Expense[]> {
  let q = supabase
    .from("expenses")
    .select("*")
    // A job's large-loss costs (contractors, supplies, equipment) are the
    // job's, not a person's claim — they live on the job's Billing tab.
    .not("kind", "in", `(${LARGE_LOSS_KINDS.join(",")})`)
    .order("spent_on", { ascending: false })
    .limit(500);
  if (opts.userId) q = q.eq("user_id", opts.userId);
  if (opts.from) q = q.gte("spent_on", opts.from);
  const { data, error } = await q;
  if (error) throw error;
  return data ?? [];
}

export async function listRequests(opts: {
  userId?: string;
  status?: ExpenseRequestStatus[];
}): Promise<ExpenseRequest[]> {
  let q = supabase
    .from("expense_requests")
    .select("*")
    .order("requested_at", { ascending: false })
    .limit(200);
  if (opts.userId) q = q.eq("user_id", opts.userId);
  if (opts.status?.length) q = q.in("status", opts.status);
  const { data, error } = await q;
  if (error) throw error;
  return data ?? [];
}

export async function requestApproval(input: {
  userId: string;
  locationId: string | null;
  kind: ExpenseKind;
  amount: number;
  merchant: string | null;
  purpose: string;
  accountId?: string | null;
}) {
  const { data, error } = await supabase
    .from("expense_requests")
    .insert({
      user_id: input.userId,
      location_id: input.locationId,
      kind: input.kind,
      amount: input.amount,
      merchant: input.merchant,
      purpose: input.purpose,
      account_id: input.accountId ?? null,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function decideRequest(id: string, approve: boolean, note?: string) {
  const { error } = await supabase
    .from("expense_requests")
    .update({
      status: approve ? "approved" : "declined",
      decision_note: note ?? null,
      decided_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) throw error;
}

export async function logExpense(input: {
  userId: string;
  locationId: string | null;
  kind: ExpenseKind;
  amount: number;
  spentOn: string;
  merchant: string | null;
  description: string | null;
  cardLast4?: string | null;
  requestId?: string | null;
  /** "one_off" | "weekly" | "biweekly" | "monthly" | "quarterly" | "yearly" */
  recurrence?: RecurrenceFreq;
  recurringFrom?: string | null;
  recurringUntil?: string | null;
}) {
  const { error } = await supabase.from("expenses").insert({
    user_id: input.userId,
    location_id: input.locationId,
    kind: input.kind,
    amount: input.amount,
    spent_on: input.spentOn,
    merchant: input.merchant,
    description: input.description,
    card_last4: input.cardLast4 ?? null,
    request_id: input.requestId ?? null,
    recurrence: input.recurrence ?? "one_off",
    recurring_from:
      input.recurrence && input.recurrence !== "one_off"
        ? (input.recurringFrom ?? input.spentOn)
        : null,
    recurring_until:
      input.recurrence && input.recurrence !== "one_off" ? (input.recurringUntil ?? null) : null,
    created_by: input.userId,
  });
  if (error) throw error;
}

export async function listThresholds(): Promise<ExpenseThreshold[]> {
  const { data, error } = await supabase.from("expense_thresholds").select("*").order("amount");
  if (error) throw error;
  return data ?? [];
}

export async function saveThreshold(input: {
  id?: string;
  userId?: string | null;
  role?: string | null;
  amount: number;
}) {
  const row = {
    ...(input.id ? { id: input.id } : {}),
    user_id: input.userId ?? null,
    role: (input.role ?? null) as never,
    amount: input.amount,
  };
  const { error } = await supabase.from("expense_thresholds").upsert(row as never);
  if (error) throw error;
}

export function summarise(expenses: Expense[]) {
  const byKind = new Map<string, number>();
  let total = 0;
  let unreimbursed = 0;
  for (const e of expenses) {
    const amt = Number(e.amount);
    total += amt;
    if (!e.reimbursed && e.kind === "reimbursement") unreimbursed += amt;
    byKind.set(e.kind, (byKind.get(e.kind) ?? 0) + amt);
  }
  return { total, unreimbursed, byKind };
}
