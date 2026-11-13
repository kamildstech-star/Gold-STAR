import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetDirectionsCache,
  addTrafficToLegs,
  applyWaypointOrder,
  buildDirectionsPlan,
  buildMapsDirectionsUrl,
  cachedRoute,
  departureDate,
  departureHourKey,
  describeDirectionsFailure,
  directionsCacheKey,
  farthestFrom,
  formatDuration,
  formatMiles,
  MAX_OPTIMIZED_STOPS,
  rememberRoute,
  requestOptimizedRoute,
  resolveEndpoints,
  stopLocation,
  summariseDirections,
  TRAFFIC_LEG_LIMIT,
  type DirectionsPlan,
  type DirectionsResultLike,
  type Place,
  type RouteStopInput,
} from "./route-optimize";
import { parseRoutePlannerPrefs, DEFAULT_ROUTE_PLANNER_PREFS } from "./route-planner-prefs";

/* Six Brooklyn stops. `d` has no pin, only an address; `f` has neither. */
const OFFICE: Place = { kind: "office", label: "Brooklyn office", lat: 40.65, lon: -73.95 };
const HOME: Place = {
  kind: "address",
  label: "1 Ocean Pkwy, Brooklyn, NY",
  lat: 40.6,
  lon: -73.97,
};
const STOPS: RouteStopInput[] = [
  { id: "a", name: "A", address: "1 A St, Brooklyn, NY", lat: 40.7, lon: -73.99 },
  { id: "b", name: "B", address: "2 B St, Brooklyn, NY", lat: 40.68, lon: -73.98 },
  { id: "c", name: "C", address: "3 C St, Brooklyn, NY", lat: 40.62, lon: -73.93 },
  { id: "d", name: "D", address: "4 D St, Brooklyn, NY", lat: null, lon: null },
  { id: "e", name: "E", address: "5 E St, Brooklyn, NY", lat: 40.58, lon: -73.96 },
  { id: "f", name: "F", address: null },
];
const AT = new Date(2026, 8, 17, 9, 0, 0);

const leg = (traffic: number, plain: number, m: number) => ({
  duration_in_traffic: { value: traffic },
  duration: { value: plain },
  distance: { value: m },
});

describe("resolveEndpoints", () => {
  const offices = [{ id: "o1", name: "Brooklyn office", lat: 40.65, lon: -73.95 }];

  it("starts from the device when it gave a position, and says so when it did not", () => {
    const ok = resolveEndpoints({
      start: { kind: "current" },
      end: { kind: "same" },
      here: { lat: 40.7, lon: -73.9 },
      offices,
    });
    expect(ok.start).toMatchObject({ kind: "current", lat: 40.7, lon: -73.9 });
    expect(ok.end).toBe(ok.start);
    expect(ok.problem).toBeNull();

    const no = resolveEndpoints({
      start: { kind: "current" },
      end: { kind: "same" },
      here: null,
      offices,
    });
    expect(no.start).toBeNull();
    expect(no.problem).toMatch(/location/i);
  });

  it("starts from the chosen office, and ends at the last stop or a typed address", () => {
    const r = resolveEndpoints({
      start: { kind: "office", id: "o1" },
      end: { kind: "last-stop" },
      here: null,
      offices,
    });
    expect(r.start).toMatchObject({ kind: "office", label: "Brooklyn office" });
    expect(r.end).toBe("last-stop");

    const home = resolveEndpoints({
      start: { kind: "office", id: "o1" },
      end: { kind: "address", label: "Home", lat: 40.6, lon: -73.97 },
      here: null,
      offices,
    });
    expect(home.end).toEqual({ kind: "address", label: "Home", lat: 40.6, lon: -73.97 });
  });
});

