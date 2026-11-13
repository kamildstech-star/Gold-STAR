/**
 * Turning a daily field form into something a report can say out loud.
 *
 * From David's 16 Sep walkthrough of the generated report:
 *
 *   · equipment written on the form — "full left on site" — never appeared,
 *     because the snapshot only ever read `equipment_placements`;
 *   · an unticked "Job completed" came out as a negative: the form "indicates
 *     work is not completed", which reads as a failure when all it means is
 *     that the crew has not finished and is coming back.
 *
 * Both are fixed by saying the thing properly in the snapshot rather than by
 * asking the model to be tactful. The snapshot is the only thing the model is
 * permitted to state, so a phrase that is not in here cannot appear in a
 * report, and a phrase that is in here needs no interpretation.
 *
 * Pure, so the wording can be tested without a database or a model.
 */

/** The ticket columns this module reads. A superset arrives from the snapshot. */
export type FieldFormEquipmentRow = {
  work_date?: string | null;
  equip_dehumidifier?: number | null;
  equip_air_mover?: number | null;
  equip_scrubber?: number | null;
  equip_injector?: number | null;
  equip_ozone?: number | null;
  equip_hydroxyl?: number | null;
  equip_generator?: number | null;
};

/** Column to the words a reader of the report should see. */
const EQUIPMENT_LABEL: { column: keyof FieldFormEquipmentRow; one: string; many: string }[] = [
  { column: "equip_dehumidifier", one: "dehumidifier", many: "dehumidifiers" },
  { column: "equip_air_mover", one: "air mover", many: "air movers" },
  { column: "equip_scrubber", one: "air scrubber", many: "air scrubbers" },
  { column: "equip_injector", one: "injector", many: "injectors" },
  { column: "equip_ozone", one: "ozone machine", many: "ozone machines" },
  { column: "equip_hydroxyl", one: "hydroxyl generator", many: "hydroxyl generators" },
  { column: "equip_generator", one: "generator", many: "generators" },
];

export type EquipmentLeft = {
  /** The machine, in words. */
  item: string;
  count: number;
};

const count = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

/** What one form says was left on site. Empty when it recorded no machines. */
export function ticketEquipmentLeft(row: FieldFormEquipmentRow): EquipmentLeft[] {
  const out: EquipmentLeft[] = [];
  for (const def of EQUIPMENT_LABEL) {
    const n = count(row[def.column]);
    if (n > 0) out.push({ item: n === 1 ? def.one : def.many, count: n });
  }
  return out;
}

/** "1 dehumidifier and 3 air movers", or null when the form recorded none. */
export function equipmentLeftSentence(left: readonly EquipmentLeft[]): string | null {
  if (left.length === 0) return null;
  const parts = left.map((e) => `${e.count} ${e.item}`);
  if (parts.length === 1) return parts[0]!;
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

export type FieldFormEquipmentSummary = {
  /** Highest number of each machine any single form recorded. */
  peak: EquipmentLeft[];
  /** The same, as a sentence, for a report to quote directly. */
  peak_sentence: string | null;
  /** The most recent form that recorded any equipment at all. */
  latest: { work_date: string | null; items: EquipmentLeft[]; sentence: string | null } | null;
  /** How many forms recorded equipment. Zero means the forms say nothing. */
  forms_with_equipment: number;
};

/**
 * Equipment across every form on the job.
 *
 * `peak` is the most of each machine on site at once, not the sum: a
 * dehumidifier recorded on Monday and again on Tuesday is one dehumidifier
 * standing for two days, and adding them would report two machines that never
 * existed. That is the same trap the running-cost engine avoids by charging a
 * placement per day rather than per mention.
 */
export function fieldFormEquipment(
  rows: readonly FieldFormEquipmentRow[],
): FieldFormEquipmentSummary {
  const peakByItem = new Map<string, number>();
  let formsWithEquipment = 0;
  let latest: FieldFormEquipmentSummary["latest"] = null;

  for (const row of rows) {
    const items = ticketEquipmentLeft(row);
    if (items.length === 0) continue;
    formsWithEquipment += 1;
    for (const e of items) {
      peakByItem.set(e.item, Math.max(peakByItem.get(e.item) ?? 0, e.count));
    }
    // Rows arrive newest first, so the first one carrying equipment is latest.
    if (!latest) {
      latest = {
        work_date: row.work_date ?? null,
        items,
        sentence: equipmentLeftSentence(items),
      };
    }
  }

  const peak = [...peakByItem.entries()].map(([item, n]) => ({ item, count: n }));
  return {
    peak,
    peak_sentence: equipmentLeftSentence(peak),
    latest,
    forms_with_equipment: formsWithEquipment,
  };
}

/**
 * How a form's completion flags should read in a report.
 *
 * The rule David gave: an unticked "completed" is not a failure to report, it
 * is work still outstanding. So nothing here says "not completed", and nothing
 * says "false" — the three states are finished, still going, and a form that
 * simply did not answer.
 */
export function ticketStatusPhrase(
  jobCompleted: boolean | null | undefined,
  moreWorkNeeded: boolean | null | undefined,
): string {
  if (jobCompleted) {
    return moreWorkNeeded
      ? "Work on this visit is complete, and further work is still outstanding on the job."
      : "Work on this visit is complete.";
  }
  if (moreWorkNeeded) return "Additional work is still pending on the job.";
  // Neither box ticked. The visit happened; the crew simply did not close it
  // out, which is "still open", not "not completed".
  return "Work on this job is still in progress.";
}
