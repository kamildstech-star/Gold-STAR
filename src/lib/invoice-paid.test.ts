import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  outstandingBalance,
  paymentTarget,
  resolveInvoiceStatusSelection,
  statusUnchangedMessage,
} from "@/lib/invoice-paid";
import { INVOICE_STATUSES } from "@/lib/billing";

const row = (billed: number, collected: number) => ({
  billed_amount: billed,
  collected_amount: collected,
  uncollected: billed - collected,
});

describe("outstandingBalance", () => {
  it("is the whole invoice when nothing has been collected", () => {
    expect(outstandingBalance(row(2400, 0))).toBe(2400);
  });

  it("is the remainder when part has been collected", () => {
    expect(outstandingBalance(row(2400, 900))).toBe(1500);
  });

  it("is zero on a fully collected invoice", () => {
    expect(outstandingBalance(row(2400, 2400))).toBe(0);
  });

  it("goes negative on an overpayment rather than clamping", () => {
    expect(outstandingBalance(row(2400, 2600))).toBe(-200);
  });

  it("reads numeric columns that arrive as strings", () => {
    expect(
      outstandingBalance({
        billed_amount: "2400.00",
        collected_amount: "900.00",
        uncollected: "1500.00",
      }),
    ).toBe(1500);
  });

  it("falls back to billed minus collected when uncollected was not selected", () => {
    expect(outstandingBalance({ billed_amount: 2400, collected_amount: 900 })).toBe(1500);
  });

  it("treats a null billed amount as nothing owed", () => {
    expect(outstandingBalance({ billed_amount: null, collected_amount: null })).toBe(0);
  });
});

describe("resolveInvoiceStatusSelection", () => {
  it("opens the payment dialog for the full balance when nothing is collected", () => {
    expect(resolveInvoiceStatusSelection("paid", row(2400, 0))).toEqual({
      action: "collect",
      amount: 2400,
    });
  });

  it("prefills only the remainder when part is already collected", () => {
    expect(resolveInvoiceStatusSelection("paid", row(2400, 900))).toEqual({
      action: "collect",
      amount: 1500,
    });
  });

  it("writes Paid straight through when the invoice is already collected in full", () => {
    // The payment rows exist and the revenue is real — this is how Disputed
    // gets corrected back to Paid without inventing a second cheque.
    expect(resolveInvoiceStatusSelection("paid", row(2400, 2400))).toEqual({
      action: "write",
      status: "paid",
    });
  });

  it("writes Paid straight through on a zero-value invoice", () => {
    expect(resolveInvoiceStatusSelection("paid", row(0, 0))).toEqual({
      action: "write",
      status: "paid",
    });
  });

  it("writes Paid straight through on an overpaid invoice", () => {
    expect(resolveInvoiceStatusSelection("paid", row(2400, 2600))).toEqual({
      action: "write",
      status: "paid",
    });
  });

  it("leaves every other status writing directly, balance or not", () => {
    for (const status of INVOICE_STATUSES.filter((s) => s !== "paid")) {
      expect(resolveInvoiceStatusSelection(status, row(2400, 0))).toEqual({
        action: "write",
        status,
      });
      expect(resolveInvoiceStatusSelection(status, row(2400, 2400))).toEqual({
        action: "write",
        status,
      });
    }
  });

  it("never asks for a payment of zero or less", () => {
    for (const [billed, collected] of [
      [0, 0],
      [2400, 2400],
      [2400, 5000],
    ]) {
      const decision = resolveInvoiceStatusSelection("paid", row(billed, collected));
      if (decision.action === "collect") expect(decision.amount).toBeGreaterThan(0);
      else expect(decision.action).toBe("write");
    }
  });
});

describe("statusUnchangedMessage", () => {
  it("names the status the invoice kept, using its screen label", () => {
    expect(statusUnchangedMessage("sent")).toBe(
      "No payment recorded — this invoice is still Sent.",
    );
    expect(statusUnchangedMessage("partial")).toBe(
      "No payment recorded — this invoice is still Part paid.",
    );
  });
});

