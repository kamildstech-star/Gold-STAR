import { supabase } from "@/integrations/supabase/client";
import {
  classifyStage,
  fetchProspectingStages,
  inScope,
  lookupStage,
  prospectRank,
  type CoverageScope,
  type ProspectingStages,
  type StopKind,
} from "@/lib/visits";

/**
 * Routes — the "look back at where I've been" side.
 *
 * There is deliberately no `visits` table: an in-person visit is a geo-tagged
 * touchpoint. Everything below reads that one history, so coverage, gaps and
 * "have I been here?" can never disagree with the account timeline.
 */

const IN_PERSON_TYPES = ["meeting_in_person"] as const;

export type VisitRecord = {
  id: string;
  occurred_at: string;
  type: string;
  lat: number;
  lon: number;
  place_label: string | null;
  notes: string | null;
  outcome: string | null;
  duration_minutes: number | null;
  account_id: string | null;
  account_name: string | null;
  contact_name: string | null;
  rep_id: string | null;
  rep_name: string | null;
  /** The Prospecting stage the account sat on when the visit happened. */
  stage_at_visit: string | null;
  stage_key_at_visit: string | null;
  /** Where the account sits today. */
  current_stage: string | null;
  /**
   * Was this a run at new business or a call on an existing client? Read from
   * the stage at the time where stage history allows, current stage otherwise.
   * Null for a stop that was never linked to an account.
   */
  kind: StopKind | null;
  /** False when the stage shown is today's, because no history covered the date. */
  stage_is_historical: boolean;
};

/** Outcome is stored as the first "Outcome: …" line of the note. */
function splitNotes(raw: string | null): { outcome: string | null; notes: string | null } {
  if (!raw) return { outcome: null, notes: null };
  const lines = raw.split("\n");
  const first = lines[0] ?? "";
  if (/^outcome:/i.test(first.trim())) {
    return {
      outcome: first.replace(/^outcome:\s*/i, "").trim() || null,
      notes: lines.slice(1).join("\n").trim() || null,
    };
  }
  return { outcome: null, notes: raw.trim() || null };
}

export async function fetchRepNames(ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map();
  const { data, error } = await supabase
    .from("profiles")
    .select("user_id,full_name")
    .in("user_id", unique);
  if (error) throw error;
  return new Map(
    (data ?? []).map((p) => [p.user_id as string, (p.full_name as string) ?? "Unnamed"]),
  );
}

/* ------------------------------------------------ stage at the time of a visit */

type StageAtPoint = { id: string | null; key: string | null };

/**
 * The stage an account was on at a given moment, read from
 * `account_stage_history`. Rows are ordered oldest first per account: the last
 * change on or before the visit is the stage the rep walked into. When the
 * first recorded change is already after the visit, that row's `from_stage`
 * still tells us where the account was standing.
 */
function stageAtFactory(rows: Map<string, { at: string; to: StageAtPoint; from: StageAtPoint }[]>) {
  return (accountId: string | null, occurredAt: string): StageAtPoint | null => {
    if (!accountId) return null;
    const list = rows.get(accountId);
    if (!list?.length) return null;
    let found: StageAtPoint | null = null;
    for (const r of list) {
      if (r.at <= occurredAt) found = r.to;
      else break;
    }
    if (found) return found;
    const first = list[0]!;
    return first.from.id || first.from.key ? first.from : null;
  };
}

async function fetchStageHistory(accountIds: string[]) {
  const ids = [...new Set(accountIds.filter(Boolean))];
  const empty = new Map<string, { at: string; to: StageAtPoint; from: StageAtPoint }[]>();
  if (!ids.length) return empty;
  const { data, error } = await supabase
    .from("account_stage_history")
    .select("account_id,changed_at,from_stage,from_stage_id,to_stage,to_stage_id")
    .in("account_id", ids)
    .order("changed_at", { ascending: true })
    .limit(6000);
  if (error) throw error;
  for (const r of data ?? []) {
    const key = r.account_id as string;
    const list = empty.get(key) ?? [];
    list.push({
      at: r.changed_at as string,
      to: {
        id: (r.to_stage_id as string | null) ?? null,
        key: (r.to_stage as string | null) ?? null,
      },
      from: {
        id: (r.from_stage_id as string | null) ?? null,
        key: (r.from_stage as string | null) ?? null,
      },
    });
    empty.set(key, list);
  }
  return empty;
}