describe("buildDirectionsPlan", () => {
  it("asks Google for the optimized order, driving, with traffic for the departure", () => {
    const plan = buildDirectionsPlan({ start: OFFICE, end: OFFICE, stops: STOPS, departureAt: AT });
    expect("error" in plan).toBe(false);
    const { request, waypointIds, destinationId, skippedIds } = plan as DirectionsPlan;
    expect(request.optimizeWaypoints).toBe(true);
    expect(request.travelMode).toBe("DRIVING");
    expect(request.drivingOptions).toEqual({ departureTime: AT, trafficModel: "bestguess" });
    expect(request.origin).toEqual({ lat: 40.65, lng: -73.95 });
    expect(request.destination).toEqual({ lat: 40.65, lng: -73.95 });
    // Pinned stops go by coordinates, an unpinned one by its address, and a
    // stop with neither is left out and named.
    expect(request.waypoints.map((w) => w.location)).toEqual([
      { lat: 40.7, lng: -73.99 },
      { lat: 40.68, lng: -73.98 },
      { lat: 40.62, lng: -73.93 },
      "4 D St, Brooklyn, NY",
      { lat: 40.58, lng: -73.96 },
    ]);
    expect(request.waypoints.every((w) => w.stopover === true)).toBe(true);
    expect(waypointIds).toEqual(["a", "b", "c", "d", "e"]);
    expect(destinationId).toBeNull();
    expect(skippedIds).toEqual(["f"]);
  });

  it("ends at a typed address when one was given", () => {
    const plan = buildDirectionsPlan({
      start: OFFICE,
      end: HOME,
      stops: STOPS,
      departureAt: AT,
    }) as DirectionsPlan;
    expect(plan.request.destination).toEqual({ lat: 40.6, lng: -73.97 });
  });

  it("with no end, fixes the farthest stop as the destination and optimizes the rest", () => {
    const plan = buildDirectionsPlan({
      start: OFFICE,
      end: "last-stop",
      stops: STOPS,
      departureAt: AT,
    }) as DirectionsPlan;
    // `e` is the farthest pinned stop from the office; `d` has no pin to measure.
    expect(farthestFrom(OFFICE, STOPS).id).toBe("e");
    expect(plan.destinationId).toBe("e");
    expect(plan.request.destination).toEqual({ lat: 40.58, lng: -73.96 });
    expect(plan.waypointIds).toEqual(["a", "b", "c", "d"]);
    // With nothing pinned, the last one picked.
    expect(farthestFrom(OFFICE, [STOPS[3]!, STOPS[5]!]).id).toBe("f");
  });

  it("refuses fewer than two routable stops", () => {
    const one = buildDirectionsPlan({
      start: OFFICE,
      end: OFFICE,
      stops: [STOPS[0]!, STOPS[5]!],
      departureAt: AT,
    });
    expect(one).toHaveProperty("error");
    expect((one as { error: string }).error).toMatch(/two stops/);
  });

  it(`caps at ${MAX_OPTIMIZED_STOPS} waypoints and says so, rather than reordering part of the route`, () => {
    const many = Array.from({ length: 26 }, (_, i) => ({
      id: `s${i}`,
      name: `S${i}`,
      address: `${i} Main St`,
      lat: 40.6 + i / 1000,
      lon: -73.9,
    }));
    const r = buildDirectionsPlan({ start: OFFICE, end: OFFICE, stops: many, departureAt: AT });
    expect(r).toHaveProperty("error");
    expect((r as { error: string }).error).toMatch(/up to 25 stops — this route has 26/);
    // One more fits when the last stop is the destination, since it is not a waypoint.
    const open = buildDirectionsPlan({
      start: OFFICE,
      end: "last-stop",
      stops: many,
      departureAt: AT,
    });
    expect(open).not.toHaveProperty("error");
    expect(
      buildDirectionsPlan({
        start: OFFICE,
        end: OFFICE,
        stops: many.slice(0, 25),
        departureAt: AT,
      }),
    ).not.toHaveProperty("error");
  });

  it("stopLocation prefers the pin and falls back to the address", () => {
    expect(stopLocation(STOPS[0]!)).toEqual({ lat: 40.7, lng: -73.99 });
    expect(stopLocation(STOPS[3]!)).toBe("4 D St, Brooklyn, NY");
    expect(stopLocation(STOPS[5]!)).toBeNull();
    expect(stopLocation({ id: "x", name: "X", address: "   " })).toBeNull();
  });
});

