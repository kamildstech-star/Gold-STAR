import * as React from "react";

import { geocodeAddresses } from "@/lib/geocode.functions";
import {
  fetchCachedGeocodes,
  fetchLastVisitCoords,
  geocodeCacheKey,
  resolveStopPositions,
  stopAddressQuery,
  unresolvedQueries,
  type GeoHit,
  type StopPosition,
} from "@/lib/stop-positions";
import type { PlannableStop } from "@/lib/visits";

/** How many un-geocoded addresses one page load will pay for. */
const MAX_NEW_PER_LOAD = 200;
const BATCH = 20;

export type StopPositionsState = {
  positions: Map<string, StopPosition>;
  /** The cached answers have arrived — what can be shown instantly, is. */
  ready: boolean;
  /** Geocoding is still in flight — the map is filling in. */
  locating: boolean;
  /** Progress through this load's geocoding budget. */
  progress: { done: number; total: number };
  /** Stops with a street address that still have no answer. */
  pendingCount: number;
  error: string | null;
};

/**
 * Positions for every stop in the planner. Cached geocodes and past-visit
 * coordinates arrive in one round trip; addresses never geocoded before are
 * resolved in the background, twenty at a time, and the map fills in as they
 * land. Nothing here blocks the page.
 */
export function useStopPositions(stops: PlannableStop[]): StopPositionsState {
  const [geocoded, setGeocoded] = React.useState<Map<string, GeoHit>>(() => new Map());
  const [visitCoords, setVisitCoords] = React.useState<Map<string, { lat: number; lon: number }>>(
    () => new Map(),
  );
  const [ready, setReady] = React.useState(false);
  const [locating, setLocating] = React.useState(false);
  const [progress, setProgress] = React.useState({ done: 0, total: 0 });
  const [pendingCount, setPendingCount] = React.useState(0);
  const [error, setError] = React.useState<string | null>(null);

  // Re-run only when the set of stops (ids + addresses) actually changes.
  const signature = React.useMemo(
    () => stops.map((s) => `${s.id}|${stopAddressQuery(s) ?? ""}`).join("\n"),
    [stops],
  );

  React.useEffect(() => {
    setReady(false);
    setLocating(false);
    setProgress({ done: 0, total: 0 });
    setPendingCount(0);
    setError(null);
    if (!stops.length) {
      setGeocoded(new Map());
      setVisitCoords(new Map());
      setReady(true);
      return;
    }
    let cancelled = false;

    (async () => {
      setError(null);
      const queries = stops.map(stopAddressQuery).filter((q): q is string => Boolean(q));
      try {
        const [cached, visits] = await Promise.all([
          fetchCachedGeocodes(queries),
          fetchLastVisitCoords(stops.map((s) => s.id)),
        ]);
        if (cancelled) return;
        setGeocoded(cached);
        setVisitCoords(visits);
        setReady(true);

        let known = cached;
        let todo = unresolvedQueries(stops, known);
        const total = Math.min(todo.length, MAX_NEW_PER_LOAD);
        setProgress({ done: 0, total });
        setPendingCount(todo.length);
        if (!todo.length) return;

        setLocating(true);
        let done = 0;
        while (todo.length && done < MAX_NEW_PER_LOAD && !cancelled) {
          const batch = todo.slice(0, BATCH);
          const res = await geocodeAddresses({ data: { addresses: batch, maxNew: BATCH } });
          if (cancelled) return;
          const next = new Map(known);
          for (const r of res.rows) {
            next.set(
              r.query,
              r.resolved && r.lat != null && r.lon != null ? { lat: r.lat, lon: r.lon } : null,
            );
          }
          // An address the geocoder failed on transiently comes back without a
          // row. Mark it so this load does not spin on it; a reload retries.
          for (const q of batch) {
            const key = geocodeCacheKey(q);
            if (!next.has(key)) next.set(key, null);
          }
          known = next;
          setGeocoded(next);
          done += batch.length;
          setProgress({ done: Math.min(done, total), total });
          todo = unresolvedQueries(stops, known);
          setPendingCount(todo.length);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Could not locate the stops.");
      } finally {
        if (!cancelled) {
          setLocating(false);
          setReady(true);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  const positions = React.useMemo(
    () => resolveStopPositions(stops, geocoded, visitCoords),
    [stops, geocoded, visitCoords],
  );

  return { positions, ready, locating, progress, pendingCount, error };
}
