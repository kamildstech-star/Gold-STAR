/**
 * Where a rep's day starts and ends, remembered.
 *
 * Mark: "the user should put in their ending points so the system can make
 * the route smart." An end point is the sort of thing that is the same every
 * day — home, or the office — so it is stored per person in
 * `user_view_prefs`, the same table the card density and the sidebar order
 * use, and follows them from the phone to the desk. It is not in the URL: the
 * Routes page carries no URL state today, and a route link a rep shares
 * should not carry their home address with it.
 *
 * The departure time is deliberately NOT here. It is a per-day answer
 * ("leaving at nine today"), and remembering yesterday's would make every
 * route look like it leaves at the wrong time.
 */
import * as React from "react";

import { supabase } from "@/integrations/supabase/client";
import type { EndChoice, StartChoice } from "@/lib/route-optimize";

export const ROUTE_PLANNER_PREFS_SCOPE = "route_planner_endpoints";

export type RoutePlannerPrefs = {
  start: StartChoice;
  end: EndChoice;
  /**
   * Put the stops in the fastest order on their own, whenever the stops change.
   *
   * ON by default since 18 Sep. It shipped off — each Directions call is billed
   * — and Melly's 17 Sep session is what that cost: he picked stops, got them
   * back in the order he had clicked, and said "It's just making the order
   * based on what you're clicking on, which is stupid." The optimiser was
   * built, wired and working; it was sitting behind a preference he never
   * found. A feature nobody turns on is a feature that does not exist.
   */
  autoOptimize: boolean;
};

export const DEFAULT_ROUTE_PLANNER_PREFS: RoutePlannerPrefs = {
  start: { kind: "current" },
  end: { kind: "same" },
  autoOptimize: true,
};

/** Anything malformed falls back field by field, never as a whole. */
export function parseRoutePlannerPrefs(raw: string | null | undefined): RoutePlannerPrefs {
  if (!raw) return DEFAULT_ROUTE_PLANNER_PREFS;
  try {
    const p = JSON.parse(raw) as Partial<RoutePlannerPrefs> | null;
    if (!p || typeof p !== "object") return DEFAULT_ROUTE_PLANNER_PREFS;
    const start: StartChoice =
      p.start?.kind === "office" && typeof p.start.id === "string"
        ? { kind: "office", id: p.start.id }
        : { kind: "current" };
    let end: EndChoice = { kind: "same" };
    if (p.end?.kind === "last-stop") end = { kind: "last-stop" };
    else if (
      p.end?.kind === "address" &&
      typeof p.end.label === "string" &&
      typeof p.end.lat === "number" &&
      typeof p.end.lon === "number"
    ) {
      end = { kind: "address", label: p.end.label, lat: p.end.lat, lon: p.end.lon };
    }
    /*
     * `!== false`, not `=== true`. Every rep who used the planner before 18 Sep
     * has a saved row with no `autoOptimize` key in it at all, and reading that
     * absence as "off" would leave exactly the people who already tried Routes
     * — Melly included — still looking at their own click order. An explicit
     * false, from somebody who turned it off on purpose, is still honoured.
     */
    return { start, end, autoOptimize: p.autoOptimize !== false };
  } catch {
    return DEFAULT_ROUTE_PLANNER_PREFS;
  }
}

export async function loadRoutePlannerPrefs(userId: string): Promise<RoutePlannerPrefs> {
  const { data } = await supabase
    .from("user_view_prefs")
    .select("view_mode")
    .eq("user_id", userId)
    .eq("scope", ROUTE_PLANNER_PREFS_SCOPE)
    .maybeSingle();
  return parseRoutePlannerPrefs(data?.view_mode);
}

export async function saveRoutePlannerPrefs(
  userId: string,
  prefs: RoutePlannerPrefs,
): Promise<void> {
  const { error } = await supabase.from("user_view_prefs").upsert(
    {
      user_id: userId,
      scope: ROUTE_PLANNER_PREFS_SCOPE,
      view_mode: JSON.stringify(prefs),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,scope" },
  );
  if (error) throw error;
}

/**
 * Read once, written on every change. As with the card density, a failed
 * read is the default and a failed write is silent: the planner in front of
 * the rep has already changed.
 */
export function useRoutePlannerPrefs(userId: string | null | undefined): {
  prefs: RoutePlannerPrefs;
  loaded: boolean;
  update: (patch: Partial<RoutePlannerPrefs>) => void;
} {
  const [prefs, setPrefs] = React.useState<RoutePlannerPrefs>(DEFAULT_ROUTE_PLANNER_PREFS);
  const [loaded, setLoaded] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    if (!userId) {
      setLoaded(true);
      return;
    }
    loadRoutePlannerPrefs(userId)
      .then((p) => {
        if (cancelled) return;
        setPrefs(p);
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const update = React.useCallback(
    (patch: Partial<RoutePlannerPrefs>) => {
      setPrefs((prev) => {
        const next = { ...prev, ...patch };
        if (userId) void saveRoutePlannerPrefs(userId, next).catch(() => {});
        return next;
      });
    },
    [userId],
  );

  return { prefs, loaded, update };
}
