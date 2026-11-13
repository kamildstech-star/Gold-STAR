import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { distanceMiles, type Incident } from "@/lib/incidents";

/**
 * Overnight board, private search and the chaser's own commission view.
 *
 * Rules encoded here on purpose, because they are the ones that get softened
 * by accident:
 *   - a chaser is never shown a count of what they didn't do;
 *   - nothing is ever labelled "missed" — the screen is "Still Open";
 *   - search is not browse: 3 characters, 7 days, 20 rows, no paging;
 *   - lists carry address and incident type only. Property detail loads on claim.
 */

import {
  CHASE_SETTING_DEFAULTS,
  fetchChaseSettings,
  type ChaseSettings,
} from "@/lib/chase-settings";

/**
 * Overnight claims hold far longer than a live alert — nobody is racing at 4am.
 * The real value is the configurable one; this is only the fallback.
 */
export const OVERNIGHT_LOCK_MINUTES = CHASE_SETTING_DEFAULTS.overnight_lock_hours * 60;

export function overnightLockMinutes(s: ChaseSettings): number {
  return Math.round(Number(s.overnight_lock_hours) * 60);
}

const SEVERITY_ORDER = ["fire", "smoke", "water", "storm", "other"];

/** Anything less severe than the configured floor never reaches the overnight board. */
export function meetsSeverityFloor(incidentType: string, floor: string): boolean {
  const f = SEVERITY_ORDER.indexOf(floor);
  const i = SEVERITY_ORDER.indexOf(incidentType);
  if (f < 0) return true;
  return (i < 0 ? SEVERITY_ORDER.length : i) <= f;
}

export type DecayBucket = "fresh" | "dimmed" | "faded" | "cleared";

/** Age decay across the configured window. Past it the card is gone, not greyed. */
export function decayBucket(
  reportedAt: string,
  now = Date.now(),
  decayHours = CHASE_SETTING_DEFAULTS.lead_decay_hours,
): DecayBucket {
  const hours = (now - new Date(reportedAt).getTime()) / 3_600_000;
  if (hours < decayHours * 0.25) return "fresh";
  if (hours < decayHours * 0.67) return "dimmed";
  if (hours < decayHours) return "faded";
  return "cleared";
}

export const DECAY_CLASS: Record<Exclude<DecayBucket, "cleared">, string> = {
  fresh: "opacity-100",
  dimmed: "opacity-75",
  faded: "opacity-50",
};

const SEVERITY_RANK: Record<string, number> = { fire: 0, smoke: 1, water: 2, storm: 3, other: 4 };

/** Severity → distance → freshness. Distance drops out when we have no fix. */
export function sortStillOpen(
  rows: Incident[],
  me: { lat: number; lon: number } | null,
): Incident[] {
  return [...rows].sort((a, b) => {
    const sev = (SEVERITY_RANK[a.incident_type] ?? 9) - (SEVERITY_RANK[b.incident_type] ?? 9);
    if (sev !== 0) return sev;
    if (me) {
      const da =
        a.lat != null && a.lon != null ? distanceMiles(me, { lat: a.lat, lon: a.lon }) : 9_999;
      const db =
        b.lat != null && b.lon != null ? distanceMiles(me, { lat: b.lat, lon: b.lon }) : 9_999;
      if (Math.abs(da - db) > 0.05) return da - db;
    }
    return new Date(b.reported_at).getTime() - new Date(a.reported_at).getTime();
  });
}

/**
 * Still Open: live, unclaimed, whole market, last 24 hours. Anything this
 * chaser declined, or that expired on them, belongs in Past Leads instead —
 * and terminally lost leads simply disappear.
 */
