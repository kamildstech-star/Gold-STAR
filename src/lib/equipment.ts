import type { Database } from "@/integrations/supabase/types";
import { TONE } from "@/lib/tone";

export type EquipmentType = Database["public"]["Enums"]["equipment_type"];
export type EquipmentStatus = Database["public"]["Enums"]["equipment_status"];
export type EquipmentCondition = Database["public"]["Enums"]["equipment_condition"];

export const EQUIPMENT_TYPES: string[] = [
  "air_mover",
  "dehumidifier",
  "air_scrubber",
  "hepa",
  "heater",
  "generator",
  "moisture_meter",
  "other",
];

export const EQUIPMENT_TYPE_LABEL: Record<string, string> = {
  air_mover: "Air mover",
  dehumidifier: "Dehumidifier",
  air_scrubber: "Air scrubber",
  hepa: "HEPA",
  heater: "Heater",
  generator: "Generator",
  moisture_meter: "Moisture meter",
  other: "Other",
};

export const EQUIPMENT_STATUSES: EquipmentStatus[] = [
  "available",
  "on_job",
  "in_transit",
  "maintenance",
  "lost",
  "retired",
];

export const EQUIPMENT_STATUS_LABEL: Record<EquipmentStatus, string> = {
  available: "Available",
  on_job: "On job",
  in_transit: "In transit",
  maintenance: "Maintenance",
  lost: "Lost",
  retired: "Retired",
};

export const EQUIPMENT_STATUS_TONE: Record<EquipmentStatus, string> = {
  available: TONE.success,
  on_job: TONE.brand,
  in_transit: TONE.info,
  maintenance: TONE.warning,
  lost: TONE.danger,
  retired: TONE.neutral,
};

export const EQUIPMENT_CONDITIONS: EquipmentCondition[] = [
  "good",
  "needs_cleaning",
  "damaged",
  "needs_service",
  "missing",
];

export const EQUIPMENT_CONDITION_LABEL: Record<EquipmentCondition, string> = {
  good: "Good",
  needs_cleaning: "Needs cleaning",
  damaged: "Damaged",
  needs_service: "Needs service",
  missing: "Missing — never came back",
};

/** Money in cents → "$10,000". Equipment value is always shown as money. */
export function fmtCents(cents: number | null | undefined): string {
  if (cents == null) return "—";
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

export function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 86400000));
}

export type OnSiteCount = { type: string; label: string; count: number };

/**
 * What is on site right now, by type — "air movers 15, dehumidifier 6".
 * Open placements only, so a retrieval takes a unit off the count. Biggest
 * first; an unknown type is shown by its key rather than dropped.
 */
