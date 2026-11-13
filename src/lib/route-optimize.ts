/// <reference types="google.maps" />
/**
 * The smart order for a day's route.
 *
 * Mark, on the Routes page: "for routes it should give you a smart route
 * based on what you choose not just in the order you choose, and it should
 * take into account traffic if we could and the user should put in their
 * ending points so the system can make the route smart."
 *
 * So a route has a start (where the rep is, or their office), an end (back
 * to the start, a place of their choosing, or simply the last stop), and the
 * stops in between are put in the shortest driving order by the Google
 * Directions API with `optimizeWaypoints`. Everything that can be worked out
 * without Google is in here as a plain function so it can be tested: building
 * the request, applying the order Google hands back, the cache key, the
 * formatting. The one call that costs money is `optimizeWithGoogle` at the
 * bottom, and the planner calls it on demand, never on a keystroke.
 *
 * Two honest limits, both surfaced in the planner copy:
 *
 * - Google optimises the ORDER on distance and time without traffic, and
 *   (checked against the deployed key) a request with stops in it comes back
 *   without traffic times at all. So the order is the shortest drive, and the
 *   traffic comes from a second pass over the legs of that order — see
 *   `addTrafficToLegs`. The times are what the drive will take at the chosen
 *   departure; the order was not chosen with traffic in mind.
 * - Directions takes at most 25 waypoints. A route with more is not
 *   optimised — the planner says so and the picked order stands — rather
 *   than silently reordering some of the stops.
 */

/** Google Directions optimises at most this many waypoints per request. */
export const MAX_OPTIMIZED_STOPS = 25;

export type LatLngLiteral = { lat: number; lng: number };

/** A stop as the planner knows it: an address, and a position when geocoded. */
export type RouteStopInput = {
  id: string;
  name: string;
  address: string | null;
  lat?: number | null;
  lon?: number | null;
};

/**
 * A resolved start or end. `kind` decides what Maps is handed: an address the
 * rep typed goes as text (Maps shows the place), the office and the rep's own
 * position go as coordinates (a name like "Brooklyn office" would resolve to
 * something else entirely).
 */
export type Place = {
  kind: "current" | "office" | "address";
  label: string;
  lat: number;
  lon: number;
};

/** What the rep chose for the start, before it is resolved to a `Place`. */
export type StartChoice = { kind: "current" } | { kind: "office"; id: string };

/** What the rep chose for the end. `same` is a loop back to the start. */
export type EndChoice =
  | { kind: "same" }
  | { kind: "last-stop" }
  | { kind: "address"; label: string; lat: number; lon: number };

export type Office = { id: string; name: string; lat: number; lon: number };

/**
 * Turn the choices into places. The current position is passed in (it is a
 * browser permission prompt, so the caller decides when to ask for it); a
 * start that cannot be resolved comes back null with the reason, and the
 * planner disables Best order with that reason rather than guessing.
 */
export function resolveEndpoints(input: {
  start: StartChoice;
  end: EndChoice;
  here: { lat: number; lon: number } | null;
  offices: Office[];
}): { start: Place | null; end: Place | "last-stop" | null; problem: string | null } {
  let start: Place | null = null;
  let problem: string | null = null;
  if (input.start.kind === "current") {
    if (input.here) start = { kind: "current", label: "Current location", ...input.here };
    else
      problem = "Your location is not available — allow location access or start from the office.";
  } else {
    const id = input.start.id;
    const office = input.offices.find((o) => o.id === id) ?? input.offices[0];
    if (office) start = { kind: "office", label: office.name, lat: office.lat, lon: office.lon };
    else problem = "No office with a map position to start from.";
  }
  let end: Place | "last-stop" | null;
  if (input.end.kind === "same") end = start;
  else if (input.end.kind === "last-stop") end = "last-stop";
  else end = { kind: "address", label: input.end.label, lat: input.end.lat, lon: input.end.lon };
  return { start, end, problem };
}

/** Where Google should drive to for one stop: its pin if it has one, else its address. */
export function stopLocation(stop: RouteStopInput): LatLngLiteral | string | null {
  if (typeof stop.lat === "number" && typeof stop.lon === "number") {
    return { lat: stop.lat, lng: stop.lon };
  }
  const address = stop.address?.trim();
  return address ? address : null;
}

