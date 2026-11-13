import { supabase } from "@/integrations/supabase/client";
import { personLabel } from "@/lib/chat";

/**
 * Management view of the chase operation. Every number here is derived from
 * real incident rows — nothing is canned, including the coaching insights,
 * which are rules over the same figures the tiles show.
 */

export type PerfIncident = {
  id: string;
  reported_at: string;
  accepted_at: string | null;
  accepted_by: string | null;
  arrived_at: string | null;
  outcome: string | null;
  lifecycle: string;
  incident_type: string;
  source: string;
  bad_data: boolean;
  lat: number | null;
  lon: number | null;
  locality: string | null;
  region: string | null;
  location_id: string | null;
  job_id: string | null;
  is_exposure: boolean;
  exposure_group_id: string | null;
};

export type LostReason = { label: string; count: number };

export type ChaserRow = {
  userId: string;
  name: string;
  heard: number;
  inspections: number;
  signed: number;
  conversion: number;
};

export type PerfBundle = {
  current: PerfIncident[];
  previous: PerfIncident[];
  allBranches: PerfIncident[];
  lostReasons: LostReason[];
  names: Map<string, string>;
  revenue: number;
  revenueAll: number;
  /** Signed value per incident, so results can be split fires vs exposures. */
  revenueByIncident: Map<string, number>;
};

const COLS =
  "id,reported_at,accepted_at,accepted_by,arrived_at,outcome,lifecycle,incident_type,source,bad_data,lat,lon,locality,region,location_id,job_id,is_exposure,exposure_group_id";

async function fetchRange(fromISO: string, toISO: string, locationId: string | null) {
  let q = supabase
    .from("incidents")
    .select(COLS)
    .gte("reported_at", fromISO)
    .lt("reported_at", toISO)
    .order("reported_at", { ascending: true });
  if (locationId) q = q.eq("location_id", locationId);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as unknown as PerfIncident[];
}

async function revenueMap(rows: PerfIncident[]): Promise<Map<string, number>> {
  const signed = rows.filter((r) => isSigned(r) && r.job_id);
  const map = new Map<string, number>();
  if (signed.length === 0) return map;
  const { data, error } = await supabase
    .from("jobs")
    .select("id,approved_amount,billed_amount,estimated_amount")
    .in("id", signed.map((r) => r.job_id!) as string[]);
  if (error) throw error;
  const byJob = new Map(
    (data ?? []).map((j) => [
      j.id,
      Number(j.billed_amount ?? j.approved_amount ?? j.estimated_amount ?? 0),
    ]),
  );
  for (const r of signed) map.set(r.id, byJob.get(r.job_id!) ?? 0);
  return map;
}

async function revenueFor(rows: PerfIncident[]): Promise<number> {
  const map = await revenueMap(rows);
  return [...map.values()].reduce((a, b) => a + b, 0);
}

export function isSigned(r: PerfIncident): boolean {
  return r.lifecycle === "won" || r.outcome === "contract_signed";
}

export async function fetchPerformance(
  from: Date,
  to: Date,
  locationId: string | null,
): Promise<PerfBundle> {
  const span = to.getTime() - from.getTime();
  const prevFrom = new Date(from.getTime() - span);

  const [current, previous, allBranches] = await Promise.all([
    fetchRange(from.toISOString(), to.toISOString(), locationId),
    fetchRange(prevFrom.toISOString(), from.toISOString(), locationId),
    locationId
      ? fetchRange(from.toISOString(), to.toISOString(), null)
      : Promise.resolve<PerfIncident[]>([]),
  ]);

  const ids = current.map((r) => r.id);
  const [attempts, names, revenueByIncident, revenueAll] = await Promise.all([
    ids.length
      ? supabase
          .from("incident_attempts")
          .select("incident_id,reason_label,kept_live")
          .in("incident_id", ids)
      : Promise.resolve({ data: [], error: null } as never),
    fetchNames(current),
    revenueMap(current),
    locationId ? revenueFor(allBranches) : Promise.resolve(0),
  ]);

  const wonIds = new Set(current.filter(isSigned).map((r) => r.id));
  const counts = new Map<string, number>();
  for (const a of (
    attempts as { data: { incident_id: string; reason_label: string; kept_live: boolean }[] }
  ).data ?? []) {
    if (a.kept_live || wonIds.has(a.incident_id)) continue;
    counts.set(a.reason_label, (counts.get(a.reason_label) ?? 0) + 1);
  }
  const lostReasons = [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);

  const revenue = [...revenueByIncident.values()].reduce((a, b) => a + b, 0);

  return {
    current,
    previous,
    allBranches: locationId ? allBranches : current,
    lostReasons,
    names,
    revenue,
    revenueAll: locationId ? revenueAll : revenue,
    revenueByIncident,
  };
}

