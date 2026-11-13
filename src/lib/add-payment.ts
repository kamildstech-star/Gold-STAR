import { supabase } from "@/integrations/supabase/client";
import { outstandingBalance, paymentTarget, type InvoiceBalanceRow } from "@/lib/invoice-paid";

/**
 * The Add payment dialog's rules, kept pure so they can be tested without a
 * screen.
 *
 * Mark, 2026-10-07, showing JobNimbus's Add Payment dialog: "make this pop up
 * for add payment, just with our look, and allow them to check an invoice
 * it's applying to."
 *
 * One cheque often pays more than one invoice — the mitigation and the
 * rebuild, or the original and its supplement — so a payment is entered once
 * (date, method, reference, the amount on the cheque) and split across the
 * invoices ticked under it. It is still stored the way it always was: one
 * `invoice_payments` row per invoice, because that row is what the rollup
 * trigger, the payment trail, the receipt and every revenue report read. This
 * file never invents a second kind of payment record.
 */

/**
 * Plain strings, not an enum: `invoice_payments.method` is free text with no
 * check constraint (read off the live database, 7 Oct), so nothing here needs
 * a migration and "Other…" can still take a method nobody listed.
 *
 * The first six are the office's existing words and stay exactly as they were
 * stored, so the Payments tab and the reports keep grouping them together.
 * JobNimbus's list maps onto them — its "Bank Wire" is our "ACH / wire", its
 * "Credit Card" our "Credit card" — and adds the two it had that we did not:
 * Money order and Finance. JobNimbus's "None" is the explicit no-method choice
 * below, stored as null like an untouched picker always was.
 */
export const PAYMENT_METHODS = [
  "Check",
  "ACH / wire",
  // Next to ACH because it is the same question being answered -- money moved
  // bank to bank -- and a rep looking for it looks there.
  "Zelle",
  "Credit card",
  "Cash",
  "Carrier direct deposit",
  "Money order",
  "Finance",
] as const;

/** UI sentinels for the method picker; neither is ever stored. */
export const NO_METHOD = "__none";
export const OTHER_METHOD = "__other";

/** What the picker's choice stores: null for None, the typed word for Other. */
export function methodValue(choice: string, other: string): string | null {
  if (!choice || choice === NO_METHOD) return null;
  if (choice === OTHER_METHOD) return other.trim() || null;
  return choice;
}

/** The invoice columns the dialog shows and checks against. */
export type PayableInvoice = InvoiceBalanceRow & {
  id: string;
  invoice_number: string;
  issue_date: string;
  due_date: string | null;
  billed_amount: number | string;
};

/**
 * Which invoices the dialog lists.
 *
 * The same rule Add payment has used since #301 (`paymentTarget`): the
 * invoices with a balance due, or — when everything is paid and a supplement
 * or a double payment arrives — every invoice. The caller passes the invoices
 * on the card (`visibleInvoices`, #321), so a draft waiting out its Undo is
 * never offered. `include` keeps the invoice a "Record payment" button was
 * pressed on, even a paid one: that button has always allowed overpaying.
 * `canRecord` mirrors the invoice_payments write policy, so nobody is offered
 * an invoice the database would refuse.
 */
export function payableInvoices<T extends PayableInvoice>(
  invoices: readonly T[],
  opts: { include?: string | null; canRecord?: (inv: T) => boolean } = {},
): T[] {
  const target = paymentTarget(invoices);
  const base: T[] =
    target.kind === "none" ? [] : target.kind === "one" ? [target.invoice] : target.invoices;
  const extra = opts.include ? invoices.find((i) => i.id === opts.include) : undefined;
  const list = extra && !base.includes(extra) ? [...base, extra] : base;
  const allowed = opts.canRecord ?? (() => true);
  // Kept in the card's own order, so the dialog reads like the list above it.
  return invoices.filter((inv) => list.includes(inv) && allowed(inv));
}

/**
 * A payment lands on the day the office says it did. toISOString() would give
 * the UTC date, which is tomorrow's for anyone posting a late-afternoon cheque
 * west of Greenwich — and received_at is a plain date column, so it would stick.
 */
export function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

/* ------------------------------------------------------------------ */
/* The draft                                                           */
/* ------------------------------------------------------------------ */

export type AddPaymentDraft = {
  date: string;
  /** Picker choice: a method, NO_METHOD or OTHER_METHOD. */
  method: string;
  methodOther: string;
  reference: string;
  notes: string;
  /**
   * The amount on the cheque. Until somebody types it, it follows what is
   * applied, so the common case (pay these invoices in full) needs no typing.
   */
  received: string;
  receivedTouched: boolean;
  /** Ticked invoices → amount to apply, as typed. Insertion order is tick order. */
  applied: Record<string, string>;
};

