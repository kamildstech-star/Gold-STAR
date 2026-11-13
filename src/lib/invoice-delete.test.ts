import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  CHECKING_REASON,
  MANAGER_ONLY_REASON,
  ON_THE_BOOKS_REASON,
  invoiceDeleteRule,
} from "@/lib/invoice-delete";

/**
 * Mark, 2026-10-06, of the Invoices card on a job's Billing tab: "need to
 * rework this box to make more sense and need a delete or undo."
 */
const draft = {
  status: "draft",
  sent_at: null,
  approved_amount: null,
  collected_amount: 0,
};
const ok = { paymentRecords: 0, manager: true };

describe("which invoices can be deleted", () => {
  it("an untouched draft, by a manager of the office", () => {
    expect(invoiceDeleteRule(draft, ok)).toEqual({ allowed: true });
  });

  it.each([
    ["sent", { status: "sent", sent_at: "2026-10-01T12:00:00Z" }],
    ["moved back to draft after it went out", { sent_at: "2026-10-01T12:00:00Z" }],
    ["ruled on by the carrier", { approved_amount: 900 }],
    ["paid in part", { status: "partial", collected_amount: 100 }],
    ["paid", { status: "paid", collected_amount: 1198 }],
    ["disputed", { status: "disputed" }],
    ["written off", { status: "written_off" }],
  ])("not one that is %s", (_what, patch) => {
    expect(invoiceDeleteRule({ ...draft, ...patch }, ok)).toEqual({
      allowed: false,
      reason: ON_THE_BOOKS_REASON,
    });
  });

  it("not a draft with any payment record — even a removed one's trail", () => {
    expect(invoiceDeleteRule(draft, { ...ok, paymentRecords: 1 }).allowed).toBe(false);
  });

  it("not for someone who does not manage the office, and not while that is unknown", () => {
    expect(invoiceDeleteRule(draft, { ...ok, manager: false })).toEqual({
      allowed: false,
      reason: MANAGER_ONLY_REASON,
    });
    expect(invoiceDeleteRule(draft, { ...ok, manager: null })).toEqual({
      allowed: false,
      reason: CHECKING_REASON,
    });
  });

  it("tells them what to do instead of a delete", () => {
    expect(ON_THE_BOOKS_REASON).toContain("Written off");
    expect(ON_THE_BOOKS_REASON).toContain("Versions");
  });
});

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const PANEL = read("src/components/job-billing-panel.tsx");
const LIB = read("src/lib/invoice-delete.ts");
const MIGRATION = read("supabase/migrations/20261006181000_invoice_delete_guard.sql");
const SECTION = PANEL.match(/<section aria-label="Invoices"[\s\S]*?<\/section>/)![0];
/* 5 Nov (T7): the boxes are the shared BillingBoxList (two a row, eight
   then a scroll), the same list the estimates use. */
const ROW = SECTION.match(
  /<BillingBoxList label="Invoices" data-invoice-boxes>[\s\S]*?<\/BillingBoxList>/,
)![0];
/* Since 3 Nov the card is short — number, status, billed, balance, Open,
   Preview, PDF — and the rest heads the invoice pop-up (`invoiceTools`). */
const TOOLS = PANEL.match(/const invoiceTools = [\s\S]*?\n {2}\};/)![0];

describe("the Invoices card, reworked", () => {
  it("is one row per invoice, with no table and nothing to scroll sideways", () => {
    // Comments stripped: the one explaining the change names `<Table cards>`.
    expect(SECTION.replace(/\{\/\*[\s\S]*?\*\/\}/g, "")).not.toContain("<Table");
    expect(SECTION).not.toContain("overflow-x-auto");
    expect(ROW).toContain("<li\n");
  });

  it("keeps the invoice number on one line, and it opens the invoice (27 Oct)", () => {
    expect(ROW).toMatch(
      /<button[^>]*className="whitespace-nowrap[^"]*font-mono[^"]*"[\s\S]*?onClick=\{\(\) => setOpenInvoiceId\(i\.id\)\}[\s\S]*?\{i\.invoice_number\}\s*<\/button>/,
    );
    expect(ROW).not.toMatch(/Expand invoice/);
  });

  it("puts the carrier and claim on one secondary line, truncated, whole on hover", () => {
    // In the pop-up now: carrier and claim as its subtitle, days out in its tools.
    expect(PANEL).toContain('{openInvoice.carrier ?? "No carrier"}');
    expect(TOOLS).toContain("days out");
    expect(ROW).not.toContain("i.carrier");
  });

  it("shows billed opposite the number, with vs estimate under it, and the balance due", () => {
    expect(ROW).toContain("fmtUsd(i.billed_amount)");
    expect(ROW).toContain("outstandingBalance(i)");
    expect(ROW).toContain("INVOICE_STATUS_LABEL[i.status]");
    expect(TOOLS).toContain('"matches estimate"');
    // A Quick Estimate's invoice compares against its sheet (#298).
    expect(TOOLS).toContain(
      "calculations.find((c) => c.id === i.job_calculation_id)?.customer_price",
    );
    expect(TOOLS).toContain("Balance due");
  });

  it("keeps every action the row had — on the card or in the pop-up", () => {
    for (const piece of [
      "onClick={() => openPayment(i)}",
      "defaultValue={i.approved_amount}",
      "onClick={() => setHistoryId(i.id)}",
      "<DropdownMenu modal={false}>",
    ]) {
      expect(TOOLS, piece).toContain(piece);
    }
    expect(PANEL).toContain("{invoiceTools(openInvoice)}");
    // Status and Versions are the invoice editor's own, in the same pop-up.
    const editor = read("src/components/invoice-editor.tsx");
    expect(editor).toContain("<RevisionHistoryButton");
    expect(editor).toMatch(/<Select\s+value=\{inv\.status\}/);
    expect(ROW).toMatch(/<DocumentPreviewButton\s+kind="invoice"/);
    expect(ROW).toMatch(/<ReportFiltersButton\s+kind="invoice"/);
  });

  it("has no summary tiles or referral line — the job ledger shows those (31 Oct)", () => {
    expect(SECTION).not.toMatch(/<Tile\b/);
    expect(SECTION).not.toContain("Absorbed is billed minus collected");
    expect(SECTION).not.toContain("<JobReferralFeeLine jobId={jobId} />");
  });
});

