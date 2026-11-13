/**
 * Does a geocoded fire fall inside a watch area?
 *
 * A watch area is a town (with an optional county) Gold Star wants fires
 * from, with three ways to say where its edge is — whichever the admin
 * filled in:
 *  - a centre and a radius (seeded from each office's own coordinates);
 *  - a set of ZIP codes;
 *  - neither, in which case the fire's town must BE the area's town.
 * A fire inside any active area is in. One outside every area is skipped
 * as "outside_areas" and stays in the run log, so an admin can see the feed
 * found it and widen an area if it should have counted.
 */
import { milesBetween, normalizeLocality } from "./dedupe";
import type { WatchArea } from "./types";

export interface PlacedFire {
  lat: number | null;
  lon: number | null;
  postalCode: string | null;
  locality: string | null;
  state: string | null;
}

export type AreaMatch = { area: WatchArea; by: "radius" | "zip" | "town" };

function inArea(f: PlacedFire, a: WatchArea): AreaMatch["by"] | null {
  if (f.state && a.state && f.state.toUpperCase() !== a.state.toUpperCase()) return null;
  if (f.postalCode && a.postal_codes.includes(f.postalCode.slice(0, 5))) return "zip";
  if (a.center_lat != null && a.center_lon != null && f.lat != null && f.lon != null) {
    const d = milesBetween({ lat: a.center_lat, lon: a.center_lon }, { lat: f.lat, lon: f.lon });
    return d <= a.radius_miles ? "radius" : null;
  }
  if (a.postal_codes.length > 0) return null;
  const fl = normalizeLocality(f.locality);
  const al = normalizeLocality(a.locality);
  return fl && al && fl === al ? "town" : null;
}

/**
 * The area this fire belongs to. When several contain it (two offices'
 * circles overlap), the one the source was asked about wins, then the
 * nearest centre.
 */
export function areaForFire(
  f: PlacedFire,
  areas: readonly WatchArea[],
  hintAreaId: string | null,
): AreaMatch | null {
  const hits: AreaMatch[] = [];
  for (const a of areas) {
    if (!a.active) continue;
    const by = inArea(f, a);
    if (by) hits.push({ area: a, by });
  }
  if (hits.length === 0) return null;
  const hinted = hits.find((h) => h.area.id === hintAreaId);
  if (hinted) return hinted;
  if (f.lat == null || f.lon == null) return hits[0]!;
  const dist = (h: AreaMatch) =>
    h.area.center_lat == null || h.area.center_lon == null
      ? Number.POSITIVE_INFINITY
      : milesBetween(
          { lat: h.area.center_lat, lon: h.area.center_lon },
          { lat: f.lat!, lon: f.lon! },
        );
  return [...hits].sort((x, y) => dist(x) - dist(y))[0]!;
}

/** "Lakewood, NJ" — what an area is called on screen and in a geocoding query. */
export function areaPlaceName(a: Pick<WatchArea, "locality" | "county" | "state">): string {
  const where = a.locality ?? (a.county ? `${a.county.replace(/\s+county$/i, "")} County` : "");
  return [where, a.state].filter(Boolean).join(", ");
}
