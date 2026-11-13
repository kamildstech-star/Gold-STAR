/**
 * Correcting a recorded payment, and the trail every correction leaves.
 *
 * David, 24 Sep: "if somebody puts in a payment and makes a mistake...
 * payments have to be editable."
 *
 * The trail is written by the database (tg_invoice_payment_audit,
 * 20260927121000) on every update and delete — who, when, the payment before
 * and after, and the reason given here. This module never writes the trail
 * itself; it cannot be skipped by a screen that forgets to.
 *
 * Until that migration is applied there is no trail, so editing refuses
 * rather than changing money with nobody's name on it.
 */

import { supabase } from "@/integrations/supabase/client";
import { isMissingSchema } from "@/lib/schema-fallback";

export type PaymentFacts = {
  amount: number;
  received_at: string;
  method: string | null;
  reference: string | null;
  notes: string | null;
};

export type PaymentChange = {
  id: string;
  payment_id: string;
  invoice_id: string;
  action: "edit" | "remove";
  changed_by: string | null;
  before_data: PaymentFacts;
  after_data: PaymentFacts | null;
  reason: string | null;
  created_at: string;
  /** Resolved from profiles for the list; null when the person is gone. */
  changed_by_name?: string | null;
};

export const NOT_MIGRATED =
  "Editing payments needs a database update that has not been applied yet — until it is, there is nowhere to keep the record of who changed what.";

/** What stops a correction from being saved, or null. */
export function paymentEditProblem(draft: {
  amount: number | null;
  received_at: string;
  reason: string;
}): string | null {
  if (draft.amount == null || !Number.isFinite(draft.amount) || draft.amount <= 0) {
    return "A payment needs an amount above zero. To take one off, use Remove.";
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.received_at)) return "Give the date it was received.";
  if (!draft.reason.trim())
    return "Say why it is being changed — it goes in the payment's history.";
  return null;
}

const usd = (n: number) =>
  Number(n).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  });

/** "Amount $5,000.00 → $500.00 · Reference 1041 → 1014": what actually moved. */
export function describePaymentChange(
  c: Pick<PaymentChange, "action" | "before_data" | "after_data">,
): string {
  const b = c.before_data;
  if (c.action === "remove" || !c.after_data) {
    return `Removed ${usd(b.amount)} received ${b.received_at}${b.method ? ` by ${b.method}` : ""}`;
  }
  const a = c.after_data;
  const parts: string[] = [];
  if (Number(a.amount) !== Number(b.amount))
    parts.push(`Amount ${usd(b.amount)} → ${usd(a.amount)}`);
  if (a.received_at !== b.received_at) parts.push(`Date ${b.received_at} → ${a.received_at}`);
  if ((a.method ?? "") !== (b.method ?? ""))
    parts.push(`Method ${b.method ?? "—"} → ${a.method ?? "—"}`);
  if ((a.reference ?? "") !== (b.reference ?? "")) {
    parts.push(`Reference ${b.reference ?? "—"} → ${a.reference ?? "—"}`);
  }
  if ((a.notes ?? "") !== (b.notes ?? "")) parts.push("Notes changed");
  return parts.join(" · ") || "No change to the figures";
}

/** RLS refuses an update by matching no row: say so instead of looking saved. */
function refused(data: unknown[] | null): boolean {
  return (data ?? []).length === 0;
}

export async function editPayment(input: {
  id: string;
  facts: PaymentFacts;
  reason: string;
}): Promise<void> {
  const { data, error } = await supabase
    .from("invoice_payments")
    .update({ ...input.facts, change_reason: input.reason.trim() } as never)
    .eq("id", input.id)
    .select("id");
  if (error) {
    if (isMissingSchema(error)) throw new Error(NOT_MIGRATED);
    throw error;
  }
  if (refused(data)) throw new Error("Only a manager of this office can change this payment.");
}

export async function removePayment(input: { id: string; reason: string }): Promise<void> {
  // The reason rides on the row so the delete trigger can file it with the removal.
  const tag = await supabase
    .from("invoice_payments")
    .update({ change_reason: input.reason.trim() } as never)
    .eq("id", input.id)
    .select("id");
  if (tag.error) {
    if (isMissingSchema(tag.error)) throw new Error(NOT_MIGRATED);
    throw tag.error;
  }
  if (refused(tag.data)) throw new Error("Only a manager of this office can remove this payment.");
  const { error } = await supabase.from("invoice_payments").delete().eq("id", input.id);
  if (error) throw error;
}

/** The trail for the invoices shown; empty (not an error) before the migration. */
export async function listPaymentChanges(invoiceIds: readonly string[]): Promise<PaymentChange[]> {
  if (invoiceIds.length === 0) return [];
  const { data, error } = await supabase
    .from("invoice_payment_changes" as never)
    .select(
      "id, payment_id, invoice_id, action, changed_by, before_data, after_data, reason, created_at",
    )
    .in("invoice_id", [...invoiceIds])
    .order("created_at", { ascending: false });
  if (error) {
    if (isMissingSchema(error)) return [];
    throw error;
  }
  const rows = (data ?? []) as unknown as PaymentChange[];
  const ids = [...new Set(rows.map((r) => r.changed_by).filter((x): x is string => !!x))];
  if (ids.length) {
    const { data: people } = await supabase
      .from("profiles")
      .select("user_id, full_name")
      .in("user_id", ids);
    const name = new Map((people ?? []).map((p) => [p.user_id, p.full_name]));
    for (const r of rows)
      r.changed_by_name = r.changed_by ? (name.get(r.changed_by) ?? null) : null;
  }
  return rows;
}
