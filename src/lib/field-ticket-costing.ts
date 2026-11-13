/**
 * What a day's field work ticket costs, and how that reaches running costs.
 *
 * David, 16 Sep: he filled a daily field form — an eight-hour day, a crew of
 * two, water extraction, one dehumidifier and three air movers — saved it, and
 * nothing whatever appeared in the job's running costs.
 *
 * Nothing was wrong with the costing engine. `job_running_cost` takes labour
 * from `time_entries` and equipment from `equipment_placements`, and
 * `writeFieldWorkTicket` writes neither: it upserts `field_work_tickets` and
 * stops. The crew's day was recorded perfectly and was invisible to the money.
 *
 * WHY `job_cost_lines`, rather than writing the two tables the engine reads:
 *
 *   · `time_entries` is the time clock's. A ticket says "two people, eight
 *     hours", not which two people clocked what, and inventing entries for
 *     named users would double-count the moment anyone also clocks in.
 *   · `equipment_placements` is the asset register. A ticket counts machines by
 *     type — "3 air movers" — and has no asset tags, so creating placements
 *     would corrupt the inventory the equipment module depends on.
 *   · `job_cost_lines` is the engine's existing manual-cost leg, already summed
 *     into `total_cost`, and exists precisely for costs entered by hand. One
 *     line per ticket, rewritten whenever the ticket is, is the smallest honest
 *     way to make the day count.
 *
 * Everything in this file above `postFieldTicketCost` is pure, so the arithmetic
 * a foreman will be asked to trust can be tested without a database.
 */

import { supabase } from "@/integrations/supabase/client";
import { isMissingSchema } from "@/lib/schema-fallback";
import { fetchEquipmentCosts } from "@/lib/cost-columns";
import { EQUIPMENT_LEFT_OPTIONS, equipColumn, type FieldWorkTicket } from "@/lib/field-work-ticket";
import { laborAmount, roundMoney } from "@/lib/money";

/** Rates to price a ticket with. Both are per the job's own office/day. */
export type TicketRates = {
  /** Blended crew rate, dollars per person-hour. Null when none is configured. */
  labourHourlyRate: number | null;
  /** Dollars per machine per day, by the ticket's own equipment key. */
  equipmentDailyRate: Record<string, number>;
};

export type TicketCost = {
  /** Hours on site, from the start and end times written on the form. */
  hours: number;
  /** GSR crew plus temps — everyone the ticket says was there. */
  crewSize: number;
  /** hours × crewSize. The number a foreman can check in his head. */
  personHours: number;
  labourCost: number;
  /** Machines left on site, all types added together. */
  equipmentUnits: number;
  equipmentCost: number;
  totalCost: number;
  /** Set when something needed to price the day was missing. */
  warnings: string[];
};

/**
 * Hours between the two clock times on the form.
 *
 * Times are stored as plain `HH:MM(:SS)` with no date, so a shift that runs
 * past midnight reads as negative; it is carried to the next day rather than
 * being thrown away, because a crew that worked 22:00–02:00 worked four hours.
 */
export function ticketHours(startTime: string | null, endTime: string | null): number {
  const parse = (t: string | null): number | null => {
    if (!t) return null;
    const m = /^(\d{1,2}):(\d{2})/.exec(t.trim());
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (!Number.isFinite(h) || !Number.isFinite(min)) return null;
    return h * 60 + min;
  };
  const from = parse(startTime);
  const to = parse(endTime);
  if (from == null || to == null) return 0;
  const minutes = to >= from ? to - from : to + 24 * 60 - from;
  return Math.round((minutes / 60) * 100) / 100;
}

/** Everyone the ticket says was on site. Temps cost money too. */
export function ticketCrewSize(ticket: Pick<FieldWorkTicket, "gsr_crew_size" | "temp_crew_size">) {
  return (
    Math.max(0, Number(ticket.gsr_crew_size ?? 0)) + Math.max(0, Number(ticket.temp_crew_size ?? 0))
  );
}

/** How many machines of each kind the ticket left on site. */
export function ticketEquipmentCounts(ticket: FieldWorkTicket): Record<string, number> {
  const out: Record<string, number> = {};
  for (const opt of EQUIPMENT_LEFT_OPTIONS) {
    const raw = ticket[equipColumn(opt.key)];
    const n = Math.max(0, Number(raw ?? 0));
    if (n > 0) out[opt.key] = n;
  }
  return out;
}

const round2 = roundMoney;

/**
 * Price one ticket.
 *
 * Equipment is charged for the single day the ticket covers. A machine left
 * standing accrues for every further day through `equipment_placements`, which
 * is the register's job; charging the whole stay here as well would count the
 * same dehumidifier twice.
 */
