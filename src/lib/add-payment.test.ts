import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Mark, 2026-10-07, showing JobNimbus's Add Payment: "make this pop up for
 * add payment, just with our look, and allow them to check an invoice it's
 * applying to." The dialog's rules, without a screen.
 */

const insert = vi.hoisted(() => vi.fn());
const from = vi.hoisted(() => vi.fn());
vi.mock("@/integrations/supabase/client", () => ({ supabase: { from } }));

import {
  NO_METHOD,
  OTHER_METHOD,
  PAYMENT_METHODS,
  buildPaymentRows,
  checkAddPayment,
  initialDraft,
  methodValue,
  payableInvoices,
  paymentTotals,
  prefillAmount,
  recordInvoicePayments,
  setAmount,
  setChecked,
  setReceived,
  splitSiblings,
  toCents,
  type AddPaymentDraft,
  type PayableInvoice,
} from "@/lib/add-payment";

const inv = (
  id: string,
  billed: number,
  collected: number,
  extra: Partial<PayableInvoice & { created_by: string | null }> = {},
) => ({
  id,
  invoice_number: `GS-INV-${id}`,
  issue_date: "2026-09-01",
  due_date: "2026-10-01",
  billed_amount: billed,
  collected_amount: collected,
  uncollected: billed - collected,
  created_by: null as string | null,
  ...extra,
});

const A = inv("1022", 1000, 0);
const B = inv("3488", 2500.5, 500);
const PAID = inv("0900", 400, 400);
const INVOICES = [A, B];

const ready = (d: AddPaymentDraft): AddPaymentDraft => ({ ...d, reference: "104882" });

describe("ticking an invoice", () => {
  it("pre-fills its balance due, and unticking forgets it", () => {
    let d = initialDraft("2026-10-07");
    d = setChecked(d, B, true);
    expect(d.applied).toEqual({ [B.id]: "2000.50" });
    d = setChecked(d, B, false);
    expect(d.applied).toEqual({});
  });

  it("does not overwrite an amount already typed when ticked again", () => {
    let d = setChecked(initialDraft("2026-10-07"), A, true);
    d = setAmount(d, A.id, "250");
    d = setChecked(d, A, true);
    expect(d.applied[A.id]).toBe("250");
  });

  it("leaves a paid invoice's amount blank rather than pre-filling $0", () => {
    expect(prefillAmount(PAID)).toBe("");
    expect(setChecked(initialDraft("2026-10-07"), PAID, true).applied[PAID.id]).toBe("");
  });

  it("opens ticked for the invoice a Record payment button was pressed on", () => {
    const d = initialDraft("2026-10-07", A);
    expect(d.applied).toEqual({ [A.id]: "1000.00" });
    expect(d.received).toBe("1000.00");
    expect(d.method).toBe(NO_METHOD);
    expect(d.reference).toBe("");
  });

  it("an amount can only be typed on a ticked invoice", () => {
    const d = setAmount(initialDraft("2026-10-07"), A.id, "50");
    expect(d.applied).toEqual({});
  });
});

describe("Applied and Credit", () => {
  it("Applied is the sum of the ticked rows, split across invoices", () => {
    let d = initialDraft("2026-10-07");
    d = setChecked(d, A, true);
    d = setChecked(d, B, true);
    d = setAmount(d, B.id, "1500.25");
    expect(paymentTotals(d)).toEqual({ applied: 250025, received: 250025, credit: 0, over: 0 });
  });

  it("received follows what is applied until somebody types it", () => {
    let d = setChecked(initialDraft("2026-10-07"), A, true);
    expect(d.received).toBe("1000.00");
    d = setChecked(d, B, true);
    expect(d.received).toBe("3000.50");
    d = setReceived(d, "3500");
    d = setChecked(d, B, false);
    expect(d.received).toBe("3500");
    // Clearing it goes back to following.
    d = setReceived(d, "");
    expect(d.received).toBe("1000.00");
    expect(d.receivedTouched).toBe(false);
  });

  it("Credit is received beyond applied", () => {
    let d = setChecked(initialDraft("2026-10-07"), A, true);
    d = setReceived(d, "1200");
    expect(paymentTotals(d)).toMatchObject({ applied: 100000, received: 120000, credit: 20000 });
  });

  it("adds in cents, so 0.10 + 0.20 is exactly 0.30", () => {
    let d = setChecked(setChecked(initialDraft("2026-10-07"), A, true), B, true);
    d = setAmount(setAmount(d, A.id, "0.1"), B.id, "0.2");
    d = setReceived(d, "0.3");
    expect(paymentTotals(d)).toMatchObject({ applied: 30, credit: 0, over: 0 });
    expect(toCents("1,000")).toBeNull();
  });
});

