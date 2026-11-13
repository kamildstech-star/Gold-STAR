import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import { isOpenInvoice, statementTotals, type StatementInvoice } from "./account-statement";

/* FE9, 28 Oct: the customer's open balance and the account statement. */
const inv = (over: Partial<StatementInvoice>): StatementInvoice => ({
  id: "i",
  invoice_number: "GS-1",
  issue_date: "2026-10-01",
  due_date: null,
  job_id: "j",
  job_number: "J-1",
  status: "sent",
  billed_amount: 1000,
  collected_amount: 0,
  location_id: "loc",
  ...over,
});

describe("open balance", () => {
  it("counts sent and part-paid invoices with money owed", () => {
    expect(isOpenInvoice(inv({}))).toBe(true);
    expect(isOpenInvoice(inv({ status: "partial", collected_amount: 400 }))).toBe(true);
  });

  it("never counts drafts, write-offs or paid invoices", () => {
    expect(isOpenInvoice(inv({ status: "draft" }))).toBe(false);
    expect(isOpenInvoice(inv({ status: "written_off" }))).toBe(false);
    expect(isOpenInvoice(inv({ status: "paid", collected_amount: 1000 }))).toBe(false);
  });

  it("adds every open invoice across the customer's jobs", () => {
    const t = statementTotals([
      inv({ id: "a", job_id: "j1", billed_amount: 1000, collected_amount: 250 }),
      inv({ id: "b", job_id: "j2", billed_amount: 2500.5, collected_amount: 0 }),
      inv({ id: "c", status: "draft", billed_amount: 999 }),
      inv({ id: "d", status: "paid", billed_amount: 300, collected_amount: 300 }),
    ]);
    expect(t).toEqual({ billed: 3500.5, paid: 250, balance: 3250.5, count: 2 });
  });
});

describe("wiring", () => {
  const read = (f: string) => readFileSync(f, "utf8");
  it("the invoice PDF prints the account's balance when it is more than this invoice, unless the invoice's switch is off", () => {
    const pdf = read("src/lib/invoice-pdf.ts");
    expect(pdf).toContain('label: "Account balance, all open invoices"');
    expect(pdf).toContain("if (accountTotal - balance > 0.005)");
    // Off only when the column says so; absent (pre-migration) prints as before.
    expect(pdf).toContain(".show_account_balance !== false");
    expect(pdf).toContain("inv.account_id && showAccountBalance");
  });

  it("the Follow-ups card shows the balance with its on-the-invoice switch; the account card sends statements", () => {
    // 6 Nov voice note: the balance sits on the Follow-ups card in the rail,
    // beside the switch that prints it on the invoice — not above the editor.
    const panel = read("src/components/invoice-followup-panel.tsx");
    expect(panel).toContain("<AccountBalanceLine");
    expect(panel).toContain('aria-label="Open balance on this invoice"');
    expect(panel).toContain(".update({ show_account_balance })");
    expect(read("src/components/invoice-editor.tsx")).not.toContain("AccountBalanceLine");
    // One Follow-ups card: the pop-up no longer stacks a compact copy above the editor.
    expect(read("src/components/invoice-review-dialog.tsx")).not.toContain("InvoiceFollowupPanel");
    const card = read("src/components/account-right-rail.tsx");
    expect(card).toContain("<AccountStatementButton accountId={accountId} />");
    const button = read("src/components/account-statement-button.tsx");
    // The invoice's own way out: the composer, category invoice, the PDF as a link.
    expect(button).toMatch(/category: "invoice"/);
    expect(button).toContain("attachmentUrl: compose.url");
  });
});

describe("the statement PDF", () => {
  it("builds, with invoices and payments", async () => {
    const { buildAccountStatementPdf } = await import("./account-statement");
    const invoices = [
      inv({ id: "a", invoice_number: "GS-1001", billed_amount: 1000, collected_amount: 250 }),
      inv({ id: "b", invoice_number: "GS-1002", job_number: "J-2", billed_amount: 400 }),
    ];
    const out = await buildAccountStatementPdf(
      {
        account: {
          name: "Riverside HOA",
          address_line1: "1 Main St",
          city: "Newark",
          state: "NJ",
          postal_code: "07102",
          email: "ap@example.com",
        },
        invoices,
        payments: [
          {
            invoice_id: "a",
            amount: 250,
            received_at: "2026-10-05",
            method: "Check",
            reference: "1201",
          },
        ],
        totals: statementTotals(invoices),
        locationId: null,
      },
      new Date(2026, 9, 28),
    );
    expect(out.bytes.length).toBeGreaterThan(1000);
    expect(out.filename).toBe("Statement_Riverside_HOA_2026-10-28.pdf");
    expect(out.title).toContain("10/28/2026");
  });
});