describe("applyWaypointOrder", () => {
  const plan = buildDirectionsPlan({
    start: OFFICE,
    end: OFFICE,
    stops: STOPS,
    departureAt: AT,
  }) as DirectionsPlan;

  it("reorders the stops as Google said, skipped ones last", () => {
    expect(applyWaypointOrder(plan, [4, 2, 0, 1, 3])).toEqual(["e", "c", "a", "b", "d", "f"]);
  });

  it("keeps the fixed destination last", () => {
    const open = buildDirectionsPlan({
      start: OFFICE,
      end: "last-stop",
      stops: STOPS,
      departureAt: AT,
    }) as DirectionsPlan;
    expect(applyWaypointOrder(open, [3, 0, 2, 1])).toEqual(["d", "a", "c", "b", "e", "f"]);
  });

  it("never loses a stop to a short or odd answer", () => {
    expect(applyWaypointOrder(plan, [2])).toEqual(["c", "a", "b", "d", "e", "f"]);
    expect(applyWaypointOrder(plan, [9, 1])).toEqual(["b", "a", "c", "d", "e", "f"]);
    expect(applyWaypointOrder(plan, [])).toEqual(["a", "b", "c", "d", "e", "f"]);
  });
});

describe("summariseDirections", () => {
  const plan = buildDirectionsPlan({
    start: OFFICE,
    end: OFFICE,
    stops: STOPS,
    departureAt: AT,
  }) as DirectionsPlan;

  it("reads the order, a leg per drive with traffic times, and the totals", () => {
    const result: DirectionsResultLike = {
      routes: [
        {
          waypoint_order: [1, 0, 3, 2, 4],
          legs: [
            leg(600, 500, 1000),
            leg(300, 250, 800),
            leg(900, 700, 3000),
            leg(120, 100, 400),
            leg(420, 400, 1500),
            leg(660, 600, 2200),
          ],
        },
      ],
    };
    const r = summariseDirections(plan, result, AT);
    expect(r.orderedIds).toEqual(["b", "a", "d", "c", "e", "f"]);
    expect(r.trafficAware).toBe(true);
    expect(r.totalSeconds).toBe(3000);
    expect(r.totalMeters).toBe(8900);
    expect(r.departureAt).toBe(AT);
    expect(r.legs.map((l) => [l.fromId, l.toId, l.seconds])).toEqual([
      [null, "b", 600],
      ["b", "a", 300],
      ["a", "d", 900],
      ["d", "c", 120],
      ["c", "e", 420],
      ["e", null, 660],
    ]);
  });

  it("falls back to plain durations and says the times are not traffic-aware", () => {
    const r = summariseDirections(
      plan,
      {
        routes: [
          {
            waypoint_order: [0, 1, 2, 3, 4],
            legs: Array.from({ length: 6 }, () => ({
              duration: { value: 100 },
              distance: { value: 10 },
            })),
          },
        ],
      },
      AT,
    );
    expect(r.trafficAware).toBe(false);
    expect(r.totalSeconds).toBe(600);
  });

  it("throws on an empty answer so the planner falls back to the picked order", () => {
    expect(() => summariseDirections(plan, { routes: [] }, AT)).toThrow(/no route/i);
  });
});

