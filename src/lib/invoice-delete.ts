/**
 * Deleting an invoice from a job's Billing tab — and when it is not allowed.
 *
 * Mark, 2026-10-06, of the Invoices card: "need to rework this box to make
 * more sense and need a delete or undo."
 *
 * Invoices are money, so the line is drawn where an invoice stops being only
 * ours. A DRAFT that was never sent, that the carrier never ruled on, and that
 * no payment was ever recorded against (not even one since removed — the
 * payment trail hangs off the invoice and would go with it) is a document
 * still being written: it may be deleted, behind the same six-second Undo the
 * section notes use (#285). Everything else is on the carrier's books and
 * stays; the reason says what to do instead.
 *
 * NO "VOID". The invoice_status enum has draft · sent · partial · paid ·
 * disputed · written_off, and no void. Adding one is not a label: every total
 * that sums invoices — this card's tiles, the job ledger's Billed, the Billing
 * page, AR aging, the reports, the payment rollup that moves status to
 * partial/paid — would have to learn to leave void out, or a voided invoice
 * would go on counting as billed. That is its own change, for its own PR.
 * Until then the closing status that already exists is Written off, and a
 * mistake on a sent invoice is corrected by editing and resending it, which
 * Versions keeps.
 *
 * NOT ON THE TIMELINE'S RESTORE. The Timeline Restore (#300) leaves money out
 * on purpose — "invoices, invoice lines, payments and money events are never
 * captured or restored here". The delete is still recorded: invoices already
 * carry `log_activity_invoices` (20260820195702), which writes "Invoice
 * deleted — GS-INV-…" to activity_log with the job id, so it shows on the
 * job's Timeline. Undo is the window to change your mind; after it, a draft
 * is re-made with New invoice or Convert.
 *
 * WHO. invoices_delete is `can_manage_location(location_id)` — a manager of
 * the office, not the invoice's author — and the button asks the same
 * function (`fetchManagesOffice`), so it is never offered to someone the
 * database would refuse. A refusal anyway (0 rows) is reported, not shown as
 * success. A BEFORE DELETE trigger (20261006181000) holds the money rule in
 * the database too, whatever path the delete takes.
 */
import { supabase } from "@/integrations/supabase/client";

export type DeletableInvoice = {
  status: string;
  sent_at: string | null;
  approved_amount: number | null;
  collected_amount: number | string | null;
};

export type InvoiceDeleteRule = { allowed: true } | { allowed: false; reason: string };

export const ON_THE_BOOKS_REASON =
  "Sent, approved or paid invoices can't be deleted — they're on the carrier's books. Set the status to Written off, or edit it and resend; Versions keeps every version.";
export const MANAGER_ONLY_REASON = "Only a manager of this office can delete an invoice.";
export const CHECKING_REASON = "Checking whether you can delete invoices for this office…";

/**
 * Whether this invoice may be deleted by this person. `paymentRecords` counts
 * payments AND the trail of removed ones; `manager` is null while the office
 * check is still out (nothing is allowed until it answers).
 */
export function invoiceDeleteRule(
  inv: DeletableInvoice,
  opts: { paymentRecords: number; manager: boolean | null },
): InvoiceDeleteRule {
  const untouched =
    inv.status === "draft" &&
    !inv.sent_at &&
    inv.approved_amount == null &&
    Number(inv.collected_amount ?? 0) === 0 &&
    opts.paymentRecords === 0;
  if (!untouched) return { allowed: false, reason: ON_THE_BOOKS_REASON };
  if (opts.manager === null) return { allowed: false, reason: CHECKING_REASON };
  if (!opts.manager) return { allowed: false, reason: MANAGER_ONLY_REASON };
  return { allowed: true };
}

export async function deleteDraftInvoice(id: string): Promise<void> {
  const { data, error } = await supabase.from("invoices").delete().eq("id", id).select("id");
  if (error) throw error;
  if (!data?.length) throw new Error(MANAGER_ONLY_REASON);
}
