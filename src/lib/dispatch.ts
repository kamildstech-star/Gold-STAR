import { supabase } from "@/integrations/supabase/client";
import { distanceMiles, incidentSeverity, type Incident } from "@/lib/incidents";

/**
 * Dispatch board data. Everything here is derived from records the app already
 * keeps — open shifts, dispatch responses, incident events. Nothing about a
 * chaser's readiness is typed by a dispatcher.
 */

export type LiveIncident = Incident & {
  severity: "high" | "med" | "low";
  rank: number;
};

export type ChaserStatus = "available" | "on_job" | "en_route" | "off";

export type RosterChaser = {
  userId: string;
  name: string;
  homeCity: string;
  locationId: string | null;
  shiftStartedAt: string;
  lat: number | null;
  lon: number | null;
  status: ChaserStatus;
  /** Live jobs carried today. */
  workload: number;
  /** 0–100, from how often and how fast they answer dispatches. */
  responseScore: number;
  notified: number;
  accepted: number;
  medianResponseMin: number | null;
};

export type ScoreFactor = { ok: boolean; text: string };

export type ScoredChaser = {
  chaser: RosterChaser;
  score: number;
  distanceMi: number | null;
  etaMin: number | null;
  factors: ScoreFactor[];
};

export type DispatchLogRow = {
  id: string;
  occurredAt: string;
  event: string;
  incidentId: string;
  incidentLabel: string;
  chaserName: string;
  details: string;
  /**
   * Where the chaser was when this happened, when the device gave it.
   *
   * Null is a real and expected answer — a chaser who declined the location
   * prompt, or a phone indoors with no fix, still works normally and their
   * events still record. Melly, 17 Sep, on chasers: "I don't want them to know
   * that they're being tracked... they don't need to toggle on location every
   * time." So the gap shows HERE, to the supervisor, and never as a warning at
   * the chaser.
   */
  lat: number | null;
  lon: number | null;
};

type LocRow = { id: string; name: string; locality: string | null; region: string | null };

const OPEN_STATUSES = ["new", "dispatched", "accepted", "on_scene"] as const;

/* ------------------------------------------------------------------ */
/*  Queue                                                              */
/* ------------------------------------------------------------------ */

const SEV_RANK = { high: 0, med: 1, low: 2 } as const;

export async function fetchLiveIncidents(locationId?: string | null): Promise<LiveIncident[]> {
  let q = supabase
    .from("incidents")
    .select("*")
    .in("status", [...OPEN_STATUSES])
    .order("reported_at", { ascending: false })
    .limit(60);
  if (locationId) q = q.eq("location_id", locationId);
  const { data, error } = await q;
  if (error) throw error;
  const rows = ((data ?? []) as Incident[]).map((i) => ({
    ...i,
    severity: incidentSeverity(i),
  }));
  rows.sort((a, b) => {
    const s = SEV_RANK[a.severity] - SEV_RANK[b.severity];
    if (s !== 0) return s;
    return new Date(b.reported_at).getTime() - new Date(a.reported_at).getTime();
  });
  return rows.map((r, idx) => ({ ...r, rank: idx + 1 }));
}

/* ------------------------------------------------------------------ */
/*  Roster                                                             */
/* ------------------------------------------------------------------ */