/**
 * Plain shape of the Directions request. `travelMode` and `trafficModel` are
 * the string values behind Google's enums, so the object is handed to the
 * SDK as is, and a test can build one without the SDK loaded.
 */
export type DirectionsRequestPlain = {
  origin: LatLngLiteral | string;
  destination: LatLngLiteral | string;
  waypoints: { location: LatLngLiteral | string; stopover: true }[];
  optimizeWaypoints: true;
  travelMode: "DRIVING";
  drivingOptions: { departureTime: Date; trafficModel: "bestguess" };
};

export type DirectionsPlan = {
  request: DirectionsRequestPlain;
  /** Stop ids in the order they went into `request.waypoints`. */
  waypointIds: string[];
  /** The stop fixed as the destination, when the route ends at its last stop. */
  destinationId: string | null;
  /** Stops with neither a pin nor an address; they cannot be driven to. */
  skippedIds: string[];
};

const kmBetween = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => {
  const r = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(h));
};

/**
 * The stop to finish on when the rep is not coming back: the one farthest
 * from the start, among those with a pin. With no pins to measure, the last
 * one picked.
 */
export function farthestFrom(
  start: { lat: number; lon: number },
  stops: RouteStopInput[],
): RouteStopInput {
  let best: RouteStopInput | null = null;
  let bestKm = -1;
  for (const s of stops) {
    if (typeof s.lat !== "number" || typeof s.lon !== "number") continue;
    const km = kmBetween(start, { lat: s.lat, lon: s.lon });
    if (km > bestKm) {
      best = s;
      bestKm = km;
    }
  }
  return best ?? stops[stops.length - 1]!;
}

/**
 * Build the Directions request. Google needs a fixed destination, so "end at
 * the last stop" is answered the usual way for an open-ended route: the stop
 * farthest from the start is the destination and the rest are optimised on
 * the way there. Stops that cannot be located are left out and named, so the
 * planner can say which ones.
 *
 * Returns an error string, never a request, when there is nothing Google can
 * do: fewer than two routable stops, or more than it will optimise.
 */
export function buildDirectionsPlan(input: {
  start: Place;
  end: Place | "last-stop";
  stops: RouteStopInput[];
  departureAt: Date;
}): DirectionsPlan | { error: string } {
  const routable = input.stops.filter((s) => stopLocation(s) !== null);
  const skippedIds = input.stops.filter((s) => stopLocation(s) === null).map((s) => s.id);
  if (routable.length < 2) {
    return { error: "Add at least two stops with addresses to find the best order." };
  }
  const waypointBudget = input.end === "last-stop" ? MAX_OPTIMIZED_STOPS + 1 : MAX_OPTIMIZED_STOPS;
  if (routable.length > waypointBudget) {
    return {
      error: `Best order works for up to ${waypointBudget} stops — this route has ${routable.length}. Remove some, or drive it as picked.`,
    };
  }

  let destinationId: string | null = null;
  let waypoints = routable;
  let destination: LatLngLiteral | string;
  if (input.end === "last-stop") {
    const far = farthestFrom(input.start, routable);
    destinationId = far.id;
    destination = stopLocation(far)!;
    waypoints = routable.filter((s) => s.id !== far.id);
  } else {
    destination = { lat: input.end.lat, lng: input.end.lon };
  }

  return {
    request: {
      origin: { lat: input.start.lat, lng: input.start.lon },
      destination,
      waypoints: waypoints.map((s) => ({ location: stopLocation(s)!, stopover: true })),
      optimizeWaypoints: true,
      travelMode: "DRIVING",
      drivingOptions: { departureTime: input.departureAt, trafficModel: "bestguess" },
    },
    waypointIds: waypoints.map((s) => s.id),
    destinationId,
    skippedIds,
  };
}

/**
 * The stop order Google chose. `waypoint_order` is indexes into the waypoints
 * as sent; the destination stop, when there is one, comes last; stops that
 * were skipped keep their place at the end so nothing the rep picked
 * disappears from the list.
 */
