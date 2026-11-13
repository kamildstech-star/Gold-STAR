import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * David, on a recorded call, looking at an open invoice on the Billing tab:
 * "And this and this, this is repetitious. ... But billing office is bill as
 * over here also. So technically it's quite repetitious."
 *
 * Since #110 portalled the editors' rail cards into the page's rail, the
 * invoice's "Billing office" card (and the estimate's "Office") sat in the
 * same 20rem column as the job's Bill to card, whose last line already reads
 * "Bills as <entity>". One office, named twice, two cards apart.
 *
 * The document's card is the one that went. It printed office_name /
 * office_address / office_phone / office_email — columns snapshotted off the
 * job's OPERATING location when the document was created, and never rewritten
 * by setJobBillingLocation. The PDF brands itself from
 * `doc.job.billing_location ?? doc.location`, the live office the Bills-as
 * line names and edits. So when the two disagreed, the card that has now gone
 * was the one telling the wrong story.
 *
 * There is no DOM testing library here, so this reads the source, the way
 * src/components/qty-takes-a-sum.test.ts does.
 */
const INVOICE = "src/components/invoice-editor.tsx";
const ESTIMATE = "src/components/estimate-editor.tsx";
const BILL_TO = "src/components/job-billing-entity.tsx";
const RUNNING_COST = "src/components/job-running-cost-panel.tsx";

const read = (f: string) => readFileSync(f, "utf8");

/** A `<CardTitle ...>Text</CardTitle>` with exactly this text. */
function hasCardTitled(source: string, title: string) {
  return new RegExp(`<CardTitle[^>]*>\\s*${title}\\s*</CardTitle>`).test(source);
}

/**
 * Reads of `x.office_name` and friends in rendered markup. Comments explaining
 * why the card went are not renders, and the `office_name` inside the PostgREST
 * select string is a column list, not a card — both are stripped first.
 */
function officeSnapshotReads(source: string) {
  const code = source
    .replace(/\{?\/\*[\s\S]*?\*\/\}?/g, "")
    .replace(/"[^"\n]*office_name, office_phone[^"\n]*"/g, "");
  return code.match(/\b(?:inv|est)\.office_(?:name|address|phone|email)\b/g) ?? [];
}

describe("the issuing office, named once on the Billing tab", () => {
  for (const [what, file, title] of [
    ["invoice", INVOICE, "Billing office"],
    ["estimate", ESTIMATE, "Office"],
  ] as const) {
    it(`the ${what} editor no longer runs its own "${title}" card`, () => {
      expect(hasCardTitled(read(file), title)).toBe(false);
    });

    it(`the ${what} editor no longer prints its office snapshot anywhere`, () => {
      // The columns stay on the row — they back the merge keys — but nothing
      // renders them beside the live office they can silently disagree with.
      expect(officeSnapshotReads(read(file))).toEqual([]);
    });
  }

  it("the job's Bill to card is still the one that names the entity", () => {
    const src = read(BILL_TO);
    expect(src).toContain("Bills as");
    expect(src).toContain("officeLabel(selected)");
  });

  it("keeps the office's phone and email reachable, off the live row", () => {
    // Not a loss when the document's card went: the details the card used to
    // show are in the entity dialog now, read from the office itself.
    const src = read(BILL_TO);
    expect(src).toContain("office.office_phone");
    expect(src).toContain("office.office_email");
  });
});

/**
 * The other half of the same complaint, and the half that was NOT a
 * duplication. "But technically totals is sort of the same idea as running
 * costs, right?"
 *
 * Sort of, but not the same numbers. Totals is one document's arithmetic —
 * subtotal, discounts, tax at that document's rate, what is billed — and it
 * owns the only tax-rate override and the only billed-amount box on the tab.
 * Running cost is the job: equipment days, labour, materials and referrals
 * against revenue from every document, and the margin against the floor. Merge
 * them and the tab loses either its only margin or its only tax control.
 *
 * They print one figure in common — Revenue against Billed, and only when a
 * job has a single invoice — which is why the Revenue tile carries its basis
 * ("invoice", "estimate", "cost lines") underneath: it is quoting the document
 * above, not offering a second opinion on it.
 */
describe("Totals and Running cost, deliberately still two cards", () => {
  it("each editor keeps its own Totals", () => {
    expect(hasCardTitled(read(INVOICE), "Totals")).toBe(true);
    expect(hasCardTitled(read(ESTIMATE), "Totals")).toBe(true);
  });

  it("Totals keeps the controls that exist nowhere else", () => {
    // Billing & Costs P4: an invoice shows its tax rate read only — no toggle
    // when generating it (the job/office sets it).
    expect(read(INVOICE)).toContain("data-tax-read-only");
    expect(read(INVOICE)).not.toContain("Tax rate override");
    expect(read(INVOICE)).toContain("Billed amount");
    expect(read(ESTIMATE)).toContain("Tax rate override");
  });

  it("Running cost keeps the cost and margin that Totals never had", () => {
    const src = read(RUNNING_COST);
    expect(src).toContain('CostTile label="Cost"');
    expect(src).toContain('label="Margin"');
    // The basis line under Revenue is what tells a reader the figure comes
    // from the invoice they are looking at. Named from the one table in
    // running-cost.ts, so the tile and the drawer cannot drift apart.
    expect(src).toContain("REVENUE_BASIS_LABEL[c.revenue_basis].short");
  });
});
