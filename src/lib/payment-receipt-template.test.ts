import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { PAYMENT_RECEIPT_TEMPLATE } from "@/lib/email";

/**
 * David, on the 9 September call, after recording a payment and pressing Send
 * receipt: "I'm choosing the template, but I want to have it defaulted."
 *
 * The auto-select already existed — JobEmailDialog resolves the first template
 * carrying the purpose it was opened with. It only falls back to the whole
 * library, unselected, when NO template has that purpose, which was the state
 * of this database: nobody had made one, so there was nothing to find.
 *
 * Migration 20260910010000 seeds it. The wording is copied from
 * PAYMENT_RECEIPT_TEMPLATE, and two copies of a paragraph drift, so this pins
 * them to each other. If you change the wording in one place this test tells
 * you about the other.
 */
const SQL = readFileSync(
  "supabase/migrations/20260910010000_seed_payment_receipt_template.sql",
  "utf8",
);

describe("the seeded payment receipt template", () => {
  it("uses the same subject line as the code", () => {
    expect(SQL).toContain(PAYMENT_RECEIPT_TEMPLATE.subject);
  });

  it("uses the same paragraphs as the code, in the same order", () => {
    const paragraphs = PAYMENT_RECEIPT_TEMPLATE.body.split("\n");
    expect(paragraphs.length).toBeGreaterThan(1);
    let at = -1;
    for (const p of paragraphs) {
      const found = SQL.indexOf(p);
      expect(found, `missing from the migration: ${p.slice(0, 60)}`).toBeGreaterThan(-1);
      expect(found, `out of order: ${p.slice(0, 60)}`).toBeGreaterThan(at);
      at = found;
    }
  });

  it("carries the merge keys the receipt depends on", () => {
    // These are resolved from the payment and the invoice. A typo here sends a
    // customer a receipt with a literal {Payment.Amount} in it.
    for (const key of [
      "{Payment.Amount}",
      "{Payment.ReceivedDate}",
      "{Payment.Method}",
      "{Payment.InvoiceNumber}",
      "{Payment.InvoiceTotal}",
      "{Payment.PaidToDate}",
      "{Payment.BalanceAfter}",
    ]) {
      expect(SQL, key).toContain(key);
    }
  });

  it("files itself under the purpose the receipt button asks for", () => {
    // send-receipt-button.tsx passes purpose="payment_receipt". A different
    // category here and the auto-select finds nothing, which is today's bug.
    expect(SQL).toContain("'payment_receipt'");
    const button = readFileSync("src/components/send-receipt-button.tsx", "utf8");
    expect(button).toContain('purpose="payment_receipt"');
  });

  it("does not overwrite a template the office wrote themselves", () => {
    // Two templates with one purpose makes the auto-select a coin toss.
    expect(SQL).toContain("WHERE NOT EXISTS");
    expect(SQL).toMatch(/category\s*=\s*'payment_receipt'/);
  });
});