describe("what blocks Save", () => {
  const fields = (d: AddPaymentDraft) => checkAddPayment(d, INVOICES).errors.map((e) => e.field);

  it("no invoice ticked", () => {
    expect(fields(ready(initialDraft("2026-10-07")))).toContain("invoices");
  });

  it("no reference — required, as JobNimbus requires it", () => {
    const d = setChecked(initialDraft("2026-10-07"), A, true);
    expect(fields(d)).toEqual(["reference"]);
    expect(fields({ ...d, reference: "   " })).toEqual(["reference"]);
    expect(checkAddPayment(ready(d), INVOICES).canSave).toBe(true);
  });

  it("an amount of zero, below zero or blank on a ticked invoice", () => {
    const d = ready(setChecked(initialDraft("2026-10-07"), A, true));
    for (const bad of ["0", "-5", ""]) {
      const r = checkAddPayment(setAmount(d, A.id, bad), INVOICES);
      expect(r.canSave, bad).toBe(false);
      expect(r.errors[0]).toMatchObject({ field: "amount", invoiceId: A.id });
    }
  });

  it("credit above $0: there is no customer credit to hold it", () => {
    const d = setReceived(ready(setChecked(initialDraft("2026-10-07"), A, true)), "1250");
    const r = checkAddPayment(d, INVOICES);
    expect(r.canSave).toBe(false);
    expect(r.errors.map((e) => e.field)).toEqual(["credit"]);
    expect(r.errors[0]!.message).toContain("Apply the full amount to invoices");
    expect(r.errors[0]!.message).toContain("$250.00");
  });

  it("more applied than received", () => {
    const d = setReceived(ready(setChecked(initialDraft("2026-10-07"), A, true)), "900");
    expect(checkAddPayment(d, INVOICES).errors.map((e) => e.field)).toEqual(["over"]);
  });

  it("no date", () => {
    const d = ready(setChecked(initialDraft(""), A, true));
    expect(fields(d)).toEqual(["date"]);
  });

  it("a future date is allowed, as the old dialog allowed it", () => {
    const d = ready(setChecked(initialDraft("2099-01-01"), A, true));
    expect(checkAddPayment(d, INVOICES).canSave).toBe(true);
  });

  it("more than the balance is a warning, never a block", () => {
    const d = setAmount(ready(setChecked(initialDraft("2026-10-07"), A, true)), A.id, "1100");
    const r = checkAddPayment(d, INVOICES);
    expect(r.canSave).toBe(true);
    expect(r.warnings).toEqual([expect.objectContaining({ field: "amount", invoiceId: A.id })]);
    expect(r.warnings[0]!.message).toContain("overpaid");
  });
});

describe("payment method", () => {
  it("offers JobNimbus's methods in the office's words, each once", () => {
    for (const m of ["Cash", "Credit card", "Check", "Money order", "ACH / wire", "Finance"]) {
      expect(PAYMENT_METHODS, m).toContain(m);
    }
    expect(new Set(PAYMENT_METHODS).size).toBe(PAYMENT_METHODS.length);
  });

  it("None stores null, Other stores what was typed", () => {
    expect(methodValue(NO_METHOD, "")).toBeNull();
    expect(methodValue("", "")).toBeNull();
    expect(methodValue("Money order", "")).toBe("Money order");
    expect(methodValue(OTHER_METHOD, "  Venmo ")).toBe("Venmo");
    expect(methodValue(OTHER_METHOD, "  ")).toBeNull();
  });
});