export function applyWaypointOrder(plan: DirectionsPlan, waypointOrder: number[]): string[] {
  const ordered = waypointOrder
    .map((i) => plan.waypointIds[i])
    .filter((id): id is string => typeof id === "string");
  // A short or malformed answer must not lose stops: fill in the rest as sent.
  for (const id of plan.waypointIds) if (!ordered.includes(id)) ordered.push(id);
  if (plan.destinationId) ordered.push(plan.destinationId);
  return [...ordered, ...plan.skippedIds];
}

/** One drive between two points of the route; null ids are the start and end places. */
export type RouteLeg = {
  fromId: string | null;
  toId: string | null;
  seconds: number;
  meters: number;
};

export type OptimizedRoute = {
  orderedIds: string[];
  legs: RouteLeg[];
  totalSeconds: number;
  totalMeters: number;
  /** Google answered with `duration_in_traffic` — the times are for the departure chosen. */
  trafficAware: boolean;
  departureAt: Date;
};

/** The parts of a DirectionsResult that are read; the SDK's type is a superset. */
export type DirectionsResultLike = {
  routes: {
    waypoint_order?: number[];
    legs: {
      duration?: { value: number } | null;
      duration_in_traffic?: { value: number } | null;
      distance?: { value: number } | null;
    }[];
  }[];
};

/**
 * Read Google's answer into the route: the order, and a leg per drive. Traffic
 * durations are preferred when present; the flag says which the planner got.
 */
export function summariseDirections(
  plan: DirectionsPlan,
  result: DirectionsResultLike,
  departureAt: Date,
): OptimizedRoute {
  const route = result.routes[0];
  if (!route) throw new Error("Google returned no route.");
  const orderedIds = applyWaypointOrder(plan, route.waypoint_order ?? []);
  const driven = orderedIds.filter((id) => !plan.skippedIds.includes(id));
  let trafficAware = false;
  const legs: RouteLeg[] = route.legs.map((leg, i) => {
    if (leg.duration_in_traffic?.value != null) trafficAware = true;
    return {
      fromId: i === 0 ? null : (driven[i - 1] ?? null),
      toId: driven[i] ?? null,
      seconds: leg.duration_in_traffic?.value ?? leg.duration?.value ?? 0,
      meters: leg.distance?.value ?? 0,
    };
  });
  return {
    orderedIds,
    legs,
    totalSeconds: legs.reduce((n, l) => n + l.seconds, 0),
    totalMeters: legs.reduce((n, l) => n + l.meters, 0),
    trafficAware,
    departureAt,
  };
}

/* ------------------------------------------------------------------ cache */

const placeKey = (p: Place) => `${p.lat.toFixed(3)},${p.lon.toFixed(3)}`;

/** Local wall-clock hour, so two requests a few minutes apart share an answer. */
export function departureHourKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}`;
}

/**
 * Directions is billed per request, so the last answers are kept in memory
 * and reused when the same question is asked again: same start and end
 * (to about a hundred metres), same set of stops in any order, same
 * departure hour. Reopening the panel, or nudging a stop and putting it
 * back, does not pay twice.
 */
export function directionsCacheKey(input: {
  start: Place;
  end: Place | "last-stop";
  stopIds: string[];
  departureAt: Date;
}): string {
  const end = input.end === "last-stop" ? "last-stop" : placeKey(input.end);
  return `${placeKey(input.start)}>${end}|${[...input.stopIds].sort().join(",")}|${departureHourKey(input.departureAt)}`;
}

const CACHE_LIMIT = 30;
const cache = new Map<string, OptimizedRoute>();

export function cachedRoute(key: string): OptimizedRoute | null {
  return cache.get(key) ?? null;
}

export function rememberRoute(key: string, route: OptimizedRoute): void {
  cache.delete(key);
  cache.set(key, route);
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Test seam. */
export function _resetDirectionsCache(): void {
  cache.clear();
}

/* -------------------------------------------------------------- departure */

/**
 * When the route leaves. Null is "now". A clock time is today at that time —
 * or tomorrow, once today's has passed, because a rep setting 9:00 at five in
 * the evening means the morning, and Google refuses a departure in the past.
 */
export function departureDate(hhmm: string | null, now: Date = new Date()): Date {
  if (!hhmm) return now;
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return now;
  const d = new Date(now);
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (d.getTime() < now.getTime() - 60_000) d.setDate(d.getDate() + 1);
  return d;
}

/* ------------------------------------------------------------- formatting */

/** "4 min", "1 h 05 min", "2 h". Rounded to the minute; nothing under one. */
export function formatDuration(seconds: number): string {
  const mins = Math.max(1, Math.round(seconds / 60));
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h} h` : `${h} h ${String(m).padStart(2, "0")} min`;
}

