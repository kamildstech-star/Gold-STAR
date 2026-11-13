import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { estimateToBillingEstimate, mergeJobEstimates, rowKey } from "@/lib/billing-estimates";

/**
 * Mark, 2026-09-16, of a job's Billing tab -- an Estimates card in the money
 * column, an Estimate panel in the rail: "and the estimates is a duplicate,
 * just have the sidebar."
 *
 * They were two lists (estimate documents; Job Calculator sheets) that read
 * as one. Now they are one list, merged by the same module the Billing page
 * merges with.
 *
 * WHERE that one list sits changed on 2026-09-28, at the client's request.
 * David, 22 Sep, walking a job: "estimates should be here on the left side,
 * and invoices on the right side... and then we have to have payments also,
 * payments underneath it." It moved out of the rail to the left of the money
 * column. The file keeps its name so its history reads; what it pins now is
 * the one-list rule and the split. Component wiring is pinned by reading the
 * source (there is no DOM testing library here); the merge is a unit test.
 */
const norm = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const PAGE = norm("src/routes/_authenticated/jobs.$id.tsx");
const PANEL = norm("src/components/job-billing-panel.tsx");
const LIST = norm("src/components/estimates-rail-list.tsx");
const RAIL = norm("src/components/billing-rail.tsx");

const ESTIMATE = {
  id: "e1",
  seq: 3,
  status: "draft" as const,
  title: null,
  total: 1470,
  estimate_date: "2026-09-16",
  current_version: 2,
};

const CALC = {
  id: "c1",
  job_id: "job-1",
  customer_name: "Falcon Holdings",
  address: "12 Maple Ave",
  locality: "Haverstraw",
  job_type: "water",
  customer_price: 8365,
  created_at: "2026-09-14T09:00:00.000Z",
  updated_at: "2026-09-14T11:00:00.000Z",
};

describe("a job's estimates list is one list from both sources", () => {
  it("names an estimate document the way the card did", () => {
    const row = estimateToBillingEstimate(ESTIMATE);
    expect(row.title).toBe("ESTIMATE-3");
    expect(row.subtitle).toBe("Scope");
    expect(row.version).toBe(2);
    expect(row.statusLabel).toBe("Draft");
    expect(row.key).toBe(rowKey("estimate", "e1"));
  });

  it("orders newest first across both kinds, and says which is which", () => {
    const rows = mergeJobEstimates([ESTIMATE], [CALC]);
    expect(rows.map((r) => r.source)).toEqual(["estimate", "calculator"]);
    expect(rows[1].statusLabel).toContain("Calculator");
    // On a job every sheet has the job's customer; the type is what differs.
    expect(rows[1].jobType).toBe("Water");
  });

  it("is what the panel actually lists", () => {
    const section = PANEL.match(/<section aria-label="Estimates"[\s\S]*?<\/section>/)![0];
    // The one merge; a row being deleted (Undo still open) is held back.
    expect(section).toMatch(
      /rows=\{mergeJobEstimates\(estimates, calculations\)\.filter\(\s*\(r\) => !removing\.has\(r\.key\),?\s*\)\}/,
    );
    // No second merge anywhere else.
    expect(LIST).not.toContain("job_calculations");
    expect(PAGE).not.toContain("listJobCalculationsForJob");
  });
});

