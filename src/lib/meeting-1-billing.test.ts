import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  calculationToEstimate,
  estimatesTotal,
  mergeBillingEstimates,
  quoteToEstimate,
  rowKey,
} from "@/lib/billing-estimates";
import {
  priceFieldTicket,
  ticketCostNote,
  ticketCrewSize,
  ticketEquipmentCounts,
  ticketHours,
  type TicketRates,
} from "@/lib/field-ticket-costing";
import type { FieldWorkTicket } from "@/lib/field-work-ticket";
import {
  calculateCustomerPricing,
  customLinesTotal,
  emptyJobCalculationInput,
  usableCustomLines,
} from "@/lib/job-calculator";

/**
 * David's 16 Sep walkthrough of billing, estimates and running costs.
 *
 * The two he called critical were both data never reaching the place that was
 * meant to show it, so those are tested on the joins themselves rather than
 * through the screens. The rest of the walkthrough was wording and layout,
 * which this repo pins by reading the source — there is no DOM testing library
 * here, and `src/components/qty-takes-a-sum.test.ts` set that precedent.
 */

/* ------------------------------ 1. the estimate that was never in Billing */

const QUOTE = {
  id: "q1",
  title: "Water mitigation",
  status: "approved" as const,
  total: 4200,
  version: 2,
  job_id: "job-1",
  created_at: "2026-09-10T10:00:00.000Z",
};

const CALC = {
  id: "c1",
  job_id: null,
  customer_name: "Falcon Holdings",
  address: "12 Maple Ave",
  locality: "Haverstraw",
  job_type: "water",
  customer_price: 1850,
  created_at: "2026-09-16T09:00:00.000Z",
  updated_at: "2026-09-16T11:00:00.000Z",
};

describe("Billing lists estimates from both places one can be priced", () => {
  it("includes a calculator estimate that has no job at all", () => {
    /*
     * The whole finding. `quotes.job_id` is NOT NULL, so an estimate priced off
     * nothing but an address can never be a quote row — which is exactly the
     * kind David made, and exactly why Billing → Estimates never showed it.
     */
    const rows = mergeBillingEstimates([QUOTE], [CALC]);
    expect(rows).toHaveLength(2);
    const calc = rows.find((r) => r.source === "calculator");
    expect(calc, "a calculator estimate must reach the billing list").toBeTruthy();
    expect(calc!.jobId).toBeNull();
    expect(calc!.total).toBe(1850);
  });

  it("names a calculator estimate after its customer, and says where it is from", () => {
    const row = calculationToEstimate(CALC);
    expect(row.title).toBe("Falcon Holdings");
    expect(row.subtitle).toBe("12 Maple Ave, Haverstraw");
    expect(row.statusLabel).toBe("Calculator");
  });

  it("falls back to the address when nobody typed a customer", () => {
    const row = calculationToEstimate({ ...CALC, customer_name: null });
    expect(row.title).toBe("12 Maple Ave, Haverstraw");
  });

  it("says when a calculator estimate has been attached to a job", () => {
    expect(calculationToEstimate({ ...CALC, job_id: "job-9" }).statusLabel).toBe(
      "Calculator · on a job",
    );
  });

  it("keeps a quote reading exactly as it did", () => {
    const row = quoteToEstimate(QUOTE);
    expect(row.title).toBe("Water mitigation");
    expect(row.version).toBe(2);
    expect(row.statusLabel).toBe("Approved");
    expect(row.jobId).toBe("job-1");
  });

  it("cannot collide two ids from different tables", () => {
    const rows = mergeBillingEstimates([{ ...QUOTE, id: "same" }], [{ ...CALC, id: "same" }]);
    expect(new Set(rows.map((r) => r.key)).size).toBe(2);
    expect(rowKey("quote", "same")).not.toBe(rowKey("calculator", "same"));
  });

  it("orders newest first across both sources", () => {
    const rows = mergeBillingEstimates([QUOTE], [CALC]);
    expect(rows[0]!.source).toBe("calculator"); // 16 Sep beats 10 Sep
  });

  it("totals both sources, which is what the Estimated tile prints", () => {
    expect(estimatesTotal(mergeBillingEstimates([QUOTE], [CALC]))).toBe(4200 + 1850);
  });

  it("is what the Billing page actually reads", () => {
    const src = readFileSync("src/routes/_authenticated/billing.index.tsx", "utf8");
    expect(src).toContain("listBillingEstimates(app.currentLocationId)");
    expect(src).toContain("estimatesTotal(quotes)");
    // The section is the client's word for it, not the database's. It was a
    // tab until David asked for the split on 22 Sep (billing-page-layout.test).
    expect(src).toContain('<section aria-label="Estimates"');
    expect(src).toContain('<CardTitle className="text-sm">Estimates</CardTitle>');
  });
});

/* ------------------------- 2. the field form that never reached the money */

