// @vitest-environment jsdom
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/*
 * Mark, 2026-10-07, showing JobNimbus's Add Payment: "make this pop up for
 * add payment, just with our look, and allow them to check an invoice it's
 * applying to."
 *
 * The dialog body drawn from a draft, the way a person would leave it after
 * ticking and typing. The state changes themselves are pinned in
 * lib/add-payment.test.ts; this proves the screen shows them.
 */
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("@/lib/documents", () => ({
  PAYMENT_ATTACHMENT_DOC_TYPE: "payment_attachment",
  uploadDocumentFile: vi.fn(),
}));

import { AddPaymentForm } from "./add-payment-dialog";
import {
  initialDraft,
  setAmount,
  setChecked,
  setReceived,
  type AddPaymentDraft,
} from "@/lib/add-payment";

const inv = (id: string, billed: number, collected: number) => ({
  id,
  invoice_number: `GS-INV-${id}`,
  issue_date: "2026-09-01",
  due_date: "2026-10-01",
  billed_amount: billed,
  collected_amount: collected,
  uncollected: billed - collected,
});
const A = inv("1022", 1000, 0);
const B = inv("3488", 2500, 500);
const INVOICES = [A, B];

const render = (draft: AddPaymentDraft, extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    createElement(AddPaymentForm, {
      invoices: INVOICES,
      draft,
      onDraft: () => {},
      file: null,
      onFile: () => {},
      handheld: false,
      attachmentsSupported: true,
      disabled: false,
      saving: false,
      onCancel: () => {},
      onSave: () => {},
      ...extra,
    }),
  );

const total = (html: string, which: string) =>
  html.match(new RegExp(`data-total="${which}"[^>]*>([^<]*)<`))![1];
const saveButton = (html: string) => html.match(/<button[^>]*>Save payment<\/button>/)![0];
/** The attribute, not the `disabled:` utility classes every button carries. */
const isDisabled = (button: string) => /\sdisabled=""/.test(button);
const blocking = (html: string) => html.match(/data-blocking="([a-z]+)"/)?.[1] ?? null;

