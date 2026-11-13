import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import { describePaymentChange, paymentEditProblem } from "./payment-edits";

/**
 * David, 24 Sep: "if somebody puts in a payment and makes a mistake...
 * payments have to be editable."
 */

const before = {
  amount: 5000,
  received_at: "2026-09-20",
  method: "Check",
  reference: "1041",
  notes: null,
};

describe("a correction", () => {
  it("needs an amount, a date and a reason", () => {
    expect(
      paymentEditProblem({ amount: 500, received_at: "2026-09-20", reason: "typo" }),
    ).toBeNull();
    expect(paymentEditProblem({ amount: 0, received_at: "2026-09-20", reason: "x" })).toMatch(
      /Remove/,
    );
    expect(paymentEditProblem({ amount: 500, received_at: "", reason: "x" })).toMatch(/date/);
    expect(paymentEditProblem({ amount: 500, received_at: "2026-09-20", reason: "  " })).toMatch(
      /why/,
    );
  });

  it("is described by what actually moved", () => {
    expect(
      describePaymentChange({
        action: "edit",
        before_data: before,
        after_data: { ...before, amount: 500, reference: "1014" },
      }),
    ).toBe("Amount $5,000.00 → $500.00 · Reference 1041 → 1014");
    expect(describePaymentChange({ action: "remove", before_data: before, after_data: null })).toBe(
      "Removed $5,000.00 received 2026-09-20 by Check",
    );
  });
});

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const SQL = read("supabase/migrations/20260927121000_invoice_payment_audit.sql");
const LIB = read("src/lib/payment-edits.ts");
const PANEL = read("src/components/job-billing-panel.tsx");

describe("the trail is the database's, not the screen's", () => {
  it("records every edit of the money facts and every removal", () => {
    const fn = SQL.match(
      /CREATE OR REPLACE FUNCTION public\.tg_invoice_payment_audit[\s\S]*?\n\$\$;/,
    )![0];
    expect(fn).toContain("'edit', auth.uid()");
    expect(fn).toContain("'remove', auth.uid()");
    expect(fn).toContain(
      "IS DISTINCT FROM (OLD.amount, OLD.received_at, OLD.method, OLD.reference, OLD.notes)",
    );
    expect(SQL).toMatch(
      /CREATE TRIGGER invoice_payments_audit_update BEFORE UPDATE ON public\.invoice_payments/,
    );
    expect(SQL).toMatch(
      /CREATE TRIGGER invoice_payments_audit_delete BEFORE DELETE ON public\.invoice_payments/,
    );
  });

  it("cannot be written or edited by anyone else", () => {
    expect(SQL.match(/CREATE POLICY[^;]*invoice_payment_changes/g)).toHaveLength(1);
    expect(SQL).toContain("FOR SELECT TO authenticated");
    expect(SQL).toContain("GRANT SELECT ON public.invoice_payment_changes TO authenticated;");
  });

  it("refuses to move a payment between invoices, which would leave a stale total", () => {
    expect(SQL).toContain("A payment cannot be moved to another invoice.");
  });

  it("will not edit money before there is a trail to keep", () => {
    expect(LIB).toContain("if (isMissingSchema(error)) throw new Error(NOT_MIGRATED);");
  });

  it("says so when RLS refuses instead of looking saved", () => {
    expect(LIB).toContain("Only a manager of this office can change this payment.");
  });
});

describe("on the screen", () => {
  it("each payment has Edit, and the history lists every change", () => {
    expect(PANEL).toContain("onClick={() => onEdit(p)}");
    expect(PANEL).toContain("History of changes");
    expect(PANEL).toContain("<PaymentEditDialog");
  });

  it("Record payment is said in words, on the row and in the history", () => {
    expect(PANEL.match(/Record payment\s*<\/Button>/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
    expect(PANEL).not.toMatch(/>\s*Payment\s*<\/Button>/);
  });

  it("the Payments tab follows and marks a corrected payment", () => {
    const billing = read("src/routes/_authenticated/billing.index.tsx");
    expect(billing).toContain("corrected.has(p.id)");
  });
});
