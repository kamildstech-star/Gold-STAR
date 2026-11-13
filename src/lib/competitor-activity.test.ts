import { beforeEach, describe, expect, it, vi } from "vitest";

/** A chainable fake of the supabase query builder that records every call. */
const db = vi.hoisted(() => ({
  tables: {} as Record<string, unknown[]>,
  calls: [] as { table: string; method: string; args: unknown[] }[],
}));

vi.mock("@/integrations/supabase/client", () => {
  const builder = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const method of ["select", "eq", "gte", "lt", "in", "order"]) {
      chain[method] = (...args: unknown[]) => {
        db.calls.push({ table, method, args });
        return chain;
      };
    }
    chain.then = (resolve: (v: unknown) => unknown) =>
      resolve({ data: db.tables[table] ?? [], error: null });
    return chain;
  };
  return { supabase: { from: (table: string) => builder(table) } };
});

import {
  countBy,
  fetchCompetitorSightings,
  previousWindow,
  UNKNOWN_AREA,
  UNNAMED_COMPETITOR,
} from "./competitor-activity";

beforeEach(() => {
  db.tables = {};
  db.calls = [];
});

const from = new Date("2026-10-08T00:00:00.000Z");
const to = new Date("2026-10-15T00:00:00.000Z");

describe("fetchCompetitorSightings", () => {
  it("names the competitor, area and who logged it from the closing attempt", async () => {
    db.tables.incidents = [
      {
        id: "a",
        outcome_detail: null,
        outcome_at: "2026-10-14T10:00:00.000Z",
        locality: "Newark",
        location_id: "nwk",
        accepted_by: "u-accepted",
        zone: { name: "North Zone" },
      },
      {
        id: "b",
        outcome_detail: " Legacy Name ",
        outcome_at: "2026-10-13T10:00:00.000Z",
        locality: null,
        location_id: null,
        accepted_by: "u-accepted",
        zone: null,
      },
    ];
    db.tables.incident_attempts = [
      {
        incident_id: "a",
        chaser_id: "u-dana",
        sub_reason_label: "Rapid Restore",
        attended_at: "x",
      },
      { incident_id: "a", chaser_id: "u-old", sub_reason_label: "Older", attended_at: "y" },
    ];
    db.tables.profiles = [
      { user_id: "u-dana", full_name: "Dana Chaser" },
      { user_id: "u-accepted", full_name: "Lee Runner" },
    ];

    const out = await fetchCompetitorSightings({ kind: "range", from, to }, null);

    expect(out).toEqual([
      {
        id: "a",
        competitor: "Rapid Restore",
        at: "2026-10-14T10:00:00.000Z",
        locationId: "nwk",
        area: "North Zone",
        loggedBy: "Dana Chaser",
      },
      {
        id: "b",
        competitor: "Legacy Name",
        at: "2026-10-13T10:00:00.000Z",
        locationId: null,
        area: UNKNOWN_AREA,
        loggedBy: "Lee Runner",
      },
    ]);
    const inc = db.calls.filter((c) => c.table === "incidents");
    expect(inc).toContainEqual({
      table: "incidents",
      method: "eq",
      args: ["outcome", "competitor_present"],
    });
    expect(inc).toContainEqual({
      table: "incidents",
      method: "gte",
      args: ["outcome_at", from.toISOString()],
    });
    expect(inc).toContainEqual({
      table: "incidents",
      method: "lt",
      args: ["outcome_at", to.toISOString()],
    });
    // No narrowing without a scope: RLS decides, as the cockpit card always has.
    expect(inc.some((c) => c.method === "in")).toBe(false);
  });

  it("narrows to the given offices and short-circuits an empty scope", async () => {
    await fetchCompetitorSightings({ kind: "range", from, to }, ["nwk"]);
    expect(db.calls).toContainEqual({
      table: "incidents",
      method: "in",
      args: ["location_id", ["nwk"]],
    });

    db.calls = [];
    expect(await fetchCompetitorSightings({ kind: "range", from, to }, [])).toEqual([]);
    expect(db.calls).toEqual([]);
  });

  it("uses an open-ended window for the rolling 24 hours", async () => {
    db.tables.incidents = [
      {
        id: "a",
        outcome_detail: null,
        outcome_at: "2026-10-14T10:00:00.000Z",
        locality: "Newark",
        location_id: null,
        accepted_by: null,
        zone: null,
      },
    ];
    const out = await fetchCompetitorSightings({ kind: "rolling", hours: 24 }, null);
    expect(out[0]).toMatchObject({
      competitor: UNNAMED_COMPETITOR,
      area: "Newark",
      loggedBy: null,
    });
    expect(db.calls.some((c) => c.table === "incidents" && c.method === "lt")).toBe(false);
  });
});

describe("helpers", () => {
  it("counts by field, biggest first", () => {
    const s = (competitor: string, area: string) => ({
      id: competitor + area,
      competitor,
      area,
      at: "",
      locationId: null,
      loggedBy: null,
    });
    expect(countBy([s("B", "x"), s("A", "y"), s("A", "x")], "competitor")).toEqual([
      { label: "A", count: 2 },
      { label: "B", count: 1 },
    ]);
    expect(countBy([s("B", "x"), s("A", "y"), s("A", "x")], "area")[0]).toEqual({
      label: "x",
      count: 2,
    });
  });

  it("previous window is the same length, ending where this one starts", () => {
    expect(previousWindow(from, to)).toEqual({
      from: new Date("2026-10-01T00:00:00.000Z"),
      to: from,
    });
  });
});
