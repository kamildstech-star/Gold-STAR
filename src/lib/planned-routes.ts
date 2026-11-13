/**
 * Routes a rep planned, kept — the "past routes" Mark asked for: "also maybe
 * add some past routes so we can see history".
 *
 * A row in `planned_routes` (migration 20260918110000) is the plan: the stops
 * in the order they were driven, the start and end, the departure, whether
 * Google put it in order. It is written when the rep opens the route in Maps
 * — that is the moment a route is driven — or taps Save route on one still
 * being built. Set beside the in-person visits logged that day it shows plan
 * versus what happened, which is what a manager wants from history.
 *
 * The table postdates the generated Supabase types and may not be applied
 * yet, so it is reached through an untyped client and a missing table is
 * "no history", never an error on the page. Same pattern as
 * `fetchCompanyClosures` in working-days.ts.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { supabase } from "@/integrations/supabase/client";

/**
 * A stored start or end. Coordinates are null when the route left from
 * "current location" and the device never gave one — the route was still
 * driven, Maps used the phone's own position. `id` is the office, so the
 * route can be reloaded starting from the same one.
 */
export type PlannedRoutePoint = {
  kind: "current" | "office" | "address";
  label: string;
  lat: number | null;
  lon: number | null;
  id?: string;
};

export type PlannedRouteStop = {
  account_id: string | null;
  job_id: string | null;
  kind: string;
  name: string;
  address: string | null;
  lat: number | null;
  lon: number | null;
  /** Minutes of driving to reach this stop from the one before, when optimised. */
  leg_minutes: number | null;
};

export type PlannedRouteEnd = PlannedRoutePoint | { kind: "last-stop" };

export type PlannedRoute = {
  id: string;
  created_by: string;
  location_id: string | null;
  planned_for: string;
  departure_at: string | null;
  name: string;
  start_point: PlannedRoutePoint;
  end_point: PlannedRouteEnd;
  stops: PlannedRouteStop[];
  optimised: boolean;
  total_minutes: number | null;
  total_km: number | null;
  opened_in_maps_at: string | null;
  created_at: string;
};

export type NewPlannedRoute = Omit<
  PlannedRoute,
  "id" | "created_by" | "created_at" | "opened_in_maps_at"
> & { created_by: string; opened_in_maps_at?: string | null };

/** 42P01 / PGRST205 mean the migration is outstanding, not that the query was wrong. */
export function plannedRoutesUnavailable(err: unknown): boolean {
  const e = err as { code?: string; message?: string; details?: string } | null;
  if (!e) return false;
  if (e.code === "42P01" || e.code === "PGRST205") return true;
  return /does not exist|could not find the table/i.test(`${e.message ?? ""} ${e.details ?? ""}`);
}

const db = () => supabase as unknown as SupabaseClient;

const COLUMNS =
  "id,created_by,location_id,planned_for,departure_at,name,start_point,end_point,stops,optimised,total_minutes,total_km,opened_in_maps_at,created_at";

/**
 * Newest first. A rep id narrows to that rep; otherwise everything RLS
 * allows, which for a manager is their offices. `available: false` is the
 * migration not being applied yet, and the caller hides the feature.
 */
export async function fetchPlannedRoutes(opts: {
  userId?: string | null;
  limit?: number;
}): Promise<{ available: boolean; routes: PlannedRoute[] }> {
  let q = db()
    .from("planned_routes")
    .select(COLUMNS)
    .order("planned_for", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(opts.limit ?? 30);
  if (opts.userId) q = q.eq("created_by", opts.userId);
  const { data, error } = await q;
  if (error) {
    if (plannedRoutesUnavailable(error)) return { available: false, routes: [] };
    throw error;
  }
  return {
    available: true,
    routes: ((data ?? []) as unknown as PlannedRoute[]).map((r) => ({
      ...r,
      planned_for: String(r.planned_for).slice(0, 10),
      stops: Array.isArray(r.stops) ? r.stops : [],
      total_km: r.total_km == null ? null : Number(r.total_km),
    })),
  };
}

export async function savePlannedRoute(route: NewPlannedRoute): Promise<PlannedRoute> {
  const { data, error } = await db()
    .from("planned_routes")
    .insert({
      created_by: route.created_by,
      location_id: route.location_id,
      planned_for: route.planned_for,
      departure_at: route.departure_at,
      name: route.name,
      start_point: route.start_point,
      end_point: route.end_point,
      stops: route.stops,
      optimised: route.optimised,
      total_minutes: route.total_minutes,
      total_km: route.total_km,
      opened_in_maps_at: route.opened_in_maps_at ?? null,
    })
    .select(COLUMNS)
    .single();
  if (error) throw error;
  return data as unknown as PlannedRoute;
}

export async function markOpenedInMaps(id: string): Promise<void> {
  const { error } = await db()
    .from("planned_routes")
    .update({ opened_in_maps_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

export async function deletePlannedRoute(id: string): Promise<void> {
  const { error } = await db().from("planned_routes").delete().eq("id", id);
  if (error) throw error;
}

/* ------------------------------------------------------------------ pure */

/** Local calendar date of a departure, the key `planned_for` is compared on. */
export function dayKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "Sep 17 · Acme Roofing → Bay Ridge Plumbing", or just the date for one stop. */
export function plannedRouteName(plannedFor: string, stops: { name: string }[]): string {
  const [y, m, d] = plannedFor.split("-").map(Number);
  const date = new Date(y!, (m ?? 1) - 1, d ?? 1).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
  const first = stops[0]?.name;
  const last = stops[stops.length - 1]?.name;
  if (!first) return date;
  if (stops.length === 1 || first === last) return `${date} · ${first}`;
  return `${date} · ${first} → ${last}`;
}

/** Same date, in the rep's own calendar: one visit row per touchpoint. */
export type DayVisit = { account_id: string | null; occurred_at: string };

/**
 * Which of a route's stops got an in-person visit logged on the day it was
 * planned for. A stop is matched by account, a visit by the local date of
 * `occurred_at` — the same day key `planned_for` holds.
 */
export function visitedStopIds(route: PlannedRoute, visits: DayVisit[]): Set<string> {
  const onDay = new Set<string>();
  for (const v of visits) {
    if (!v.account_id) continue;
    if (dayKey(new Date(v.occurred_at)) === route.planned_for) onDay.add(v.account_id);
  }
  const hit = new Set<string>();
  for (const s of route.stops) if (s.account_id && onDay.has(s.account_id)) hit.add(s.account_id);
  return hit;
}

/** The date window that covers every route in the list, for one visits fetch. */
export function routesDateRange(routes: PlannedRoute[]): { from: Date; to: Date } | null {
  if (!routes.length) return null;
  const days = routes.map((r) => r.planned_for).sort();
  const [fy, fm, fd] = days[0]!.split("-").map(Number);
  const [ty, tm, td] = days[days.length - 1]!.split("-").map(Number);
  return {
    from: new Date(fy!, fm! - 1, fd!, 0, 0, 0, 0),
    to: new Date(ty!, tm! - 1, td!, 23, 59, 59, 999),
  };
}

/**
 * Reloading a route into the planner: the stops still in the book, and the
 * names of those that are not, so the rep is told rather than left one short.
 */
export function splitReloadableStops(
  route: PlannedRoute,
  inBook: (accountId: string) => boolean,
): { ids: string[]; missing: string[] } {
  const ids: string[] = [];
  const missing: string[] = [];
  for (const s of route.stops) {
    if (s.account_id && inBook(s.account_id)) ids.push(s.account_id);
    else missing.push(s.name);
  }
  return { ids, missing };
}