describe("deleting a draft invoice", () => {
  const body = PANEL.match(/const removeInvoice = \(inv: Invoice\) => \{[\s\S]*?\n {2}\};/)![0];

  it("asks the rule, and shows why when it says no", () => {
    expect(TOOLS).toContain("invoiceDeleteRule(i, {");
    expect(TOOLS).toContain("manager: managesOffice");
    expect(TOOLS).toContain("onSelect={() => removeInvoice(i)}");
    expect(TOOLS).toContain("{deleteRule.reason}");
  });

  it("puts a bin on a Draft's box only, asked first in the app's dialog (5 Nov, T6)", () => {
    const can = PANEL.match(/const canDeleteFromList = [\s\S]*?\.allowed;/)![0];
    expect(can).toContain('inv.status === "draft"');
    expect(can).toContain("invoiceDeleteRule(inv, {");
    expect(ROW).toMatch(
      /\{canDeleteFromList\(i\) && \([\s\S]*?onClick=\{\(\) => setConfirmDelete\(i\)\}/,
    );
    expect(PANEL).toMatch(
      /<AlertDialog open=\{!!confirmDelete\}[\s\S]*?removeInvoice\(confirmDelete\)/,
    );
    expect(ROW).not.toContain("window.confirm");
  });

  it("asks the database the same question its delete policy asks", () => {
    expect(PANEL).toContain("fetchManagesOffice(app.userId as string, jobLocationId)");
    expect(PANEL).toMatch(/managesQ\.isError \? false : null/);
  });

  it("hides the row, offers Undo, and only then sends the delete", () => {
    expect(body).toContain("setRemovingInvoices(");
    expect(body).toContain("undoableDelete({");
    expect(body).toContain('label: "Undo"');
    expect(body).toContain("await deleteDraftInvoice(inv.id);");
    // Add payment (#301) never offers a draft that is waiting out its Undo.
    expect(PANEL).toContain("payableInvoices(visibleInvoices, {");
  });

  it("is a plain delete that reports a refusal instead of looking like success", () => {
    const del = LIB.match(/export async function deleteDraftInvoice[\s\S]*?\n}\n/)![0];
    expect(del).toContain('.delete().eq("id", id).select("id")');
    expect(del).toContain("if (!data?.length)");
  });

  it("is held in the database too, for every other path", () => {
    expect(MIGRATION).toMatch(
      /CREATE TRIGGER invoices_refuse_issued_delete BEFORE DELETE ON public\.invoices/,
    );
    for (const clause of [
      "OLD.status::text <> 'draft'",
      "OLD.sent_at IS NOT NULL",
      "OLD.approved_amount IS NOT NULL",
      "FROM public.invoice_payments p WHERE p.invoice_id = OLD.id",
      "invoice_payment_changes",
    ]) {
      expect(MIGRATION, clause).toContain(clause);
    }
    expect(MIGRATION).toContain(
      "REVOKE ALL ON FUNCTION public.refuse_deleting_issued_invoice() FROM PUBLIC, anon, authenticated;",
    );
  });
});

describe("the open invoice is a pop-up (27 Oct)", () => {
  const src = readFileSync("src/components/job-billing-panel.tsx", "utf8");
  it("opens in a dialog, not as an editor unfolded under the page", () => {
    expect(src).toMatch(/<DialogContent[\s\S]{0,200}data-invoice-open/);
    expect(src).not.toMatch(/openInvoiceRef/);
  });
});