async function fetchNames(rows: PerfIncident[]): Promise<Map<string, string>> {
  const ids = [...new Set(rows.map((r) => r.accepted_by).filter(Boolean) as string[])];
  const map = new Map<string, string>();
  if (ids.length === 0) return map;
  const { data } = await supabase.from("profiles").select("user_id,full_name").in("user_id", ids);
  for (const p of data ?? []) map.set(p.user_id, personLabel(p));
  return map;
}

/* ------------------------------ derivations ------------------------------ */

export const minutesBetween = (a: string | null, b: string | null): number | null =>
  a && b ? (new Date(b).getTime() - new Date(a).getTime()) / 60_000 : null;

export function avgResponseMinutes(rows: PerfIncident[]): number | null {
  const xs = rows
    .map((r) => minutesBetween(r.reported_at, r.accepted_at))
    .filter((x): x is number => x != null && x >= 0);
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function summary(rows: PerfIncident[]) {
  const heard = rows.length;
  const qualified = rows.filter((r) => !r.bad_data).length;
  const claimed = rows.filter((r) => r.accepted_by).length;
  const inspections = rows.filter((r) => r.arrived_at).length;
  const signed = rows.filter(isSigned).length;
  return {
    heard,
    qualified,
    claimed,
    inspections,
    signed,
    conversion: heard > 0 ? signed / heard : 0,
    avgResponse: avgResponseMinutes(rows),
  };
}

export function funnel(rows: PerfIncident[]) {
  const s = summary(rows);
  const stages = [
    { stage: "Heard", count: s.heard },
    { stage: "Qualified", count: s.qualified },
    { stage: "Contacted", count: s.claimed },
    { stage: "Inspection", count: s.inspections },
    { stage: "Signed", count: s.signed },
  ];
  return stages.map((row, i) => ({
    ...row,
    conversion: i === 0 ? null : s.heard > 0 ? row.count / s.heard : 0,
  }));
}

export function dailyResponse(rows: PerfIncident[], from: Date, to: Date) {
  const days: { key: string; date: Date; minutes: number | null }[] = [];
  for (let d = new Date(from); d < to; d = new Date(d.getTime() + 86_400_000)) {
    const day = new Date(d);
    const inDay = rows.filter((r) => new Date(r.reported_at).toDateString() === day.toDateString());
    days.push({
      key: day.toISOString().slice(0, 10),
      date: day,
      minutes: avgResponseMinutes(inDay),
    });
  }
  return days;
}

export function weeklyResponse(rows: PerfIncident[], from: Date, to: Date) {
  const out: { key: string; date: Date; minutes: number | null }[] = [];
  for (let d = new Date(from); d < to; d = new Date(d.getTime() + 7 * 86_400_000)) {
    const end = new Date(d.getTime() + 7 * 86_400_000);
    const inWeek = rows.filter((r) => {
      const t = new Date(r.reported_at);
      return t >= d && t < end;
    });
    out.push({
      key: d.toISOString().slice(0, 10),
      date: new Date(d),
      minutes: avgResponseMinutes(inWeek),
    });
  }
  return out;
}

export function byKey(rows: PerfIncident[], key: "incident_type" | "source") {
  const map = new Map<string, PerfIncident[]>();
  for (const r of rows) {
    const k = r[key] || "other";
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(r);
  }
  return [...map.entries()]
    .map(([k, list]) => {
      const s = summary(list);
      return {
        key: k,
        heard: s.heard,
        inspections: s.inspections,
        signed: s.signed,
        conversion: s.inspections > 0 ? s.signed / s.inspections : 0,
      };
    })
    .sort((a, b) => b.heard - a.heard);
}

export function byHour(rows: PerfIncident[]) {
  return Array.from({ length: 24 }, (_, h) => {
    const inHour = rows.filter((r) => new Date(r.reported_at).getHours() === h);
    const s = summary(inHour);
    return { hour: h, heard: s.heard, inspections: s.inspections, signed: s.signed };
  });
}

const DAY_LABEL = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function byDayOfWeek(rows: PerfIncident[]) {
  return DAY_LABEL.map((label, d) => {
    const inDay = rows.filter((r) => new Date(r.reported_at).getDay() === d);
    const s = summary(inDay);
    return { hour: d, label, heard: s.heard, inspections: s.inspections, signed: s.signed };
  });
}

export function perChaser(rows: PerfIncident[], names: Map<string, string>): ChaserRow[] {
  const map = new Map<string, PerfIncident[]>();
  for (const r of rows) {
    if (!r.accepted_by) continue;
    if (!map.has(r.accepted_by)) map.set(r.accepted_by, []);
    map.get(r.accepted_by)!.push(r);
  }
  return [...map.entries()]
    .map(([userId, list]) => {
      const s = summary(list);
      return {
        userId,
        name: names.get(userId) ?? "Chaser",
        heard: s.heard,
        inspections: s.inspections,
        signed: s.signed,
        conversion: s.heard > 0 ? s.signed / s.heard : 0,
      };
    })
    .sort((a, b) => b.heard - a.heard || b.signed - a.signed);
}

/** Weekend vs weekday conversion, used by the coaching rules. */
function conversionOn(rows: PerfIncident[], weekend: boolean): number | null {
  const set = rows.filter((r) => {
    const d = new Date(r.reported_at).getDay();
    return weekend ? d === 0 || d === 6 : d > 0 && d < 6;
  });
  if (set.length === 0) return null;
  return set.filter(isSigned).length / set.length;
}

export type Insight = { title: string; body: string; tone: "good" | "warn" | "info" };

export function coachingInsights(rows: PerfIncident[], goalMinutes = 10): Insight[] {
  const s = summary(rows);
  const out: Insight[] = [];

  if (s.avgResponse != null) {
    const under = s.avgResponse <= goalMinutes;
    out.push({
      title: under
        ? `Response time is under the ${goalMinutes}-minute goal`
        : `Response time is over the ${goalMinutes}-minute goal`,
      body: under
        ? `Averaging ${fmtMinutes(s.avgResponse)}. Keep it up and aim for under ${Math.max(
            1,
            Math.round(goalMinutes * 0.8),
          )} minutes.`
        : `Averaging ${fmtMinutes(s.avgResponse)} — ${fmtMinutes(
            s.avgResponse - goalMinutes,
          )} slower than the goal.`,
      tone: under ? "good" : "warn",
    });
  }

  const we = conversionOn(rows, true);
  const wd = conversionOn(rows, false);
  if (we != null && wd != null) {
    const diff = (we - wd) * 100;
    out.push({
      title: diff >= 0 ? "Book more inspections on weekends" : "Weekdays convert better",
      body:
        diff >= 0
          ? `Weekend incidents convert ${diff.toFixed(0)} pp higher than weekdays.`
          : `Weekday incidents convert ${Math.abs(diff).toFixed(0)} pp higher — protect weekday coverage.`,
      tone: "info",
    });
  }

  const unclaimed = rows.filter((r) => !r.accepted_by).length;
  if (rows.length > 0) {
    out.push({
      title:
        unclaimed > 0 ? "Follow up faster on unclaimed incidents" : "Every incident was claimed",
      body:
        unclaimed > 0
          ? `${unclaimed} of ${rows.length} incidents were never claimed. Claim within 5 minutes to hold the lead.`
          : `All ${rows.length} incidents in range were claimed by a chaser.`,
      tone: unclaimed > 0 ? "warn" : "good",
    });
  }

  const inspectRate = s.claimed > 0 ? s.inspections / s.claimed : null;
  if (inspectRate != null) {
    out.push({
      title:
        inspectRate >= 0.5
          ? "Inspection rate on claimed leads is healthy"
          : "Turn more claims into inspections",
      body: `${Math.round(inspectRate * 100)}% of claimed incidents reached an inspection (${
        s.inspections
      } of ${s.claimed}).`,
      tone: inspectRate >= 0.5 ? "good" : "warn",
    });
  }

  return out.slice(0, 4);
}

export function fmtMinutes(m: number | null): string {
  if (m == null) return "—";
  const mins = Math.floor(m);
  const secs = Math.round((m - mins) * 60);
  return `${mins}m ${String(secs).padStart(2, "0")}s`;
}

export function shortMoney(n: number): string {
  if (!n) return "$0";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `$${Math.round(n / 1000)}K`;
  return `$${Math.round(n)}`;
}

export function deltaPct(cur: number, prev: number): number | null {
  if (!prev) return null;
  return ((cur - prev) / prev) * 100;
}

/* --------------------- origin fires vs exposures --------------------- */

export type ExposureSplitSide = {
  leads: number;
  signed: number;
  conversion: number;
  revenue: number;
};

export type ExposureSplit = {
  fires: ExposureSplitSide;
  exposures: ExposureSplitSide;
  /** Fires that produced at least one neighbour lead. */
  firesWorked: number;
  firesWithExposures: number;
  avgExposuresPerFire: number;
};

/**
 * Splits the chase results into the fires themselves and the neighbours taken
 * off them. Average exposures per fire is the number the client reads to know
 * whether chasers are actually working the block.
 */
export function exposureSplit(
  rows: PerfIncident[],
  revenueByIncident: Map<string, number>,
): ExposureSplit {
  const side = (list: PerfIncident[]): ExposureSplitSide => {
    const signed = list.filter(isSigned);
    return {
      leads: list.length,
      signed: signed.length,
      conversion: list.length > 0 ? signed.length / list.length : 0,
      revenue: signed.reduce((s, r) => s + (revenueByIncident.get(r.id) ?? 0), 0),
    };
  };

  const fireRows = rows.filter((r) => !r.is_exposure);
  const exposureRows = rows.filter((r) => r.is_exposure);

  const perFire = new Map<string, number>();
  for (const r of fireRows) perFire.set(r.exposure_group_id ?? r.id, 0);
  for (const r of exposureRows) {
    const key = r.exposure_group_id ?? r.id;
    perFire.set(key, (perFire.get(key) ?? 0) + 1);
  }

  const firesWorked = fireRows.length;
  const firesWithExposures = [...perFire.values()].filter((n) => n > 0).length;

  return {
    fires: side(fireRows),
    exposures: side(exposureRows),
    firesWorked,
    firesWithExposures,
    avgExposuresPerFire: firesWorked > 0 ? exposureRows.length / firesWorked : 0,
  };
}

/* --------------------- alert response by chaser --------------------- */

/**
 * The three response states the client cares about, per chaser. A chaser who
 * ignores 40 alerts and one who declines 40 with a reason are different people,
 * so no-action is never folded into declined. Management view only — none of
 * this is shown on the chaser's own performance screen.
 */
export type DispatchResponseRow = {
  userId: string;
  name: string;
  sent: number;
  accepted: number;
  declined: number;
  noAction: number;
  pending: number;
  acceptRate: number;
  noActionRate: number;
};

export async function fetchDispatchResponses(
  from: Date,
  to: Date,
  locationId: string | null,
): Promise<DispatchResponseRow[]> {
  let q = supabase
    .from("incident_dispatches")
    .select("user_id,response,notified_at,incidents!inner(location_id)")
    .gte("notified_at", from.toISOString())
    .lt("notified_at", to.toISOString());
  if (locationId) q = q.eq("incidents.location_id", locationId);
  const { data, error } = await q;
  if (error) throw error;

  const rows = (data ?? []) as unknown as { user_id: string; response: string | null }[];
  const byUser = new Map<string, DispatchResponseRow>();
  for (const d of rows) {
    if (!d.user_id) continue;
    let r = byUser.get(d.user_id);
    if (!r) {
      r = {
        userId: d.user_id,
        name: "Chaser",
        sent: 0,
        accepted: 0,
        declined: 0,
        noAction: 0,
        pending: 0,
        acceptRate: 0,
        noActionRate: 0,
      };
      byUser.set(d.user_id, r);
    }
    r.sent += 1;
    const resp = d.response ?? "pending";
    if (resp === "accepted") r.accepted += 1;
    else if (resp === "no_action") r.noAction += 1;
    else if (resp === "pending") r.pending += 1;
    else r.declined += 1; // declined and declined_race
  }

  const ids = [...byUser.keys()];
  if (ids.length) {
    const { data: profiles } = await supabase
      .from("profiles")
      .select("user_id,full_name")
      .in("user_id", ids);
    for (const p of profiles ?? []) {
      const r = byUser.get(p.user_id);
      if (r) r.name = personLabel(p);
    }
  }

  return [...byUser.values()]
    .map((r) => ({
      ...r,
      acceptRate: r.sent > 0 ? r.accepted / r.sent : 0,
      noActionRate: r.sent > 0 ? r.noAction / r.sent : 0,
    }))
    .sort((a, b) => b.noActionRate - a.noActionRate || b.sent - a.sent);
}

/** Chronic ignore: enough alerts to judge, and a no-action share over the admin threshold. */
export function isChronicNoAction(
  r: DispatchResponseRow,
  thresholdPct: number,
  minAlerts = 5,
): boolean {
  return r.sent >= minAlerts && r.noActionRate * 100 >= thresholdPct;
}