/** Miles, one decimal under ten. The page already talks in miles. */
export function formatMiles(meters: number): string {
  const mi = meters / 1609.344;
  return mi < 10 ? `${mi.toFixed(1)} mi` : `${Math.round(mi)} mi`;
}

/* --------------------------------------------------------------- Maps URL */

/** A place as the Maps URL wants it: typed addresses as text, the rest as coordinates. */
export function mapsPoint(p: Place): string {
  return p.kind === "address" ? p.label : `${p.lat},${p.lon}`;
}

/**
 * The route as a Google Maps directions link, start and end included, stops
 * in the given order as waypoints. With no end place the last stop is the
 * destination. Stops go by address, as they always have: Maps then shows the
 * business, not a dropped pin.
 */
export function buildMapsDirectionsUrl(input: {
  start: Place | null;
  end: Place | "last-stop" | null;
  stops: { address: string | null }[];
}): string | null {
  const addresses = input.stops.map((s) => s.address?.trim() ?? "").filter(Boolean);
  if (!addresses.length) return null;
  const endPlace = input.end && input.end !== "last-stop" ? input.end : null;
  const destination = endPlace ? mapsPoint(endPlace) : addresses[addresses.length - 1]!;
  const waypoints = endPlace ? addresses : addresses.slice(0, -1);
  const params = new URLSearchParams({ api: "1", destination, travelmode: "driving" });
  if (input.start) params.set("origin", mapsPoint(input.start));
  if (waypoints.length) params.set("waypoints", waypoints.join("|"));
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

/* --------------------------------------------------------- the Google call */

/** A single drive, no stops between: the only request Directions answers with traffic. */
export type LegRequestPlain = {
  origin: LatLngLiteral | string;
  destination: LatLngLiteral | string;
  travelMode: "DRIVING";
  drivingOptions: { departureTime: Date; trafficModel: "bestguess" };
};

/** The one method of `google.maps.DirectionsService` used, so a test can pass a fake. */
export type DirectionsServiceLike = {
  route: (request: DirectionsRequestPlain | LegRequestPlain) => Promise<DirectionsResultLike>;
};

/**
 * Ask Google, through whichever service is handed in. The planner passes the
 * real `DirectionsService`; tests pass a fake that returns a `waypoint_order`.
 */
export async function requestOptimizedRoute(
  plan: DirectionsPlan,
  svc: DirectionsServiceLike,
): Promise<OptimizedRoute> {
  const result = await svc.route(plan.request);
  return summariseDirections(plan, result, plan.request.drivingOptions.departureTime);
}

/**
 * Past this many legs the traffic pass is skipped and the times are the
 * static ones: every leg is its own billed request.
 */
export const TRAFFIC_LEG_LIMIT = 12;

/**
 * Traffic, leg by leg.
 *
 * Verified against the deployed key: the legacy Directions API answers a
 * request with stopover waypoints WITHOUT `duration_in_traffic` — it only
 * returns traffic times for a drive with no stops in between. So the
 * optimising call gives the order and static durations, and the traffic
 * comes from a second pass: one waypoint-free request per leg of the order
 * just found, in parallel, at the chosen departure. Any leg Google cannot
 * answer keeps its static time and the route is marked as not traffic-aware,
 * so the planner never claims what it did not get.
 *
 * The right fix is the Routes API (`Route.computeRoutes`, `TRAFFIC_AWARE`,
 * `optimizeWaypointOrder`): one call, traffic in, and the API Google now
 * recommends over DirectionsService. It is not enabled on the project yet.
 */
export async function addTrafficToLegs(
  route: OptimizedRoute,
  input: { start: Place; end: Place | "last-stop"; stops: RouteStopInput[] },
  svc: DirectionsServiceLike,
): Promise<OptimizedRoute> {
  if (route.trafficAware || route.legs.length === 0 || route.legs.length > TRAFFIC_LEG_LIMIT) {
    return route;
  }
  const byId = new Map(input.stops.map((s) => [s.id, s]));
  const point = (id: string | null): LatLngLiteral | string | null => {
    if (id === null) return null;
    const stop = byId.get(id);
    return stop ? stopLocation(stop) : null;
  };
  const startPoint: LatLngLiteral = { lat: input.start.lat, lng: input.start.lon };
  const endPoint: LatLngLiteral | null =
    input.end === "last-stop" ? null : { lat: input.end.lat, lng: input.end.lon };

  const answers = await Promise.all(
    route.legs.map(async (leg): Promise<number | null> => {
      const origin = leg.fromId === null ? startPoint : point(leg.fromId);
      const destination = leg.toId === null ? endPoint : point(leg.toId);
      if (!origin || !destination) return null;
      try {
        const res = await svc.route({
          origin,
          destination,
          travelMode: "DRIVING",
          drivingOptions: { departureTime: route.departureAt, trafficModel: "bestguess" },
        });
        return res.routes[0]?.legs[0]?.duration_in_traffic?.value ?? null;
      } catch {
        return null;
      }
    }),
  );

  const legs = route.legs.map((leg, i) => {
    const seconds = answers[i];
    return seconds == null ? leg : { ...leg, seconds };
  });
  return {
    ...route,
    legs,
    totalSeconds: legs.reduce((n, l) => n + l.seconds, 0),
    trafficAware: answers.every((a) => a != null),
  };
}

/**
 * The billable calls, cached. Loads the Maps SDK if the page has not already
 * (the map on the Routes page will have), asks Directions for the order once
 * per distinct question, then for the traffic on each leg of that order.
 */
export async function optimizeWithGoogle(input: {
  start: Place;
  end: Place | "last-stop";
  stops: RouteStopInput[];
  departureAt: Date;
}): Promise<{ route: OptimizedRoute; plan: DirectionsPlan; fromCache: boolean }> {
  const planned = buildDirectionsPlan(input);
  if ("error" in planned) throw new Error(planned.error);
  const key = directionsCacheKey({
    start: input.start,
    end: input.end,
    stopIds: input.stops.map((s) => s.id),
    departureAt: input.departureAt,
  });
  const hit = cachedRoute(key);
  if (hit) return { route: hit, plan: planned, fromCache: true };

  const { loadGoogleMaps } = await import("./google-maps-loader");
  await loadGoogleMaps();
  const svc = new google.maps.DirectionsService();
  const like: DirectionsServiceLike = {
    route: (req) =>
      svc.route(
        req as unknown as google.maps.DirectionsRequest,
      ) as unknown as Promise<DirectionsResultLike>,
  };
  const ordered = await requestOptimizedRoute(planned, like);
  const route = await addTrafficToLegs(ordered, input, like);
  rememberRoute(key, route);
  return { route, plan: planned, fromCache: false };
}

/**
 * What to tell the rep when Google could not answer. Every branch ends the
 * same way in the planner — the picked order stands and Maps still opens —
 * so the message only has to say why, in words a rep can act on.
 */
export function describeDirectionsFailure(err: unknown): string {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return "You look offline — the stops stay in the order you picked.";
  }
  const e = err as { code?: string; reason?: string; message?: string } | null;
  const code = String(e?.code ?? e?.reason ?? "");
  switch (code) {
    case "OVER_QUERY_LIMIT":
      return "Google's route limit was hit for now — try again in a minute.";
    case "REQUEST_DENIED":
    case "auth":
      return "Route optimization is not enabled on this Maps key — the order stays as picked.";
    case "ZERO_RESULTS":
    case "NOT_FOUND":
      return "Google could not find a drive between these stops — check the addresses.";
    case "MAX_WAYPOINTS_EXCEEDED":
      return `Best order works for up to ${MAX_OPTIMIZED_STOPS} stops.`;
    case "no-key":
    case "script":
      return "Google Maps did not load — the stops stay in the order you picked.";
    default:
      return e?.message
        ? `Could not find the best order: ${e.message}`
        : "Could not find the best order — the stops stay in the order you picked.";
  }
}