/** Money compared in whole cents — 0.1 + 0.2 must not block a save. */
export function toCents(text: string | number | null | undefined): number | null {
  if (text == null) return null;
  const s = String(text).trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

const fromCents = (c: number) => (c / 100).toFixed(2);

/** The amount a tick pre-fills: what is still owed, never a negative. */
export function prefillAmount(inv: PayableInvoice): string {
  const due = Math.round(outstandingBalance(inv) * 100);
  return due > 0 ? fromCents(due) : "";
}

export function initialDraft(today: string, preselect?: PayableInvoice | null): AddPaymentDraft {
  const draft: AddPaymentDraft = {
    date: today,
    method: NO_METHOD,
    methodOther: "",
    reference: "",
    notes: "",
    received: "",
    receivedTouched: false,
    applied: {},
  };
  return preselect ? setChecked(draft, preselect, true) : draft;
}

function followReceived(d: AddPaymentDraft): AddPaymentDraft {
  if (d.receivedTouched) return d;
  const sum = Object.values(d.applied).reduce((s, v) => s + (toCents(v) ?? 0), 0);
  return { ...d, received: sum ? fromCents(sum) : "" };
}

/** Ticking pre-fills the invoice's balance due; unticking forgets the amount. */
export function setChecked(
  d: AddPaymentDraft,
  inv: PayableInvoice,
  checked: boolean,
): AddPaymentDraft {
  const applied = { ...d.applied };
  if (checked) {
    if (!(inv.id in applied)) applied[inv.id] = prefillAmount(inv);
  } else {
    delete applied[inv.id];
  }
  return followReceived({ ...d, applied });
}

export function setAmount(d: AddPaymentDraft, invoiceId: string, text: string): AddPaymentDraft {
  if (!(invoiceId in d.applied)) return d;
  return followReceived({ ...d, applied: { ...d.applied, [invoiceId]: text } });
}

/** Typing the received amount pins it; clearing it goes back to following. */
export function setReceived(d: AddPaymentDraft, text: string): AddPaymentDraft {
  if (!text.trim()) return followReceived({ ...d, received: "", receivedTouched: false });
  return { ...d, received: text, receivedTouched: true };
}

export type PaymentTotals = {
  /** Sum of the ticked invoices' amounts, in cents. */
  applied: number;
  received: number;
  /** Received beyond what is applied — JobNimbus's "Credit". */
  credit: number;
  /** Applied beyond what was received. */
  over: number;
};

export function paymentTotals(d: AddPaymentDraft): PaymentTotals {
  const applied = Object.values(d.applied).reduce((s, v) => s + Math.max(0, toCents(v) ?? 0), 0);
  const received = d.receivedTouched ? Math.max(0, toCents(d.received) ?? 0) : applied;
  return {
    applied,
    received,
    credit: Math.max(0, received - applied),
    over: Math.max(0, applied - received),
  };
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

export type AddPaymentIssue = {
  /** Which part of the dialog it is about, so the line can sit beside it. */
  field: "invoices" | "amount" | "reference" | "date" | "credit" | "over";
  invoiceId?: string;
  message: string;
};

const usd = (cents: number) =>
  (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

/**
 * Why Save is off, and what is worth a second look but allowed.
 *
 * - At least one invoice: a payment row is a child of an invoice.
 * - Reference # required, as JobNimbus requires it. The old Record payment
 *   dialog let it go blank (two live rows have none), and a blank reference
 *   is the payment nobody can match to a deposit later.
 * - Each ticked amount above $0. More than the balance is a warning only —
 *   carriers pay twice, or pay a supplement on the original — exactly as the
 *   old dialog treated it.
 * - Credit must be $0. There is no customer credit or unapplied-payment
 *   ledger in this app (no column or table holds one), so money not applied
 *   to an invoice would have nowhere to be recorded. The dialog says to apply
 *   it all rather than quietly dropping the difference.
 * - Applied cannot exceed received: that would record money that never came.
 * - The date: required. A future date is allowed, as it always has been.
 */
export function checkAddPayment(
  d: AddPaymentDraft,
  invoices: readonly PayableInvoice[],
): { errors: AddPaymentIssue[]; warnings: AddPaymentIssue[]; canSave: boolean } {
  const errors: AddPaymentIssue[] = [];
  const warnings: AddPaymentIssue[] = [];
  const ticked = Object.keys(d.applied);

  if (ticked.length === 0) {
    errors.push({ field: "invoices", message: "Check the invoice this payment applies to." });
  }
  for (const id of ticked) {
    const inv = invoices.find((i) => i.id === id);
    const label = inv?.invoice_number ?? "this invoice";
    const cents = toCents(d.applied[id]);
    if (cents == null || cents <= 0) {
      errors.push({
        field: "amount",
        invoiceId: id,
        message: `Enter an amount above $0 for ${label}.`,
      });
      continue;
    }
    const due = inv ? Math.round(outstandingBalance(inv) * 100) : null;
    if (due != null && cents > due) {
      warnings.push({
        field: "amount",
        invoiceId: id,
        message: `${usd(cents)} is more than the ${usd(Math.max(0, due))} due on ${label} — it will be left overpaid.`,
      });
    }
  }
  if (!d.reference.trim()) {
    errors.push({
      field: "reference",
      message: "Reference # is required — the check number, ACH trace or transaction ID.",
    });
  }
  if (!d.date) errors.push({ field: "date", message: "Pick the payment date." });

  const t = paymentTotals(d);
  if (t.credit > 0) {
    errors.push({
      field: "credit",
      message: `Apply the full amount to invoices — ${usd(t.credit)} is left as credit, and there is no customer credit to hold it.`,
    });
  }
  if (t.over > 0) {
    errors.push({
      field: "over",
      message: `${usd(t.over)} more is applied than was received. Lower an invoice's amount or correct the amount received.`,
    });
  }
  return { errors, warnings, canSave: errors.length === 0 };
}

/* ------------------------------------------------------------------ */
/* Saving                                                              */
/* ------------------------------------------------------------------ */

export type PaymentInsertRow = {
  invoice_id: string;
  amount: number;
  method: string | null;
  received_at: string;
  reference: string | null;
  notes: string | null;
  created_by: string | null;
  document_id?: string;
};

/**
 * One row per ticked invoice, in tick order, each carrying the shared facts
 * of the payment — date, method, reference, notes, the photo. Every row has
 * the same keys, because PostgREST takes a bulk insert's columns from them.
 */
export function buildPaymentRows(
  d: AddPaymentDraft,
  opts: { userId: string | null; documentId?: string | null },
): PaymentInsertRow[] {
  const shared = {
    method: methodValue(d.method, d.methodOther),
    received_at: d.date,
    reference: d.reference.trim() || null,
    notes: d.notes.trim() || null,
    created_by: opts.userId,
    // Spread rather than a plain null: before 20260902100000 the column does
    // not exist and naming it at all would reject the insert.
    ...(opts.documentId ? { document_id: opts.documentId } : {}),
  };
  return Object.entries(d.applied).map(([invoice_id, text]) => ({
    invoice_id,
    amount: (toCents(text) ?? 0) / 100,
    ...shared,
  }));
}

/**
 * THE write. One insert of every row, which PostgREST runs as a single
 * statement in a single transaction: either every invoice gets its share or
 * none does, and a refusal on one (RLS, a bad amount) takes the rest back
 * with it. That is the atomicity an RPC would have bought, without a function
 * to maintain or a migration to wait for — and the rows still go in under the
 * caller's own invoice_payments_write policy, through the same rollup trigger
 * and payment trail as the old single-invoice dialog. Supabase-js sends an
 * array as one request; do not loop this.
 *
 * Rows of one split share `created_at` (the transaction's `now()`) and
 * `created_by`; `splitSiblings` reads that to say "split across".
 */
export async function recordInvoicePayments(rows: readonly PaymentInsertRow[]): Promise<void> {
  if (rows.length === 0) throw new Error("Nothing to record — check an invoice.");
  // The generated types may not know document_id yet, hence the cast.
  const { error } = await supabase.from("invoice_payments").insert(rows as never);
  if (error) throw error;
}

/**
 * Which payments were recorded together, for the Payments list's "split
 * across …" line. A split's rows share their author and their insert's
 * timestamp exactly (one statement, one `now()`); two separate saves never
 * do. Rows with no author are skipped: the demo seeds inserted many rows in
 * one statement with nobody's name on them, and they are not splits.
 */
export function splitSiblings<
  P extends {
    id: string;
    invoice_id: string;
    created_by: string | null;
    created_at?: string | null;
  },
>(payments: readonly P[]): Map<string, P[]> {
  const groups = new Map<string, P[]>();
  for (const p of payments) {
    if (!p.created_by || !p.created_at) continue;
    const key = `${p.created_by}|${p.created_at}`;
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  const out = new Map<string, P[]>();
  for (const rows of groups.values()) {
    if (rows.length < 2) continue;
    for (const p of rows)
      out.set(
        p.id,
        rows.filter((r) => r.id !== p.id),
      );
  }
  return out;
}
