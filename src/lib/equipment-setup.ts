/**
 * "Set up equipment – Scan" — the deployment half of David's scope of work.
 *
 * His 2 Sep email puts scanning inside the tech's own steps, not on a separate
 * screen: a crew sets up, scans, and moves on. Until now a scan on the work
 * ticket recorded TAGS on the ticket and nothing else, so somebody still had
 * to open the Equipment tab afterwards and log the same six machines out a
 * second time. That second pass is the one that does not happen at 7pm in a
 * flooded basement, which is why the placement log and the ticket disagreed.
 *
 * So one scan now does both: the tags land on the ticket AND the units are
 * placed on the job. This module is the arithmetic in between — which scanned
 * units still need placing, what each one counts as on the paper form, and the
 * counts that result. Pure, so the honesty of it is testable without a camera.
 */
import { EQUIPMENT_LEFT_OPTIONS, ticketKeyForAssetType } from "@/lib/field-work-ticket";

/** A scanned unit, reduced to what the setup arithmetic needs. */
export type SetupUnit = {
  id: string;
  asset_tag: string;
  equipment_type: string;
};

export type TicketTag = { tag: string; key: string | null };

export type SetupPlan = {
  /** Units to log out to the job. */
  toPlace: SetupUnit[];
  /**
   * Scanned units the log already has open on this job. Not an error and not
   * a duplicate scan — a crew re-scanning the room they set up this morning is
   * confirming, and confirming must not log the machine out twice.
   */
  alreadyOnJob: SetupUnit[];
  /** Tags to add to the ticket, categorized by the paper form's line. */
  newTags: TicketTag[];
  /**
   * Units whose type Gold Star does not asset-tag onto a ticket line (an
   * injector, an ozone machine). They are still placed; they simply have no
   * count to drive, and the crew keeps typing that number.
   */
  uncategorized: SetupUnit[];
};

/**
 * Split a scan session into what has to happen.
 *
 * `alreadyOut` is the placement log's open units keyed by equipment id, and
 * `ticketTags` is what this ticket already claims — the two are different
 * questions and a unit can easily be in one and not the other (placed this
 * morning by the crew chief, scanned again onto tonight's ticket).
 */
export function planSetup(input: {
  scanned: SetupUnit[];
  alreadyOut: ReadonlySet<string>;
  ticketTags: TicketTag[];
}): SetupPlan {
  const onTicket = new Set(input.ticketTags.map((t) => t.tag.toUpperCase()));
  const plan: SetupPlan = { toPlace: [], alreadyOnJob: [], newTags: [], uncategorized: [] };

  for (const unit of input.scanned) {
    if (input.alreadyOut.has(unit.id)) plan.alreadyOnJob.push(unit);
    else plan.toPlace.push(unit);

    const key = ticketKeyForAssetType(unit.equipment_type);
    if (key == null) plan.uncategorized.push(unit);
    if (!onTicket.has(unit.asset_tag.toUpperCase())) {
      plan.newTags.push({ tag: unit.asset_tag, key });
      onTicket.add(unit.asset_tag.toUpperCase());
    }
  }
  return plan;
}

/**
 * Tags → the ticket's per-line counts.
 *
 * Only lines that were scanned are touched. A crew that scans four air movers
 * and types "2 injectors" by hand keeps their 2: the scan is evidence about
 * air movers and says nothing about injectors, and overwriting an untouched
 * line with a zero would quietly delete a number somebody entered.
 */
export function countsFromTags(tags: TicketTag[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const o of EQUIPMENT_LEFT_OPTIONS) {
    const n = tags.filter((t) => t.key === o.key).length;
    if (n > 0) out[o.key] = String(n);
  }
  return out;
}

/**
 * What the crew is told a scan did, in one line.
 *
 * Both halves always, even when one is zero: "6 units placed" alone leaves the
 * crew wondering about the seventh they scanned, and a session that placed
 * nothing because everything was already out has to say so or it reads as a
 * failure.
 */
export function describeSetup(plan: SetupPlan): string {
  const parts: string[] = [];
  if (plan.toPlace.length > 0) {
    parts.push(`${plan.toPlace.length} unit${plan.toPlace.length === 1 ? "" : "s"} placed`);
  }
  if (plan.alreadyOnJob.length > 0) {
    parts.push(`${plan.alreadyOnJob.length} already on this job`);
  }
  if (parts.length === 0) return "Nothing scanned.";
  return parts.join(" · ");
}