/*
 * Wiring. There is no DOM testing library here, so the two status controls are
 * read as source. What has to be proved is that neither of them can reach a
 * bare status write for 'paid' again.
 */
const read = (rel: string) =>
  readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const PANEL = read("../components/job-billing-panel.tsx");
const EDITOR = read("../components/invoice-editor.tsx");

const fragment = (source: string, re: RegExp) => {
  const m = source.match(re);
  expect(m).not.toBeNull();
  return m![0];
};

/** The invoice editor's status Select, anchored on the badge beside it. */
const EDITOR_STATUS = fragment(EDITOR, /INVOICE_STATUS_TONE\[inv\.status\][\s\S]*?<SelectTrigger/);

describe("the status dropdowns route Paid through a payment", () => {
  it("the invoice card has no status control of its own — the pop-up's editor is the one", () => {
    // 3 Nov: the card is short; status is changed in the invoice pop-up.
    expect(PANEL).not.toMatch(/<Select\s+value=\{i\.status\}/);
  });

  it("markPaid asks the shared rule instead of writing Paid unconditionally", () => {
    const fn = fragment(PANEL, /const markPaid = \(inv: Invoice\) => \{[\s\S]*?\n {2}\};/);
    expect(fn).toContain('resolveInvoiceStatusSelection("paid", inv)');
    expect(fn).toContain("openPayment(inv, { revertsTo: inv.status })");
  });

  it("the invoice editor refuses 'paid' outright when it has no way to collect", () => {
    expect(EDITOR_STATUS).toContain('if (next === "paid")');
    expect(EDITOR_STATUS).toContain("return onMarkPaid();");
    expect(EDITOR_STATUS).toContain("Record the payment to mark this invoice paid.");
    expect(EDITOR_STATUS.indexOf('next === "paid"')).toBeLessThan(
      EDITOR_STATUS.indexOf("patchInvoice.mutate"),
    );
  });

  it("the editor is given the panel's markPaid where it is mounted", () => {
    // Mounted under the split since 2026-09-28 (David's estimates | invoices
    // layout), so it is handed the open invoice rather than the table row.
    expect(fragment(PANEL, /<InvoiceEditor[\s\S]*?\/>/)).toContain(
      "onMarkPaid={() => markPaid(openInvoice)}",
    );
  });

  it("neither file still writes a hard-coded paid status alongside sent_at", () => {
    for (const source of [PANEL, EDITOR]) {
      expect(source).not.toMatch(/status:\s*"paid"\s*,\s*sent_at/);
      // markPaid's approved zero-balance branch is the only literal left.
      expect((source.match(/status: "paid"/g) ?? []).length).toBeLessThanOrEqual(1);
    }
  });
});

describe("canceling the payment dialog leaves the status alone", () => {
  it("the dialog's close handler writes no status and says which one was kept", () => {
    const close = fragment(PANEL, /const closePayment = \(saved: boolean\) => \{[\s\S]*?\n {2}\};/);
    expect(close).toContain("if (!saved && payOpen?.revertsTo)");
    expect(close).toContain("statusUnchangedMessage(payOpen.revertsTo)");
    expect(close).not.toContain("patchInvoice");
    expect(close).not.toContain("status:");
  });

  it("the dropdown is controlled by the record, so it cannot drift from it", () => {
    // `value={inv.status}` is what makes a cancelled selection honest: the
    // control has no state of its own left sitting on Paid. Since 3 Nov the
    // invoice pop-up's editor holds the only status dropdown.
    expect(EDITOR_STATUS).toContain("value={inv.status}");
  });

  it("a recorded payment says nothing about the status it was waiting on", () => {
    // The dialog calls onClose(true) after a save; only a dismissal (false)
    // reports the kept status.
    const dialog = readFileSync("src/components/add-payment-dialog.tsx", "utf8").replace(
      /\r\n/g,
      "\n",
    );
    const save = fragment(dialog, /const save = async \(\) => \{[\s\S]*?\n {2}\};/);
    expect(save).toContain("onClose(true);");
    expect(dialog).toMatch(/onOpenChange=\{\(v\) => !v && !saving && onClose\(false\)\}/);
  });
});

