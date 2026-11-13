/**
 * "Pull from job": the invoice written from what the crew recorded.
 *
 * David, 24 Sep: "by estimates we have quick estimates... we should do
 * something like this for invoices also. It should pull in — we had 30 hours
 * of labor and 15 pieces of equipment — I'll see the breakdown on the side,
 * I'll click a button to pull it into the invoice... obviously I could edit
 * it afterwards... you're essentially writing up the bill as you do the job.
 * Obviously we have to review it and approve it afterwards."
 *
 * Pure: the job's actuals and the CHARGE rates in, invoice lines out. The
 * panel shows the breakdown, the button inserts these lines, and they are
 * ordinary lines from then on — editable, deletable, nothing sent.
 *
 * WHAT IS PULLED
 *   - Labor: one line per day, man-hours at the regular labor charge rate,
 *     from the labor rollup (field forms where a day has one, the time clock
 *     otherwise). Only APPROVED hours by default; the rest is listed as
 *     excluded, and can be included only as a line that says it is not yet
 *     approved. Never silently billed.
 *   - Equipment: one line per type, units × days on site from the scanned
 *     placements, counted the way the running cost counts them (inclusive
 *     calendar days, equipmentDaysOnSite).
 *   - Untagged classes (injector, ozone, hydroxyl — no asset tags, so no
 *     placements): unit-days from APPROVED field tickets.
 *
 * PRICED AT CHARGE RATES — the estimate catalog and price lists the Quick
 * Estimate uses (customer, then office, then state list, then catalog, then
 * the calculator's own rates), never the cost rates. A type with no charge
 * rate goes in at $0 with the line saying so, rather than at a guess.
 */

import type { LabourDay } from "@/lib/job-labour-rollup";
import type { EquipmentKey } from "@/lib/job-calculator";
import { equipmentDaysOnSite, pluralType, EQUIPMENT_TYPE_LABEL } from "@/lib/equipment";
import { roundMoney, sumMoney } from "@/lib/money";

/** Register type → the calculator's charge key. Absent = no charge rate. */
export const REGISTER_TO_CHARGE_KEY: Record<string, EquipmentKey> = {
  air_mover: "air_mover",
  dehumidifier: "dehumidifier",
  air_scrubber: "scrubber_xl",
  hepa: "scrubber_xxl",
  generator: "generator",
};

/** Field-ticket classes that are never asset-tagged, and their charge keys. */
export const UNTAGGED_TICKET_CLASSES: Record<string, { label: string; key: EquipmentKey }> = {
  injector: { label: "Injector", key: "injector" },
  ozone: { label: "Ozone", key: "ozone" },
  hydroxyl: { label: "Hydroxyl", key: "hydroxyl" },
};

export type PullRates = {
  regularLabor: number;
  equipment: Partial<Record<EquipmentKey, number>>;
};

export type PullPlacement = {
  equipment_type: string | null;
  placed_at: string;
  retrieved_at: string | null;
};

export type PullTicket = {
  work_date: string;
  approved: boolean;
  /** equip_<class> counts for the untagged classes. */
  counts: Record<string, number>;
};

export type PullLine = {
  /** `supply` is the ledger button's (invoice-ledger-pull.ts); Pull from job never makes one. */
  kind: "labor" | "equipment" | "supply";
  name: string;
  description: string;
  uom: "HR" | "DAY" | "EA";
  quantity: number;
  unit_price: number;
  /** Included although not approved — the description says so too. */
  unapproved?: boolean;
  /** No charge rate on file: in at $0, to be priced by hand. */
  unpriced?: boolean;
  /** Taxable on the invoice; absent = taxable, as a hand-added line is. */
  taxable?: boolean;
  /** The catalog item it was priced as, kept on the invoice line. */
  catalog_item_id?: string;
  code?: string;
};

export type PullPlan = {
  lines: PullLine[];
  /** Labor left out because nobody has approved it yet. */
  excluded: { date: string; hours: number }[];
  totals: { laborHours: number; equipmentUnits: number; amount: number };
};

