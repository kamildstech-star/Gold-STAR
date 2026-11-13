import { LiveMap, type LiveMapMarker, type LiveMapPath } from "@/components/live-map";

export type MapPoint = {
  id: string;
  lat: number;
  lon: number;
  label: string;
  tone: "moving" | "idle" | "stale" | "incident";
};

const TONE_FILL: Record<MapPoint["tone"], string> = {
  moving: "var(--success)",
  idle: "#1B6ACB",
  stale: "#8A97A8",
  incident: "#E4572E",
};

/**
 * Real basemap for fleet positions. Every marker is a row from
 * vehicle_positions — with no Raven feed connected the map says so.
 */
export function FleetMap({
  points,
  emptyMessage,
  trail = false,
  stops = [],
}: {
  points: MapPoint[];
  emptyMessage: string;
  /**
   * One vehicle over one day, in order. A hundred identical dots say where it
   * has been but not which way it was going or where it ended up, so the trail
   * is drawn as an arrowed line with only its two ends marked.
   */
  trail?: boolean;
  stops?: MapPoint[];
}) {
  const last = points.length - 1;

  const markers: LiveMapMarker[] = trail
    ? points
        .map((p, i) => ({ p, i }))
        .filter(({ i }) => i === 0 || i === last)
        .map(({ p, i }) => ({
          id: p.id,
          lat: p.lat,
          lon: p.lon,
          label: i === last ? `Latest · ${p.label}` : `Start · ${p.label}`,
          color: i === last ? TONE_FILL.moving : "#8A97A8",
          emphasis: i === last,
          active: i === last,
        }))
    : points.map((p) => ({
        id: p.id,
        lat: p.lat,
        lon: p.lon,
        label: p.label,
        color: TONE_FILL[p.tone],
        emphasis: p.tone === "incident",
      }));

  const paths: LiveMapPath[] =
    trail && points.length > 1
      ? [
          {
            id: "trail",
            points: points.map((p) => ({ lat: p.lat, lon: p.lon })),
            color: "#1B6ACB",
            arrows: true,
          },
        ]
      : [];

  markers.push(
    ...stops.map((p) => ({
      id: p.id,
      lat: p.lat,
      lon: p.lon,
      label: p.label,
      color: TONE_FILL.idle,
      emphasis: true,
    })),
  );

  return (
    <LiveMap
      markers={markers}
      fitPoints={points}
      maxFitZoom={16}
      paths={paths}
      emptyMessage={emptyMessage}
      className="h-[320px] w-full sm:h-[420px]"
    />
  );
}