export async function fetchStillOpen(userId: string): Promise<Incident[]> {
  const settings = await fetchChaseSettings();
  const decay = Number(settings.lead_decay_hours);
  const since = new Date(Date.now() - decay * 3_600_000).toISOString();
  const [{ data: rows, error }, { data: mine }] = await Promise.all([
    supabase
      .from("incidents")
      .select("*")
      .eq("lifecycle", "live")
      .is("accepted_by", null)
      .gte("reported_at", since)
      .order("reported_at", { ascending: false })
      .limit(200),
    supabase
      .from("incident_dispatches")
      .select("incident_id,response")
      .eq("user_id", userId)
      .in("response", ["declined", "declined_race", "no_action"]),
  ]);
  if (error) throw error;
  const passed = new Set((mine ?? []).map((d) => d.incident_id));
  return ((rows as Incident[]) ?? []).filter(
    (i) =>
      !passed.has(i.id) &&
      decayBucket(i.reported_at, Date.now(), decay) !== "cleared" &&
      meetsSeverityFloor(i.incident_type, String(settings.overnight_severity_floor)),
  );
}

/** Past Leads — what this chaser declined or let lapse. No totals, just the list. */
export async function fetchPastLeads(userId: string): Promise<Incident[]> {
  const settings = await fetchChaseSettings();
  const cutoff = new Date(
    Date.now() - Number(settings.past_lead_retention_days) * 86_400_000,
  ).toISOString();
  const { data: disp, error } = await supabase
    .from("incident_dispatches")
    .select("incident_id,responded_at,response")
    .eq("user_id", userId)
    .in("response", ["declined", "declined_race", "no_action"])
    .gte("responded_at", cutoff)
    .order("responded_at", { ascending: false })
    .limit(40);
  if (error) throw error;
  const ids = (disp ?? []).map((d) => d.incident_id);
  if (ids.length === 0) return [];
  const { data, error: e2 } = await supabase.from("incidents").select("*").in("id", ids);
  if (e2) throw e2;
  const order = new Map(ids.map((id, idx) => [id, idx]));
  return ((data as Incident[]) ?? []).sort(
    (a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
  );
}

/* ------------------------------------------------------------------ */
/*  Morning digest time — chaser-set, never hardcoded                  */
/* ------------------------------------------------------------------ */

export async function fetchDigestTime(userId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("chaser_territories")
    .select("digest_time")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return (data?.digest_time as string | undefined)?.slice(0, 5) ?? null;
}

export async function saveDigestTime(userId: string, hhmm: string): Promise<void> {
  const { error } = await supabase
    .from("chaser_territories")
    .update({ digest_time: `${hhmm}:00` })
    .eq("user_id", userId);
  if (error) throw error;
}

/* ------------------------------------------------------------------ */
/*  Search is not browse                                               */
/* ------------------------------------------------------------------ */

export type ChaseSearchRow =
  Database["public"]["Functions"]["search_chase_incidents"]["Returns"][number];

/** Fallback only — the live value comes from chase settings. */
export const SEARCH_MIN_CHARS = CHASE_SETTING_DEFAULTS.search_min_chars;

export async function searchChaseIncidents(
  q: string,
  minChars = SEARCH_MIN_CHARS,
): Promise<ChaseSearchRow[]> {
  if (q.trim().length < minChars) return [];
  const { data, error } = await supabase.rpc("search_chase_incidents", { _q: q.trim() });
  if (error) throw error;
  return data ?? [];
}

/* ------------------------------------------------------------------ */
/*  Their own commission, always with its state                        */
/* ------------------------------------------------------------------ */

export type ChaseJobRow = Database["public"]["Functions"]["my_chase_jobs"]["Returns"][number];

export async function fetchMyChaseJobs(): Promise<ChaseJobRow[]> {
  const { data, error } = await supabase.rpc("my_chase_jobs");
  if (error) throw error;
  return data ?? [];
}

const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

/** Commission never appears without its state. "~$1,800 estimated". */
export function commissionLabel(row: {
  commission_amount: number | null;
  commission_state: string | null;
  commission_at: string | null;
}): string {
  const amount = Number(row.commission_amount ?? 0);
  if (!amount) return "Commission not set";
  switch (row.commission_state) {
    case "paid":
      return `${money(amount)} paid${
        row.commission_at
          ? ` ${new Date(row.commission_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`
          : ""
      }`;
    case "confirmed":
      return `${money(amount)} confirmed`;
    default:
      return `~${money(amount)} estimated`;
  }
}