describe("requestOptimizedRoute (mocked DirectionsService)", () => {
  it("sends the built request and hands back the summarized route", async () => {
    const plan = buildDirectionsPlan({
      start: OFFICE,
      end: HOME,
      stops: STOPS,
      departureAt: AT,
    }) as DirectionsPlan;
    const route = vi.fn(async (_req: unknown): Promise<DirectionsResultLike> => ({
      routes: [
        {
          waypoint_order: [2, 4, 0, 1, 3],
          legs: Array.from({ length: 6 }, (_, i) => leg(100 * (i + 1), 90 * (i + 1), 500)),
        },
      ],
    }));
    const r = await requestOptimizedRoute(plan, { route });
    expect(route).toHaveBeenCalledTimes(1);
    expect(route.mock.calls[0]![0]).toBe(plan.request);
    expect(r.orderedIds).toEqual(["c", "e", "a", "b", "d", "f"]);
    expect(r.totalSeconds).toBe(2100);
  });

  it("surfaces a rejection, which the planner turns into a plain message", async () => {
    const plan = buildDirectionsPlan({
      start: OFFICE,
      end: OFFICE,
      stops: STOPS,
      departureAt: AT,
    }) as DirectionsPlan;
    const err = Object.assign(new Error("denied"), { code: "REQUEST_DENIED" });
    await expect(
      requestOptimizedRoute(plan, { route: async () => Promise.reject(err) }),
    ).rejects.toBe(err);
    expect(describeDirectionsFailure(err)).toMatch(/not enabled on this Maps key/);
  });
});

describe("addTrafficToLegs — the second pass", () => {
  const plan = buildDirectionsPlan({
    start: OFFICE,
    end: HOME,
    stops: STOPS.slice(0, 3),
    departureAt: AT,
  }) as DirectionsPlan;
  // Google's answer to a request with stops: an order and STATIC durations.
  const ordered = summariseDirections(
    plan,
    {
      routes: [
        {
          waypoint_order: [1, 0, 2],
          legs: [
            { duration: { value: 600 }, distance: { value: 1000 } },
            { duration: { value: 300 }, distance: { value: 800 } },
            { duration: { value: 900 }, distance: { value: 3000 } },
            { duration: { value: 400 }, distance: { value: 1500 } },
          ],
        },
      ],
    },
    AT,
  );

  it("asks once per leg, no stops in between, and overlays the traffic times", async () => {
    expect(ordered.trafficAware).toBe(false);
    const route = vi.fn(async (req: { origin: unknown; destination: unknown }) => ({
      routes: [
        {
          legs: [
            {
              duration: { value: 100 },
              // A leg's traffic time: its static time plus a minute.
              duration_in_traffic: { value: 60 + (JSON.stringify(req).length % 7) * 100 },
              distance: { value: 1 },
            },
          ],
        },
      ],
    }));
    const withTraffic = await addTrafficToLegs(
      ordered,
      { start: OFFICE, end: HOME, stops: STOPS.slice(0, 3) },
      { route },
    );
    expect(route).toHaveBeenCalledTimes(4);
    const reqs = route.mock.calls.map((c) => c[0] as Record<string, unknown>);
    // Office → b → a → c → home, each without waypoints and with the departure.
    expect(reqs[0]!.origin).toEqual({ lat: 40.65, lng: -73.95 });
    expect(reqs[0]!.destination).toEqual({ lat: 40.68, lng: -73.98 });
    expect(reqs[3]!.destination).toEqual({ lat: 40.6, lng: -73.97 });
    for (const r of reqs) {
      expect(r).not.toHaveProperty("waypoints");
      expect(r.drivingOptions).toEqual({ departureTime: AT, trafficModel: "bestguess" });
    }
    expect(withTraffic.trafficAware).toBe(true);
    expect(withTraffic.orderedIds).toEqual(ordered.orderedIds);
    expect(withTraffic.legs.map((l) => l.seconds)).not.toEqual(ordered.legs.map((l) => l.seconds));
    expect(withTraffic.totalSeconds).toBe(withTraffic.legs.reduce((n, l) => n + l.seconds, 0));
    // Distances are not re-read; the order call had them.
    expect(withTraffic.totalMeters).toBe(6300);
  });

  it("a leg Google cannot answer keeps its static time, and the route says so", async () => {
    let n = 0;
    const route = vi.fn(async () => {
      n += 1;
      if (n === 2) throw new Error("ZERO_RESULTS");
      return {
        routes: [{ legs: [{ duration_in_traffic: { value: 999 }, duration: { value: 1 } }] }],
      };
    });
    const r = await addTrafficToLegs(
      ordered,
      { start: OFFICE, end: HOME, stops: STOPS.slice(0, 3) },
      { route },
    );
    expect(r.legs.map((l) => l.seconds)).toEqual([999, 300, 999, 999]);
    expect(r.trafficAware).toBe(false);
  });

  it("skips the pass past the leg limit — each leg is a billed request", async () => {
    const many = {
      ...ordered,
      legs: Array.from({ length: TRAFFIC_LEG_LIMIT + 1 }, () => ordered.legs[0]!),
    };
    const route = vi.fn();
    expect(
      await addTrafficToLegs(many, { start: OFFICE, end: HOME, stops: STOPS }, { route }),
    ).toBe(many);
    expect(route).not.toHaveBeenCalled();
  });

  it("does nothing when the order call already came with traffic", async () => {
    const route = vi.fn();
    const already = { ...ordered, trafficAware: true };
    expect(
      await addTrafficToLegs(already, { start: OFFICE, end: HOME, stops: STOPS }, { route }),
    ).toBe(already);
    expect(route).not.toHaveBeenCalled();
  });
});