describe("which invoices the dialog lists", () => {
  it("those with a balance due, in the card's order", () => {
    expect(payableInvoices([A, PAID, B]).map((i) => i.id)).toEqual([A.id, B.id]);
  });

  it("every invoice when all are paid — a supplement or a double payment", () => {
    const P2 = inv("0901", 100, 100);
    expect(payableInvoices([PAID, P2]).map((i) => i.id)).toEqual([PAID.id, P2.id]);
  });

  it("adds the paid invoice a Record payment button was pressed on", () => {
    expect(payableInvoices([A, PAID, B], { include: PAID.id }).map((i) => i.id)).toEqual([
      A.id,
      PAID.id,
      B.id,
    ]);
  });

  it("only invoices this person may record on (the write policy)", () => {
    const mine = inv("7", 100, 0, { created_by: "me" });
    const theirs = inv("8", 100, 0, { created_by: "them" });
    const list = payableInvoices([mine, theirs], { canRecord: (i) => i.created_by === "me" });
    expect(list.map((i) => i.id)).toEqual([mine.id]);
  });

  it("nothing when there is no invoice", () => {
    expect(payableInvoices([])).toEqual([]);
  });
});

describe("saving", () => {
  beforeEach(() => {
    insert.mockReset().mockResolvedValue({ error: null });
    from.mockReset().mockReturnValue({ insert });
  });

  const split = () => {
    let d = setChecked(setChecked(initialDraft("2026-10-07"), A, true), B, true);
    d = setAmount(d, B.id, "1500");
    return {
      ...d,
      reference: " 104882 ",
      method: "Check",
      notes: "Mitigation and rebuild on one check",
    };
  };

  it("one row per ticked invoice, each carrying the shared facts", () => {
    const rows = buildPaymentRows(split(), { userId: "u1", documentId: "doc-1" });
    expect(rows).toEqual([
      {
        invoice_id: A.id,
        amount: 1000,
        method: "Check",
        received_at: "2026-10-07",
        reference: "104882",
        notes: "Mitigation and rebuild on one check",
        created_by: "u1",
        document_id: "doc-1",
      },
      {
        invoice_id: B.id,
        amount: 1500,
        method: "Check",
        received_at: "2026-10-07",
        reference: "104882",
        notes: "Mitigation and rebuild on one check",
        created_by: "u1",
        document_id: "doc-1",
      },
    ]);
  });

  it("never names document_id without a photo (the column may not exist)", () => {
    const rows = buildPaymentRows(split(), { userId: "u1" });
    expect(rows.every((r) => !("document_id" in r))).toBe(true);
  });

  it("goes in as ONE insert of every row — one statement, all or none", async () => {
    const rows = buildPaymentRows(split(), { userId: "u1" });
    await recordInvoicePayments(rows);
    expect(from).toHaveBeenCalledTimes(1);
    expect(from).toHaveBeenCalledWith("invoice_payments");
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert.mock.calls[0]![0]).toHaveLength(2);
  });

  it("throws the database's refusal for the caller to show", async () => {
    insert.mockResolvedValue({ error: { code: "42501", message: "row-level security" } });
    await expect(
      recordInvoicePayments(buildPaymentRows(split(), { userId: "u1" })),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("refuses to send nothing", async () => {
    await expect(recordInvoicePayments([])).rejects.toThrow(/check an invoice/);
    expect(insert).not.toHaveBeenCalled();
  });
});

describe("split across", () => {
  const p = (id: string, invoice_id: string, created_by: string | null, created_at: string) => ({
    id,
    invoice_id,
    created_by,
    created_at,
  });

  it("pairs the rows one save wrote, and nothing else", () => {
    const at = "2026-10-07T15:00:00.123456+00:00";
    const map = splitSiblings([
      p("a", "1022", "u1", at),
      p("b", "3488", "u1", at),
      p("c", "1022", "u1", "2026-10-07T15:00:09.000001+00:00"),
      p("d", "3488", "u2", at),
    ]);
    expect(map.get("a")!.map((r) => r.id)).toEqual(["b"]);
    expect(map.get("b")!.map((r) => r.id)).toEqual(["a"]);
    expect(map.has("c")).toBe(false);
    expect(map.has("d")).toBe(false);
  });

  it("ignores the demo seeds' authorless rows that share a timestamp", () => {
    const at = "2026-08-21T17:18:45.990722+00:00";
    expect(splitSiblings([p("x", "1", null, at), p("y", "2", null, at)]).size).toBe(0);
  });
});