/** Every geo-tagged in-person touchpoint in a window, oldest first. */
export async function fetchVisitHistory(opts: {
  from: Date;
  to: Date;
  userId?: string | null;
}): Promise<VisitRecord[]> {
  let q = supabase
    .from("touchpoints")
    .select(
      "id,occurred_at,type,lat,lon,place_label,notes,duration_seconds,account_id,created_by,accounts(name,stage,stage_id),contacts(full_name)",
    )
    .not("lat", "is", null)
    .in("type", IN_PERSON_TYPES)
    .gte("occurred_at", opts.from.toISOString())
    .lte("occurred_at", opts.to.toISOString())
    .order("occurred_at", { ascending: true });
  if (opts.userId) q = q.eq("created_by", opts.userId);
  const { data, error } = await q.limit(2000);
  if (error) throw error;

  const rows = data ?? [];
  const accountIds = rows.map((r) => (r.account_id as string | null) ?? "").filter(Boolean);
  const [names, stages, history] = await Promise.all([
    fetchRepNames(rows.map((r) => r.created_by as string)),
    fetchProspectingStages(),
    fetchStageHistory(accountIds),
  ]);
  const stageAt = stageAtFactory(history);

  return rows.map((r) => {
    const acc = r.accounts as {
      name: string;
      stage: string | null;
      stage_id: string | null;
    } | null;
    const con = r.contacts as { full_name: string } | null;
    const { outcome, notes } = splitNotes((r.notes as string | null) ?? null);
    const rep = (r.created_by as string | null) ?? null;
    const accountId = (r.account_id as string | null) ?? null;
    const occurredAt = r.occurred_at as string;

    const current = lookupStage(stages, acc?.stage_id ?? null, acc?.stage ?? null);
    const past = stageAt(accountId, occurredAt);
    const historical = past ? lookupStage(stages, past.id, past.key) : null;
    const effective = historical ?? current;

    return {
      id: r.id as string,
      occurred_at: occurredAt,
      type: r.type as string,
      lat: Number(r.lat),
      lon: Number(r.lon),
      place_label: (r.place_label as string | null) ?? null,
      notes,
      outcome,
      duration_minutes: r.duration_seconds ? Math.round(Number(r.duration_seconds) / 60) : null,
      account_id: accountId,
      account_name: acc?.name ?? null,
      contact_name: con?.full_name ?? null,
      rep_id: rep,
      rep_name: rep ? (names.get(rep) ?? null) : null,
      stage_at_visit: effective?.name ?? null,
      stage_key_at_visit: effective?.key ?? null,
      current_stage: current?.name ?? null,
      kind: accountId ? classifyStage(effective) : null,
      stage_is_historical: Boolean(historical),
    } satisfies VisitRecord;
  });
}

/* --------------------------------------------------- "have I been here?" */

export type LastVisit = {
  account_id: string;
  occurred_at: string;
  rep_id: string | null;
  rep_name: string | null;
  place_label: string | null;
};

/**
 * Last in-person visit per account — by ANY rep, not just the caller. Reps ask
 * "has anyone been here?", and the honest answer names the colleague.
 */
export async function fetchLastVisits(accountIds: string[]): Promise<Map<string, LastVisit>> {
  const ids = [...new Set(accountIds.filter(Boolean))];
  if (!ids.length) return new Map();
  const { data, error } = await supabase
    .from("touchpoints")
    .select("account_id,occurred_at,created_by,place_label")
    .in("account_id", ids)
    .in("type", IN_PERSON_TYPES)
    .order("occurred_at", { ascending: false })
    .limit(4000);
  if (error) throw error;

  const latest = new Map<string, LastVisit>();
  for (const r of data ?? []) {
    const key = r.account_id as string;
    if (latest.has(key)) continue;
    latest.set(key, {
      account_id: key,
      occurred_at: r.occurred_at as string,
      rep_id: (r.created_by as string | null) ?? null,
      rep_name: null,
      place_label: (r.place_label as string | null) ?? null,
    });
  }
  const names = await fetchRepNames([...latest.values()].map((v) => v.rep_id ?? ""));
  for (const v of latest.values()) v.rep_name = v.rep_id ? (names.get(v.rep_id) ?? null) : null;
  return latest;
}

