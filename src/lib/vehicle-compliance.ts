/**
 * Is each van legal to drive, and is it due in the shop — the Fleet page's
 * tiles, its filter, the expired banner and the next-service arithmetic.
 *
 * Mark, on Fleet: "add more boxes for insurance, registration, etc, with
 * alerts for each vehicle to make sure nothing lapses", and "add fields in
 * here the maintance".
 *
 * ONE VOCABULARY. Vehicle paperwork is banded with the same words and colours
 * as vendor compliance (`COMPLIANCE_STATUS_LABEL` / `_TONE` in compliance.ts):
 * Satisfied, Expiring soon, Expired, Missing. A lapsing registration and a
 * lapsing contractor certificate are one idea, and a manager who has learnt
 * what amber means on /compliance should not learn it again on /fleet. The
 * warning window is the item's own `warn_days`, 30 by default — the same 30
 * days as a requirement's `renewal_lead_days` and the client-health Watch band
 * (`COMPLIANCE_WATCH_EXPIRY_DAYS`).
 *
 * ONE RULE. The thresholds are not restated here: every status comes from
 * `dueStatus` in vehicle-maintenance.ts, which mirrors run_vehicle_due_alerts()
 * stage for stage, so the tile, the badge and the bell cannot disagree about
 * whether a van has lapsed.
 *
 * Pure. Every function takes `now` and none defaults it.
 */
import type { ComplianceStatus } from "@/lib/compliance";
import {
  DUE_KINDS,
  dueStatus,
  isPaperwork,
  kindLabel,
  type DueItem,
  type DueKind,
  type DueState,
} from "@/lib/vehicle-maintenance";

const SEVERITY: Record<DueState, number> = { ok: 0, due_soon: 1, overdue: 2 };

/** The statuses a vehicle document can be in — a subset of vendor compliance's. */
export type PaperworkStatus = Extract<
  ComplianceStatus,
  "satisfied" | "expiring_soon" | "expired" | "missing"
>;

/**
 * One document's status. `null` for optional paperwork that is simply not on
 * file (a van with no DOT inspection does not need one); `missing` for
 * required paperwork with no row.
 */
export function paperworkStatus(
  kind: DueKind,
  item: Pick<DueItem, "due_on" | "due_odometer" | "warn_days" | "warn_miles"> | null,
  now: Date,
): PaperworkStatus | null {
  if (!item) return DUE_KINDS.find((k) => k.value === kind)?.optional ? null : "missing";
  const s = dueStatus({ ...item, kind }, { now });
  return s.state === "overdue" ? "expired" : s.state === "due_soon" ? "expiring_soon" : "satisfied";
}

/* ------------------------------------------------------------------ tiles */

/**
 * The boxes. Inspection is ONE tile for both the state and the DOT
 * inspection: to a manager scanning the strip they are the same question
 * ("is anything due at the inspection station?"), and the vehicle page says
 * which.
 */
export const FLEET_DUE_TILES = [
  { key: "insurance", label: "Insurance expiring", kinds: ["insurance"] },
  { key: "registration", label: "Registration expiring", kinds: ["registration"] },
  { key: "inspection", label: "Inspection due", kinds: ["inspection", "dot_inspection"] },
  { key: "maintenance", label: "Maintenance due", kinds: ["service"] },
] as const satisfies readonly { key: string; label: string; kinds: readonly DueKind[] }[];

export type FleetDueTileKey = (typeof FLEET_DUE_TILES)[number]["key"];

export const isFleetDueTileKey = (v: unknown): v is FleetDueTileKey =>
  FLEET_DUE_TILES.some((t) => t.key === v);

export type FleetDueTile = {
  key: FleetDueTileKey;
  label: string;
  /** Vans inside the warning window OR past it — what the tile counts and filters to. */
  flagged: string[];
  /** Of those, the ones already expired / overdue. */
  expired: string[];
  /** Vans with no row at all for a required kind. Paperwork only. */
  missing: string[];
};

/**
 * Counts per tile, for the vans on screen. A van is counted once per tile even
 * when both its inspections are due.
 */
export function fleetDueTiles(input: {
  vehicleIds: readonly string[];
  itemsByVehicle: ReadonlyMap<string, readonly DueItem[]>;
  odometers: ReadonlyMap<string, number>;
  now: Date;
}): FleetDueTile[] {
  const { vehicleIds, itemsByVehicle, odometers, now } = input;
  return FLEET_DUE_TILES.map((tile) => {
    const flagged: string[] = [];
    const expired: string[] = [];
    const missing: string[] = [];
    for (const id of vehicleIds) {
      const items = itemsByVehicle.get(id) ?? [];
      let worst: DueState | null = null;
      let gap = false;
      for (const kind of tile.kinds) {
        const item = items.find((i) => i.kind === kind) ?? null;
        if (!item) {
          if (isPaperwork(kind) && !DUE_KINDS.find((k) => k.value === kind)?.optional) gap = true;
          continue;
        }
        const s = dueStatus(item, { now, odometer: odometers.get(id) ?? null }).state;
        if (worst == null || SEVERITY[s] > SEVERITY[worst]) worst = s;
      }
      if (worst === "overdue" || worst === "due_soon") flagged.push(id);
      if (worst === "overdue") expired.push(id);
      // "Not on file" only when there is nothing at all for the tile: a van
      // with a DOT inspection on file but no state one still counts.
      if (gap && worst == null) missing.push(id);
    }
    return { key: tile.key, label: tile.label, flagged, expired, missing };
  });
}