describe("the Add payment dialog", () => {
  it("lists every invoice with a tick, its dates, original amount and balance due", () => {
    const html = render(initialDraft("2026-10-07"));
    for (const head of [
      "Invoice #",
      "Invoice date",
      "Original amount",
      "Due date",
      "Balance due",
      "Amount to apply",
    ]) {
      expect(html, head).toContain(`>${head}</th>`);
    }
    expect(html.match(/role="checkbox"/g)).toHaveLength(2);
    expect(html).toContain('aria-label="Apply to GS-INV-1022"');
    expect(html).toContain("$2,500.00");
    expect(html).toContain("$2,000.00");
  });

  it("asks for date, method and a required Reference #", () => {
    const html = render(initialDraft("2026-10-07"));
    expect(html).toContain("Payment date");
    expect(html).toContain('data-date-input="date"');
    expect(html).toContain('value="10/07/2026"');
    expect(html).toContain("Payment method");
    expect(html).toMatch(/<input[^>]*id="add-payment-reference"[^>]*required=""/);
    // Autofill left alone on the reference.
    const ref = html.match(/<input[^>]*id="add-payment-reference"[^>]*>/)![0];
    expect(ref.toLowerCase()).not.toContain("autocomplete");
  });

  it("nothing ticked: no amount boxes, Save off, and it says why", () => {
    const html = render(initialDraft("2026-10-07"));
    expect(html).not.toContain('aria-label="Amount to apply to');
    expect(isDisabled(saveButton(html))).toBe(true);
    expect(blocking(html)).toBe("invoices");
    expect(total(html, "applied")).toBe("$0.00");
  });

  it("ticked: checked, the amount box pre-filled with the balance due", () => {
    const html = render(setChecked(initialDraft("2026-10-07"), B, true));
    const tick = (n: string) =>
      html.match(new RegExp(`<button[^>]*aria-label="Apply to GS-INV-${n}"[^>]*>`))![0];
    expect(tick("3488")).toContain('data-state="checked"');
    expect(tick("1022")).toContain('data-state="unchecked"');
    const box = html.match(/<input[^>]*aria-label="Amount to apply to GS-INV-3488"[^>]*>/)![0];
    // NumberInput shows it grouped; the draft holds "2000.00".
    expect(box).toContain('value="2,000"');
    expect(html).not.toContain('aria-label="Amount to apply to GS-INV-1022"');
  });

  it("split across two invoices: Applied is the sum, Credit $0, Save on with a reference", () => {
    let d = setChecked(setChecked(initialDraft("2026-10-07"), A, true), B, true);
    d = setAmount(d, B.id, "1500");
    d = { ...d, reference: "104882" };
    const html = render(d);
    expect(total(html, "applied")).toBe("$2,500.00");
    expect(total(html, "credit")).toBe("$0.00");
    expect(isDisabled(saveButton(html))).toBe(false);
    expect(blocking(html)).toBeNull();
  });

  it("without a reference, Save stays off and says so", () => {
    const html = render(setChecked(initialDraft("2026-10-07"), A, true));
    expect(isDisabled(saveButton(html))).toBe(true);
    expect(blocking(html)).toBe("reference");
    expect(html).toContain("Reference # is required");
  });

  it("received more than applied shows the Credit and refuses it", () => {
    let d = setChecked(initialDraft("2026-10-07"), A, true);
    d = setReceived({ ...d, reference: "1" }, "1200");
    const html = render(d);
    expect(total(html, "credit")).toBe("$200.00");
    expect(blocking(html)).toBe("credit");
    expect(html).toContain("Apply the full amount to invoices");
    expect(isDisabled(saveButton(html))).toBe(true);
  });

  it("warns, beside the invoice, when an amount is more than it owes", () => {
    let d = setChecked(initialDraft("2026-10-07"), A, true);
    d = setAmount({ ...d, reference: "1" }, A.id, "1200");
    const html = render(d);
    expect(html).toContain("left overpaid");
    expect(isDisabled(saveButton(html))).toBe(false);
  });

  it("Save is pinned and 44px on a phone; Cancel beside it", () => {
    const html = render(initialDraft("2026-10-07"));
    expect(html).toMatch(/class="[^"]*sticky -bottom-6[^"]*"/);
    expect(saveButton(html)).toContain("h-11");
    expect(html).toMatch(/<button[^>]*h-11[^>]*>Cancel<\/button>/);
  });

  it("each invoice is a card on a phone, the tick a 44px target", () => {
    const html = render(setChecked(initialDraft("2026-10-07"), A, true));
    expect(html).toContain("data-table-cards");
    expect(html).toMatch(/<label class="[^"]*min-h-11[^"]*"/);
    expect(html).toContain('data-label="Amount to apply"');
  });

  it("says so when there is no invoice to apply it to", () => {
    const html = render(initialDraft("2026-10-07"), { invoices: [] });
    expect(html).toContain("create the invoice first");
  });
});

describe("wired into the Billing tab", () => {
  const PANEL = readFileSync("src/components/job-billing-panel.tsx", "utf8").replace(/\r\n/g, "\n");

  it("is the only payment dialog, and the panel inserts no payment itself", () => {
    expect(PANEL.match(/<AddPaymentDialog\b/g)).toHaveLength(1);
    expect(PANEL).not.toContain('from("invoice_payments").insert');
    expect(PANEL).not.toContain("Record payment ·");
  });

  it("is handed the payable invoices on the card, with the opener's invoice kept", () => {
    const dialog = PANEL.match(/<AddPaymentDialog[\s\S]*?\/>/)![0];
    expect(dialog).toContain("invoices={payDialogInvoices}");
    expect(dialog).toContain("preselectId={payOpen?.preselectId ?? null}");
    expect(PANEL).toMatch(
      /const payDialogInvoices = payableInvoices\(visibleInvoices, \{\s*canRecord: canRecordOn,\s*include: payOpen\?\.preselectId,/,
    );
  });

  it("every Record payment button opens it ticked for its invoice, and only for who may", () => {
    expect(PANEL).toMatch(
      /\{canRecordOn\(i\) \? \(\s*<Button[\s\S]*?onClick=\{\(\) => openPayment\(i\)\}/,
    );
    expect(PANEL).toContain("historyInvoice && canRecordOn(historyInvoice) ? (");
    const open = PANEL.match(/const openPayment = [\s\S]*?\n {2}\};/)![0];
    expect(open).toContain("preselectId: inv?.id ?? null");
  });

  it("says split across on the Payments list", () => {
    const payments = PANEL.match(/<section aria-label="Payments"[\s\S]*?<\/section>/)![0];
    expect(payments).toContain("siblings.has(p.id)");
    expect(payments).toContain("Split across");
    expect(PANEL).toContain("const siblings = splitSiblings(payments);");
  });
});
