/**
 * Pure viewport maths for map surfaces: which points are on screen, how to
 * collapse a crowded view into clusters, and how to cap a marker set. No
 * Google types here so it can be unit-tested.
 */

export type GeoPoint = { lat: number; lon: number };

export type Viewport = {
  north: number;
  south: number;
  east: number;
  west: number;
  zoom: number;
};

/** True when the point sits inside the viewport, allowing for a dateline crossing. */
export function inViewport(p: GeoPoint, vp: Viewport): boolean {
  if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return false;
  if (p.lat < vp.south || p.lat > vp.north) return false;
  if (vp.west <= vp.east) return p.lon >= vp.west && p.lon <= vp.east;
  // The view straddles the dateline: the visible longitudes are two disjoint bands.
  return p.lon >= vp.west || p.lon <= vp.east;
}

/** Everything on screen; a null viewport (map not ready yet) keeps everything. */
export function filterToViewport<T extends GeoPoint>(points: T[], vp: Viewport | null): T[] {
  if (!vp) return points;
  return points.filter((p) => inViewport(p, vp));
}

export type Cluster<T extends GeoPoint> = {
  id: string;
  lat: number;
  lon: number;
  count: number;
  items: T[];
};

/** Degrees of longitude per screen pixel at a Web Mercator zoom level. */
export function degreesPerPixel(zoom: number): number {
  return 360 / (256 * Math.pow(2, Math.max(0, zoom)));
}

/**
 * Grid clustering: points closer together than `cellPx` on screen share one
 * cluster. Cheap, deterministic, and good enough for a few thousand accounts.
 * The point is that a crowded suburb reads as "38 here, zoom in" rather than
 * a blob of overlapping pins.
 */
export function clusterPoints<T extends GeoPoint & { id: string }>(
  points: T[],
  zoom: number,
  cellPx = 56,
): Cluster<T>[] {
  const cell = degreesPerPixel(zoom) * cellPx;
  const buckets = new Map<string, T[]>();
  for (const p of points) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
    const key = `${Math.floor(p.lat / cell)}:${Math.floor(p.lon / cell)}`;
    const list = buckets.get(key);
    if (list) list.push(p);
    else buckets.set(key, [p]);
  }
  const out: Cluster<T>[] = [];
  for (const [key, items] of buckets) {
    if (items.length === 1) {
      const only = items[0]!;
      out.push({ id: only.id, lat: only.lat, lon: only.lon, count: 1, items });
      continue;
    }
    const lat = items.reduce((a, p) => a + p.lat, 0) / items.length;
    const lon = items.reduce((a, p) => a + p.lon, 0) / items.length;
    out.push({ id: `cluster:${key}`, lat, lon, count: items.length, items });
  }
  return out;
}

/** The zoom to jump to when a cluster is tapped: close enough to break it up. */
export function zoomIntoCluster(zoom: number, maxZoom = 18): number {
  return Math.min(maxZoom, Math.floor(zoom) + 2);
}

/**
 * Whether zooming in can ever separate this cluster's members. Three
 * accounts geocoded to the same building share one coordinate, and a
 * cluster of them is still one grey pin at zoom 18 — so a tap that only ever
 * zooms is a tap that does nothing. Mark, on his phone:
 *
 *   "tapping pins dont work to add them as a staop"
 *
 * The map already sits at the ceiling, or the members would still share a
 * cell at the ceiling: either way there is nothing to zoom into, and the
 * caller opens the cluster as a list instead.
 */
export function clusterSplitsOnZoom<T extends GeoPoint & { id: string }>(
  cluster: Cluster<T>,
  zoom: number,
  maxZoom = 18,
  cellPx = 56,
): boolean {
  if (cluster.count < 2) return false;
  if (zoomIntoCluster(zoom, maxZoom) <= zoom) return false;
  return clusterPoints(cluster.items, maxZoom, cellPx).length > 1;
}

/**
 * Keep the map honest when a view still holds more markers than is useful:
 * the nearest `max` to the centre are drawn and the caller says how many
 * were left out.
 */
export function capPoints<T extends GeoPoint>(
  points: T[],
  max: number,
  center: GeoPoint | null,
): { shown: T[]; hidden: number } {
  if (points.length <= max) return { shown: points, hidden: 0 };
  const c = center ?? {
    lat: points.reduce((a, p) => a + p.lat, 0) / points.length,
    lon: points.reduce((a, p) => a + p.lon, 0) / points.length,
  };
  const d2 = (p: GeoPoint) => (p.lat - c.lat) ** 2 + (p.lon - c.lon) ** 2;
  const shown = [...points].sort((a, b) => d2(a) - d2(b)).slice(0, max);
  return { shown, hidden: points.length - max };
}

/** Bounds that contain every point, or null when there are none. */
export function boundsOf(points: GeoPoint[]): Omit<Viewport, "zoom"> | null {
  const valid = points.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  if (!valid.length) return null;
  return {
    north: Math.max(...valid.map((p) => p.lat)),
    south: Math.min(...valid.map((p) => p.lat)),
    east: Math.max(...valid.map((p) => p.lon)),
    west: Math.min(...valid.map((p) => p.lon)),
  };
}
