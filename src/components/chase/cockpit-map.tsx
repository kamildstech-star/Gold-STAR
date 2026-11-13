/// <reference types="google.maps" />
import { useEffect, useMemo, useRef, useState } from "react";
import { Minus, Plus, LocateFixed } from "lucide-react";

import {
  describeMapsFailure,
  loadGoogleMaps,
  mapsFailureOf,
  useMapsAuthFailed,
  type MapsFailure,
} from "@/lib/google-maps-loader";
import { MapBoundary } from "@/components/error-boundary";
import { fireTypeLine, incidentSeverity, type Incident } from "@/lib/incidents";

/**
 * Chase cockpit map: a real Google basemap with Map/Satellite toggle, DOM
 * incident pins carrying unit-count badges, a pulsing ring on the newest
 * fire, the chaser's own position and an optimized route line to the
 * selected incident.
 */

const PIN_RED = "var(--destructive)";
const PIN_ORANGE = "#FA6702";
const PIN_AMBER = "#F2B01E";
const ROUTE_BLUE = "var(--primary)";

/*
 * 4 Nov: Google's own markers and lines cannot read a CSS variable — "you are
 * here" was drawn black, its ring and the route line too. Read the theme's
 * real colour off the page for them; the DOM pins keep the variables.
 */
function cssColor(v: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const name = /^var\((--[\w-]+)\)$/.exec(v)?.[1];
  if (!name) return v;
  const got = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return got || fallback;
}