export function priceFieldTicket(ticket: FieldWorkTicket, rates: TicketRates): TicketCost {
  const warnings: string[] = [];
  const hours = ticketHours(ticket.job_start_time, ticket.job_end_time);
  const crewSize = ticketCrewSize(ticket);
  const personHours = round2(hours * crewSize);

  if (hours <= 0) warnings.push("No start and end time on the ticket, so there are no hours.");
  if (crewSize <= 0) warnings.push("No crew size on the ticket, so there is nobody to pay.");

  let labourCost = 0;
  if (personHours > 0) {
    if (rates.labourHourlyRate == null) {
      warnings.push("No crew hourly rate is configured, so labor is not costed.");
    } else {
      labourCost = laborAmount(personHours, rates.labourHourlyRate);
    }
  }

  const counts = ticketEquipmentCounts(ticket);
  let equipmentUnits = 0;
  let equipmentCost = 0;
  const unpriced: string[] = [];
  for (const [key, n] of Object.entries(counts)) {
    equipmentUnits += n;
    const rate = rates.equipmentDailyRate[key];
    if (rate == null) {
      unpriced.push(key);
      continue;
    }
    equipmentCost += n * rate;
  }
  equipmentCost = round2(equipmentCost);
  if (unpriced.length > 0) {
    warnings.push(
      `No daily rate for ${unpriced.join(", ")}, so ${unpriced.length === 1 ? "it is" : "they are"} not costed.`,
    );
  }

  return {
    hours,
    crewSize,
    personHours,
    labourCost,
    equipmentUnits,
    equipmentCost,
    totalCost: round2(labourCost + equipmentCost),
    warnings,
  };
}

/** The note written on the cost line, so the number explains itself in Billing. */
export function ticketCostNote(ticket: FieldWorkTicket, cost: TicketCost): string {
  const bits = [`Field ticket ${ticket.work_date}`];
  if (cost.personHours > 0) {
    bits.push(`${cost.hours}h × ${cost.crewSize} crew = ${cost.personHours} person-hours`);
  }
  if (cost.equipmentUnits > 0) bits.push(`${cost.equipmentUnits} machines on site`);
  return bits.join(" · ");
}

/* ------------------------------------------------------------------ */
/* Rates                                                               */
/* ------------------------------------------------------------------ */

/**
 * Day rates for the machine classes the asset register cannot hold.
 *
 * `equipment_type` is an enum of eight values and has no injector, no ozone and
 * no hydroxyl. Gold Star does not asset-tag those units, so a ticket's count is
 * the only record there will ever be of them — and until David's rates arrived
 * on 18 Sep they priced at nothing, silently, on every ticket that carried one.
 *
 * Seeded by 20260918131000 into `app_settings.equipment_day_rates`, keyed by
 * the ticket's own vocabulary. Dollars per machine per day.
 */
export const EQUIPMENT_DAY_RATES_KEY = "equipment_day_rates";

/**
 * Fold the settings card into the rates read off the register.
 *
 * The register WINS. An admin who has typed a number at /admin/equipment-rates
 * has made a decision about that machine, and a fallback that quietly overrode
 * it would make that screen a lie. The card only fills keys the register left
 * with no rate at all — which, for injector, ozone and hydroxyl, is always.
 *
 * Pure, so the precedence a foreman's numbers depend on is testable.
 */
export function mergeDayRates(
  fromRegister: Record<string, number>,
  card: Record<string, unknown> | null | undefined,
): Record<string, number> {
  const merged = { ...fromRegister };
  for (const [key, raw] of Object.entries(card ?? {})) {
    if (merged[key] != null) continue;
    const n = Number(raw);
    // A card entry that is not a number is ignored rather than costed as zero:
    // "not priced" already has a warning, and a silent $0 has none.
    if (Number.isFinite(n) && n > 0) merged[key] = n;
  }
  return merged;
}

/**
 * The rates in force for a job's day.
 *
 * Labour comes from the same `labour_rates` table `job_running_cost` falls back
 * to for an unrated user, so a ticket and a clocked hour are costed off one
 * number. Equipment is the daily rate the equipment catalogue already carries
 * per asset, collapsed to one rate per type — `setTypeRate` is how the catalogue
 * is priced in practice, so the units of a type agree anyway — and then topped
 * up from the settings card for the classes that have no assets to carry one.
 */
