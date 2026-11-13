/// <reference types="google.maps" />
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { MapBoundary } from "@/components/error-boundary";
import {
  describeMapsFailure,
  loadGoogleMaps,
  mapsFailureOf,
  useMapsAuthFailed,
  type MapsFailure,
} from "@/lib/google-maps-loader";
import { fitMapToCoordinates } from "@/lib/map-camera";
import { pinGlyphDataUri, type PinGlyph } from "@/lib/map-pin-glyphs";
import type { Viewport } from "@/lib/map-viewport";

/**
 * Real Google basemap (tiles, streets, pan/zoom) shared by every map surface
 * in the app. No decorative grids: markers are real coordinates only.
 */

export type LiveMapMarker = {
  id: string;
  lat: number;
  lon: number;
  label?: string;
  /** Short text drawn inside the pin (queue rank, cluster count). */
  text?: string;
  /** Fill colour for the pin. */
  color?: string;
  /** Slightly larger, ringed pin (crews / vehicles). */
  emphasis?: boolean;
  active?: boolean;
  /** Explicit pin radius in px; overrides the size rules above. */
  scale?: number;
  /** White fill with the colour as the ring — a closed job beside an open one. */
  hollow?: boolean;
  /**
   * A small picture inside the pin saying what it is. Ignored when the pin
   * carries `text`: a route rank or a cluster count is the label there.
   */
  glyph?: PinGlyph;
};

/**
 * A card anchored above one pin — Google's own InfoWindow, so it looks the
 * way the Pipedrive map Mark sent does: white, a tail down to the pin, an ×
 * in the corner, one open at a time. The content is React, portalled into
 * the window's element, so the card is an ordinary component with links and
 * buttons in it.
 */
export type LiveMapCallout = {
  /** Anchors the window; a new id re-opens it at the new position. */
  id: string;
  lat: number;
  lon: number;
  /** Pin radius in px, so the tail sits on the ring and not over the dot. */
  offsetPx?: number;
  content: ReactNode;
};

