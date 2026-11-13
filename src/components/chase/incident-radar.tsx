import { useMemo } from "react";

import { incidentSeverity, type Incident } from "@/lib/incidents";
import { LiveMap, type LiveMapMarker } from "@/components/live-map";

const SEV_COLOR: Record<string, string> = {
  critical: "#FF3B30",
  high: "#FF7A1A",
  medium: "#F5C518",
  low: "#4CB4FF",
};

/**
 * Command-centre map for the chase cockpit: a real dark basemap with one
 * marker per real incident row, colour-coded by derived severity.
 */
export function IncidentRadar({
  incidents,
  selectedId,
  onSelect,
  me,
  className,
}: {
  incidents: Incident[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  me?: { lat: number; lon: number } | null;
  className?: string;
}) {
  const markers = useMemo<LiveMapMarker[]>(() => {
    const pts = incidents.filter(
      (i) => typeof i.lat === "number" && typeof i.lon === "number",
    ) as (Incident & { lat: number; lon: number })[];
    const list: LiveMapMarker[] = pts.map((p) => ({
      id: p.id,
      lat: p.lat,
      lon: p.lon,
      label: p.address ?? "Incident",
      color: SEV_COLOR[String(incidentSeverity(p))] ?? "#FF7A1A",
      active: p.id === selectedId,
    }));
    if (me) {
      list.push({
        id: "__me",
        lat: me.lat,
        lon: me.lon,
        label: "You",
        color: "var(--card)",
        emphasis: true,
      });
    }
    return list;
  }, [incidents, selectedId, me]);

  return (
    <LiveMap
      markers={markers}
      theme="dark"
      onSelect={(id) => id !== "__me" && onSelect(id)}
      center={me ?? null}
      emptyMessage="No mapped incidents in the last 24 hours."
      className={"h-full min-h-[320px] " + (className ?? "")}
    />
  );
}
