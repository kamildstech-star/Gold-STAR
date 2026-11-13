import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { mergeDayRates, priceFieldTicket, type TicketRates } from "@/lib/field-ticket-costing";
import { EQUIPMENT_LEFT_OPTIONS, type FieldWorkTicket } from "@/lib/field-work-ticket";

/**
 * David's real cost rates, and the migration that seeds them.
 *
 * Meeting point 7 carried a standing note: "crew rate + equipment day rates
 * must be set in the app or costs show $0". The engine was never wrong — it had
 * nothing to multiply. His numbers arrived on 18 Sep from the Item Cost sheet
 * of his Excel calculator: crew labour $45/hour, dehumidifier $20/day, air
 * mover $5/day, and so on.
 *
 * They are COSTS. His charge rate is $65/hour and lives in the estimate
 * catalogue; nothing here touches it, and a test says so, because mixing cost
 * and charge is exactly how a margin report starts lying.
 */

const MIGRATION = readFileSync(
  "supabase/migrations/20260918131000_gsr_cost_rates.sql",
  "utf8",
).replace(/\r\n/g, "\n");

/**
 * The statements only.
 *
 * The file's header explains at length that $65 is his CHARGE rate and is not
 * touched here, so asserting "65 never appears" against the raw text would be
 * satisfied or broken by the prose rather than by the SQL. Every assertion
 * about what is written runs against this instead.
 */
const STATEMENTS = MIGRATION.split("\n")
  .filter((line) => !/^\s*--/.test(line))
  .join("\n");

describe("the seed migration", () => {
  it("sets the corporate crew cost to $45 an hour", () => {
    // user_id, location_id, role and crew_class all NULL is the corporate
    // default — the last rate job_running_cost() reaches for.
    expect(STATEMENTS).toContain("INSERT INTO public.labour_rates");
    expect(STATEMENTS).toMatch(/SELECT NULL, NULL, NULL, NULL, 45, DATE '2026-09-18'/);
  });

  it("writes his $45 cost and never his $65 charge rate", () => {
    /*
     * 65 appears once in the statements, inside the note the seeded row carries
     * — "Cost, not the $65/hr charge rate" — which is the point, so the
     * assertion is about the numbers being WRITTEN, not about the text. Charge
     * lives in the estimate catalogue; a seed that put it here would make every
     * margin on every job wrong by $20 an hour in the client's favour.
     */
    const inserted = /,\s*(\d+(?:\.\d+)?),\s*DATE '2026-09-18'/.exec(STATEMENTS)?.[1];
    expect(inserted).toBe("45");
    expect(STATEMENTS).not.toMatch(/hourly_rate\s*=\s*65\b/);
    expect(STATEMENTS).not.toMatch(/daily_rate_cents\s*=\s*6500\b/);
    // Nothing outside labour_rates and the settings card is written at all.
    expect(STATEMENTS).not.toMatch(/estimate_catalog_items|customer_price|price_list/);
  });

  it("widens labour_rate_subject before inserting the company default", () => {
    /*
     * Applying this failed and rolled back with 23514: the live constraint
     * demands that every rate name a person, a role or a crew class, and the
     * company-wide default names none of them. Order matters — the constraint
     * change has to come BEFORE the insert or the same rollback happens again.
     */
    const constraintAt = STATEMENTS.indexOf("ADD CONSTRAINT labour_rate_subject");
    const insertAt = STATEMENTS.indexOf("INSERT INTO public.labour_rates");
    expect(constraintAt).toBeGreaterThan(-1);
    expect(constraintAt).toBeLessThan(insertAt);
  });

  it("admits the all-NULL default without dropping the rule", () => {
    // The original intent survives: a rate still names its subject. The
    // company default joins the list the way crew_class did in 20260902200000,
    // rather than the constraint being deleted.
    const check = STATEMENTS.slice(
      STATEMENTS.indexOf("ADD CONSTRAINT labour_rate_subject"),
      STATEMENTS.indexOf("EXCEPTION WHEN duplicate_object"),
    );
    expect(check).toContain("user_id IS NOT NULL");
    expect(check).toContain("role IS NOT NULL");
    expect(check).toContain("crew_class IS NOT NULL");
    // And the one new shape, bounded: no subject AND no office.
    expect(check).toContain("location_id IS NULL");
  });

  it("still refuses a subject-less rate that names an office", () => {
    // "$45/hour at the Paterson office, for whom?" is the ambiguity the
    // constraint exists to prevent, so the new clause requires location_id to
    // be NULL too rather than allowing any subject-less row.
    const check = STATEMENTS.slice(
      STATEMENTS.indexOf("OR ("),
      STATEMENTS.indexOf("EXCEPTION WHEN duplicate_object"),
    );
    expect(check).toMatch(/user_id IS NULL[\s\S]*AND location_id IS NULL/);
  });

  it("can be re-run after the constraint already exists", () => {
    // DROP IF EXISTS plus the duplicate_object handler, so a second run of the
    // whole file is a no-op rather than an error.
    expect(STATEMENTS).toContain("DROP CONSTRAINT IF EXISTS labour_rate_subject");
    expect(STATEMENTS).toContain("EXCEPTION WHEN duplicate_object THEN NULL");
  });

  it("closes the old default off by date rather than deleting it", () => {
    // A rate is effective-dated. A job costed last month should still cost what
    // it cost last month.
    expect(STATEMENTS).toContain("SET effective_to = DATE '2026-09-17'");
    expect(STATEMENTS).not.toMatch(/DELETE FROM public\.labour_rates/);
  });

  it("prices each equipment type off David's sheet, in cents", () => {
    const rate = (type: string) =>
      new RegExp(`SET daily_rate_cents = (\\d+)\\s*\\n?\\s*WHERE equipment_type = '${type}'`).exec(
        STATEMENTS,
      )?.[1];
    expect(rate("air_mover")).toBe("500"); // $5
    expect(rate("dehumidifier")).toBe("2000"); // $20
    expect(rate("air_scrubber")).toBe("1000"); // Scrubber XL, $10
    expect(rate("hepa")).toBe("1500"); // Scrubber XXL, $15
    expect(rate("generator")).toBe("1000"); // $10
  });

  it("only fills a rate that is missing, never one an admin has set", () => {
    // The complaint was $0. A number already typed at /admin/equipment-rates is
    // a decision, not a gap.
    const updates =
      STATEMENTS.match(/UPDATE public\.equipment SET daily_rate_cents[\s\S]*?;/g) ?? [];
    expect(updates).toHaveLength(5);
    for (const u of updates) expect(u).toContain("coalesce(daily_rate_cents, 0) = 0");
  });

  it("records the classes the asset register cannot hold", () => {
    // equipment_type is an enum of eight values with no injector, ozone or
    // hydroxyl in it, and Gold Star does not asset-tag them.
    expect(STATEMENTS).toContain("'equipment_day_rates'");
    expect(STATEMENTS).toMatch(/'injector',\s*10/);
    expect(STATEMENTS).toMatch(/'ozone',\s*10/);
    expect(STATEMENTS).toMatch(/'hydroxyl',\s*20/);
  });

  it("keeps the three lines nothing counts yet, rather than dropping them", () => {
    expect(STATEMENTS).toMatch(/'submersible_pump'[\s\S]*?'amount', 5/);
    expect(STATEMENTS).toMatch(/'encapsulation'[\s\S]*?'amount', 200[\s\S]*?'bucket'/);
    expect(STATEMENTS).toMatch(/'air_samples'[\s\S]*?'amount', 175/);
  });

  it("gives every key the field ticket can count a day rate", () => {
    // The whole point: no ticket box may price at nothing in silence.
    const card = STATEMENTS.slice(
      STATEMENTS.indexOf("'day_rates'"),
      STATEMENTS.indexOf("'other_rates'"),
    );
    for (const opt of EQUIPMENT_LEFT_OPTIONS) {
      expect(card, `no day rate for ${opt.key}`).toContain(`'${opt.key}'`);
    }
  });
});

