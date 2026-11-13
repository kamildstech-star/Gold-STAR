import { supabase } from "@/integrations/supabase/client";
import { round2 } from "./estimates";

/**
 * The arithmetic behind a payment receipt.
 *
 * The number a customer reads on a receipt — and the only one they ever
 * dispute — is what is still owed after the payment just made. It is computed
 * here from the invoice total and the payment rows, never typed and never
 * copied off a screen.
 *
 * A receipt is a statement about a *moment*: two cheques against one invoice
 * produce two receipts, and the first one must still say what was outstanding
 * on the day it was written, not what is outstanding today. So the balance is
 * measured through this payment inclusive, over payments ordered as the office
 * recorded them — `received_at` is a plain date, so same-day cheques are
 * separated by `created_at` and finally by id, which keeps the order stable
 * across reloads.
 *
 * Overpayment is real here: carriers pay twice, or pay a supplement against
 * the original invoice. It surfaces as a credit rather than as a negative
 * balance, because "you owe -$400" is not a sentence to send a customer.
 */

export type ReceiptPaymentRow = {
  id: string;
  amount: number;
  received_at: string;
  created_at?: string | null;
  method?: string | null;
  reference?: string | null;
  notes?: string | null;
};

export type ReceiptMath = {
  /** The invoice's own billed figure — already net of any discounts. */
  invoiceTotal: number;
  /** Received against this invoice before the payment being receipted. */
  priorPaid: number;
  /** The payment being receipted. */
  thisPayment: number;
  /** Received through this payment inclusive. */
  paidThrough: number;
  /** Still owed after this payment. Never negative. */
  balanceAfter: number;
  /** Received beyond the invoice total. Never negative. */
  overpaid: number;
  /** 1-based position of this payment in the invoice's payment history. */
  ordinal: number;
  /** Payments before this one, oldest first — the receipt's context rows. */
  prior: ReceiptPaymentRow[];
};

/** Oldest first, with same-day cheques kept in the order they were recorded. */
export function orderPayments<T extends ReceiptPaymentRow>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => {
    if (a.received_at !== b.received_at) return a.received_at < b.received_at ? -1 : 1;
    const ac = a.created_at ?? "";
    const bc = b.created_at ?? "";
    if (ac !== bc) return ac < bc ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export function receiptMath(
  invoiceTotal: number,
  rows: readonly ReceiptPaymentRow[],
  paymentId: string,
): ReceiptMath {
  const ordered = orderPayments(rows);
  const index = ordered.findIndex((p) => p.id === paymentId);
  if (index < 0) {
    throw new Error("That payment is not among the payments recorded on this invoice.");
  }
  const prior = ordered.slice(0, index);
  const total = round2(Number(invoiceTotal) || 0);
  const priorPaid = round2(prior.reduce((s, p) => s + (Number(p.amount) || 0), 0));
  const thisPayment = round2(Number(ordered[index]!.amount) || 0);
  const paidThrough = round2(priorPaid + thisPayment);
  return {
    invoiceTotal: total,
    priorPaid,
    thisPayment,
    paidThrough,
    balanceAfter: round2(Math.max(0, total - paidThrough)),
    overpaid: round2(Math.max(0, paidThrough - total)),
    ordinal: index + 1,
    prior,
  };
}

/**
 * A receipt needs an identifier of its own: a customer with two receipts
 * against one invoice must be able to say which one they are holding.
 */
export function receiptNumber(invoiceNumber: string | null | undefined, ordinal: number): string {
  return `${invoiceNumber?.trim() || "PAYMENT"}-R${ordinal}`;
}

/* ------------------------------------------------------------------ */
/* Loading                                                             */
/* ------------------------------------------------------------------ */

export type ReceiptInvoice = {
  id: string;
  invoice_number: string | null;
  billed_amount: number | null;
  collected_amount: number | null;
  issue_date: string | null;
  due_date: string | null;
  job_id: string | null;
  location_id: string;
  account_id: string | null;
};

export type ReceiptContext = {
  payment: ReceiptPaymentRow;
  invoice: ReceiptInvoice;
  math: ReceiptMath;
  receiptNumber: string;
};

const PAYMENT_FIELDS = "id, invoice_id, amount, received_at, created_at, method, reference, notes";
const INVOICE_FIELDS =
  "id, invoice_number, billed_amount, collected_amount, issue_date, due_date, job_id, location_id, account_id";

/**
 * Throws on a failed read rather than returning an empty history: "no earlier
 * payments" and "we could not read the earlier payments" produce different
 * balances, and only one of them is true.
 */
export async function loadReceiptContext(paymentId: string): Promise<ReceiptContext> {
  const { data: payment, error: payErr } = await supabase
    .from("invoice_payments")
    .select(PAYMENT_FIELDS)
    .eq("id", paymentId)
    .maybeSingle();
  if (payErr) throw payErr;
  if (!payment) throw new Error("That payment record no longer exists.");

  const [{ data: invoice, error: invErr }, { data: siblings, error: sibErr }] = await Promise.all([
    supabase.from("invoices").select(INVOICE_FIELDS).eq("id", payment.invoice_id).maybeSingle(),
    supabase.from("invoice_payments").select(PAYMENT_FIELDS).eq("invoice_id", payment.invoice_id),
  ]);
  if (invErr) throw invErr;
  if (sibErr) throw sibErr;
  if (!invoice) throw new Error("The invoice this payment was recorded against could not be read.");

  const math = receiptMath(
    Number(invoice.billed_amount ?? 0),
    (siblings ?? []) as ReceiptPaymentRow[],
    paymentId,
  );
  return {
    payment: payment as ReceiptPaymentRow,
    invoice: invoice as ReceiptInvoice,
    math,
    receiptNumber: receiptNumber(invoice.invoice_number, math.ordinal),
  };
}
