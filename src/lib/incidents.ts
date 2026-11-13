// Fire-chase incident helpers. Kept tiny and dependency-free so the chaser
// cockpit stays snappy on a phone.
import type { Database } from "@/integrations/supabase/types";

export type Incident = Database["public"]["Tables"]["incidents"]["Row"];
export type IncidentStatus = Database["public"]["Enums"]["incident_status"];
export type IncidentType = Database["public"]["Enums"]["incident_type"];
export type IncidentOutcome = Database["public"]["Enums"]["incident_outcome"];

export const INCIDENT_TYPES: string[] = ["fire", "water", "smoke", "storm", "other"];

export const INCIDENT_TYPE_LABEL: Record<string, string> = {
  fire: "Fire",
  water: "Water",
  smoke: "Smoke",
  storm: "Storm",
  other: "Other",
};

export const INCIDENT_STATUS_LABEL: Record<IncidentStatus, string> = {
  new: "New",
  dispatched: "Dispatched",
  accepted: "Accepted",
  on_scene: "On scene",
  closed: "Closed",
  discarded: "Discarded",
};

export const OUTCOME_LABEL: Record<IncidentOutcome, string> = {
  contract_signed: "Contract signed",
  homeowner_declined: "Homeowner declined",
  no_contact: "No contact made",
  competitor_present: "Another company signed",
  not_owner: "Not the owner",
  damage_too_minor: "Damage too minor",
  going_direct: "Going direct",
  wrong_address: "Wrong address",
  /** Retired — split into damage too minor / wrong address. Kept for old rows. */
  not_real_loss: "Not a real loss",
};

/** Which outcomes should close vs discard the record. */
export function outcomeTerminalStatus(o: IncidentOutcome): IncidentStatus {
  return o === "not_real_loss" || o === "wrong_address" ? "discarded" : "closed";
}

/* ------------------------------------------------------------------ */
/*  Dispatch codes — what a chaser actually reads on the card          */
/* ------------------------------------------------------------------ */

/**
 * Fire-service dispatch codes, spelled out. A chaser knows "10-75" cold, but
 * the plain words next to it are what tell a new chaser whether this is worth
 * the drive.
 */
const DISPATCH_CODE_LABEL: Record<string, string> = {
  "10-75": "10-75 · all hands",
  "all hands": "All hands",
  "10-76": "10-76 · high-rise fire",
  "10-77": "10-77 · high-rise fire",
  "2nd alarm": "2nd alarm",
  "3rd alarm": "3rd alarm",
  "4th alarm": "4th alarm",
  "5th alarm": "5th alarm",
  "10-45": "10-45 · casualty",
};

/** Normalises whatever the feed sent into a readable dispatch line. */
export function dispatchCodeLabel(code: string | null | undefined): string | null {
  if (!code) return null;
  const key = code.trim().toLowerCase();
  return DISPATCH_CODE_LABEL[key] ?? code.trim();
}

/** The one-line "what kind of fire is this" summary for an alert card. */
export function fireTypeLine(i: {
  alarm_level: string | null;
  call_sign: string | null;
  incident_type: string;
}): string {
  const parts = [dispatchCodeLabel(i.alarm_level), dispatchCodeLabel(i.call_sign)].filter(
    (v, idx, arr) => v && arr.indexOf(v) === idx,
  ) as string[];
  return parts.length > 0
    ? parts.join(" · ")
    : (INCIDENT_TYPE_LABEL[i.incident_type] ?? i.incident_type);
}

/** Building type and units dispatched, when the feed gave them. */
export function dispatchDetailLine(i: {
  building_type: string | null;
  units_dispatched: number | null;
}): string | null {
  const parts: string[] = [];
  if (i.building_type) parts.push(i.building_type);
  if (i.units_dispatched != null)
    parts.push(`${i.units_dispatched} unit${i.units_dispatched === 1 ? "" : "s"} dispatched`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * Display severity for an alert. Derived from the dispatch facts we already
 * have — alarm level first, then how many units rolled. Presentation only.
 */
export function incidentSeverity(i: {
  alarm_level: string | null;
  call_sign: string | null;
  units_dispatched: number | null;
}): "high" | "med" | "low" {
  const code = `${i.alarm_level ?? ""} ${i.call_sign ?? ""}`.toLowerCase();
  if (/10-75|all hands|10-76|10-77|10-45|[2-9](nd|rd|th) alarm/.test(code)) return "high";
  const units = i.units_dispatched ?? 0;
  if (units >= 8 || /alarm/.test(code)) return "high";
  if (units >= 4) return "med";
  return "low";
}

/** Best-effort geolocation. Never throws; returns null on refusal or timeout. */
export function getCurrentPosition(
  timeoutMs = 8_000,
): Promise<{ lat: number; lon: number } | null> {
  if (typeof navigator === "undefined" || !navigator.geolocation) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: { lat: number; lon: number } | null) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        clearTimeout(timer);
        finish({ lat: p.coords.latitude, lon: p.coords.longitude });
      },
      () => {
        clearTimeout(timer);
        finish(null);
      },
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 30_000 },
    );
  });
}

/** Duration in mm:ss / h:mm:ss suitable for a chase-timer badge. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/** Relative "3m ago" / "2h ago" — chase alerts read in seconds. */
export function timeSince(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

/** Haversine distance in miles. Cheap enough to run per row. */
export function distanceMiles(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const R = 3958.7613;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** Native-friendly map deep link — Apple Maps on iOS, Google Maps everywhere else. */
export function mapsDeepLink(address: string, lat?: number | null, lon?: number | null) {
  const q = encodeURIComponent(address);
  const isiOS = typeof navigator !== "undefined" && /iPad|iPhone|iPod/.test(navigator.userAgent);
  if (isiOS) {
    return lat != null && lon != null
      ? `https://maps.apple.com/?daddr=${lat},${lon}&q=${q}`
      : `https://maps.apple.com/?daddr=${q}`;
  }
  return lat != null && lon != null
    ? `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}`
    : `https://www.google.com/maps/dir/?api=1&destination=${q}`;
}