describe("mergeDayRates — the register wins", () => {
  it("fills only the keys the asset register left with no rate", () => {
    const merged = mergeDayRates({ dehumidifier: 20 }, { dehumidifier: 99, injector: 10 });
    // An admin's number at /admin/equipment-rates is not overridden by a
    // fallback, or that screen would be a lie.
    expect(merged.dehumidifier).toBe(20);
    expect(merged.injector).toBe(10);
  });

  it("is the whole card when the register knows nothing", () => {
    expect(mergeDayRates({}, { ozone: 10, hydroxyl: 20 })).toEqual({ ozone: 10, hydroxyl: 20 });
  });

  it("survives a missing settings row — a database without the migration", () => {
    expect(mergeDayRates({ air_mover: 5 }, null)).toEqual({ air_mover: 5 });
    expect(mergeDayRates({ air_mover: 5 }, undefined)).toEqual({ air_mover: 5 });
  });

  it("ignores a junk entry rather than costing it at zero", () => {
    // "Not priced" already raises a warning on the ticket; a silent $0 does not.
    expect(mergeDayRates({}, { ozone: "ten", injector: 0, hydroxyl: -5 })).toEqual({});
  });
});

describe("David's numbers on a real ticket", () => {
  const TICKET = {
    id: "t-1",
    job_id: "j-1",
    work_date: "2026-09-18",
    job_start_time: "08:00",
    job_end_time: "16:00",
    gsr_crew_size: 2,
    temp_crew_size: 0,
    equip_dehumidifier: 1,
    equip_air_mover: 3,
    equip_scrubber: 0,
    equip_injector: 0,
    equip_ozone: 0,
    equip_hydroxyl: 0,
    equip_generator: 0,
  } as unknown as FieldWorkTicket;

  /** Exactly what the two migration halves put in front of the pricer. */
  const RATES: TicketRates = {
    labourHourlyRate: 45,
    equipmentDailyRate: mergeDayRates(
      { dehumidifier: 20, air_mover: 5, scrubber: 15, generator: 10 },
      { injector: 10, ozone: 10, hydroxyl: 20 },
    ),
  };

  it("turns David's own walkthrough ticket into real money", () => {
    // The ticket he filled on the call — eight hours, a crew of two, one
    // dehumidifier and three air movers — which produced nothing at all.
    const cost = priceFieldTicket(TICKET, RATES);
    expect(cost.personHours).toBe(16);
    expect(cost.labourCost).toBe(720); // 16 × $45
    expect(cost.equipmentCost).toBe(35); // $20 + 3 × $5
    expect(cost.totalCost).toBe(755);
    expect(cost.warnings).toEqual([]);
  });

  it("costs a dehumidifier at $20 a day, so two days is $40", () => {
    // What QC checks: a dehumidifier standing for two days is $40 of
    // equipment cost, not $0.
    expect(RATES.equipmentDailyRate.dehumidifier * 2).toBe(40);
  });

  it("no longer prices an ozone machine at nothing", () => {
    const ozoneDay = priceFieldTicket(
      { ...TICKET, equip_dehumidifier: 0, equip_air_mover: 0, equip_ozone: 2 } as FieldWorkTicket,
      RATES,
    );
    expect(ozoneDay.equipmentCost).toBe(20);
    expect(ozoneDay.warnings.join(" ")).not.toMatch(/no daily rate/i);
  });
});