export async function fetchRoster(locationId?: string | null): Promise<RosterChaser[]> {
  let shiftQ = supabase
    .from("chaser_shifts")
    .select("id,user_id,location_id,started_at,started_lat,started_lon")
    .is("ended_at", null)
    .order("started_at", { ascending: true });
  if (locationId) shiftQ = shiftQ.eq("location_id", locationId);
  const { data: shifts, error } = await shiftQ;
  if (error) throw error;
  const rows = shifts ?? [];
  if (rows.length === 0) return [];

  const userIds = [...new Set(rows.map((s) => s.user_id))];
  const locIds = [...new Set(rows.map((s) => s.location_id).filter(Boolean))] as string[];

  const [profiles, locations, openIncidents, dispatches] = await Promise.all([
    supabase.from("profiles").select("user_id,full_name").in("user_id", userIds),
    locIds.length
      ? supabase.from("locations").select("id,name,locality,region").in("id", locIds)
      : Promise.resolve({ data: [] as LocRow[], error: null }),
    supabase
      .from("incidents")
      .select("id,accepted_by,accepted_at,arrived_at,status")
      .in("accepted_by", userIds)
      .in("status", ["accepted", "on_scene", "dispatched"]),
    supabase
      .from("incident_dispatches")
      .select("user_id,notified_at,responded_at,response")
      .in("user_id", userIds)
      .limit(2000),
  ]);

  const nameOf = new Map((profiles.data ?? []).map((p) => [p.user_id, p.full_name ?? "Unnamed"]));
  const locOf = new Map(
    ((locations.data ?? []) as LocRow[]).map((l) => [
      l.id,
      [l.locality ?? l.name, l.region].filter(Boolean).join(", "),
    ]),
  );

  return rows.map((s) => {
    const mine = (openIncidents.data ?? []).filter((i) => i.accepted_by === s.user_id);
    const onScene = mine.some((i) => i.arrived_at);
    const enRoute = mine.some((i) => i.accepted_at && !i.arrived_at);
    const status: ChaserStatus = onScene ? "on_job" : enRoute ? "en_route" : "available";

    const mineDispatches = (dispatches.data ?? []).filter((d) => d.user_id === s.user_id);
    const notified = mineDispatches.length;
    const accepted = mineDispatches.filter((d) => d.response === "accepted").length;
    const times = mineDispatches
      .filter((d) => d.responded_at && d.notified_at)
      .map(
        (d) =>
          (new Date(d.responded_at as string).getTime() -
            new Date(d.notified_at as string).getTime()) /
          60_000,
      )
      .sort((a, b) => a - b);
    const median = times.length ? times[Math.floor(times.length / 2)]! : null;

    // Accept rate carries most of it; a fast median lifts it, a slow one drags.
    const acceptRate = notified > 0 ? accepted / notified : 0.75;
    const speed = median == null ? 0.7 : Math.max(0, Math.min(1, 1 - median / 20));
    const responseScore = Math.round((acceptRate * 0.65 + speed * 0.35) * 100);

    return {
      userId: s.user_id,
      name: nameOf.get(s.user_id) ?? "Unnamed",
      homeCity: (s.location_id && locOf.get(s.location_id)) || "—",
      locationId: s.location_id,
      shiftStartedAt: s.started_at,
      lat: s.started_lat,
      lon: s.started_lon,
      status,
      workload: mine.length,
      responseScore,
      notified,
      accepted,
      medianResponseMin: median,
    };
  });
}

export const STATUS_LABEL: Record<ChaserStatus, string> = {
  available: "Available",
  on_job: "On Job",
  en_route: "En Route",
  off: "On Break",
};

export const STATUS_STYLE: Record<ChaserStatus, { bg: string; fg: string }> = {
  available: { bg: "#E3F6EA", fg: "#12874A" },
  on_job: { bg: "#E4EEFE", fg: "#1166F5" },
  en_route: { bg: "#FDF0DF", fg: "#B7690C" },
  off: { bg: "#EFF2F6", fg: "#6B7B93" },
};

/* ------------------------------------------------------------------ */
/*  Recommendation                                                     */
/* ------------------------------------------------------------------ */

const AVG_MPH = 24;

