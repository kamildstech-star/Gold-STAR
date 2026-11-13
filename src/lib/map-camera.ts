/// <reference types="google.maps" />

/** Fit the full dataset, then cap only the automatic zoom after Maps settles. */
export function fitMapToCoordinates(
  map: google.maps.Map,
  points: { lat: number; lon: number }[],
  center?: { lat: number; lon: number } | null,
  maxFitZoom?: number,
): () => void {
  const targets = points.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  if (!targets.length) return () => {};
  const bounds = new google.maps.LatLngBounds();
  targets.forEach((p) => bounds.extend({ lat: p.lat, lng: p.lon }));
  if (center) bounds.extend({ lat: center.lat, lng: center.lon });
  const limit = maxFitZoom ?? (targets.length === 1 ? 14 : undefined);
  const listener =
    limit === undefined
      ? undefined
      : google.maps.event.addListenerOnce(map, "idle", () => {
          const zoom = map.getZoom();
          if (zoom !== undefined && zoom > limit) map.setZoom(limit);
        });
  map.fitBounds(bounds, 48);
  return () => listener?.remove();
}
