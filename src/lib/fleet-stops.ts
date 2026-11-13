export type FleetSample = {
  id: string;
  lat: number;
  lon: number;
  occurred_at: string;
  speed_mph: number | null;
};

export type FleetStop = {
  id: string;
  lat: number;
  lon: number;
  startedAt: string;
  endedAt: string;
  minutes: number;
};

/** Invalid fixes cannot form a route; repeated samples cannot extend a stop. */
export function orderedFleetSamples<T extends FleetSample>(samples: T[]): T[] {
  const seen = new Set<string>();
  return samples
    .filter(
      (p) =>
        Number.isFinite(p.lat) &&
        Math.abs(p.lat) <= 90 &&
        Number.isFinite(p.lon) &&
        Math.abs(p.lon) <= 180 &&
        Number.isFinite(Date.parse(p.occurred_at)),
    )
    .slice()
    .sort(
      (a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at) || a.id.localeCompare(b.id),
    )
    .filter((p) => {
      const key = `${Date.parse(p.occurred_at)}:${p.lat}:${p.lon}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function distance(a: FleetSample, b: FleetSample): number {
  const radians = Math.PI / 180;
  const h =
    Math.sin(((b.lat - a.lat) * radians) / 2) ** 2 +
    Math.cos(a.lat * radians) *
      Math.cos(b.lat * radians) *
      Math.sin(((b.lon - a.lon) * radians) / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}

/**
 * Observed stationary intervals over 30 minutes, allowing 50m GPS jitter.
 * Missing speed is unknown, and gaps over 10 minutes break continuity.
 * Never infer parking across a telemetry outage or extend it to the current time.
 */
export function fleetStops(samples: FleetSample[]): FleetStop[] {
  const stops: FleetStop[] = [];
  let start: FleetSample | undefined;
  let end: FleetSample | undefined;
  function flush() {
    if (start && end) {
      const minutes = (Date.parse(end.occurred_at) - Date.parse(start.occurred_at)) / 60000;
      if (minutes > 30)
        stops.push({
          id: `stop-${start.id}`,
          lat: start.lat,
          lon: start.lon,
          startedAt: start.occurred_at,
          endedAt: end.occurred_at,
          minutes,
        });
    }
    start = end = undefined;
  }
  for (const p of orderedFleetSamples(samples)) {
    if (
      p.speed_mph == null ||
      !Number.isFinite(p.speed_mph) ||
      p.speed_mph < 0 ||
      p.speed_mph > 3
    ) {
      flush();
      continue;
    }
    if (
      start &&
      end &&
      (distance(start, p) > 50 || Date.parse(p.occurred_at) - Date.parse(end.occurred_at) > 600000)
    )
      flush();
    start ??= p;
    end = p;
  }
  flush();
  return stops;
}