describe("the job's money column: estimates left, invoices right, payments beneath", () => {
  const SPLIT = PANEL.match(
    /<div className="@container">[\s\S]*?<section aria-label="Payments"/,
  )![0];

  /*
   * Was `@3xl:grid-cols-[minmax(20rem,1fr)_minmax(0,2fr)]` with `items-start`:
   * estimates floored at the 20rem it had in the rail, invoices taking twice
   * the rest, each card as tall as its own content. Mark, 2026-10-05: "these
   * need to line up better and the invoices box needs to be the same size,
   * and the buttons should look like the invoices, and the split shou.d be
   * 50/50." Deliberately re-pinned to the even split and to stretch.
   */
  it("splits its own width in half, and the two halves are the same height", () => {
    const grid = SPLIT.match(/<div className="grid [^"]*"/)![0];
    expect(grid).toContain("@3xl:grid-cols-2");
    // Stretch, not a hardcoded height: `items-start` would leave the shorter
    // card floating, a fixed height would clip a job with several estimates.
    expect(grid).not.toContain("items-start");
    for (const label of ["Estimates", "Invoices"]) {
      const section = PANEL.match(
        new RegExp(`<section aria-label="${label}"[\\s\\S]*?<Card([^>]*)>`),
      )![1];
      expect(section).toContain('className="h-full"');
    }
  });

  it("gives Estimates the Invoices header: matched outline buttons, on one baseline", () => {
    const section = PANEL.match(/<section aria-label="Estimates"[\s\S]*?<\/section>/)![0];
    const header = section.match(/<CardHeader className="([^"]*)"/)![1];
    const invoiceHeader = PANEL.match(
      /<section aria-label="Invoices"[\s\S]*?<CardHeader className="([^"]*)"/,
    )![1];
    expect(header).toBe(invoiceHeader);
    // Both ways in sit in that header, and both are outline — no filled
    // primary beside an outline neighbour any more, and no `flex-1` stretch.
    const inHeader = section.slice(
      section.indexOf("<CardHeader"),
      section.indexOf("</CardHeader>"),
    );
    expect(inHeader).toContain("Quick Estimate");
    expect(inHeader).toContain('{creating ? "Creating…" : "Detailed estimate"}');
    const buttons = inHeader
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
      .match(/<Button[\s\S]*?<\/Button>/g)!;
    expect(buttons).toHaveLength(2);
    expect(buttons.every((b) => b.includes('variant="outline"'))).toBe(true);
    expect(inHeader).not.toContain("flex-1");
  });

  it("puts Estimates first, Invoices second, and Payments after both", () => {
    const est = PANEL.indexOf('<section aria-label="Estimates"');
    const inv = PANEL.indexOf('<section aria-label="Invoices"');
    const pay = PANEL.indexOf('<section aria-label="Payments"');
    expect(est).toBeGreaterThan(0);
    expect(inv).toBeGreaterThan(est);
    expect(pay).toBeGreaterThan(inv);
    // Payments is outside the two-column grid: the full width, underneath.
    expect(SPLIT.indexOf('<section aria-label="Payments"')).toBe(
      SPLIT.length - '<section aria-label="Payments"'.length,
    );
  });

  it("opens both editors full width under the split, not inside a half column", () => {
    const code = PANEL.replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    const invoices = code.match(/<section aria-label="Invoices"[\s\S]*?<\/section>/)![0];
    expect(invoices).not.toContain("<InvoiceEditor");
    const open = PANEL.match(/\{openEstimate && \([\s\S]*?<EstimateEditor[\s\S]*?\/>/)![0];
    expect(open).toContain("embedded");
    expect(open).toContain('aria-label="Collapse estimate"');
    const openInv = PANEL.match(/\{openInvoice && \([\s\S]*?<InvoiceEditor[\s\S]*?\/>/)![0];
    expect(openInv).toContain("embedded");
  });

  it("records a payment through the one dialog, from the invoice or the Payments card", () => {
    const payments = PANEL.match(/<section aria-label="Payments"[\s\S]*?<\/section>/)![0];
    // Mark, 2026-10-06: "add a add payment button here". The card now opens
    // the Record payment dialog too — the same `openPayment`, never a dialog
    // or an insert of its own, so there is still one way a payment is written.
    expect(payments).toContain("openPayment(");
    expect(payments).not.toContain("<Dialog");
    expect(payments).not.toContain("invoice_payments");
    expect(payments).toContain("setHistoryId(p.invoice_id)");
    // The invoice's own Record payment heads its pop-up (3 Nov).
    const tools = PANEL.match(/const invoiceTools = [\s\S]*?\n {2}\};/)![0];
    expect(tools).toContain("onClick={() => openPayment(i)}");
  });

  it("scrolls the editor into view, for the phone where the rail is above it", () => {
    const effect = PANEL.match(
      /useEffect\(\(\) => \{\s*if \(!openEstimateId\) return;[\s\S]*?\}, \[openEstimateId\]\)/,
    );
    expect(effect![0]).toContain("scrollIntoView");
  });
});

describe("the rail", () => {
  it("no longer carries an Estimates card or a slot for one", () => {
    const code = PAGE.replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    expect(code).not.toContain('<CardTitle className="text-sm">Estimates</CardTitle>');
    expect(code).not.toContain("slots.estimates");
    expect(RAIL).not.toContain("RailEstimates");
  });

  it("gives an estimate row everything the card row had", () => {
    const row = LIST.match(/function EstimateRow\([\s\S]*$/)![0];
    expect(row).toMatch(/<DocumentPreviewButton\s+kind="estimate"/);
    expect(row).toMatch(/<RevisionHistoryButton\s+kind="estimate"/);
    // Convert is the shared box-corner button (5 Nov, T7).
    expect(row).toContain("<ConvertButton");
    expect(LIST).toContain('aria-label="Convert to invoice"');
    // Said by the helper both kinds of row share (2026-10-06).
    expect(row).toContain("invoicedNote(invoice)");
    expect(LIST.match(/function invoicedNote\([\s\S]*?(?=function CalculatorRow\()/)![0]).toContain(
      "invoiced as",
    );
    expect(row).toContain("ESTIMATE_STATUS_TONE");
  });

  it("links a calculator row to its sheet, labeled as the calculator's", () => {
    const calc = LIST.match(/function CalculatorRow\([\s\S]*?(?=function EstimateRow\()/)![0];
    expect(calc).toContain('to="/estimates/$id"');
    expect(calc).toContain("Calculator ·");
    // Mark, 2026-10-06: "these need to be able to be converted to invoices."
    // A sheet converts now (see estimates-rail-list.render.test.tsx for why
    // it did not before) — but only through the prop the panel withholds
    // until the database can record which invoice a sheet became.
    expect(calc).toContain("<ConvertButton");
    expect(calc).toMatch(/\{onConvert && \(/);
    // And Delete, unless the sheet is an invoice (#312).
    expect(calc).toContain("<DeleteRowButton");
    expect(calc).not.toContain("RevisionHistoryButton");
  });

  it("shows about eight boxes and scrolls the rest (5 Nov, T7)", () => {
    expect(LIST).toMatch(/export const RAIL_ESTIMATES_CAP = BILLING_BOX_CAP;/);
    expect(LIST).toContain("<BillingBoxList");
    expect(LIST).not.toContain("Show all");
    const asides = PAGE.match(/<aside\s+className="order-1[^"]*"/g)!;
    expect(asides.some((a) => a.includes("xl:overflow-y-auto"))).toBe(true);
  });

  it("stays first on a phone on General; Billing follows David's phone order", () => {
    // General's rail is `order-1` below the grid's breakpoint: the rail
    // renders above the column, not after it.
    const asides = PAGE.match(/<aside\s+className="order-1[^"]*xl:sticky[^"]*"/g)!;
    expect(asides.length).toBeGreaterThanOrEqual(1);
    // Billing's rail is flattened on a phone so each card takes its place in
    // the money-first order (David, 15 Oct; lib/job-billing-order.ts).
    expect(PAGE).toMatch(/<aside\s+className="contents xl:sticky xl:block[^"]*xl:overflow-y-auto"/);
  });
});