const DARK_STYLE: google.maps.MapTypeStyle[] = [
  { elementType: "geometry", stylers: [{ color: "#0b1728" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#0b1728" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#7f92ab" }] },
  { featureType: "poi", stylers: [{ visibility: "off" }] },
  { featureType: "transit", stylers: [{ visibility: "off" }] },
  { featureType: "road", elementType: "geometry", stylers: [{ color: "#16263c" }] },
  { featureType: "road", elementType: "labels.text.fill", stylers: [{ color: "#5d7a9e" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#07101d" }] },
];

const LIGHT_STYLE: google.maps.MapTypeStyle[] = [
  { featureType: "poi", stylers: [{ visibility: "off" }] },
  { featureType: "transit", elementType: "labels.icon", stylers: [{ visibility: "off" }] },
];

/* Compatibility re-exports: older surfaces import the loader from here. */
export {
  loadGoogleMaps as loadMaps,
  mapsAuthFailed,
  useMapsAuthFailed,
} from "@/lib/google-maps-loader";

/** Shared copy so every map surface explains the same root cause. */
export const MAP_AUTH_MESSAGE = `${describeMapsFailure("auth").title} ${describeMapsFailure("auth").detail}`;

/** The radius a pin is drawn at — the one place the size rules live. */
function pinRadius(m: LiveMapMarker): number {
  if (m.scale !== undefined) return m.scale;
  if (m.text) return 11;
  if (m.glyph) return m.emphasis ? 11 : 9;
  return m.emphasis || m.active ? 8 : 6;
}

function pinIcon(m: LiveMapMarker): google.maps.Symbol | google.maps.Icon {
  if (m.glyph && !m.text) {
    const radius = pinRadius(m);
    return {
      url: pinGlyphDataUri({
        glyph: m.glyph,
        color: m.color ?? "#1B6ACB",
        radius,
        hollow: m.hollow,
        active: m.active,
      }),
      scaledSize: new google.maps.Size(radius * 2, radius * 2),
      anchor: new google.maps.Point(radius, radius),
    };
  }
  return {
    path: google.maps.SymbolPath.CIRCLE,
    scale: pinRadius(m),
    fillColor: m.hollow ? "#FFFFFF" : (m.color ?? "#1B6ACB"),
    fillOpacity: 1,
    strokeColor: m.hollow
      ? (m.color ?? "#1B6ACB")
      : m.active
        ? "var(--card)"
        : "rgba(255,255,255,.9)",
    strokeWeight: m.active ? 3 : m.hollow ? 2.5 : 2,
  };
}

/** A drive path drawn between consecutive stops of one day. */
export type LiveMapPath = {
  id: string;
  points: { lat: number; lon: number }[];
  color?: string;
  /** Repeating arrowheads showing which way the vehicle was travelling. */
  arrows?: boolean;
};

/** A shaded area — coverage bands, or the area a rep is targeting. */
export type LiveMapCircle = {
  id: string;
  lat: number;
  lon: number;
  /** Radius in metres. */
  radiusM: number;
  color?: string;
  opacity?: number;
};

/** An explicit camera position, applied whenever it changes. */
export type LiveMapView = { lat: number; lon: number; zoom: number };

function viewportOf(map: google.maps.Map): Viewport | null {
  const b = map.getBounds();
  if (!b) return null;
  const ne = b.getNorthEast();
  const sw = b.getSouthWest();
  /*
   * A zero-area viewport is not a viewport.
   *
   * Google fires `idle` as soon as it is constructed, and if the container has
   * not been laid out yet the bounds come back with all four corners equal.
   * Handing that upward filtered EVERY pin off the map, and nothing recomputed
   * until a pan or a zoom produced real bounds — Melly, 17 Sep: "unless I
   * scroll it doesn't populate." Null instead, which the caller already reads
   * as "map not ready, keep everything".
   */
  if (ne.lat() === sw.lat() || ne.lng() === sw.lng()) return null;
  return {
    north: ne.lat(),
    south: sw.lat(),
    east: ne.lng(),
    west: sw.lng(),
    zoom: map.getZoom() ?? 0,
  };
}

/** What the surface shows instead of tiles when the SDK cannot be used. */
function MapFailurePanel({ reason, onRetry }: { reason: MapsFailure; onRetry?: () => void }) {
  const copy = describeMapsFailure(reason);
  return (
    <div
      role="alert"
      className="absolute inset-0 grid place-items-center bg-muted/40 p-4 text-center"
    >
      <div className="max-w-md space-y-1.5 rounded-lg border bg-card/95 px-4 py-3 shadow-sm">
        <p className="text-[13px] font-semibold text-foreground">{copy.title}</p>
        <p className="text-[12px] text-muted-foreground">{copy.detail}</p>
        {reason === "script" && onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="mt-1 rounded-md border px-2.5 py-1 text-[12px] font-medium hover:bg-muted"
          >
            Try again
          </button>
        )}
      </div>
    </div>
  );
}

export function LiveMap({
  markers,
  emptyMessage,
  className,
  theme = "light",
  onSelect,
  center,
  height,
  traffic = false,
  paths,
  circles,
  onMapClick,
  preserveView = false,
  view,
  onViewportChange,
  fitKey,
  fitPoints,
  maxFitZoom,
  callout,
  onCalloutClose,
}: {
  markers: LiveMapMarker[];
  emptyMessage?: string;
  className?: string;
  theme?: "light" | "dark";
  onSelect?: (id: string) => void;
  center?: { lat: number; lon: number } | null;
  height?: number | string;
  /** Google's live traffic layer. */
  traffic?: boolean;
  paths?: LiveMapPath[];
  circles?: LiveMapCircle[];
  onMapClick?: (lat: number, lon: number) => void;
  /**
   * Fit the markers once, then leave the camera where the user put it.
   * Marker changes no longer refit; a `center` change pans to it; `view`
   * sets the camera explicitly. Off by default so existing surfaces keep
   * their fit-to-everything behaviour.
   */
  preserveView?: boolean;
  view?: LiveMapView | null;
  /** Fires after every pan/zoom settles with the visible bounds and zoom. */
  onViewportChange?: (vp: Viewport) => void;
  /**
   * Change this to refit the camera to the current markers on demand — the
   * "fit to my accounts" button, or the moment a data set finishes loading.
   */
  fitKey?: string | number;
  /** Full account set for fitting, independent of viewport-filtered display pins. */
  fitPoints?: { lat: number; lon: number }[];
  /** Limit automatic fitting without preventing the user from zooming in. */
  maxFitZoom?: number;
  /** The one card open above a pin, or nothing. */
  callout?: LiveMapCallout | null;
  /** The × on the card, or Escape while it has focus. */
  onCalloutClose?: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const markerRef = useRef<google.maps.Marker[]>([]);
  const resizeRef = useRef<ResizeObserver | null>(null);
  const pathRef = useRef<google.maps.Polyline[]>([]);
  const circleRef = useRef<google.maps.Circle[]>([]);
  const clickRef = useRef(onMapClick);
  clickRef.current = onMapClick;
  const viewportRef = useRef(onViewportChange);
  viewportRef.current = onViewportChange;
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;
  const trafficRef = useRef<google.maps.TrafficLayer | null>(null);
  const infoRef = useRef<google.maps.InfoWindow | null>(null);
  const calloutCloseRef = useRef(onCalloutClose);
  calloutCloseRef.current = onCalloutClose;
  const pointsRef = useRef<LiveMapMarker[]>([]);
  /** The element the callout's React content is portalled into. */
  const [calloutEl, setCalloutEl] = useState<HTMLDivElement | null>(null);
  /** Has the camera been fitted to data at least once? (preserveView only) */
  const fittedRef = useRef(false);
  /** The latest fit-to-markers routine, for on-demand refits. */
  const fitRef = useRef<() => void>(() => {});
  const fitCleanupRef = useRef<() => void>(() => {});
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [failure, setFailure] = useState<MapsFailure | null>(null);
  const [attempt, setAttempt] = useState(0);
  const authBlocked = useMapsAuthFailed();

  const points = useMemo(
    () => markers.filter((m) => Number.isFinite(m.lat) && Number.isFinite(m.lon)),
    [markers],
  );
  pointsRef.current = points;

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setFailure(null);
    loadGoogleMaps()
      .then(() => {
        if (cancelled || !ref.current) return;
        const map = new google.maps.Map(ref.current, {
          center: { lat: center?.lat ?? 40.7128, lng: center?.lon ?? -74.006 },
          zoom: 10,
          disableDefaultUI: true,
          zoomControl: true,
          gestureHandling: "greedy",
          styles: theme === "dark" ? DARK_STYLE : LIGHT_STYLE,
        });
        mapRef.current = map;
        fittedRef.current = false;
        map.addListener("click", (e: google.maps.MapMouseEvent) => {
          const ll = e.latLng;
          if (ll && clickRef.current) clickRef.current(ll.lat(), ll.lng());
        });
        const emitViewport = () => {
          const vp = viewportOf(map);
          if (vp && viewportRef.current) viewportRef.current(vp);
        };
        map.addListener("idle", emitViewport);

        /*
         * The other half of the first-paint fix. `idle` fires once at
         * construction and then only on a pan or a zoom, so a map that was
         * still zero-sized at that moment — a tab that was not visible, a
         * layout that had not settled — never got a second chance to report
         * real bounds, and the pins waited for a scroll that should not have
         * been necessary. Watching the container closes that gap at the source
         * rather than polling for it.
         */
        if (typeof ResizeObserver !== "undefined" && ref.current) {
          const ro = new ResizeObserver(() => emitViewport());
          ro.observe(ref.current);
          resizeRef.current = ro;
        }
        setStatus("ready");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setFailure(mapsFailureOf(err));
        setStatus("error");
      });
    return () => {
      cancelled = true;
      resizeRef.current?.disconnect();
      resizeRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme, attempt]);

  /* Drive paths between consecutive stops, and shaded coverage areas. */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;
    pathRef.current.forEach((p) => p.setMap(null));
    pathRef.current = (paths ?? []).map(
      (p) =>
        new google.maps.Polyline({
          map,
          path: p.points.map((pt) => ({ lat: pt.lat, lng: pt.lon })),
          strokeColor: p.color ?? "#1B6ACB",
          strokeOpacity: 0.85,
          strokeWeight: 3,
          /*
           * Arrowheads repeated along the line, not one at the end. A day
           * trail doubles back on itself constantly, and a single arrow at
           * the finish says nothing about the middle of the route.
           */
          icons: p.arrows
            ? [
                {
                  icon: {
                    path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
                    scale: 2.6,
                    strokeColor: p.color ?? "#1B6ACB",
                    fillColor: p.color ?? "#1B6ACB",
                    fillOpacity: 1,
                    strokeWeight: 1,
                  },
                  offset: "6%",
                  repeat: "90px",
                },
              ]
            : undefined,
        }),
    );
    return () => pathRef.current.forEach((p) => p.setMap(null));
  }, [paths, status]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;
    circleRef.current.forEach((c) => c.setMap(null));
    circleRef.current = (circles ?? []).map(
      (c) =>
        new google.maps.Circle({
          map,
          center: { lat: c.lat, lng: c.lon },
          radius: c.radiusM,
          fillColor: c.color ?? "#1B6ACB",
          fillOpacity: c.opacity ?? 0.18,
          strokeColor: c.color ?? "#1B6ACB",
          strokeOpacity: 0.6,
          strokeWeight: 1.5,
          clickable: false,
        }),
    );
    return () => circleRef.current.forEach((c) => c.setMap(null));
  }, [circles, status]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;
    if (traffic) {
      if (!trafficRef.current) trafficRef.current = new google.maps.TrafficLayer();
      trafficRef.current.setMap(map);
    } else {
      trafficRef.current?.setMap(null);
    }
  }, [traffic, status]);

  /* Markers. In the default mode the camera refits whenever they change. */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;
    markerRef.current.forEach((m) => m.setMap(null));
    markerRef.current = points.map((p) => {
      const marker = new google.maps.Marker({
        position: { lat: p.lat, lng: p.lon },
        map,
        icon: pinIcon(p),
        title: p.label,
        label: p.text
          ? { text: p.text, color: "var(--card)", fontSize: "11px", fontWeight: "700" }
          : undefined,
        zIndex: p.active ? 999 : p.emphasis ? 500 : undefined,
      });
      marker.addListener("click", () => selectRef.current?.(p.id));
      return marker;
    });
    const fit = () => {
      const targets = (fitPoints ?? points).filter(
        (p) => Number.isFinite(p.lat) && Number.isFinite(p.lon),
      );
      if (targets.length === 0) return;
      fitCleanupRef.current();
      fitCleanupRef.current = fitMapToCoordinates(map, targets, center, maxFitZoom);
      fittedRef.current = true;
    };
    fitRef.current = fit;
    const shouldFit = !preserveView || !fittedRef.current;
    if (shouldFit) fit();
    // The container is often 0-width on first paint (mobile, dialogs, resizable
    // panels) — refit whenever it actually gets its size, unless the user is
    // meant to keep the view they chose.
    const el = ref.current;
    let ro: ResizeObserver | null = null;
    if (el && typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => {
        if (!preserveView || !fittedRef.current) fit();
      });
      ro.observe(el);
    }
    return () => {
      ro?.disconnect();
      fitCleanupRef.current();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    points,
    fitPoints,
    maxFitZoom,
    status,
    preserveView ? null : center?.lat,
    preserveView ? null : center?.lon,
  ]);

  /* preserveView: a new centre (area search) pans there without a full refit. */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready" || !preserveView || !center) return;
    map.panTo({ lat: center.lat, lng: center.lon });
    if ((map.getZoom() ?? 0) < 12) map.setZoom(12);
    fittedRef.current = true;
  }, [preserveView, status, center?.lat, center?.lon]); // eslint-disable-line react-hooks/exhaustive-deps

  /* An on-demand refit to whatever is on the map right now. */
  const firstFitKey = useRef(true);
  useEffect(() => {
    if (status !== "ready" || fitKey === undefined) return;
    // The first value is the initial state, not a request.
    if (firstFitKey.current) {
      firstFitKey.current = false;
      return;
    }
    fitRef.current();
  }, [fitKey, status]);

  /* An explicit camera request (a tapped cluster). */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready" || !view) return;
    map.setCenter({ lat: view.lat, lng: view.lon });
    map.setZoom(view.zoom);
    fittedRef.current = true;
  }, [status, view]);

  /* The callout. One InfoWindow for the life of the map; opening it at a
   * new pin moves it, and a null callout closes it. The window's × fires
   * `closeclick`, which hands the close back to the page so its state and
   * the window never disagree about whether a card is open. */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;
    if (!callout) {
      infoRef.current?.close();
      setCalloutEl(null);
      return;
    }
    const el = document.createElement("div");
    el.className = "live-map-callout";
    if (!infoRef.current) {
      infoRef.current = new google.maps.InfoWindow({ maxWidth: 320 });
      infoRef.current.addListener("closeclick", () => calloutCloseRef.current?.());
    }
    const info = infoRef.current;
    // The tail sits on the pin's ring, whatever size that pin is drawn at.
    const pin = pointsRef.current.find((p) => p.id === callout.id);
    const offset = callout.offsetPx ?? (pin ? pinRadius(pin) + 2 : 8);
    info.setOptions({
      content: el,
      position: { lat: callout.lat, lng: callout.lon },
      pixelOffset: new google.maps.Size(0, -offset),
    });
    info.open({ map, shouldFocus: false });
    setCalloutEl(el);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, callout?.id, callout?.lat, callout?.lon, callout?.offsetPx]);

  useEffect(() => () => infoRef.current?.close(), []);

  const failed = authBlocked ? "auth" : failure;

  return (
    <MapBoundary className={className}>
      <div
        className={`relative overflow-hidden rounded-xl border ${className ?? ""}`}
        style={height ? { height } : undefined}
      >
        <div ref={ref} className="absolute inset-0" />
        {failed && <MapFailurePanel reason={failed} onRetry={() => setAttempt((n) => n + 1)} />}
        {!failed && (status !== "ready" || points.length === 0) && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 grid place-items-center p-3 text-center">
            <p className="pointer-events-auto max-w-md rounded-lg bg-background/90 px-3 py-1.5 text-[12px] text-muted-foreground shadow-sm">
              {status === "loading" ? "Loading map…" : (emptyMessage ?? "No mapped activity yet.")}
            </p>
          </div>
        )}
        {callout && calloutEl && createPortal(callout.content, calloutEl)}
      </div>
    </MapBoundary>
  );
}