/** Straight-line miles between two points. */
function milesBetween(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 3958.8;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function pinColor(i: Incident): string {
  const sev = incidentSeverity(i);
  if (sev === "high") return PIN_RED;
  if (sev === "med") return PIN_ORANGE;
  return PIN_AMBER;
}

type PinData = {
  id: string;
  lat: number;
  lon: number;
  color: string;
  units: number | null;
  pulse: boolean;
  active: boolean;
  /** Hover text: what and where — the click opens the alert's card. */
  label: string;
};

/** DOM overlay so pins can carry a badge and a CSS pulse ring. */
function makeOverlayClass() {
  return class PinOverlay extends google.maps.OverlayView {
    el: HTMLDivElement;
    pos: google.maps.LatLng;
    constructor(pin: PinData, onClick: () => void) {
      super();
      this.pos = new google.maps.LatLng(pin.lat, pin.lon);
      const el = document.createElement("div");
      el.className = "cockpit-pin" + (pin.active ? " is-active" : "");
      el.title = pin.label;
      el.setAttribute("role", "button");
      el.setAttribute("aria-label", pin.label);
      el.innerHTML = `
        ${pin.pulse ? `<span class="cockpit-pin-pulse" style="--pin:${pin.color}"></span>` : ""}
        <span class="cockpit-pin-dot" style="background:${pin.color}">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="#fff"><path d="M12 2c1 3-1 4-2 6s0 4 2 4 3-2 2-4c2 1 4 3 4 6a6 6 0 1 1-12 0c0-4 3-6 6-12z"/></svg>
        </span>
        ${pin.units && pin.units > 0 ? `<span class="cockpit-pin-badge">${pin.units}</span>` : ""}`;
      el.addEventListener("click", onClick);
      this.el = el;
    }
    onAdd() {
      this.getPanes()?.floatPane.appendChild(this.el);
    }
    draw() {
      const p = this.getProjection()?.fromLatLngToDivPixel(this.pos);
      if (!p) return;
      this.el.style.left = `${p.x}px`;
      this.el.style.top = `${p.y}px`;
    }
    onRemove() {
      this.el.remove();
    }
  };
}

export function CockpitMap({
  incidents,
  selectedId,
  onSelect,
  me,
  newestId,
  className,
}: {
  incidents: Incident[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  me?: { lat: number; lon: number } | null;
  newestId?: string | null;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const overlaysRef = useRef<google.maps.OverlayView[]>([]);
  const meRef = useRef<google.maps.Marker | null>(null);
  const lineRef = useRef<google.maps.Polyline | null>(null);
  const infoRef = useRef<google.maps.InfoWindow | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [failure, setFailure] = useState<MapsFailure | null>(null);
  const [type, setType] = useState<"map" | "satellite">("map");
  const authBlocked = useMapsAuthFailed();

  const pins = useMemo<PinData[]>(
    () =>
      incidents
        .filter((i) => Number.isFinite(i.lat) && Number.isFinite(i.lon))
        .map((i) => ({
          id: i.id,
          lat: i.lat as number,
          lon: i.lon as number,
          color: pinColor(i),
          units: i.units_dispatched ?? null,
          pulse: i.id === newestId,
          active: i.id === selectedId,
          label:
            [fireTypeLine(i), i.address, i.locality].filter(Boolean).join(" · ") +
            " — click for details",
        })),
    [incidents, selectedId, newestId],
  );

  useEffect(() => {
    let cancelled = false;
    loadGoogleMaps()
      .then(() => {
        if (cancelled || !ref.current) return;
        mapRef.current = new google.maps.Map(ref.current, {
          center: { lat: me?.lat ?? 40.7128, lng: me?.lon ?? -74.006 },
          zoom: 12,
          disableDefaultUI: true,
          gestureHandling: "greedy",
          styles: [
            { featureType: "poi", stylers: [{ visibility: "off" }] },
            {
              featureType: "transit",
              elementType: "labels.icon",
              stylers: [{ visibility: "off" }],
            },
          ],
        });
        setStatus("ready");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setFailure(mapsFailureOf(err));
        setStatus("error");
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    mapRef.current?.setMapTypeId(type === "map" ? "roadmap" : "hybrid");
  }, [type, status]);

  /* pins */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;
    overlaysRef.current.forEach((o) => o.setMap(null));
    const Cls = makeOverlayClass();
    overlaysRef.current = pins.map((p) => {
      const o = new Cls(p, () => onSelect(p.id));
      o.setMap(map);
      return o;
    });
    if (pins.length) {
      const b = new google.maps.LatLngBounds();
      pins.forEach((p) => b.extend({ lat: p.lat, lng: p.lon }));
      if (me) b.extend({ lat: me.lat, lng: me.lon });
      map.fitBounds(b, 64);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pins, status]);

  /* my position + route line */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;
    meRef.current?.setMap(null);
    lineRef.current?.setMap(null);
    if (me) {
      const target = pins.find((p) => p.id === selectedId);
      meRef.current = new google.maps.Marker({
        position: { lat: me.lat, lng: me.lon },
        map,
        title: "You are here — click for details",
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: 8,
          fillColor: cssColor(ROUTE_BLUE, "#a8880f"),
          fillOpacity: 1,
          strokeColor: cssColor("var(--card)", "#ffffff"),
          strokeWeight: 3,
        },
        zIndex: 5,
      });
      meRef.current.addListener("click", () => {
        const away = target ? milesBetween(me, target) : null;
        infoRef.current?.close();
        infoRef.current = new google.maps.InfoWindow({
          content: `<div style="font:13px/1.45 system-ui,sans-serif;min-width:180px">
            <div style="font-weight:600;margin-bottom:2px">Your location</div>
            <div>${me.lat.toFixed(5)}, ${me.lon.toFixed(5)}</div>
            ${
              target && away != null
                ? `<div style="margin-top:4px">${away.toFixed(1)} mi to the selected alert (straight line)</div>`
                : `<div style="margin-top:4px;color:#667085">Select an alert to see the distance and the route.</div>`
            }
            <div style="margin-top:4px;color:#667085">From this device's location; updates while the cockpit is open.</div>
          </div>`,
        });
        infoRef.current.open({ map, anchor: meRef.current ?? undefined });
      });
      if (target) {
        const svc = new google.maps.DirectionsService();
        void svc
          .route({
            origin: { lat: me.lat, lng: me.lon },
            destination: { lat: target.lat, lng: target.lon },
            travelMode: google.maps.TravelMode.DRIVING,
          })
          .then((res) => {
            const path = res.routes[0]?.overview_path;
            if (!path) return;
            lineRef.current?.setMap(null);
            lineRef.current = new google.maps.Polyline({
              path,
              map,
              strokeColor: cssColor(ROUTE_BLUE, "#a8880f"),
              strokeWeight: 5,
              strokeOpacity: 0.95,
            });
          })
          .catch(() => {
            lineRef.current = new google.maps.Polyline({
              path: [
                { lat: me.lat, lng: me.lon },
                { lat: target.lat, lng: target.lon },
              ],
              map,
              strokeColor: cssColor(ROUTE_BLUE, "#a8880f"),
              strokeWeight: 5,
              strokeOpacity: 0.9,
            });
          });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.lat, me?.lon, selectedId, status, pins.length]);

  const zoom = (d: number) => {
    const m = mapRef.current;
    if (m) m.setZoom((m.getZoom() ?? 12) + d);
  };

  return (
    <MapBoundary className={className}>
      <div className={"relative overflow-hidden " + (className ?? "")}>
        <div ref={ref} className="absolute inset-0" />

        {/* Map / Satellite toggle */}
        <div className="absolute left-3 top-3 flex overflow-hidden rounded-[6px] border border-[var(--border)] bg-card shadow-sm">
          {(["map", "satellite"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setType(t)}
              className={
                "px-3 py-1.5 text-[11px] font-bold uppercase tracking-[0.08em] " +
                (type === t
                  ? "bg-[#c2410c] text-white"
                  : "text-[var(--muted-foreground)] hover:bg-[var(--surface)]")
              }
            >
              {t}
            </button>
          ))}
        </div>

        {/* Legend */}
        <div className="absolute bottom-3 left-3 rounded-[8px] border border-[var(--border)] bg-card/95 px-3 py-2.5 shadow-sm">
          {[
            { c: PIN_RED, l: "New Dispatch" },
            { c: PIN_ORANGE, l: "Active Fire" },
            { c: ROUTE_BLUE, l: "Your Location" },
          ].map((r) => (
            <div
              key={r.l}
              className="flex items-center gap-2 py-[3px] text-[12px] text-[var(--foreground)]"
            >
              <span className="size-3.5 rounded-full" style={{ background: r.c }} />
              {r.l}
            </div>
          ))}
          <div className="flex items-center gap-2 py-[3px] text-[12px] text-[var(--foreground)]">
            <span className="h-[3px] w-3.5 rounded-full" style={{ background: ROUTE_BLUE }} />
            Optimized Route
          </div>
        </div>

        {/* Zoom controls */}
        <div className="absolute bottom-3 right-3 flex flex-col overflow-hidden rounded-[8px] border border-[var(--border)] bg-card shadow-sm">
          <button
            type="button"
            onClick={() => zoom(1)}
            className="grid size-9 place-items-center text-[var(--foreground)] hover:bg-[var(--surface)]"
          >
            <Plus className="size-4" />
          </button>
          <button
            type="button"
            onClick={() => zoom(-1)}
            className="grid size-9 place-items-center border-t border-[var(--border)] text-[var(--foreground)] hover:bg-[var(--surface)]"
          >
            <Minus className="size-4" />
          </button>
          <button
            type="button"
            onClick={() => me && mapRef.current?.panTo({ lat: me.lat, lng: me.lon })}
            className="grid size-9 place-items-center border-t border-[var(--border)] text-[var(--primary)] hover:bg-[var(--surface)]"
          >
            <LocateFixed className="size-4" />
          </button>
        </div>

        {(authBlocked || failure) && (
          <div
            role="alert"
            className="absolute inset-0 z-10 grid place-items-center bg-[#F2F5F9] p-4 text-center dark:bg-muted"
          >
            <div className="max-w-sm space-y-1">
              <p className="text-[13px] font-semibold">
                {describeMapsFailure(authBlocked ? "auth" : failure!).title}
              </p>
              <p className="text-[12px] text-[var(--muted-foreground)]">
                {describeMapsFailure(authBlocked ? "auth" : failure!).detail}
              </p>
            </div>
          </div>
        )}

        {!authBlocked && !failure && status !== "ready" && (
          <div className="absolute inset-x-0 bottom-0 grid place-items-center p-3">
            <p className="rounded-lg bg-card/90 px-3 py-1.5 text-[12px] text-[var(--muted-foreground)] shadow-sm">
              {status === "error" ? "Map unavailable." : "Loading map…"}
            </p>
          </div>
        )}
      </div>
    </MapBoundary>
  );
}
