import { supabase } from "@/integrations/supabase/client";

/**
 * Routes — where a field rep has actually been.
 *
 * Nothing here is covert tracking: a point exists only because a visit or
 * meeting was recorded at a place. It reads the existing touchpoint records
 * rather than inventing a second history.
 */

export type Visit = {
  id: string;
  occurred_at: string;
  type: string;
  lat: number;
  lon: number;
  place_label: string | null;
  account_id: string | null;
  account_name: string | null;
  created_by: string | null;
  /** What the rep wrote down — the point of opening a past-visit pin on the map. */
  notes: string | null;
};

export async function fetchVisits(opts: {
  from: Date;
  to: Date;
  userId?: string | null;
}): Promise<Visit[]> {
  let q = supabase
    .from("touchpoints")
    .select("id,occurred_at,type,lat,lon,place_label,notes,account_id,created_by,accounts(name)")
    .not("lat", "is", null)
    .gte("occurred_at", opts.from.toISOString())
    .lte("occurred_at", opts.to.toISOString())
    .order("occurred_at", { ascending: true });
  if (opts.userId) q = q.eq("created_by", opts.userId);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []).map((r) => {
    const acc = r.accounts as { name: string } | null;
    return {
      id: r.id as string,
      occurred_at: r.occurred_at as string,
      type: r.type as string,
      lat: Number(r.lat),
      lon: Number(r.lon),
      place_label: (r.place_label as string | null) ?? null,
      account_id: (r.account_id as string | null) ?? null,
      account_name: acc?.name ?? null,
      created_by: (r.created_by as string | null) ?? null,
      notes: (r.notes as string | null) ?? null,
    };
  });
}

export type DayRoute = { day: string; visits: Visit[] };

/** Visits grouped into the days they were walked, newest day first. */
export function groupByDay(visits: Visit[]): DayRoute[] {
  const m = new Map<string, Visit[]>();
  for (const v of visits) {
    const d = v.occurred_at.slice(0, 10);
    m.set(d, [...(m.get(d) ?? []), v]);
  }
  return [...m.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([day, list]) => ({ day, visits: list }));
}

