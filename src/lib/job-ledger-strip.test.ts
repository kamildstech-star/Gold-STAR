import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { jobLedgerRows, ledgerStripCells, type LedgerInput } from "./job-ledger";

const input: LedgerInput = {
  cost: {
    labour_cost: 9000,
    field_ticket_labour_cost: 1000,
    equipment_cost: 2500,
    field_ticket_equipment_cost: 500,
    materials_cost: 700,
    stock_used_cost: 300,
    subcontractor_cost: 0,
    referral_cost: 0,
    total_cost: 14000,
    revenue: 30000,
  } as LedgerInput["cost"],
  effort: { days: 3, crew: 18, personHours: 500 },
  billed: 25000,
  paid: 10000,
  referral: null,
  commission: 3000,
};

/*
 * Mark, 2026-10-06: "have this sticky as well on the billing page", then
 * "also make the sticky bar have 2 rows with the title and the number
 * underneath like excel cells" — listing the ledger card's columns. The strip
 * was David's six figures (22 Sep); it is now every column the card has.
 */
const MARKS_COLUMNS = [
  "Days",
  "Guys",
  "Hours",
  "Garbage",
  "Supplies",
  // 23 Oct: each supply × its charge (Settings › Cost rates).
  "Supplies Charge",
  "Truck Fee",
  "Misc Fees",
  "Equipment",
  "Sub Fees",
  "Labor",
  // 22 Oct: the labor charge rate (Settings › Labor rates) × hours.
  "Labor Charge",
  "Total Expenses",
  "Billed",
  "Paid",
  "Referral",
  "Commission",
  "Total Profit",
];

describe("the ledger strip", () => {
  const rows = jobLedgerRows(input);

  it("carries every column Mark listed, under the card's own labels, in the sheet's order", () => {
    const cells = ledgerStripCells(rows, { showMoney: true });
    expect(cells.map((c) => c.label)).toEqual(MARKS_COLUMNS);
    // The same row objects the full ledger renders — no second arithmetic.
    for (const c of cells) expect(c.row).toBe(rows.find((r) => r.key === c.key));
    expect(cells.find((c) => c.key === "profit")!.row!.value).toBe(13000);
  });

  it("is the whole card, column for column", () => {
    const cells = ledgerStripCells(rows, { showMoney: true });
    expect(cells.map((c) => c.key)).toEqual(rows.map((r) => r.key));
  });

  it("drops the money for a viewer without cost access, keeping the effort", () => {
    const cells = ledgerStripCells(rows, { showMoney: false });
    expect(cells.map((c) => c.label)).toEqual(["Days", "Guys", "Hours"]);
  });

  it("keeps an untracked figure as a cell the strip can dash", () => {
    const cells = ledgerStripCells(jobLedgerRows({ ...input, effort: null, billed: null }), {
      showMoney: true,
    });
    expect(cells.find((c) => c.key === "days")!.row!.tracked).toBe(false);
    expect(cells.find((c) => c.key === "billed")!.row!.tracked).toBe(false);
    expect(cells.find((c) => c.key === "garbage")!.row!.tracked).toBe(false);
  });
});

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

