/*
 * Kept apart from address.functions.ts so the public intake handlers can use
 * it without importing the staff auth middleware.
 */
/** A point on the map, in degrees. */
export type GeoPoint = { lat: number; lon: number };

/**
 * A point a browser sent, made safe to use: real coordinates only, and
 * rounded — to about a kilometer for leaning suggestions (it is a hint, and
 * nobody's exact position needs to travel with every keystroke), or to about
 * a meter when it IS the address being asked for.
 */
export function cleanGeoPoint(raw: unknown, decimals = 2): GeoPoint | null {
  const p = raw as { lat?: unknown; lon?: unknown } | null | undefined;
  const lat = Number(p?.lat);
  const lon = Number(p?.lon);
  if (!p || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) return null;
  const f = 10 ** decimals;
  return { lat: Math.round(lat * f) / f, lon: Math.round(lon * f) / f };
}