const TICKET = {
  id: "t1",
  job_id: "job-1",
  work_date: "2026-09-16",
  job_start_time: "08:00",
  job_end_time: "16:00",
  gsr_crew_size: 2,
  temp_crew_size: 0,
  equip_dehumidifier: 1,
  equip_air_mover: 3,
  equip_scrubber: null,
  equip_injector: null,
  equip_ozone: null,
  equip_hydroxyl: null,
  equip_generator: null,
} as unknown as FieldWorkTicket;

const RATES: TicketRates = {
  labourHourlyRate: 35,
  equipmentDailyRate: { dehumidifier: 60, air_mover: 25 },
};

describe("a day on a field ticket reaches the running costs", () => {
  it("reads the hours off the two clock times", () => {
    expect(ticketHours("08:00", "16:00")).toBe(8);
    expect(ticketHours("08:30", "17:00")).toBe(8.5);
  });

  it("carries a night shift past midnight instead of losing it", () => {
    // 22:00–02:00 is four hours worked, not minus twenty.
    expect(ticketHours("22:00", "02:00")).toBe(4);
  });

  it("has no hours when the crew did not write the times down", () => {
    expect(ticketHours(null, "16:00")).toBe(0);
    expect(ticketHours("08:00", null)).toBe(0);
  });

  it("counts temps as crew, because they cost money too", () => {
    expect(ticketCrewSize({ gsr_crew_size: 2, temp_crew_size: 1 })).toBe(3);
    expect(ticketCrewSize({ gsr_crew_size: null, temp_crew_size: null })).toBe(0);
  });

  it("reads the machines left on site", () => {
    expect(ticketEquipmentCounts(TICKET)).toEqual({ dehumidifier: 1, air_mover: 3 });
  });

  it("prices David's own example", () => {
    /*
     * The exact ticket from the walkthrough: an eight-hour day, a crew of two,
     * one dehumidifier and three air movers — which produced nothing at all.
     */
    const cost = priceFieldTicket(TICKET, RATES);
    expect(cost.personHours).toBe(16);
    expect(cost.labourCost).toBe(16 * 35);
    expect(cost.equipmentUnits).toBe(4);
    expect(cost.equipmentCost).toBe(60 + 3 * 25);
    expect(cost.totalCost).toBe(560 + 135);
    expect(cost.totalCost).toBeGreaterThan(0);
    expect(cost.warnings).toEqual([]);
  });

  it("says why, rather than silently costing nothing", () => {
    const noRate = priceFieldTicket(TICKET, { labourHourlyRate: null, equipmentDailyRate: {} });
    expect(noRate.labourCost).toBe(0);
    expect(noRate.warnings.join(" ")).toMatch(/no crew hourly rate/i);
    expect(noRate.warnings.join(" ")).toMatch(/no daily rate/i);

    const noTimes = priceFieldTicket(
      { ...TICKET, job_start_time: null, job_end_time: null } as FieldWorkTicket,
      RATES,
    );
    expect(noTimes.warnings.join(" ")).toMatch(/no start and end time/i);
  });

  it("charges equipment for the ticket's own day only", () => {
    // A machine left standing keeps accruing through equipment_placements.
    // Charging its whole stay here as well would bill the same unit twice.
    expect(priceFieldTicket(TICKET, RATES).equipmentCost).toBe(135);
  });

  it("writes a note that explains the figure in Billing", () => {
    const note = ticketCostNote(TICKET, priceFieldTicket(TICKET, RATES));
    expect(note).toContain("2026-09-16");
    expect(note).toContain("8h × 2 crew = 16 person-hours");
    expect(note).toContain("4 machines on site");
  });

  it("files the day as one cost line, keyed so an edit corrects it", () => {
    const src = readFileSync("src/lib/field-ticket-costing.ts", "utf8");
    expect(src).toContain('.from("job_cost_lines")');
    expect(src).toContain('onConflict: "field_work_ticket_id"');
    // Never the two tables the engine owns for the time clock and the register.
    expect(src).not.toContain('.from("time_entries")');
    expect(src).not.toContain('.from("equipment_placements")');
  });

  it("is posted when a ticket is saved, and never costs the crew their shift", () => {
    const src = readFileSync("src/components/field-work-ticket-panel.tsx", "utf8");
    expect(src).toContain("await postTicketCost(");
    expect(src).toMatch(/const postTicketCost[\s\S]{0,400}catch \{/);
  });
});

/* ---------------------------------------------- 7. blank lines on a sheet */

describe("the calculator takes lines the catalog has no row for", () => {
  it("adds typed-in lines to what the customer is charged", () => {
    const base = emptyJobCalculationInput();
    const before = calculateCustomerPricing(base).customerPrice;
    const after = calculateCustomerPricing({
      ...base,
      customLines: [
        { label: "Dumpster permit", amount: 175 },
        { label: "Specialist sub", amount: 400 },
      ],
    });
    expect(after.customLinesPrice).toBe(575);
    expect(after.customerPrice).toBe(before + 575);
    expect(after.customLines).toHaveLength(2);
  });

  it("drops a row the user added and never filled in", () => {
    // Adding three blanks and using one must store one, not three.
    expect(usableCustomLines([{ label: "", amount: 0 }])).toEqual([]);
    expect(usableCustomLines([{ label: "Permit", amount: 0 }])).toHaveLength(1);
    expect(usableCustomLines([{ label: "  ", amount: 50 }])).toHaveLength(1);
    expect(customLinesTotal([{ label: "", amount: 0 }])).toBe(0);
  });

  it("never lets a negative line quietly discount the job", () => {
    expect(customLinesTotal([{ label: "Oops", amount: -500 }])).toBe(0);
  });

  it("offers the control at the bottom of the list, as asked", () => {
    const src = readFileSync("src/components/job-calculator-editor.tsx", "utf8");
    expect(src).toContain("Add item");
    expect(src).toContain("addCustomLine");
    expect(src).toContain("removeCustomLine");
  });
});

/* -------------------------------------- 8, 4, 5, 6: layout and wording */

describe("the rest of the walkthrough", () => {
  it("puts job type in the list instead of the address block", () => {
    const src = readFileSync("src/components/job-calculator-editor.tsx", "utf8");
    const jobTypeCard = src.indexOf('<CardTitle className="text-base">Job type</CardTitle>');
    const crewCard = src.indexOf('<CardTitle className="text-base">Crew and labor</CardTitle>');
    expect(jobTypeCard).toBeGreaterThan(-1);
    // It leads the priced list rather than sitting up with the customer.
    expect(jobTypeCard).toBeLessThan(crewCard);
  });

  it("explains what Cost by component shows and where it comes from", () => {
    const src = readFileSync("src/components/job-cost-breakdown.tsx", "utf8");
    expect(src).toContain("Where this job&rsquo;s money has gone");
    expect(src).toContain("Field work");
    // The old copy promised field-form hours were excluded, which is no
    // longer true now a ticket files its own cost line.
    expect(src).not.toContain("are not in it");
  });

  it("calls the invoices card Invoices", () => {
    const src = readFileSync("src/components/job-billing-panel.tsx", "utf8");
    expect(src).toContain('<CardTitle className="text-base">Invoices</CardTitle>');
    expect(src).not.toContain("Carrier invoicing");
  });

  it("offers a basic estimate and a quick invoice as separate actions", () => {
    const src = readFileSync("src/components/job-billing-panel.tsx", "utf8");
    expect(src).toContain("Quick Estimate");
    expect(src).toContain("Detailed estimate");
    expect(src).toContain("Quick invoice");
    // The basic one is the calculator, not a third editor built from scratch.
    expect(src).toContain("JobCalculatorDialog");
  });

  it("shows cost, revenue and margin money together", () => {
    const src = readFileSync("src/components/job-running-cost-panel.tsx", "utf8");
    expect(src).toContain('label="Cost"');
    expect(src).toContain('label="Revenue"');
    expect(src).toContain('label="Margin"');
    // The money used to vanish from the margin tile exactly when it went
    // under the floor, which is when somebody most wants to see it.
    expect(src).toContain("under ${threshold}% floor");
    expect(src).toMatch(/\$\{moneyExact\(c\.margin\)\} · under/);
  });

  it("gives the ticket an accept step at the bottom of the sheet", () => {
    const src = readFileSync("src/components/field-work-ticket-panel.tsx", "utf8");
    expect(src).toContain("Approve ticket");
    expect(src).toContain("Withdraw approval");
    expect(src).toContain("setFieldWorkTicketApproval");
  });
});

/**
 * David, 17 Sep, on the two controls beside each other in billing.
 *
 * On the calculator-style estimate: it should be called a "quick estimate or
 * something like that". On its neighbour: "why is the quick invoice like a
 * button, like the other one? It's clickable, but it doesn't show up as a
 * button."
 */
describe("Quick Estimate and Quick Invoice", () => {
  const PANEL = readFileSync("src/components/job-billing-panel.tsx", "utf8").replace(/\r\n/g, "\n");
  const code = PANEL.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("calls the calculator estimate Quick Estimate", () => {
    expect(code).toContain("Quick Estimate");
    expect(code).not.toContain("Basic estimate");
  });

  it("gives Quick invoice the same weight as the button beside it", () => {
    // It was `ghost` — no border, no fill — next to an `outline` neighbour
    // doing the same kind of thing.
    // The opening tag spans lines and its onClick contains "=>", so a
    // character class stopping at ">" cannot bound it. Walk back from the
    // handler to the <Button that owns it instead.
    const at = code.indexOf("setQuickOpen(true)");
    expect(at).toBeGreaterThan(-1);
    const button = code.slice(code.lastIndexOf("<Button", at), at);
    expect(button).toContain('variant="outline"');
    expect(button).not.toContain('variant="ghost"');
  });
});
