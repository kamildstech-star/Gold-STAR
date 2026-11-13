import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  dayKey,
  plannedRouteName,
  plannedRoutesUnavailable,
  routesDateRange,
  splitReloadableStops,
  visitedStopIds,
  type PlannedRoute,
} from "./planned-routes";

const route = (over: Partial<PlannedRoute> = {}): PlannedRoute => ({
  id: "r1",
  created_by: "u1",
  location_id: "l1",
  planned_for: "2026-09-17",
  departure_at: "2026-09-17T13:00:00.000Z",
  name: "Sep 17 · A → C",
  start_point: { kind: "office", label: "Brooklyn office", lat: 40.65, lon: -73.95, id: "l1" },
  end_point: { kind: "last-stop" },
  stops: [
    {
      account_id: "a",
      job_id: null,
      kind: "prospect",
      name: "A",
      address: "1 A St",
      lat: 40.7,
      lon: -73.99,
      leg_minutes: 10,
    },
    {
      account_id: "b",
      job_id: null,
      kind: "client",
      name: "B",
      address: "2 B St",
      lat: 40.68,
      lon: -73.98,
      leg_minutes: 5,
    },
    {
      account_id: "c",
      job_id: null,
      kind: "prospect",
      name: "C",
      address: null,
      lat: null,
      lon: null,
      leg_minutes: null,
    },
  ],
  optimised: true,
  total_minutes: 15,
  total_km: 8.5,
  opened_in_maps_at: null,
  created_at: "2026-09-17T11:00:00.000Z",
  ...over,
});

describe("plannedRoutesUnavailable", () => {
  it("is the migration not being applied, in either of Postgres's or PostgREST's words", () => {
    expect(plannedRoutesUnavailable({ code: "42P01" })).toBe(true);
    expect(plannedRoutesUnavailable({ code: "PGRST205", message: "x" })).toBe(true);
    expect(plannedRoutesUnavailable({ message: "relation planned_routes does not exist" })).toBe(
      true,
    );
    expect(plannedRoutesUnavailable({ code: "42501", message: "permission denied" })).toBe(false);
    expect(plannedRoutesUnavailable(null)).toBe(false);
  });
});

describe("plannedRouteName", () => {
  it("is the date plus first and last stop", () => {
    expect(plannedRouteName("2026-09-17", [{ name: "A" }, { name: "B" }, { name: "C" }])).toBe(
      "Sep 17 · A → C",
    );
    expect(plannedRouteName("2026-09-17", [{ name: "A" }])).toBe("Sep 17 · A");
    expect(plannedRouteName("2026-09-17", [])).toBe("Sep 17");
  });
});

describe("visitedStopIds — plan versus what happened", () => {
  it("matches a stop by account on the local day the route was planned for", () => {
    const at = (d: Date) => d.toISOString();
    const visits = [
      { account_id: "a", occurred_at: at(new Date(2026, 8, 17, 10, 30)) },
      // Same account, the day before: not this route's visit.
      { account_id: "b", occurred_at: at(new Date(2026, 8, 16, 23, 50)) },
      // An unlinked stop says nothing about the plan.
      { account_id: null, occurred_at: at(new Date(2026, 8, 17, 12, 0)) },
      { account_id: "zzz", occurred_at: at(new Date(2026, 8, 17, 12, 0)) },
    ];
    expect([...visitedStopIds(route(), visits)]).toEqual(["a"]);
  });

  it("dayKey is the local calendar date", () => {
    expect(dayKey(new Date(2026, 0, 5, 0, 30))).toBe("2026-01-05");
  });
});

describe("routesDateRange", () => {
  it("is one window over every route's day, whole days", () => {
    const r = routesDateRange([
      route({ planned_for: "2026-09-17" }),
      route({ id: "r2", planned_for: "2026-09-02" }),
    ])!;
    expect(dayKey(r.from)).toBe("2026-09-02");
    expect(r.from.getHours()).toBe(0);
    expect(dayKey(r.to)).toBe("2026-09-17");
    expect(r.to.getHours()).toBe(23);
    expect(routesDateRange([])).toBeNull();
  });
});

describe("splitReloadableStops", () => {
  it("keeps the driven order for stops still in the book and names the rest", () => {
    const book = new Set(["c", "a"]);
    expect(splitReloadableStops(route(), (id) => book.has(id))).toEqual({
      ids: ["a", "c"],
      missing: ["B"],
    });
  });
});

/* ---------------------------------------------------------- the migration */

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const SQL = read("supabase/migrations/20260918110000_planned_routes.sql");
const PAST = read("src/components/routes/past-routes.tsx");

describe("planned_routes migration", () => {
  it("is written, not applied, and creates the table the code reads", () => {
    expect(SQL).toContain("WRITTEN, NOT APPLIED");
    const table = SQL.match(
      /CREATE TABLE IF NOT EXISTS public\.planned_routes \(([\s\S]*?)\n\);/,
    )![1]!;
    for (const col of [
      "id uuid PRIMARY KEY",
      "created_by uuid NOT NULL DEFAULT auth.uid()",
      "location_id uuid REFERENCES public.locations(id)",
      "planned_for date NOT NULL",
      "departure_at timestamptz",
      "start_point jsonb NOT NULL",
      "end_point jsonb NOT NULL",
      "stops jsonb NOT NULL",
      "optimised boolean NOT NULL DEFAULT false",
      "total_minutes integer",
      "total_km numeric",
      "opened_in_maps_at timestamptz",
    ]) {
      expect(table, col).toContain(col);
    }
  });

  it("RLS: the rep's own rows, and the office's for those who manage it", () => {
    expect(SQL).toContain("ENABLE ROW LEVEL SECURITY");
    const read = SQL.match(/CREATE POLICY "planned_routes_read"[\s\S]*?\);/)![0];
    expect(read).toContain("created_by = auth.uid()");
    expect(read).toContain("public.can_manage_location(auth.uid(), location_id)");
    const insert = SQL.match(/CREATE POLICY "planned_routes_insert"[\s\S]*?\);/)![0];
    expect(insert).toContain("WITH CHECK (created_by = auth.uid())");
  });
});

describe("PastRoutes wiring", () => {
  it("hides itself until the table exists, and reuses the visit-history join", () => {
    expect(PAST.match(/if \(!available\) return null;/)).not.toBeNull();
    expect(
      PAST.match(/fetchVisitHistory\(\{ from: range!\.from, to: range!\.to, userId: repId \}\)/),
    ).not.toBeNull();
    expect(PAST.match(/const visited = visitedStopIds\(r, visits\);/)).not.toBeNull();
  });
});
