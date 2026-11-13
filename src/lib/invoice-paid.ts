import type { InvoiceStatus } from "@/lib/billing";
import { INVOICE_STATUS_LABEL } from "@/lib/billing";

/**
 * Mark says: "payments should be recorded when an invoice is marked paid".
 *
 * Half of that already worked. Recording a payment inserts an `invoice_payments`
 * row and `tg_invoice_payment_rollup` re-derives `collected_amount` and the
 * status from the sum — so payment -> Paid was right. The other direction was
 * not: picking "Paid" in the status dropdown wrote `invoices.status` alone, so
 * the invoice read as paid on screen while `collected_amount` stayed at zero
 * and no payment row existed at all.
 *
 * That matters because every revenue figure in the app is sourced from
 * `invoice_payments`, not from the status: reporting (`reports-engine.ts`), the
 * location scorecard (`location-scorecard.ts`) and rep revenue (the
 * `rep_revenue_from_invoice_payments` migration). An invoice marked paid the
 * old way was a paid invoice that had collected nothing, everywhere it counted.
 *
 * So "Paid" is no longer something you can type. It is derived from the money,
 * and choosing it asks for the money. The database trigger stays the only thing
 * that writes `status = 'paid'`, which keeps one source of truth instead of two
 * writers that can disagree.
 */

/** The columns this decision needs. `uncollected` is generated: billed − collected. */
export type InvoiceBalanceRow = {
  billed_amount: number | string | null;
  collected_amount: number | string | null;
  uncollected?: number | string | null;
};

const num = (v: number | string | null | undefined): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * What is still owed on this invoice. Prefers the generated `uncollected`
 * column, but a caller that selected only billed and collected still gets the
 * right answer rather than a silent zero — a zero here means "nothing to
 * collect", and inventing one would hand the user a $0 payment dialog.
 */
export function outstandingBalance(inv: InvoiceBalanceRow): number {
  if (inv.uncollected != null && Number.isFinite(Number(inv.uncollected))) {
    return num(inv.uncollected);
  }
  return num(inv.billed_amount) - num(inv.collected_amount);
}

export type StatusSelection =
  /** Write the status straight through, exactly as this control always has. */
  | { action: "write"; status: InvoiceStatus }
  /** Don't write anything — open the payment dialog prefilled with `amount`. */
  | { action: "collect"; amount: number };

/**
 * Decides what picking `next` in an invoice status dropdown should do.
 *
 * Only "Paid" changes behavior. Draft, Sent, Part paid, Disputed and Written
 * off all still write directly, because none of them claims money arrived.
 *
 * Two cases end up writing "Paid" anyway, and both are honest:
 *
 *  - a zero-value invoice — nothing was ever owed, so there is no payment to
 *    record and forcing a $0 row through the dialog would put a fiction in the
 *    ledger;
 *  - an invoice already collected in full — the payment rows exist and the
 *    revenue is real. This is how Disputed or Written off gets corrected back
 *    to Paid without asking for a second cheque that never came.
 */
export function resolveInvoiceStatusSelection(
  next: InvoiceStatus,
  inv: InvoiceBalanceRow,
): StatusSelection {
  if (next !== "paid") return { action: "write", status: next };
  const balance = outstandingBalance(inv);
  if (balance <= 0) return { action: "write", status: next };
  return { action: "collect", amount: balance };
}

/**
 * Said when the payment dialog is dismissed without recording anything. The
 * dropdown snapping back to where it was, on its own, reads like the app lost
 * the click; naming the status it kept makes the refusal deliberate.
 */
export function statusUnchangedMessage(status: InvoiceStatus): string {
  return `No payment recorded — this invoice is still ${INVOICE_STATUS_LABEL[status]}.`;
}

/**
 * Which invoice the Payments card's "Add payment" records against.
 *
 * Mark, 2026-10-06, of the Payments card ("No payment recorded yet. Use
 * Record payment on the invoice it pays."): "add a add payment button here".
 *
 * A payment row is a child of one invoice (`invoice_payments.invoice_id`) —
 * the collected and outstanding figures, the Paid rollup and the receipt all
 * hang off it — so the card's button never writes a payment of its own.
 *
 * Since 2026-10-07 the button opens the Add payment dialog, where the person
 * ticks the invoices (Mark: "allow them to check an invoice it's applying
 * to"); this rule is now what that dialog lists — `payableInvoices` in
 * `add-payment.ts`.
 *
 *  - one invoice with a balance due: that one, straight into the dialog;
 *  - several with a balance: the person picks, by number and balance;
 *  - none with a balance but some invoices (all paid, a supplement or a
 *    double payment arriving): every invoice, picked the same way — or the
 *    only one, directly. Overpaying is allowed; the dialog warns, as it does;
 *  - no invoice at all: nothing. A payment cannot float unattached, and
 *    inventing an invoice to hang it on would put a number on the carrier's
 *    books nobody chose. The card says to create the invoice first.
 */
export type PaymentTarget<T> =
  { kind: "none" } | { kind: "one"; invoice: T } | { kind: "pick"; invoices: T[] };

export function paymentTarget<T extends InvoiceBalanceRow>(
  invoices: readonly T[],
): PaymentTarget<T> {
  const open = invoices.filter((inv) => outstandingBalance(inv) > 0.005);
  const candidates = open.length ? open : [...invoices];
  if (candidates.length === 0) return { kind: "none" };
  if (candidates.length === 1) return { kind: "one", invoice: candidates[0]! };
  return { kind: "pick", invoices: candidates };
}