describe("the strip's wiring", () => {
  const PANEL = read("src/components/job-ledger-panel.tsx");
  const PAGE = read("src/routes/_authenticated/jobs.$id.tsx");
  const STRIP = PANEL.match(/export function JobLedgerStrip[\s\S]*?\n}\n/)![0];

  it("reads the ledger's own hook and rows, and adds nothing up itself", () => {
    expect(STRIP).toMatch(
      /useJobLedger\(jobId, \{\s*money: showMoney,\s*billing: showBilling,\s*\}\)/,
    );
    expect(STRIP).toContain("ledgerStripCells(rows, { showMoney, showBilling })");
    expect(STRIP).not.toContain("jobLedgerRows(");
    expect(STRIP).not.toContain("useQuery(");
    // The strip's Referral and Commission cells are the Commissions card's
    // own figures: both read useJobCommission.
    expect(PANEL).toContain("useJobCommission(jobId, { money })");
    expect(PANEL).toMatch(/referral: referralOwed,\s*commission: salesmenOwed,/);
  });

  it("is two rows of cells: the labels over their figures", () => {
    expect(STRIP).toMatch(/<thead>\s*<tr>\s*\{cells\.map/);
    expect(STRIP).toMatch(/<tbody>\s*<tr>\s*\{cells\.map/);
    expect(STRIP).toContain('scope="col"');
  });

  it("scrolls sideways inside itself, with the tab strip's edge fade, never the page", () => {
    const scroller = STRIP.match(/ref=\{scrollerRef\}[\s\S]*?className="([^"]*)"/)![1];
    expect(scroller).toContain("edge-fade");
    expect(scroller).toContain("overflow-x-auto");
    expect(scroller).toContain("min-w-0");
    expect(STRIP).toContain("stripFade(el)");
    const box = STRIP.match(/return \(\s*<div className="([^"]*)"/)![1];
    expect(box).toContain("overflow-hidden");
    expect(box).toContain("min-w-0");
  });

  it("shows a negative profit as negative", () => {
    expect(STRIP).toContain('const negative = c.key === "profit" && value != null && value < 0;');
    expect(STRIP).toContain('negative && "bg-destructive/10 text-destructive"');
  });

  it("keeps the name Job ledger, as text: there is no card left to jump to", () => {
    expect(STRIP).toContain("<span>Job ledger</span>");
    expect(STRIP).not.toMatch(/<a\s/);
    expect(STRIP).not.toContain("#job-ledger");
  });

  it("sits first on the Billing tab, pinned under the job's own header", () => {
    const tab = PAGE.match(/<TabsContent value="billing"[\s\S]*?<BillingRailProvider>/)![0];
    expect(tab).toContain(
      "<JobLedgerStrip jobId={job.id} showMoney={showMoney} showBilling={showBilling} />",
    );
    expect(PAGE).toMatch(/const showMoney = useCan\("job\.view_costs"\);/);
    const pin = tab.match(/<div\s+ref=\{ledgerPinRef\}[\s\S]*?>/)![0];
    expect(pin).toMatch(/className="sticky z-20 /);
    // Measured, not hard-coded: whatever is pinned above it, which is only
    // the tab row below md (#282) and the whole header from md up.
    expect(pin).toContain("style={{ top: Math.round(headerH) }}");
    expect(pin).toContain("empty:hidden");
    // Under the header (z-30), never over it.
    expect(PAGE).toMatch(/ref=\{tabPinRef\}\s*className="sticky top-0 z-30 /);
  });

  it("the rail no longer lists the ledger a second time; the Commissions card replaces it", () => {
    const rail = PAGE.match(/<TabsContent value="billing"[\s\S]*?<\/TabsContent>/)![0];
    expect(rail).not.toContain("JobLedgerPanel");
    expect(PANEL).not.toContain("export function JobLedgerPanel");
    expect(PANEL).not.toContain('id="job-ledger"');
    // Mark, 7 Oct: "we want to replace the ledger to be replaced with a card
    // called commissions". One card in the slot, not two.
    // Wrapped for the phone order since 15 Oct (lib/job-billing-order.ts).
    expect(rail).toMatch(
      /\{showMoney && \(\s*<div className=\{billingOrderClass\("commission"\)\}>\s*<JobCommissionsCard jobId=\{job\.id\} \/>/,
    );
    expect(rail).not.toContain("<JobCommissionCard ");
    const CARD = read("src/components/job-commissions-card.tsx");
    const card = CARD.match(/export function JobCommissionsCard[\s\S]*?\n}\n/)![0];
    // Everything the stop-gap card could do is still here.
    expect(card).toContain("<CommissionPaidControl");
    expect(card).toContain('aria-label="Commission came from"');
    expect(CARD).toContain('"Commission rate override"');
    // The sixteen rows are the strip's, not the card's.
    expect(card).not.toContain("rows.map");
  });

  it("moves the rail and the editors' scroll target below the strip as well", () => {
    expect(PAGE).toContain("`${Math.round(headerH + ledgerH) + 16}px`");
  });
});