export async function fetchTicketRates(workDate: string): Promise<TicketRates> {
  const rates: TicketRates = { labourHourlyRate: null, equipmentDailyRate: {} };

  // One labor-rate rule (P5): the Gold Star field crew's company-wide rate
  // on the work date — crew_rate_for('gsr', …) — never whichever row with no
  // person happens to sort first (an Owner or Cold Caller rate could).
  const labour = await supabase
    .from("labour_rates")
    .select("hourly_rate, effective_from, effective_to, user_id")
    .is("user_id", null)
    .eq("crew_class", "gsr")
    .is("location_id", null)
    .lte("effective_from", workDate)
    .order("effective_from", { ascending: false })
    .limit(20);
  if (!labour.error) {
    const row = (labour.data ?? []).find(
      (r) => !r.effective_to || String(r.effective_to) >= workDate,
    );
    if (row?.hourly_rate != null) rates.labourHourlyRate = Number(row.hourly_rate);
  }

  // daily_rate_cents is withheld at the column (20261027150000): the rates
  // come from equipment_costs(), which answers only job.view_costs holders —
  // as labour_rates above is readable by managers only. Anyone else prices
  // the ticket from the day-rate card below, or not at all.
  const [equipment, costs] = await Promise.all([
    supabase.from("equipment").select("id, equipment_type"),
    fetchEquipmentCosts().catch(() => null),
  ]);
  if (!equipment.error && costs) {
    const byType = new Map<string, number>();
    const units = (equipment.data ?? []) as { id: string; equipment_type: string | null }[];
    for (const row of units.map((u) => ({
      equipment_type: u.equipment_type,
      daily_rate_cents: costs.get(u.id)?.daily_rate_cents ?? null,
    }))) {
      if (!row.equipment_type || row.daily_rate_cents == null) continue;
      // Highest rate of the type, so a part-priced catalogue never quietly
      // under-charges a day it could have charged properly.
      const dollars = Number(row.daily_rate_cents) / 100;
      const seen = byType.get(row.equipment_type);
      if (seen == null || dollars > seen) byType.set(row.equipment_type, dollars);
    }
    for (const opt of EQUIPMENT_LEFT_OPTIONS) {
      const types = TICKET_KEY_TO_ASSET_TYPES[opt.key] ?? [];
      const found = types.map((t) => byType.get(t)).filter((v): v is number => v != null);
      if (found.length > 0) rates.equipmentDailyRate[opt.key] = Math.max(...found);
    }
  }

  // Billing & Costs P4: then each type's company day cost (Cost tab), which
  // injector, ozone and hydroxyl now have as types. The card below keeps its
  // old values for a database without them.
  const typeCosts = await supabase
    .from("money_values" as never)
    .select("item_key, office_id, effective_from, value")
    .eq("book", "cost")
    .eq("measure", "cost_rate")
    .like("item_key", "EQ:%")
    .is("office_id", null)
    .lte("effective_from", workDate)
    .order("effective_from", { ascending: false });
  if (!typeCosts.error) {
    const byType = new Map<string, number>();
    for (const r of (typeCosts.data ?? []) as {
      item_key: string;
      value: number | string | null;
    }[]) {
      const t = r.item_key.slice(3);
      if (!byType.has(t) && r.value != null) byType.set(t, Number(r.value));
    }
    rates.equipmentDailyRate = mergeDayRates(
      rates.equipmentDailyRate,
      Object.fromEntries(
        Object.entries(TICKET_KEY_TO_ASSET_TYPES)
          .map(([key, types]) => [key, types.map((t) => byType.get(t)).find((v) => v != null)])
          .filter(([, v]) => v != null),
      ),
    );
  }

  // A missing settings row is not an error — it is a database that has not had
  // 20260918131000 yet, and the ticket still costs whatever the register knows.
  const card = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", EQUIPMENT_DAY_RATES_KEY)
    .maybeSingle();
  if (!card.error) {
    const value = (card.data?.value ?? {}) as { day_rates?: Record<string, unknown> };
    rates.equipmentDailyRate = mergeDayRates(rates.equipmentDailyRate, value.day_rates);
  }

  return rates;
}

/**
 * Ticket vocabulary to asset types. A superset of the register's own map: the
 * lines Gold Star does not asset-tag (injector, ozone, hydroxyl) still cost
 * money, and the catalogue may well carry a rate for them under their own name.
 */
const TICKET_KEY_TO_ASSET_TYPES: Record<string, string[]> = {
  dehumidifier: ["dehumidifier"],
  air_mover: ["air_mover"],
  scrubber: ["air_scrubber", "hepa"],
  injector: ["injector"],
  ozone: ["ozone"],
  hydroxyl: ["hydroxyl"],
  generator: ["generator"],
};

/* ------------------------------------------------------------------ */
/* Write                                                               */
/* ------------------------------------------------------------------ */

/** The component name the ticket's cost line is filed under. */
export const FIELD_TICKET_COMPONENT = "Field work";

/**
 * Put the ticket's day into the job's running costs, replacing whatever the
 * same ticket put there before.
 *
 * Keyed on `field_work_ticket_id`, so editing a ticket corrects its line rather
 * than adding a second one. Returns `false` when the database has not had the
 * migration that adds that column — the ticket itself is already saved by then,
 * and a crew must never lose a shift because the money could not be filed.
 */
export async function postFieldTicketCost(
  ticket: FieldWorkTicket,
  cost: TicketCost,
): Promise<boolean> {
  const payload = {
    job_id: ticket.job_id,
    field_work_ticket_id: ticket.id,
    work_component: FIELD_TICKET_COMPONENT,
    direct_cost: cost.labourCost,
    equipment_cost: cost.equipmentCost,
    equipment_days: cost.equipmentUnits > 0 ? 1 : 0,
    materials_cost: 0,
    subcontractor_cost: 0,
    revenue: 0,
    notes: ticketCostNote(ticket, cost),
  };

  const { error } = await supabase
    .from("job_cost_lines")
    .upsert(payload as never, { onConflict: "field_work_ticket_id" });
  if (!error) return true;
  if (isMissingSchema(error)) return false;
  throw error;
}