export async function fetchLastVisit(accountId: string): Promise<LastVisit | null> {
  const m = await fetchLastVisits([accountId]);
  return m.get(accountId) ?? null;
}

/* ------------------------------------------------------- accounts in scope */

export type PatchAccount = {
  id: string;
  name: string;
  address: string | null;
  area: string;
  city: string | null;
  postal_code: string | null;
  value: number;
  assigned_rep: string | null;
  last_visit_at: string | null;
  last_visit_by: string | null;
  last_visit_by_name: string | null;
  /** Pipeline deal, existing client, or a closed-out prospect. */
  kind: StopKind;
  stage_id: string | null;
  stage_key: string | null;
  stage_name: string | null;
  stage_order: number | null;
  /** Higher means "go here first" — never-visited deals float to the top. */
  rank: number;
};

export const daysSince = (iso: string | null): number | null =>
  iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000) : null;

/**
 * The rep's patch with last-visit age and pipeline stage attached. Coverage,
 * targeting and the gaps list are all views over this one list — which is why
 * a deal and a client can be told apart everywhere without a second query.
 */
export async function fetchPatch(
  userId: string | null,
  opts?: { scope?: CoverageScope },
): Promise<PatchAccount[]> {
  const scope = opts?.scope ?? "all";
  let q = supabase
    .from("accounts")
    .select(
      "id,name,address_line1,city,state,postal_code,estimated_annual_value,assigned_rep,last_in_person_at,stage,stage_id",
    )
    .is("archived_at", null)
    .order("name");
  if (userId) q = q.eq("assigned_rep", userId);

  const [{ data, error }, stages] = await Promise.all([q.limit(2000), fetchProspectingStages()]);
  if (error) throw error;

  const rows = data ?? [];
  const last = await fetchLastVisits(rows.map((r) => r.id as string));
  const out: PatchAccount[] = [];
  for (const a of rows) {
    const parts = [a.address_line1, a.city, a.state, a.postal_code].filter(Boolean) as string[];
    const lv = last.get(a.id as string) ?? null;
    const stage = lookupStage(
      stages,
      (a.stage_id as string | null) ?? null,
      (a.stage as string | null) ?? null,
    );
    const kind = classifyStage(stage);
    if (!inScope(kind, scope)) continue;
    const value = Number(a.estimated_annual_value ?? 0);
    const lastVisitAt = lv?.occurred_at ?? (a.last_in_person_at as string | null) ?? null;
    out.push({
      id: a.id as string,
      name: a.name as string,
      address: parts.length ? parts.join(", ") : null,
      area:
        (a.postal_code as string | null)?.trim() ||
        (a.city as string | null)?.trim() ||
        "No area on file",
      city: (a.city as string | null) ?? null,
      postal_code: (a.postal_code as string | null) ?? null,
      value,
      assigned_rep: (a.assigned_rep as string | null) ?? null,
      last_visit_at: lastVisitAt,
      last_visit_by: lv?.rep_id ?? null,
      last_visit_by_name: lv?.rep_name ?? null,
      kind,
      stage_id: stage?.id ?? (a.stage_id as string | null) ?? null,
      stage_key: stage?.key ?? (a.stage as string | null) ?? null,
      stage_name: stage?.name ?? null,
      stage_order: stage?.sort_order ?? null,
      rank: prospectRank({
        kind,
        stageOrder: stage?.sort_order ?? null,
        value,
        lastVisitAt,
      }),
    });
  }
  return out;
}

/**
 * "Who should I see" — deals in the patch never visited, or not visited inside
 * the window. Ordered by deal heat, so a prospect nobody has driven out to
 * comes before a client who is merely overdue.
 */
export function visitGaps(patch: PatchAccount[], gapDays: number): PatchAccount[] {
  return patch
    .filter((a) => {
      const age = daysSince(a.last_visit_at);
      return age === null || age >= gapDays;
    })
    .sort((a, b) => b.rank - a.rank || b.value - a.value);
}

/** Deals grouped into their Prospecting stage, hottest stage first. */
export function groupByStage(
  rows: PatchAccount[],
): { key: string; name: string; order: number; rows: PatchAccount[] }[] {
  const m = new Map<string, { key: string; name: string; order: number; rows: PatchAccount[] }>();
  for (const r of rows) {
    const key = r.stage_key ?? "none";
    const g = m.get(key) ?? {
      key,
      name: r.stage_name ?? "No stage",
      order: r.stage_order ?? 0,
      rows: [],
    };
    g.rows.push(r);
    m.set(key, g);
  }
  return [...m.values()].sort((a, b) => b.order - a.order);
}