describe("directions cache", () => {
  beforeEach(() => _resetDirectionsCache());

  it("keys on start, end, the SET of stops and the departure hour", () => {
    const base = {
      start: OFFICE,
      end: OFFICE as Place | "last-stop",
      stopIds: ["a", "b", "c"],
      departureAt: AT,
    };
    const k = directionsCacheKey(base);
    expect(k).toBe("40.650,-73.950>40.650,-73.950|a,b,c|2026-09-17T09");
    // Same stops in a different order: same question.
    expect(directionsCacheKey({ ...base, stopIds: ["c", "a", "b"] })).toBe(k);
    // Twenty minutes later, same hour: same question.
    expect(directionsCacheKey({ ...base, departureAt: new Date(2026, 8, 17, 9, 20) })).toBe(k);
    // A different hour, end, start or stop: a different question.
    expect(directionsCacheKey({ ...base, departureAt: new Date(2026, 8, 17, 10, 0) })).not.toBe(k);
    expect(directionsCacheKey({ ...base, end: "last-stop" })).toBe(
      "40.650,-73.950>last-stop|a,b,c|2026-09-17T09",
    );
    expect(directionsCacheKey({ ...base, end: HOME })).not.toBe(k);
    expect(directionsCacheKey({ ...base, stopIds: ["a", "b"] })).not.toBe(k);
    // The rep drifting a few metres does not re-bill.
    expect(directionsCacheKey({ ...base, start: { ...OFFICE, lat: 40.6502 } })).toBe(k);
  });

  it("remembers and returns the last answer", () => {
    const r = {
      orderedIds: ["a"],
      legs: [],
      totalSeconds: 1,
      totalMeters: 1,
      trafficAware: true,
      departureAt: AT,
    };
    expect(cachedRoute("k")).toBeNull();
    rememberRoute("k", r);
    expect(cachedRoute("k")).toBe(r);
  });

  it("departureHourKey is local wall-clock", () => {
    expect(departureHourKey(new Date(2026, 0, 5, 7, 59))).toBe("2026-01-05T07");
  });
});

describe("departureDate", () => {
  const now = new Date(2026, 8, 17, 7, 0, 0);

  it("is now when nothing was chosen", () => {
    expect(departureDate(null, now)).toBe(now);
    expect(departureDate("", now)).toBe(now);
    expect(departureDate("nonsense", now)).toBe(now);
  });

  it("is today at the chosen time — a 9am start planned at 7am", () => {
    const d = departureDate("09:00", now);
    expect(d.getDate()).toBe(17);
    expect(d.getHours()).toBe(9);
    expect(d.getMinutes()).toBe(0);
  });

  it("rolls to tomorrow once today's time has passed, so Google is never asked about the past", () => {
    const evening = new Date(2026, 8, 17, 17, 30, 0);
    const d = departureDate("09:00", evening);
    expect(d.getDate()).toBe(18);
    expect(d.getHours()).toBe(9);
  });
});