/** Rough kilometres walked, straight-line between consecutive stops. */
export function routeDistanceKm(visits: Visit[]): number {
  let km = 0;
  for (let i = 1; i < visits.length; i++) {
    const a = visits[i - 1]!;
    const b = visits[i]!;
    const dLat = ((b.lat - a.lat) * Math.PI) / 180;
    const dLon = ((b.lon - a.lon) * Math.PI) / 180;
    const lat1 = (a.lat * Math.PI) / 180;
    const lat2 = (b.lat * Math.PI) / 180;
    const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
    km += 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  return km;
}

/**
 * Coverage — which of the rep's *deals* were visited in the window and which
 * were not. Scoped to pipeline deals by default: a prospect nobody drove out
 * to is the gap that costs new business; an unvisited existing client is a
 * softer signal. Grouped by postcode, because that is the unit a rep actually
 * plans a day around.
 */
export type AreaCoverage = {
  area: string;
  accounts: number;
  visited: number;
};

export type CoverageScope = "prospects" | "clients" | "all";

// Coverage follows the rep selector, which now defaults to everyone the viewer
// can see, so "my patch" would be wrong most of the time it is read.
export const COVERAGE_SCOPE_LABEL: Record<CoverageScope, string> = {
  prospects: "Pipeline deals",
  clients: "Active clients",
  all: "Deals and clients",
};

export function inScope(kind: StopKind, scope: CoverageScope): boolean {
  if (scope === "all") return true;
  if (scope === "prospects") return kind === "prospect";
  return kind === "client";
}

export async function fetchAreaCoverage(opts: {
  from: Date;
  to: Date;
  userId?: string | null;
  scope?: CoverageScope;
}): Promise<AreaCoverage[]> {
  const scope = opts.scope ?? "prospects";
  let accQ = supabase
    .from("accounts")
    .select("id,postal_code,city,stage,stage_id")
    .is("archived_at", null);
  if (opts.userId) accQ = accQ.eq("assigned_rep", opts.userId);

  const [{ data: accounts, error }, stages, visits] = await Promise.all([
    accQ,
    fetchProspectingStages(),
    fetchVisits(opts),
  ]);
  if (error) throw error;

  const visited = new Set(visits.map((v) => v.account_id).filter(Boolean) as string[]);

  const m = new Map<string, AreaCoverage>();
  for (const a of accounts ?? []) {
    const stage = lookupStage(
      stages,
      (a.stage_id as string | null) ?? null,
      (a.stage as string | null) ?? null,
    );
    if (!inScope(classifyStage(stage), scope)) continue;
    const area =
      (a.postal_code as string | null)?.trim() || (a.city as string | null)?.trim() || "Unknown";
    const row = m.get(area) ?? { area, accounts: 0, visited: 0 };
    row.accounts += 1;
    if (visited.has(a.id as string)) row.visited += 1;
    m.set(area, row);
  }
  return [...m.values()].sort((a, b) => a.visited / a.accounts - b.visited / b.accounts);
}

/* ----------------------------------------------------------- logging a visit */

/**
 * Manual "log a visit". Visits live on `touchpoints` (type `meeting_in_person`)
 * rather than a second table, so the account timeline, cadence and coverage all
 * keep reading one history.
 */
export async function logVisit(input: {
  accountId: string;
  occurredAt?: string;
  lat?: number | null;
  lon?: number | null;
  placeLabel?: string | null;
  durationMinutes?: number | null;
  outcome?: string | null;
  notes?: string | null;
  userId: string | null;
}) {
  const notes = [input.outcome ? `Outcome: ${input.outcome}` : null, input.notes?.trim() || null]
    .filter(Boolean)
    .join("\n");
  const { error } = await supabase.from("touchpoints").insert({
    account_id: input.accountId,
    type: "meeting_in_person",
    direction: "outbound",
    occurred_at: input.occurredAt ?? new Date().toISOString(),
    lat: input.lat ?? null,
    lon: input.lon ?? null,
    place_label: input.placeLabel ?? null,
    duration_seconds: input.durationMinutes ? Math.round(input.durationMinutes * 60) : null,
    notes: notes || null,
    meeting_held: true,
    counts_toward_cadence: true,
    is_self_reported: true,
    capture_source: "manual",
    created_by: input.userId,
  });
  if (error) throw error;
}

/** Best-effort browser position; a visit can still be logged without one. */
export function currentPosition(): Promise<{ lat: number; lon: number } | null> {
  if (typeof navigator === "undefined" || !navigator.geolocation) return Promise.resolve(null);
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
      () => resolve(null),
      { timeout: 8000, maximumAge: 60_000 },
    );
  });
}

/* ------------------------------------------------------------ planning a day */

export type PlannableAccount = {
  id: string;
  name: string;
  address: string | null;
  area: string | null;
  last_in_person_at: string | null;
};

export async function fetchPlannableAccounts(userId: string | null): Promise<PlannableAccount[]> {
  let q = supabase
    .from("accounts")
    .select("id,name,address_line1,city,state,postal_code,last_in_person_at")
    .is("archived_at", null)
    .order("name");
  if (userId) q = q.eq("assigned_rep", userId);
  const { data, error } = await q.limit(500);
  if (error) throw error;
  return (data ?? []).map((a) => {
    const parts = [a.address_line1, a.city, a.state, a.postal_code].filter(Boolean) as string[];
    return {
      id: a.id as string,
      name: a.name as string,
      address: parts.length ? parts.join(", ") : null,
      area: ((a.postal_code as string | null)?.trim() || (a.city as string | null)?.trim()) ?? null,
      last_in_person_at: (a.last_in_person_at as string | null) ?? null,
    };
  });
}

/* --------------------------------------------------- prospecting stages */