/* ------------------------------------------------------------- coverage map */

export type CoverageBand = "recent" | "cooling" | "cold" | "untouched";

export type AreaRecency = {
  area: string;
  accounts: number;
  visitedAccounts: number;
  /** Deals in this area nobody has ever driven out to. */
  unvisitedProspects: number;
  /** Open value sitting in the area, from the accounts counted above. */
  value: number;
  lastVisitAt: string | null;
  ageDays: number | null;
  band: CoverageBand;
  /** Centroid of recorded visit coordinates in this area, when there are any. */
  lat: number | null;
  lon: number | null;
};

export const BAND_COLOR: Record<CoverageBand, string> = {
  recent: "#1E9E6A",
  cooling: "#C8951C",
  cold: "#D9534F",
  untouched: "#5B6B7F",
};

export const BAND_LABEL: Record<CoverageBand, string> = {
  recent: "Worked recently",
  cooling: "Going cold",
  cold: "Cold",
  untouched: "Never visited",
};

function bandFor(ageDays: number | null, recentDays: number, coldDays: number): CoverageBand {
  if (ageDays === null) return "untouched";
  if (ageDays <= recentDays) return "recent";
  if (ageDays <= coldDays) return "cooling";
  return "cold";
}

/**
 * Areas shaded by how recently they were worked. Coordinates come from the
 * visits themselves — an area nobody has ever been to has no point to plot,
 * which is exactly why untouched areas are listed as well as shaded.
 */
export async function fetchCoverage(opts: {
  userId?: string | null;
  recentDays?: number;
  coldDays?: number;
  /** Defaults to pipeline deals — the visits that win new business. */
  scope?: CoverageScope;
}): Promise<AreaRecency[]> {
  const recentDays = opts.recentDays ?? 30;
  const coldDays = opts.coldDays ?? 90;
  const patch = await fetchPatch(opts.userId ?? null, { scope: opts.scope ?? "prospects" });
  const ids = patch.map((p) => p.id);

  const coords = new Map<string, { lat: number; lon: number; n: number }>();
  if (ids.length) {
    const { data, error } = await supabase
      .from("touchpoints")
      .select("account_id,lat,lon")
      .in("account_id", ids)
      .in("type", IN_PERSON_TYPES)
      .not("lat", "is", null)
      .limit(4000);
    if (error) throw error;
    const byAccount = new Map(patch.map((p) => [p.id, p.area]));
    for (const r of data ?? []) {
      const area = byAccount.get(r.account_id as string);
      if (!area) continue;
      const cur = coords.get(area) ?? { lat: 0, lon: 0, n: 0 };
      cur.lat += Number(r.lat);
      cur.lon += Number(r.lon);
      cur.n += 1;
      coords.set(area, cur);
    }
  }

  const m = new Map<string, AreaRecency>();
  for (const a of patch) {
    const row =
      m.get(a.area) ??
      ({
        area: a.area,
        accounts: 0,
        visitedAccounts: 0,
        unvisitedProspects: 0,
        value: 0,
        lastVisitAt: null,
        ageDays: null,
        band: "untouched",
        lat: null,
        lon: null,
      } as AreaRecency);
    row.accounts += 1;
    row.value += a.value;
    if (a.last_visit_at) {
      row.visitedAccounts += 1;
      if (!row.lastVisitAt || a.last_visit_at > row.lastVisitAt) row.lastVisitAt = a.last_visit_at;
    } else if (a.kind === "prospect") {
      row.unvisitedProspects += 1;
    }
    m.set(a.area, row);
  }

  for (const row of m.values()) {
    row.ageDays = daysSince(row.lastVisitAt);
    row.band = bandFor(row.ageDays, recentDays, coldDays);
    const c = coords.get(row.area);
    if (c && c.n) {
      row.lat = c.lat / c.n;
      row.lon = c.lon / c.n;
    }
  }

  const order: CoverageBand[] = ["untouched", "cold", "cooling", "recent"];
  return [...m.values()].sort(
    (a, b) => order.indexOf(a.band) - order.indexOf(b.band) || b.accounts - a.accounts,
  );
}

/* ---------------------------------------------------------------- geometry */

export function distanceKm(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}
