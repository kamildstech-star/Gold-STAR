/**
 * "Scan all equipment" — the pickup half of David's scope of work.
 *
 * His 2 Sep email lists it as its own step at the end of a job: "Scan all
 * equipment". The point is not the scanning, it is the reconciliation. A crew
 * loads the truck, drives away, and the only thing that catches the air mover
 * still running in a crawl space is somebody comparing what went back on the
 * truck against what was logged out. A scanner without that comparison is just
 * a faster way to record the units you already remembered.
 *
 * So this module is the checklist, not the camera: everything open on the job,
 * what has been checked off, and — the part that matters — what has not, said
 * plainly while the crew is still in the driveway.
 *
 * Pure. Rows in, rows out.
 */
import { EQUIPMENT_TYPE_LABEL } from "@/lib/equipment";

/**
 * The three words a tech uses about a machine coming off a job.
 *
 * David asked for "good / needs cleaning / repair". The register's own
 * `equipment_condition` enum had no word for a unit that is fine but filthy,
 * and pushing that into `needs_service` would put a wipe-down and a failed
 * compressor in the same bucket — which is how a shop ends up with a service
 * queue nobody trusts. `needs_cleaning` is added to the enum by the migration;
 * until it is applied, `storedCondition` below keeps the write legal and the
 * UI says the finer word is not stored yet.
 */
export const PICKUP_CONDITIONS: {
  key: PickupCondition;
  en: string;
  es: string;
  /** The enum value written when `needs_cleaning` is not in the database yet. */
  fallback: string;
}[] = [
  { key: "good", en: "Good", es: "Bueno", fallback: "good" },
  {
    key: "needs_cleaning",
    en: "Needs cleaning",
    es: "Necesita limpieza",
    fallback: "needs_service",
  },
  { key: "damaged", en: "Needs repair", es: "Necesita reparación", fallback: "damaged" },
];

export type PickupCondition = "good" | "needs_cleaning" | "damaged";

export const PICKUP_CONDITION_LABEL: Record<PickupCondition, string> = Object.fromEntries(
  PICKUP_CONDITIONS.map((c) => [c.key, c.en]),
) as Record<PickupCondition, string>;

/**
 * What actually goes in `return_condition`.
 *
 * `supported` is the answer to "does this database know the word yet", probed
 * once per session. A pickup logged against an older database is still a
 * correct pickup — it just records the nearest word the enum has, and the
 * session says so rather than failing the write in a basement.
 */
export function storedCondition(condition: PickupCondition, supported: boolean): string {
  if (condition !== "needs_cleaning" || supported) return condition;
  return PICKUP_CONDITIONS.find((c) => c.key === condition)!.fallback;
}

/** One open placement, as much of it as the checklist needs. */
export type PickupUnit = {
  placementId: string;
  equipmentId: string;
  assetTag: string;
  equipmentType: string;
  roomLabel: string | null;
  placedAt: string;
  expectedRetrievalDate: string | null;
};

export type PickupRow = PickupUnit & {
  scanned: boolean;
  condition: PickupCondition;
  typeLabel: string;
};

/**
 * The checklist: every unit logged out to this job, scanned ones marked.
 *
 * Order is deliberate — still missing first. A crew looking at this screen is
 * looking for what is not on the truck, and making them scroll past twelve
 * ticks to find it is how the thirteenth machine gets left in a basement.
 */
export function pickupChecklist(
  units: PickupUnit[],
  scanned: ReadonlyMap<string, PickupCondition>,
): PickupRow[] {
  const rows = units.map((u) => ({
    ...u,
    scanned: scanned.has(u.equipmentId),
    condition: scanned.get(u.equipmentId) ?? ("good" as PickupCondition),
    typeLabel: EQUIPMENT_TYPE_LABEL[u.equipmentType] ?? u.equipmentType,
  }));
  return rows.sort((a, b) => {
    if (a.scanned !== b.scanned) return a.scanned ? 1 : -1;
    // Then by type, so six air movers read as a block and a gap in them shows.
    const t = a.typeLabel.localeCompare(b.typeLabel);
    return t !== 0 ? t : a.assetTag.localeCompare(b.assetTag);
  });
}

export type PickupSummary = {
  total: number;
  scanned: number;
  missing: PickupRow[];
  /** True only when every open unit has been checked off. */
  complete: boolean;
  /** Nothing was logged out, so there is nothing this flow can verify. */
  empty: boolean;
  /** One line, ready to show. Never cheerful about an incomplete pickup. */
  headline: string;
};

export function pickupSummary(rows: PickupRow[]): PickupSummary {
  const scanned = rows.filter((r) => r.scanned).length;
  const missing = rows.filter((r) => !r.scanned);
  const total = rows.length;
  if (total === 0) {
    return {
      total: 0,
      scanned: 0,
      missing: [],
      complete: false,
      empty: true,
      headline: "Nothing is logged out to this job, so there is nothing to scan back in.",
    };
  }
  if (missing.length === 0) {
    return {
      total,
      scanned,
      missing,
      complete: true,
      empty: false,
      headline: `All ${total} unit${total === 1 ? "" : "s"} accounted for.`,
    };
  }
  return {
    total,
    scanned,
    missing,
    complete: false,
    empty: false,
    headline: `${scanned} of ${total} scanned — ${missing.length} still on the job.`,
  };
}

/**
 * The sentence shown before a crew is allowed to close an incomplete session.
 *
 * Named, never counted. "1 unit not scanned" sends a crew back to the house to
 * look for something; "GSR-AM00034-NJ (Air mover, Basement) was not scanned"
 * sends them to the right room. A machine left behind is exactly what this
 * flow exists to catch, so the warning spends the words.
 */
export function unscannedWarning(summary: PickupSummary): string | null {
  if (summary.complete || summary.empty) return null;
  const named = summary.missing
    .slice(0, 8)
    .map((m) => `${m.assetTag} (${m.typeLabel}${m.roomLabel ? `, ${m.roomLabel}` : ""})`)
    .join(", ");
  const more = summary.missing.length > 8 ? ` and ${summary.missing.length - 8} more` : "";
  return `${summary.missing.length} unit${
    summary.missing.length === 1 ? "" : "s"
  } still logged out to this job: ${named}${more}. Anything you do not scan stays flagged as out on the job.`;
}