/**
 * Routes exist so a rep can go and *win* business. The unit of that work is a
 * pipeline deal — a property manager, adjuster, broker or plumber being worked
 * on the Prospecting pipeline — not an account in general. A deal is
 * identified by its `stage_id` pointing at a stage of the Prospecting
 * pipeline; existing clients sit elsewhere (won stage, or the Farming
 * pipeline) and are secondary on this page.
 */
export type StopKind = "prospect" | "client" | "closed";

export const STOP_KIND_LABEL: Record<StopKind, string> = {
  prospect: "Pipeline deals",
  client: "Active clients",
  closed: "Closed / not working",
};

export type ProspectingStageRow = {
  id: string;
  key: string;
  name: string;
  sort_order: number;
  is_won: boolean;
  is_lost: boolean;
  /** The board's colour for the stage; the map card draws it as a dot. */
  color: string | null;
  /** Still being worked — neither won nor lost. This is what a rep drives to. */
  open: boolean;
};

export type ProspectingStages = {
  byId: Map<string, ProspectingStageRow>;
  byKey: Map<string, ProspectingStageRow>;
  /** Open stages in board order — the groups the stop picker renders. */
  open: ProspectingStageRow[];
};

const EMPTY_STAGES: ProspectingStages = { byId: new Map(), byKey: new Map(), open: [] };

/**
 * Every stage belonging to the Prospecting pipeline. Matched on the pipeline's
 * `kind`, falling back to its name, so a renamed or re-seeded pipeline still
 * resolves rather than silently emptying the planner.
 */
export async function fetchProspectingStages(): Promise<ProspectingStages> {
  const { data: pipes, error: pipeErr } = await supabase
    .from("pipelines")
    .select("id,name,kind,entity_type,is_active");
  if (pipeErr) throw pipeErr;

  const ids = (pipes ?? [])
    .filter(
      (p) =>
        (p.kind as string) === "prospecting" || /prospect/i.test((p.name as string | null) ?? ""),
    )
    .map((p) => p.id as string);
  if (!ids.length) return EMPTY_STAGES;

  const { data, error } = await supabase
    .from("pipeline_stages")
    .select("id,key,name,sort_order,is_won,is_lost,color,pipeline_id")
    .in("pipeline_id", ids)
    .order("sort_order");
  if (error) throw error;

  const byId = new Map<string, ProspectingStageRow>();
  const byKey = new Map<string, ProspectingStageRow>();
  for (const r of data ?? []) {
    const stage: ProspectingStageRow = {
      id: r.id as string,
      key: (r.key as string) ?? "",
      name: (r.name as string) ?? "Stage",
      sort_order: Number(r.sort_order ?? 0),
      is_won: Boolean(r.is_won),
      is_lost: Boolean(r.is_lost),
      color: (r.color as string | null) ?? null,
      open: !r.is_won && !r.is_lost,
    };
    byId.set(stage.id, stage);
    if (stage.key) byKey.set(stage.key, stage);
  }
  return {
    byId,
    byKey,
    open: [...byId.values()].filter((s) => s.open).sort((a, b) => a.sort_order - b.sort_order),
  };
}

/** Resolve a stage from whichever identifier a row happens to carry. */
export function lookupStage(
  stages: ProspectingStages,
  stageId: string | null,
  stageKey?: string | null,
): ProspectingStageRow | null {
  if (stageId) {
    const byId = stages.byId.get(stageId);
    if (byId) return byId;
  }
  if (stageKey) return stages.byKey.get(stageKey) ?? null;
  return null;
}

/**
 * An account with no Prospecting stage is an existing client — it has either
 * been handed to the Farming pipeline or never entered prospecting at all.
 */
export function classifyStage(stage: ProspectingStageRow | null): StopKind {
  if (!stage) return "client";
  if (stage.open) return "prospect";
  return stage.is_won ? "client" : "closed";
}

/**
 * Deal heat. A prospect nobody has ever been to outranks everything: that is
 * the signal the client cares about. After that, the later the stage the
 * closer the money, then value, then how stale the last visit is.
 */