describe("formatting", () => {
  it("durations", () => {
    expect(formatDuration(0)).toBe("1 min");
    expect(formatDuration(240)).toBe("4 min");
    expect(formatDuration(3900)).toBe("1 h 05 min");
    expect(formatDuration(7200)).toBe("2 h");
  });

  it("miles", () => {
    expect(formatMiles(1609.344)).toBe("1.0 mi");
    expect(formatMiles(500)).toBe("0.3 mi");
    expect(formatMiles(20000)).toBe("12 mi");
  });
});

describe("buildMapsDirectionsUrl", () => {
  const stops = [
    { address: "1 A St" },
    { address: "2 B St" },
    { address: null },
    { address: "3 C St" },
  ];

  it("sends origin, waypoints in the given order, and the end place as destination", () => {
    const url = new URL(buildMapsDirectionsUrl({ start: OFFICE, end: HOME, stops })!);
    expect(url.origin + url.pathname).toBe("https://www.google.com/maps/dir/");
    expect(url.searchParams.get("api")).toBe("1");
    expect(url.searchParams.get("travelmode")).toBe("driving");
    expect(url.searchParams.get("origin")).toBe("40.65,-73.95");
    expect(url.searchParams.get("destination")).toBe("1 Ocean Pkwy, Brooklyn, NY");
    expect(url.searchParams.get("waypoints")).toBe("1 A St|2 B St|3 C St");
  });

  it("with no end place, the last stop is the destination, as before", () => {
    const url = new URL(buildMapsDirectionsUrl({ start: OFFICE, end: "last-stop", stops })!);
    expect(url.searchParams.get("destination")).toBe("3 C St");
    expect(url.searchParams.get("waypoints")).toBe("1 A St|2 B St");
  });

  it("with no start, leaves origin to the device — the route still opens", () => {
    const url = new URL(buildMapsDirectionsUrl({ start: null, end: null, stops })!);
    expect(url.searchParams.has("origin")).toBe(false);
    expect(url.searchParams.get("destination")).toBe("3 C St");
  });

  it("is null when no stop has an address", () => {
    expect(
      buildMapsDirectionsUrl({ start: OFFICE, end: OFFICE, stops: [{ address: null }] }),
    ).toBeNull();
  });
});

describe("describeDirectionsFailure", () => {
  it("names the reason in words a rep can act on, and always says the order stands", () => {
    expect(describeDirectionsFailure({ code: "OVER_QUERY_LIMIT" })).toMatch(/try again/);
    expect(describeDirectionsFailure({ code: "ZERO_RESULTS" })).toMatch(/check the addresses/);
    expect(describeDirectionsFailure({ reason: "no-key" })).toMatch(/order you picked/);
    expect(describeDirectionsFailure({ reason: "auth" })).toMatch(/order stays as picked/);
    expect(describeDirectionsFailure(new Error("boom"))).toBe(
      "Could not find the best order: boom",
    );
    expect(describeDirectionsFailure(null)).toMatch(/order you picked/);
  });
});