/** The quiet line under a tile's number: "2 expired · 5 not on file". */
export function tileNote(tile: FleetDueTile): string | undefined {
  const parts: string[] = [];
  const word = tile.key === "maintenance" ? "overdue" : "expired";
  if (tile.expired.length) parts.push(`${tile.expired.length} ${word}`);
  if (tile.missing.length) parts.push(`${tile.missing.length} not on file`);
  return parts.length ? parts.join(" · ") : undefined;
}

/** Danger once anything has lapsed, warning while it is only coming up. */
export function tileTone(tile: FleetDueTile): "danger" | "warning" | "default" {
  return tile.expired.length ? "danger" : tile.flagged.length ? "warning" : "default";
}

/** The list, narrowed to a tile's vans. No tile → every van. */
export function filterByTile<T extends { id: string }>(
  vehicles: readonly T[],
  tiles: readonly FleetDueTile[],
  key: FleetDueTileKey | null | undefined,
): T[] {
  if (!key) return [...vehicles];
  const tile = tiles.find((t) => t.key === key);
  if (!tile) return [...vehicles];
  const keep = new Set(tile.flagged);
  return vehicles.filter((v) => keep.has(v.id));
}

/* -------------------------------------------------------- expired banner */

export type LapsedPaperwork = {
  vehicleId: string;
  kind: DueKind;
  label: string;
  phrase: string;
  days: number;
  reference: string | null;
  provider: string | null;
};

/**
 * Every expired document across the fleet, longest-lapsed first. This is the
 * banner that cannot be scrolled past — the equipment page's "N equipment
 * alerts" card, for paperwork. Service is not here: a late oil change is a
 * tile, not an emergency.
 */
export function lapsedPaperwork(
  itemsByVehicle: ReadonlyMap<string, readonly DueItem[]>,
  now: Date,
): LapsedPaperwork[] {
  const out: LapsedPaperwork[] = [];
  for (const [vehicleId, items] of itemsByVehicle) {
    for (const item of items) {
      if (!isPaperwork(item.kind)) continue;
      const s = dueStatus(item, { now });
      if (s.state !== "overdue" || s.days == null) continue;
      out.push({
        vehicleId,
        kind: item.kind as DueKind,
        label: kindLabel(item.kind),
        phrase: s.phrase,
        days: s.days,
        reference: item.reference,
        provider: item.provider,
      });
    }
  }
  return out.sort((a, b) => a.days - b.days);
}

/* --------------------------------------------------------- alert stages */

export type AlertStage = "window" | "week" | "overdue";

/**
 * Which alert run_vehicle_due_alerts() sends for an item today, or null for
 * none. Mirrored from the SQL so the lead times are pinned by a test: once
 * on entering the warning window (30 days by default), again inside the last
 * 7, then weekly once it has lapsed.
 */
export function alertStage(
  item: Pick<DueItem, "warn_days" | "warn_miles">,
  daysLeft: number | null,
  milesLeft: number | null,
): AlertStage | null {
  if ((daysLeft != null && daysLeft < 0) || (milesLeft != null && milesLeft < 0)) return "overdue";
  if (daysLeft != null && daysLeft <= Math.min(7, item.warn_days)) return "week";
  if (
    (daysLeft != null && daysLeft <= item.warn_days) ||
    (milesLeft != null && milesLeft <= item.warn_miles)
  ) {
    return "window";
  }
  return null;
}

/* ---------------------------------------------------------- next service */

/**
 * The usual interval after each kind of work, offered as a one-tap default
 * when the work is logged. A suggestion, never a rule: the shop's sticker
 * wins, and the fields stay editable.
 */
export const SERVICE_INTERVALS: Partial<Record<string, { months: number; miles: number }>> = {
  oil_change: { months: 6, miles: 5_000 },
  service: { months: 6, miles: 5_000 },
};

const iso = (y: number, m0: number, d: number) =>
  `${y}-${String(m0 + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/**
 * Add whole months to a YYYY-MM-DD date without drifting: Aug 31 + 6 months
 * is Feb 28 (or 29), not Mar 3. Calendar arithmetic on the string, so no
 * timezone can move the day.
 */
export function addMonths(date: string, months: number): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1 + months;
  const d = Number(m[3]);
  const ty = y + Math.floor(mo / 12);
  const tm = ((mo % 12) + 12) % 12;
  const last = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  return iso(ty, tm, Math.min(d, last));
}

/**
 * Next service due from the work just logged: date + months, odometer + miles.
 * Either half is null when its input is missing — a record with no odometer
 * reading can still set a date.
 */
export function nextServiceDue(input: {
  performedOn: string;
  odometer: number | null;
  months: number | null;
  miles: number | null;
}): { due_on: string | null; due_odometer: number | null } {
  return {
    due_on: input.months ? addMonths(input.performedOn, input.months) : null,
    due_odometer:
      input.odometer != null && input.miles ? Math.round(input.odometer + input.miles) : null,
  };
}