export function prospectRank(input: {
  kind: StopKind;
  stageOrder: number | null;
  value: number;
  lastVisitAt: string | null;
}): number {
  const neverVisited = input.lastVisitAt === null;
  const ageDays = input.lastVisitAt
    ? Math.floor((Date.now() - new Date(input.lastVisitAt).getTime()) / 86_400_000)
    : 0;
  const kindWeight =
    input.kind === "prospect" ? 1_000_000 : input.kind === "client" ? 0 : -1_000_000;
  return (
    kindWeight +
    (neverVisited ? 500_000 : 0) +
    (input.stageOrder ?? 0) * 1_000 +
    Math.min(input.value, 1_000_000) / 1_000 +
    Math.min(ageDays, 720)
  );
}

/* ------------------------------------------------------- stops: deals + clients */

export type PlannableStop = {
  id: string;
  name: string;
  address: string | null;
  /** The street line on its own — what the geocoder needs to place a pin. */
  street: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  area: string | null;
  last_in_person_at: string | null;
  /** A stop is a pipeline deal when it sits on an open Prospecting stage. */
  kind: StopKind;
  stage_id: string | null;
  stage_key: string | null;
  stage_name: string | null;
  stage_order: number | null;
  value: number;
  /* ------------------------------------------------------ the map pin card
   * Mark, sent with a Pipedrive map: "it should show the current stage in the
   * pipeline and who the salesman is." Everything the card needs rides on the
   * same accounts read — embedded, never a second fetch per tap. */
  /** The board's colour for `stage_name`. */
  stage_color: string | null;
  /** The hand-set Farming health band, for a client card in place of the stage. */
  health_name: string | null;
  health_color: string | null;
  owner_id: string | null;
  owner_name: string | null;
  /** The primary contact, or the first one on the account. */
  contact_name: string | null;
  /** The contact's email and phone, falling back to the account's own. */
  email: string | null;
  phone: string | null;
};

/**
 * Everything a route can be built to, classified by whether it is a deal being
 * worked or a client already won. Deals live on the same account row — the
 * Prospecting stage is what makes one a deal rather than an existing client.
 *
 * WHO IS IN SCOPE
 * ---------------
 * `repId` null means every account the viewer is allowed to see; RLS is the
 * boundary and nothing is narrowed here. The Routes page used to pass the
 * viewer's own id unconditionally, so a manager planning a run for the office
 * only ever saw their own three accounts. Mark, on that page:
 *
 *   "This is supposed to be showing all the active clients, so you could
 *    choose a new route."
 *
 * A rep id narrows to that rep's book by `assigned_rep`. That is deliberately
 * the plain column and not `inRepBook`: this is a worklist — who should I
 * drive to today — and a house account with a rep's name on it is still one
 * that rep services. #172 left every worklist (`my-goals`, `coaching`,
 * `farming`, this file) on `assigned_rep` for exactly that reason; the house
 * rule is about crediting and transferring, not about who does the driving.
 *
 * THE CAP
 * -------
 * 500 rows, ordered by name, the same read and ceiling `fetchActiveClients`
 * uses for the whole non-archived book. If the book ever outgrows it the
 * accounts late in the alphabet would drop off silently — so the planner
 * compares what came back against this constant and says so, rather than
 * pretending the list is complete.
 */
export const PLANNABLE_STOPS_CAP = 500;