/** Explainable ranking: distance, availability, workload, response record. */
export function rankChasers(
  incident: Pick<LiveIncident, "lat" | "lon" | "incident_type">,
  roster: RosterChaser[],
): ScoredChaser[] {
  const withDistance = roster.map((c) => {
    const distanceMi =
      incident.lat != null && incident.lon != null && c.lat != null && c.lon != null
        ? distanceMiles({ lat: incident.lat, lon: incident.lon }, { lat: c.lat, lon: c.lon })
        : null;
    return { c, distanceMi };
  });

  const available = withDistance.filter((r) => r.c.status === "available" && r.distanceMi != null);
  const closestAvailable = available.length
    ? Math.min(...available.map((r) => r.distanceMi as number))
    : null;

  const scored = withDistance.map(({ c, distanceMi }) => {
    // 40 pts distance — full marks inside a mile, nothing past 15.
    const distPts = distanceMi == null ? 12 : Math.max(0, 40 - (distanceMi / 15) * 40);
    // 25 pts availability.
    const availPts = c.status === "available" ? 25 : c.status === "en_route" ? 10 : 0;
    // 20 pts workload — each live job costs 7.
    const loadPts = Math.max(0, 20 - c.workload * 7);
    // 15 pts response record.
    const respPts = (c.responseScore / 100) * 15;
    const score = Math.round(distPts + availPts + loadPts + respPts);

    const etaMin = distanceMi == null ? null : Math.max(3, Math.round((distanceMi / AVG_MPH) * 60));

    const factors: ScoreFactor[] = [];
    if (distanceMi != null) {
      const isClosest = closestAvailable != null && distanceMi <= closestAvailable + 0.05;
      factors.push({
        ok: distanceMi <= 5,
        text:
          (isClosest && c.status === "available" ? "Closest available" : "Distance") +
          ` (${distanceMi.toFixed(1)} mi away)`,
      });
    } else {
      factors.push({ ok: false, text: "No recent position — distance unknown" });
    }
    factors.push({
      ok: c.status === "available",
      text:
        c.status === "available"
          ? "Free right now — no live job"
          : c.status === "en_route"
            ? "En route to another incident"
            : "On scene at another job",
    });
    factors.push({
      ok: c.responseScore >= 70,
      text: `Response score ${c.responseScore}${
        c.medianResponseMin != null ? ` (answers in ~${Math.round(c.medianResponseMin)} min)` : ""
      }`,
    });
    factors.push({
      ok: c.workload <= 2,
      text:
        c.workload === 0
          ? "No jobs carried today"
          : `${c.workload <= 2 ? "Light" : "Heavy"} workload (${c.workload} job${
              c.workload === 1 ? "" : "s"
            } today)`,
    });

    return { chaser: c, score, distanceMi, etaMin, factors };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/* ------------------------------------------------------------------ */
/*  Actions + log                                                      */
/* ------------------------------------------------------------------ */

export async function assignIncident(args: {
  incidentId: string;
  userId: string;
  etaMinutes: number | null;
  reason: string | null;
}): Promise<void> {
  const { error } = await supabase.rpc("dispatch_incident_to_chaser", {
    _incident_id: args.incidentId,
    _user_id: args.userId,
    _eta_minutes: args.etaMinutes ?? undefined,
    _reason: args.reason ?? undefined,
  });
  if (error) throw error;
}

const EVENT_LABEL: Record<string, string> = {
  created: "Created",
  dispatched: "Assigned",
  accepted: "Accepted",
  declined: "Declined",
  arrived: "Arrived",
  escalated: "Reassigned",
  outcome_logged: "Closed",
  converted: "Converted",
  matched_hpd: "Matched",
  discarded: "Discarded",
};

export const EVENT_STYLE: Record<string, { bg: string; fg: string }> = {
  Accepted: { bg: "#E3F6EA", fg: "#12874A" },
  Arrived: { bg: "#E4EEFE", fg: "#1166F5" },
  Declined: { bg: "#FDE7E7", fg: "#C42222" },
  Reassigned: { bg: "#FDF0DF", fg: "#B7690C" },
  Assigned: { bg: "#EDE9FE", fg: "#6D46D6" },
  Created: { bg: "#EFF2F6", fg: "#5A6B84" },
  Closed: { bg: "#EFF2F6", fg: "#5A6B84" },
  Converted: { bg: "#E3F6EA", fg: "#12874A" },
  Matched: { bg: "#EFF2F6", fg: "#5A6B84" },
  Discarded: { bg: "#EFF2F6", fg: "#5A6B84" },
};

export const LOG_EVENT_OPTIONS = [
  "All Events",
  "Assigned",
  "Accepted",
  "Declined",
  "Arrived",
  "Reassigned",
] as const;

export async function fetchDispatchLog(opts: {
  since: string | null;
  event: string;
  locationId?: string | null;
}): Promise<DispatchLogRow[]> {
  let q = supabase
    .from("incident_events")
    // lat/lon have been stored on every chase event since 20260812173002 and
    // were simply never read back, so the one place a supervisor looks at
    // chaser activity could not show where any of it happened.
    .select("id,incident_id,event_type,actor_id,payload,occurred_at,lat,lon")
    .order("occurred_at", { ascending: false })
    .limit(60);
  if (opts.since) q = q.gte("occurred_at", opts.since);
  const { data, error } = await q;
  if (error) throw error;
  const rows = data ?? [];
  if (rows.length === 0) return [];

  const incidentIds = [...new Set(rows.map((r) => r.incident_id))];
  const payloadUser = (p: unknown) =>
    p && typeof p === "object" && "assigned_to" in (p as Record<string, unknown>)
      ? ((p as Record<string, unknown>)["assigned_to"] as string | null)
      : null;

  const userIds = [
    ...new Set(
      rows.flatMap((r) => [r.actor_id, payloadUser(r.payload)].filter(Boolean) as string[]),
    ),
  ];

  const [incidents, profiles] = await Promise.all([
    supabase
      .from("incidents")
      .select("id,address,locality,incident_type,location_id")
      .in("id", incidentIds),
    userIds.length
      ? supabase.from("profiles").select("user_id,full_name").in("user_id", userIds)
      : Promise.resolve({ data: [], error: null } as const),
  ]);

  const incOf = new Map((incidents.data ?? []).map((i) => [i.id, i]));
  const nameOf = new Map(
    ((profiles.data ?? []) as { user_id: string; full_name: string | null }[]).map((p) => [
      p.user_id,
      p.full_name ?? "Unknown",
    ]),
  );

  const out: DispatchLogRow[] = [];
  for (const r of rows) {
    const inc = incOf.get(r.incident_id);
    if (!inc) continue;
    if (opts.locationId && inc.location_id !== opts.locationId) continue;
    const event = EVENT_LABEL[r.event_type] ?? r.event_type;
    if (opts.event !== "All Events" && opts.event !== event) continue;

    const payload = (r.payload ?? {}) as Record<string, unknown>;
    const assignee = payloadUser(r.payload);
    const chaserName = assignee
      ? (nameOf.get(assignee) ?? "Unknown")
      : r.actor_id
        ? (nameOf.get(r.actor_id) ?? "Unknown")
        : "—";

    const eta = payload["eta_minutes"];
    const details =
      typeof eta === "number"
        ? `ETA ${eta} min`
        : event === "Arrived"
          ? "On site"
          : typeof payload["reason"] === "string" && payload["reason"]
            ? (payload["reason"] as string)
            : typeof payload["note"] === "string"
              ? (payload["note"] as string)
              : "—";

    out.push({
      id: r.id,
      occurredAt: r.occurred_at,
      event,
      incidentId: r.incident_id,
      incidentLabel: `${inc.incident_type ? inc.incident_type[0]!.toUpperCase() + inc.incident_type.slice(1) : "Incident"} — ${inc.address ?? inc.locality ?? ""}`,
      chaserName,
      details,
      lat: r.lat ?? null,
      lon: r.lon ?? null,
    });
  }
  return out;
}

/**
 * Where a chase event happened, for a supervisor's eyes.
 *
 * "No location" is stated rather than left blank: an empty cell reads as a
 * rendering slip, and the whole point of surfacing this is that a supervisor
 * can see which chasers are reporting position and which are not. Pure, so the
 * distinction is testable.
 */
export function eventLocationLabel(row: Pick<DispatchLogRow, "lat" | "lon">): string {
  if (row.lat == null || row.lon == null) return "No location";
  return `${row.lat.toFixed(5)}, ${row.lon.toFixed(5)}`;
}