describe("route planner prefs", () => {
  it("defaults to leaving from here and looping back", () => {
    expect(parseRoutePlannerPrefs(null)).toBe(DEFAULT_ROUTE_PLANNER_PREFS);
    expect(parseRoutePlannerPrefs("{not json")).toBe(DEFAULT_ROUTE_PLANNER_PREFS);
    /*
     * autoOptimize shipped false — each Directions call is billed — and
     * Melly's 17 Sep session is what that cost: he picked stops, got his own
     * click order back, and said "It's just making the order based on what
     * you're clicking on, which is stupid." The optimiser was built and wired
     * the whole time; it was behind a preference nobody found. It is on now.
     */
    expect(DEFAULT_ROUTE_PLANNER_PREFS).toEqual({
      start: { kind: "current" },
      end: { kind: "same" },
      autoOptimize: true,
    });
  });

  it("reads a saved office start, address end and auto flag, field by field", () => {
    const p = parseRoutePlannerPrefs(
      JSON.stringify({
        start: { kind: "office", id: "o1" },
        end: { kind: "address", label: "Home", lat: 40.6, lon: -73.97 },
        autoOptimize: true,
      }),
    );
    expect(p).toEqual({
      start: { kind: "office", id: "o1" },
      end: { kind: "address", label: "Home", lat: 40.6, lon: -73.97 },
      autoOptimize: true,
    });
    // A half-written end falls back on its own, the start survives.
    const half = parseRoutePlannerPrefs(
      JSON.stringify({ start: { kind: "office", id: "o1" }, end: { kind: "address", label: "x" } }),
    );
    expect(half).toEqual({
      start: { kind: "office", id: "o1" },
      end: { kind: "same" },
      // Absent reads as ON, not off. Every rep who used the planner before
      // 18 Sep has a saved row with no such key, and reading that as "off"
      // would leave exactly the people who already tried Routes still looking
      // at their own click order.
      autoOptimize: true,
    });
  });
});

/* ------------------------------------------------------------- the wiring */

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const BUILDER = read("src/components/routes/route-builder.tsx");
const PANEL = read("src/components/visit-planner.tsx");
const PAGE = read("src/routes/_authenticated/routes.index.tsx");