export async function fetchPlannableStops(repId: string | null): Promise<PlannableStop[]> {
  let q = supabase
    .from("accounts")
    .select(
      "id,name,address_line1,city,state,postal_code,last_in_person_at,stage,stage_id,estimated_annual_value,assigned_rep,email,phone,owner:profiles!accounts_assigned_rep_profiles_fkey(full_name),health:pipeline_stages!accounts_health_stage_id_fkey(name,color),contacts(full_name,email,phone,is_primary)",
    )
    .is("archived_at", null)
    .order("name");
  if (repId) q = q.eq("assigned_rep", repId);

  const [{ data, error }, stages] = await Promise.all([
    q.limit(PLANNABLE_STOPS_CAP),
    fetchProspectingStages(),
  ]);
  if (error) throw error;

  return (data ?? []).map((a) => {
    const parts = [a.address_line1, a.city, a.state, a.postal_code].filter(Boolean) as string[];
    const stage = lookupStage(
      stages,
      (a.stage_id as string | null) ?? null,
      (a.stage as string | null) ?? null,
    );
    const owner = (a.owner as { full_name: string | null } | null) ?? null;
    const health = (a.health as { name: string | null; color: string | null } | null) ?? null;
    const contacts =
      (a.contacts as
        | {
            full_name: string | null;
            email: string | null;
            phone: string | null;
            is_primary: boolean;
          }[]
        | null) ?? [];
    const contact = contacts.find((c) => c.is_primary) ?? contacts[0] ?? null;
    return {
      id: a.id as string,
      name: a.name as string,
      address: parts.length ? parts.join(", ") : null,
      street: (a.address_line1 as string | null)?.trim() || null,
      city: (a.city as string | null) ?? null,
      state: (a.state as string | null) ?? null,
      postal_code: (a.postal_code as string | null) ?? null,
      area: ((a.postal_code as string | null)?.trim() || (a.city as string | null)?.trim()) ?? null,
      last_in_person_at: (a.last_in_person_at as string | null) ?? null,
      kind: classifyStage(stage),
      stage_id: stage?.id ?? (a.stage_id as string | null) ?? null,
      stage_key: stage?.key ?? (a.stage as string | null) ?? null,
      stage_name: stage?.name ?? null,
      stage_order: stage?.sort_order ?? null,
      value: Number(a.estimated_annual_value ?? 0),
      stage_color: stage?.color ?? null,
      health_name: health?.name ?? null,
      health_color: health?.color ?? null,
      owner_id: (a.assigned_rep as string | null) ?? null,
      owner_name: owner?.full_name ?? null,
      contact_name: contact?.full_name?.trim() || null,
      email: contact?.email?.trim() || (a.email as string | null)?.trim() || null,
      phone: contact?.phone?.trim() || (a.phone as string | null)?.trim() || null,
    };
  });
}

/**
 * The sentence for an empty planner, worded for who is actually in scope. It
 * used to say "your book" unconditionally, which was true only because the
 * query was pinned to the viewer; now the same list is everyone's by default.
 */
export function plannerEmptyCopy(
  repId: string | null,
  viewerId: string | null,
  nearArea: boolean,
): string {
  if (!repId) return nearArea ? "Nothing near that area." : "No deals or clients to plan around.";
  const book = repId === viewerId ? "your book" : "this rep's book";
  return nearArea ? `Nothing in ${book} near that area.` : `No deals or clients in ${book}.`;
}

/** Inline fix for a stop with no address — writes straight to the account. */
export async function saveAccountAddress(
  accountId: string,
  parts: {
    address_line1: string;
    city: string | null;
    state: string | null;
    postal_code: string | null;
  },
) {
  const { error } = await supabase
    .from("accounts")
    .update({
      address_line1: parts.address_line1,
      city: parts.city,
      state: parts.state,
      postal_code: parts.postal_code,
    })
    .eq("id", accountId);
  if (error) throw error;
}

/**
 * Multi-stop route handed to whatever Maps app the device has. Same mechanism
 * the chase board uses: a maps directions URL, not an in-app navigator.
 */
export function buildMapsRouteUrl(stops: string[], origin?: string | null): string | null {
  const clean = stops.map((s) => s.trim()).filter(Boolean);
  if (!clean.length) return null;
  const destination = clean[clean.length - 1]!;
  const waypoints = clean.slice(0, -1);
  const params = new URLSearchParams({ api: "1", destination, travelmode: "driving" });
  if (origin) params.set("origin", origin);
  if (waypoints.length) params.set("waypoints", waypoints.join("|"));
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}