export function countOnSiteByType(
  open: readonly { equipment_type: string | null | undefined }[],
): OnSiteCount[] {
  const by = new Map<string, number>();
  for (const r of open) {
    const t = r.equipment_type || "other";
    by.set(t, (by.get(t) ?? 0) + 1);
  }
  return [...by.entries()]
    .map(([type, count]) => ({
      type,
      count,
      label: pluralType(EQUIPMENT_TYPE_LABEL[type] ?? type, count),
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/** "Air mover" → "Air movers" for more than one; initialisms stay as they are. */
export function pluralType(label: string, count: number): string {
  if (count === 1 || /^[A-Z]{2,}$/.test(label) || label === "Other" || /s$/.test(label))
    return label;
  return `${label}s`;
}

/**
 * Every Gold Star office is on Eastern time; the calendar a crew and a bill
 * both count in. `public.gsr_local_date()` is the same rule in SQL.
 */
export const OFFICE_TIME_ZONE = "America/New_York";

/** An instant's calendar date in the office zone, as YYYY-MM-DD. */
export function officeDate(at: Date | string): string {
  const d = typeof at === "string" ? new Date(at) : at;
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: OFFICE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/**
 * Days a unit has been (or was) on site: INCLUSIVE CALENDAR DAYS, the drop-off
 * day being day 1 — the rule the running cost has always billed by
 * (`GREATEST(1, retrieved_or_today - placed + 1)` in job_running_cost).
 *
 * David, 24 Sep: "it's out zero days. I dropped it off [yesterday]... it's
 * not reading how long it's there for." The screen used `daysSince`, whole
 * 24-hour periods rounded down, so yesterday afternoon's drop read 0 while the
 * job was already charged 2 days. Now the screen and the bill say one number.
 */
export function equipmentDaysOnSite(
  placedAt: string | null | undefined,
  retrievedAt?: string | null,
  now: Date = new Date(),
): number | null {
  if (!placedAt || !Number.isFinite(new Date(placedAt).getTime())) return null;
  const end = retrievedAt && Number.isFinite(new Date(retrievedAt).getTime()) ? retrievedAt : now;
  const [a, b] = [officeDate(placedAt), officeDate(end)].map((s) => Date.parse(`${s}T00:00:00Z`));
  return Math.max(1, Math.round((b! - a!) / 86_400_000) + 1);
}

/** Great-circle distance in metres. Used to detect a unit leaving a job site. */
export function distanceMeters(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** A tracker ping further than this from the job site counts as "left site". */
export const OFF_SITE_METERS = 250;

export type AlertKind = "off_site" | "overdue_retrieval" | "job_closed_with_equipment";

export const ALERT_LABEL: Record<AlertKind, string> = {
  off_site: "Left the job site",
  overdue_retrieval: "Past expected retrieval",
  job_closed_with_equipment: "Job closed with equipment still out",
};

export type PlacementRow = {
  id: string;
  equipment_id: string;
  job_id: string;
  placed_at: string;
  expected_retrieval_date: string | null;
  retrieved_at: string | null;
  equipment: {
    id: string;
    asset_tag: string;
    equipment_type: EquipmentType;
    purchase_cost_cents: number | null;
    location_id: string;
    external_tracker_id: string | null;
  } | null;
  job: {
    id: string;
    job_number: string;
    address: string;
    status: string;
    lat: number | null;
    lon: number | null;
  } | null;
};

export type EquipmentAlert = {
  kind: AlertKind;
  placement: PlacementRow;
  detail: string;
};

const CLOSED_JOB_STATUSES = new Set(["complete", "invoiced", "paid", "cancelled"]);

export function isClosedJobStatus(status: string | null | undefined): boolean {
  return !!status && CLOSED_JOB_STATUSES.has(status);
}

/**
 * Derive the three alerts the client actually cares about from open placements
 * plus the most recent tracker ping per unit. Pure — no data access here.
 */
export function deriveAlerts(
  placements: PlacementRow[],
  lastPingByEquipment: Map<string, { lat: number | null; lon: number | null; occurred_at: string }>,
): EquipmentAlert[] {
  const out: EquipmentAlert[] = [];
  const today = new Date().toISOString().slice(0, 10);

  for (const p of placements) {
    if (p.retrieved_at) continue;

    if (isClosedJobStatus(p.job?.status)) {
      out.push({
        kind: "job_closed_with_equipment",
        placement: p,
        detail: `${p.job?.job_number ?? "Job"} is ${p.job?.status} but ${p.equipment?.asset_tag ?? "this unit"} was never retrieved.`,
      });
    }

    if (p.expected_retrieval_date && p.expected_retrieval_date < today) {
      const late = daysSince(p.expected_retrieval_date);
      out.push({
        kind: "overdue_retrieval",
        placement: p,
        detail: `Expected back ${p.expected_retrieval_date}${late ? ` — ${late} days ago` : ""}. Unbilled rental.`,
      });
    }

    const ping = lastPingByEquipment.get(p.equipment_id);
    if (ping?.lat != null && ping?.lon != null && p.job?.lat != null && p.job?.lon != null) {
      const d = distanceMeters(p.job.lat, p.job.lon, ping.lat, ping.lon);
      if (d > OFF_SITE_METERS) {
        out.push({
          kind: "off_site",
          placement: p,
          detail: `Last tracker position is ${Math.round(d).toLocaleString("en-US")} m from ${p.job.address}, with no retrieval logged.`,
        });
      }
    }
  }
  return out;
}