describe("RouteBuilder wiring", () => {
  it("exposes Start, End and a departure time", () => {
    expect(BUILDER.match(/<SelectTrigger id="route-start"[^>]*>/)).not.toBeNull();
    expect(BUILDER.match(/<SelectTrigger id="route-end"[^>]*>/)).not.toBeNull();
    const endItems = BUILDER.match(/<SelectItem value="(same|last-stop|address)">/g) ?? [];
    expect(endItems).toHaveLength(3);
    expect(BUILDER.match(/<Input\s+id="route-departure"\s+type="time"/)).not.toBeNull();
    // The end address goes through the shared picker, not a second one.
    expect(BUILDER.match(/<AddressAutocomplete\s+id="route-end-address"/)).not.toBeNull();
  });

  it("has a Fastest order button that calls the optimizer on demand, and an Auto switch", () => {
    const button = BUILDER.match(
      /<Button[^>]*onClick=\{\(\) => void optimize\(\)\}[\s\S]*?<\/Button>/,
    )![0];
    // Renamed from "Best order" on 18 Sep so every label on the panel uses the
    // word Melly used — fastest — rather than three synonyms for it.
    expect(button).toContain('"Fastest order again" : "Fastest order"');
    expect(BUILDER.match(/const \{ route, plan \} = await optimizeWithGoogle\(/)).not.toBeNull();
    expect(
      BUILDER.match(/onCheckedChange=\{\(v\) => updatePrefs\(\{ autoOptimize: v \}\)\}/),
    ).not.toBeNull();
    expect(
      BUILDER.match(/setTimeout\(\(\) => void optimizeRef\.current\(\), AUTO_OPTIMIZE_DELAY_MS\)/),
    ).not.toBeNull();
  });

  it("shows whether the list is Google's order or the rep's", () => {
    const badge = BUILDER.match(/data-order-mode=\{mode\}[\s\S]*?<\/span>/)![0];
    expect(badge).toContain('"Fastest order"');
    expect(badge).toContain('"Your order"');
    expect(badge).toContain('"Pick order"');
  });

  it("never presents the click order as the answer while the fastest one is coming", () => {
    // The whole of Melly's complaint. During the debounce and the Directions
    // call the list IS still click order, so the badge says what is happening
    // rather than labelling it a route.
    const badge = BUILDER.match(/data-order-mode=\{mode\}[\s\S]*?<\/span>/)![0];
    expect(badge).toContain("awaitingBest");
    expect(badge).toContain('"Finding fastest…"');

    const gate = BUILDER.match(/const awaitingBest =[\s\S]*?;/)![0];
    expect(gate).toContain("prefs.autoOptimize");
    expect(gate).toContain("stops.length >= 2");
    expect(gate).toContain('mode !== "optimized"');
  });

  it("Open in Maps sends the stops as listed with the chosen start and end", () => {
    const open = BUILDER.match(/async function openInMaps\(\) \{[\s\S]*?\n  \}/)![0];
    expect(open).toContain("buildMapsDirectionsUrl({ start, end, stops })");
    expect(open).toContain('window.open(url, "_blank", "noopener")');
    // Driving it is what makes it history.
    expect(open).toContain("persist(true, start, end)");
  });

  it("applies the optimized order to the shared picked list", () => {
    const run = BUILDER.match(
      /const \{ route, plan \} = await optimizeWithGoogle\([\s\S]*?setResult\(route\);/,
    )![0];
    expect(run).toContain("onChange(route.orderedIds)");
  });

  it("a failed optimization leaves the picked order and a plain message", () => {
    expect(
      BUILDER.match(/catch \(e\) \{\s*setNotice\(describeDirectionsFailure\(e\)\);/),
    ).not.toBeNull();
  });
});

describe("PlanRoutePanel wiring", () => {
  it("renders the builder in place of the old pick-order list", () => {
    expect(PANEL).not.toContain("RouteStopList");
    const builder = PANEL.match(/<RouteBuilder[\s\S]*?\/>/)![0];
    expect(builder).toContain("onChange={setPicked}");
    expect(builder).toContain("offices={offices}");
    expect(builder).toContain("load={load}");
  });

  it("reloading a past route keeps the stops still in the book and names the rest", () => {
    const effect = PANEL.match(
      /const \{ ids, missing \} = splitReloadableStops\([\s\S]*?\}, \[load, stopsQ\.isLoading\]\);/,
    )![0];
    expect(effect).toContain("setPicked(ids)");
    expect(effect).toContain("No longer in the book");
  });
});

describe("Routes page wiring", () => {
  it("hands the planner the offices and a past route to load, and shows Past routes beside it", () => {
    const panel = PAGE.match(/<PlanRoutePanel[\s\S]*?\/>/)![0];
    expect(panel).toContain("offices={offices}");
    expect(panel).toContain("load={loadRoute}");
    const past = PAGE.match(/<PastRoutes[\s\S]*?\/>/)![0];
    expect(past).toContain("repId={repId}");
    expect(past).toContain("setLoadRoute({ route, nonce: Date.now() })");
  });

  it("the Map · By day · Coverage pills sit on the panel they switch, not in the map header", () => {
    const header = PAGE.match(
      /<header className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">[\s\S]*?<\/header>/,
    )![0];
    expect(header).toContain("Field map");
    expect(header).toContain("Fit all");
    expect(header).not.toContain('"By day"');
    const tabs = PAGE.match(/<div\s+ref=\{panelRef\}\s+role="tablist"[\s\S]*?<\/div>\n/)![0];
    expect(tabs).toContain('["days", "By day"]');
    expect(tabs).toContain("onClick={() => pickTab(v)}");
    // ...and switching scrolls that panel into view.
    expect(PAGE.match(/panelRef\.current\?\.scrollIntoView\(\{ block: "nearest"/)).not.toBeNull();
  });

  it("hands the map nothing new — the pins are another agent's work", () => {
    const map = PAGE.match(/<LiveMap\s[\s\S]*?\/>/)![0];
    expect(map).not.toMatch(/optimi|planned|loadRoute|panelRef/);
  });
});
