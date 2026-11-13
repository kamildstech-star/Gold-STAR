/**
 * The balance a payment receipt prints.
 *
 * This is the figure a customer disputes, so every shape the office actually
 * produces is pinned here: paid in full, part paid, overpaid, several cheques
 * against one invoice, and an invoice whose total is already net of discounts.
 *
 * The last one matters because `invoices.billed_amount` is derived in the
 * database from the lines. The receipt must agree with the Total printed on
 * the invoice PDF, so the fixture builds that total with the same helpers
 * invoice-pdf.ts uses rather than asserting a hand-typed number.
 */
import { describe, expect, it } from "vitest";
import {
  discountAmount,
  discountPrintsInTotals,
  discountTargetMark,
  round2,
  scopeTotal,
  splitDiscounts,
} from "@/lib/estimates";
import {
  orderPayments,
  receiptMath,
  receiptNumber,
  type ReceiptPaymentRow,
} from "@/lib/payment-receipt";

const P = (o: Partial<ReceiptPaymentRow> & { id: string; amount: number }): ReceiptPaymentRow => ({
  received_at: o.received_at ?? "2026-09-01",
  created_at: o.created_at ?? null,
  method: o.method ?? null,
  reference: o.reference ?? null,
  notes: o.notes ?? null,
  ...o,
});

describe("a single payment", () => {
  it("paid in full leaves nothing owed", () => {
    const p = P({ id: "p1", amount: 4200 });
    const m = receiptMath(4200, [p], "p1");
    expect(m.priorPaid).toBe(0);
    expect(m.thisPayment).toBe(4200);
    expect(m.balanceAfter).toBe(0);
    expect(m.overpaid).toBe(0);
    expect(m.ordinal).toBe(1);
  });

  it("a partial payment leaves the remainder", () => {
    const m = receiptMath(4200, [P({ id: "p1", amount: 1500 })], "p1");
    expect(m.paidThrough).toBe(1500);
    expect(m.balanceAfter).toBe(2700);
    expect(m.overpaid).toBe(0);
  });

  it("an overpayment reads as a credit, never as a negative balance", () => {
    const m = receiptMath(4200, [P({ id: "p1", amount: 5000 })], "p1");
    expect(m.balanceAfter).toBe(0);
    expect(m.overpaid).toBe(800);
  });

  it("cents survive the arithmetic", () => {
    const m = receiptMath(1000.1, [P({ id: "p1", amount: 333.37 })], "p1");
    expect(m.balanceAfter).toBe(666.73);
  });
});

describe("several payments against one invoice", () => {
  const rows = [
    P({ id: "c", amount: 1000, received_at: "2026-08-20" }),
    P({ id: "a", amount: 2500, received_at: "2026-07-01" }),
    P({ id: "b", amount: 500, received_at: "2026-08-01" }),
  ];

  it("orders them oldest first whatever order they were read in", () => {
    expect(orderPayments(rows).map((p) => p.id)).toEqual(["a", "b", "c"]);
  });

  it("each receipt states the balance as at its own payment", () => {
    expect(receiptMath(4200, rows, "a")).toMatchObject({
      priorPaid: 0,
      paidThrough: 2500,
      balanceAfter: 1700,
      ordinal: 1,
    });
    expect(receiptMath(4200, rows, "b")).toMatchObject({
      priorPaid: 2500,
      paidThrough: 3000,
      balanceAfter: 1200,
      ordinal: 2,
    });
    expect(receiptMath(4200, rows, "c")).toMatchObject({
      priorPaid: 3000,
      paidThrough: 4000,
      balanceAfter: 200,
      ordinal: 3,
    });
  });

  it("lists only the payments that preceded it", () => {
    expect(receiptMath(4200, rows, "b").prior.map((p) => p.id)).toEqual(["a"]);
    expect(receiptMath(4200, rows, "a").prior).toEqual([]);
  });

  it("two checks on the same day keep the order they were recorded in", () => {
    const sameDay = [
      P({ id: "z", amount: 300, received_at: "2026-09-01", created_at: "2026-09-01T16:04:00Z" }),
      P({ id: "y", amount: 700, received_at: "2026-09-01", created_at: "2026-09-01T09:12:00Z" }),
    ];
    expect(orderPayments(sameDay).map((p) => p.id)).toEqual(["y", "z"]);
    expect(receiptMath(4200, sameDay, "z").priorPaid).toBe(700);
    expect(receiptMath(4200, sameDay, "y").priorPaid).toBe(0);
  });

  it("a later payment that tips the invoice over reads as a credit", () => {
    const over = [
      P({ id: "a", amount: 4000 }),
      P({ id: "b", amount: 700, received_at: "2026-09-05" }),
    ];
    expect(receiptMath(4200, over, "b")).toMatchObject({ balanceAfter: 0, overpaid: 500 });
  });

  it("refuses a payment that is not on this invoice rather than guessing", () => {
    expect(() => receiptMath(4200, rows, "nope")).toThrow(/not among the payments/);
  });
});

describe("an invoice carrying discounts", () => {
  /*
   * `billed_amount` is derived from the lines, so the receipt is fed the same
   * net total the invoice PDF prints: gross work, less the targeted credits
   * inside the scope, less the whole-document discount deducted in the money
   * stack.
   */
  const line = (
    id: string,
    subtotal: number,
    isDiscount = false,
    description: string | null = null,
  ) => ({
    id,
    name: isDiscount ? "Discount" : "Line",
    code: null,
    description,
    note: null,
    quantity: 1,
    unit_price: subtotal,
    taxable: true,
    is_discount: isDiscount,
    subtotal,
  });

  const lines = [
    line("a", 3000),
    line("b", 2000),
    // Targeted at line a — prints inline and comes off the scope.
    line("d1", -500, true, discountTargetMark(["a"])),
    // Whole-document — deducted once in the money stack.
    line("d2", -250, true),
  ];

  it("the receipt balance follows the invoice's discounted total", () => {
    const stack = splitDiscounts(lines).discounts.filter(discountPrintsInTotals);
    const invoiceTotal = round2(
      scopeTotal(lines) - stack.reduce((s, d) => s + discountAmount(d), 0),
    );
    expect(invoiceTotal).toBe(4250);

    const m = receiptMath(invoiceTotal, [P({ id: "p1", amount: 2000 })], "p1");
    expect(m.invoiceTotal).toBe(4250);
    expect(m.balanceAfter).toBe(2250);
  });

  it("a payment of the discounted total closes the invoice", () => {
    const m = receiptMath(4250, [P({ id: "p1", amount: 4250 })], "p1");
    expect(m.balanceAfter).toBe(0);
    expect(m.overpaid).toBe(0);
  });
});

describe("receipt numbering", () => {
  it("distinguishes two receipts against one invoice", () => {
    expect(receiptNumber("INV-1042", 1)).toBe("INV-1042-R1");
    expect(receiptNumber("INV-1042", 2)).toBe("INV-1042-R2");
  });
  it("never renders a blank identifier", () => {
    expect(receiptNumber(null, 1)).toBe("PAYMENT-R1");
    expect(receiptNumber("   ", 3)).toBe("PAYMENT-R3");
  });
});
