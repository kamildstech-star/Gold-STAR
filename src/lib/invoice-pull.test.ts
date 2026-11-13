import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { LabourDay } from "./job-labour-rollup";
import { planInvoicePull } from "./invoice-pull";

/**
 * David, 24 Sep: "It should pull in — we had 30 hours of labor and 15 pieces
 * of equipment — I'll see the breakdown on the side, I'll click a button to
 * pull it into the invoice... obviously I could edit it afterwards."
 */

const day = (date: string, crew: number, hoursEach: number, approved = true): LabourDay => {
  const minutes = crew * hoursEach * 60;
  return {
    date,
    source: "field_form",
    covered: true,
    fieldMinutes: minutes,
    fieldCrew: crew,
    fieldApprovedMinutes: approved ? minutes : 0,
    clockMinutes: 0,
    clockApprovedMinutes: 0,
    clockPeople: 0,
    minutes,
    approvedMinutes: approved ? minutes : 0,
    crewSize: crew,
    supersededMinutes: 0,
    crewDisagreement: null,
    minutesDisagreement: null,
  };
};

// Placed 21 Sep 9am Eastern, picked up 22 Sep 4pm: two calendar days.
const unit = (type: string) => ({
  equipment_type: type,
  placed_at: "2026-09-21T13:00:00Z",
  retrieved_at: "2026-09-22T20:00:00Z",
});
/** The calculator's own charge rates, which apply when no price list says otherwise. */
const rates = { regularLabor: 70, equipment: { dehumidifier: 225, air_mover: 45, injector: 100 } };

describe("the worked example: 3 guys × 8h × 2 days, 1 dehu + 3 air movers × 2 days", () => {
  const plan = planInvoicePull({
    labourDays: [day("2026-09-22", 3, 8), day("2026-09-21", 3, 8)],
    placements: [unit("dehumidifier"), unit("air_mover"), unit("air_mover"), unit("air_mover")],
    tickets: [],
    rates,
    includeUnapproved: false,
  });

  it("inserts exactly these lines", () => {
    expect(plan.lines.map((l) => [l.name, l.description, l.quantity, l.uom, l.unit_price])).toEqual(
      [
        ["Labor", "Mon, Sep 21 — 3 crew × 8 h", 24, "HR", 70],
        ["Labor", "Tue, Sep 22 — 3 crew × 8 h", 24, "HR", 70],
        ["Air mover", "3 air movers — 6 unit-days on site", 6, "DAY", 45],
        ["Dehumidifier", "1 dehumidifier — 2 unit-days on site", 2, "DAY", 225],
      ],
    );
  });

  it("comes to $4,080 at those rates: 48 h × $70 + 2 × $225 + 6 × $45", () => {
    expect(plan.totals).toEqual({ laborHours: 48, equipmentUnits: 4, amount: 4080 });
  });

  it("at NJ's $65/h (a state price list on the labor rate) it is $3,840", () => {
    const nj = planInvoicePull({
      labourDays: [day("2026-09-22", 3, 8), day("2026-09-21", 3, 8)],
      placements: [unit("dehumidifier"), unit("air_mover"), unit("air_mover"), unit("air_mover")],
      tickets: [],
      rates: { ...rates, regularLabor: 65 },
      includeUnapproved: false,
    });
    expect(nj.totals.amount).toBe(3840);
  });
});

describe("never silently billed", () => {
  it("leaves unapproved hours out and lists them", () => {
    const plan = planInvoicePull({
      labourDays: [day("2026-09-21", 2, 8, false)],
      placements: [],
      tickets: [],
      rates,
      includeUnapproved: false,
    });
    expect(plan.lines).toEqual([]);
    expect(plan.excluded).toEqual([{ date: "2026-09-21", hours: 16 }]);
  });

  it("includes them only as a line that says so", () => {
    const plan = planInvoicePull({
      labourDays: [day("2026-09-21", 2, 8, false)],
      placements: [],
      tickets: [],
      rates,
      includeUnapproved: true,
    });
    expect(plan.lines[0]).toMatchObject({ unapproved: true, quantity: 16 });
    expect(plan.lines[0]!.description).toContain("(not yet approved)");
  });

  it("puts a type with no charge rate in at $0, marked, never at a guess", () => {
    const plan = planInvoicePull({
      labourDays: [],
      placements: [unit("heater")],
      tickets: [],
      rates,
      includeUnapproved: false,
    });
    expect(plan.lines[0]).toMatchObject({ unit_price: 0, unpriced: true });
    expect(plan.lines[0]!.description).toContain("no charge rate on file");
  });

  it("bills untagged classes only from approved field forms", () => {
    const plan = planInvoicePull({
      labourDays: [],
      placements: [],
      tickets: [
        { work_date: "2026-09-21", approved: true, counts: { injector: 2 } },
        { work_date: "2026-09-22", approved: false, counts: { injector: 5 } },
      ],
      rates,
      includeUnapproved: false,
    });
    expect(plan.lines.map((l) => [l.name, l.quantity, l.unit_price])).toEqual([
      ["Injector", 2, 100],
    ]);
  });
});

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
// The panel's reads and insert moved to invoice-pull-run.ts, shared with the
// Billing tab's one-press "Pull from job"; the rules still hold for both.
const PANEL =
  read("src/components/invoice-pull-panel.tsx") + "\n" + read("src/lib/invoice-pull-run.ts");

describe("charge rates, one press, editable after", () => {
  it("prices with the Quick Estimate's charge-rate resolver, not the cost rates", () => {
    expect(PANEL).toContain("fetchCalculatorRates({");
    expect(PANEL).not.toMatch(/daily_rate_cents|labour_rates|fetchTicketRates/);
  });

  it("inserts ordinary lines in their own scope, and sends nothing", () => {
    expect(PANEL).toContain('.from("invoice_scopes")');
    expect(PANEL).toContain('.from("invoice_lines").insert(');
    expect(PANEL).not.toMatch(/sendEmail|email_messages|status: "sent"|sent_at/);
  });

  it("is on the invoice editor's rail and on the quick-invoice path", () => {
    expect(read("src/components/invoice-editor.tsx")).toContain("<InvoicePullPanel");
    expect(read("src/components/job-billing-panel.tsx")).toContain("Pull from job");
  });
});