/*
 * Mark, 2026-10-06, of the Payments card: "add a add payment button here".
 * The button picks the invoice; these are its rules.
 */
describe("paymentTarget — which invoice the Payments card's Add payment pays", () => {
  const inv = (id: string, billed: number, collected: number) => ({
    id,
    ...row(billed, collected),
  });

  it("has nothing to pay when the job has no invoice", () => {
    expect(paymentTarget([])).toEqual({ kind: "none" });
  });

  it("goes straight to the one invoice with a balance due", () => {
    const open = inv("a", 1198, 0);
    expect(paymentTarget([inv("paid", 500, 500), open])).toEqual({ kind: "one", invoice: open });
  });

  it("asks which, when several have a balance, and lists only those", () => {
    const t = paymentTarget([inv("a", 1000, 0), inv("paid", 500, 500), inv("b", 800, 300)]);
    expect(t.kind).toBe("pick");
    if (t.kind === "pick") expect(t.invoices.map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("still lets a supplement or a double payment land when everything is paid", () => {
    const only = inv("paid", 500, 500);
    expect(paymentTarget([only])).toEqual({ kind: "one", invoice: only });
    const t = paymentTarget([inv("p1", 500, 500), inv("p2", 900, 900)]);
    expect(t.kind).toBe("pick");
    if (t.kind === "pick") expect(t.invoices).toHaveLength(2);
  });

  it("treats a sub-cent remainder as paid", () => {
    const t = paymentTarget([inv("dust", 100, 99.999), inv("real", 50, 0)]);
    expect(t).toMatchObject({ kind: "one", invoice: { id: "real" } });
  });
});

const PANEL_SRC = readFileSync("src/components/job-billing-panel.tsx", "utf8").replace(
  /\r\n/g,
  "\n",
);
const PAYMENTS = PANEL_SRC.match(/<section aria-label="Payments"[\s\S]*?<\/section>/)![0];
const header = (label: string) =>
  PANEL_SRC.match(
    new RegExp(`<section aria-label="${label}"[\\s\\S]*?<CardHeader className="([^"]*)"`),
  )![1];

describe("the Payments card's Add payment", () => {
  it("sits in the card header, shaped like the Estimates and Invoices header buttons", () => {
    expect(header("Payments")).toBe(header("Invoices"));
    expect(header("Payments")).toBe(header("Estimates"));
    const head = PAYMENTS.match(/<CardHeader[\s\S]*?<\/CardHeader>/)![0];
    expect(head).toContain("Add payment");
    expect(head).toMatch(/<Button\s+size="sm"\s+variant="outline"/);
  });

  it("opens the Add payment dialog with nothing ticked, and writes nothing itself", () => {
    // Mark, 2026-10-07: "allow them to check an invoice it's applying to" —
    // no more guessing the invoice or asking in a menu.
    const head = PAYMENTS.match(/<CardHeader[\s\S]*?<\/CardHeader>/)![0];
    expect(head).toContain("onClick={() => openPayment()}");
    expect(head).not.toContain("DropdownMenu");
    expect(head).not.toContain("supabase");
    expect(head).not.toContain("<Dialog");
  });

  it("is gated like Record payment, hidden for whoever RLS would refuse, off with no invoice", () => {
    const head = PAYMENTS.match(/<CardHeader[\s\S]*?<\/CardHeader>/)![0];
    expect(head).toContain("{showAddPayment ? (");
    expect(head).toContain("disabled={disabled || payable.length === 0}");
    expect(PANEL_SRC).toContain(
      "const showAddPayment = managesOffice === true || payable.length > 0;",
    );
    // invoice_payments_write: can_manage_location OR the invoice's creator.
    expect(PANEL_SRC).toMatch(
      /const canRecordOn = \(inv: Invoice\) =>\s*managesOffice === true \|\| \(!!app\.userId && inv\.created_by === app\.userId\);/,
    );
  });

  it("no longer sends people to another card from the empty state", () => {
    expect(PAYMENTS).not.toContain("Use Record payment on the invoice it pays");
    expect(PAYMENTS).toContain("Add payment records one against the invoice it pays.");
    expect(PAYMENTS).toContain("create the invoice first");
  });
});