const round2 = roundMoney;
const hours1 = (minutes: number) => Math.round((minutes / 60) * 10) / 10;

function dayLabel(date: string): string {
  return new Date(`${date}T12:00:00`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

export function planInvoicePull(input: {
  labourDays: readonly LabourDay[];
  placements: readonly PullPlacement[];
  tickets: readonly PullTicket[];
  rates: PullRates;
  includeUnapproved: boolean;
  now?: Date;
}): PullPlan {
  const lines: PullLine[] = [];
  const excluded: { date: string; hours: number }[] = [];

  // Labor, oldest day first, one line per day.
  for (const d of [...input.labourDays].sort((a, b) => a.date.localeCompare(b.date))) {
    const approvedH = hours1(d.approvedMinutes);
    const pendingH = hours1(Math.max(0, d.minutes - d.approvedMinutes));
    const crew = Math.max(1, d.crewSize);
    const push = (h: number, unapproved: boolean) => {
      if (h <= 0) return;
      const each = Math.round((h / crew) * 10) / 10;
      lines.push({
        kind: "labor",
        name: "Labor",
        description: `${dayLabel(d.date)} — ${crew} crew × ${each} h${unapproved ? " (not yet approved)" : ""}`,
        uom: "HR",
        quantity: h,
        unit_price: input.rates.regularLabor,
        ...(unapproved ? { unapproved: true } : {}),
      });
    };
    push(approvedH, false);
    if (pendingH > 0) {
      if (input.includeUnapproved) push(pendingH, true);
      else excluded.push({ date: d.date, hours: pendingH });
    }
  }

  // Tagged equipment: units × days on site, by type.
  const byType = new Map<string, { units: number; days: number }>();
  for (const p of input.placements) {
    const t = p.equipment_type || "other";
    const days = equipmentDaysOnSite(p.placed_at, p.retrieved_at, input.now) ?? 0;
    const agg = byType.get(t) ?? { units: 0, days: 0 };
    agg.units += 1;
    agg.days += days;
    byType.set(t, agg);
  }
  for (const [type, { units, days }] of [...byType.entries()].sort(
    (a, b) => b[1].days - a[1].days,
  )) {
    const key = REGISTER_TO_CHARGE_KEY[type];
    const price = key ? input.rates.equipment[key] : undefined;
    const label = EQUIPMENT_TYPE_LABEL[type] ?? type;
    lines.push({
      kind: "equipment",
      name: label,
      description: `${units} ${pluralType(label, units).toLowerCase()} — ${days} unit-day${days === 1 ? "" : "s"} on site${price ? "" : " (no charge rate on file — enter a price)"}`,
      uom: "DAY",
      quantity: days,
      unit_price: price ?? 0,
      ...(price ? {} : { unpriced: true }),
    });
  }

  // Untagged classes: unit-days from approved tickets only.
  for (const [cls, def] of Object.entries(UNTAGGED_TICKET_CLASSES)) {
    const days = input.tickets
      .filter((t) => t.approved)
      .reduce((s, t) => s + Math.max(0, Number(t.counts[cls]) || 0), 0);
    if (days <= 0) continue;
    const price = input.rates.equipment[def.key];
    lines.push({
      kind: "equipment",
      name: def.label,
      description: `${days} unit-day${days === 1 ? "" : "s"} from approved field forms${price ? "" : " (no charge rate on file — enter a price)"}`,
      uom: "DAY",
      quantity: days,
      unit_price: price ?? 0,
      ...(price ? {} : { unpriced: true }),
    });
  }

  return {
    lines,
    excluded,
    totals: {
      laborHours: round2(
        lines.filter((l) => l.kind === "labor").reduce((s, l) => s + l.quantity, 0),
      ),
      equipmentUnits: input.placements.length,
      // The total is the sum of the printed lines, each to the cent (P5).
      amount: sumMoney(lines.map((l) => roundMoney(l.quantity * l.unit_price))),
    },
  };
}
