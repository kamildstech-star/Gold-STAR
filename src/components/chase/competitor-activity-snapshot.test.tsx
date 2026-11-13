import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompetitorSighting } from "@/lib/competitor-activity";

/** Sightings served per window key, so a period change can return different data. */
const state = vi.hoisted(() => ({
  byWindow: new Map<string, CompetitorSighting[]>(),
  keys: [] as unknown[][],
  loading: false,
  error: false,
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, className }: { to: string; children: unknown; className?: string }) =>
    createElement("a", { href: to, className }, children as never),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => {
    state.keys.push(queryKey);
    return {
      data:
        state.loading || state.error ? undefined : (state.byWindow.get(String(queryKey[1])) ?? []),
      isLoading: state.loading,
      isError: state.error,
    };
  },
}));
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import { CompetitorActivitySnapshot } from "./competitor-activity-snapshot";

const day = 86_400_000;
const to = new Date("2026-10-15T00:00:00.000Z");
const from7 = new Date(to.getTime() - 7 * day);
const prev7 = new Date(from7.getTime() - 7 * day);
const from30 = new Date(to.getTime() - 30 * day);
const prev30 = new Date(from30.getTime() - 30 * day);
const key = (a: Date, b: Date) => `${a.toISOString()}..${b.toISOString()}`;

const sighting = (
  id: string,
  competitor: string,
  area: string,
  at: string,
  loggedBy: string | null = "Dana Chaser",
): CompetitorSighting => ({ id, competitor, area, at, loggedBy, locationId: "nwk" });

const render = (from: Date, periodLabel: string, officeIds: string[] | null = null) =>
  renderToStaticMarkup(
    createElement(CompetitorActivitySnapshot, { from, to, officeIds, periodLabel }),
  );

beforeEach(() => {
  state.byWindow = new Map();
  state.keys = [];
  state.loading = false;
  state.error = false;
});

describe("CompetitorActivitySnapshot", () => {
  it("shows totals, counts by competitor and area, recent sightings and the trend", () => {
    state.byWindow.set(key(from7, to), [
      sighting("1", "Rapid Restore", "North Zone", "2026-10-14T18:00:00.000Z", "Dana Chaser"),
      sighting("2", "Rapid Restore", "South Zone", "2026-10-13T12:00:00.000Z", "Lee Runner"),
      sighting("3", "BlueLine", "North Zone", "2026-10-12T09:00:00.000Z", null),
    ]);
    state.byWindow.set(key(prev7, from7), [
      sighting("p1", "BlueLine", "North Zone", "2026-10-05T09:00:00.000Z"),
    ]);

    const html = render(from7, "Last 7 days");

    expect(html).toContain("Competitor activity");
    expect(html).toContain("Last 7 days");
    expect(html).toContain("leads lost to a competitor");
    expect(html).toMatch(/>3<\/span>/);
    expect(html).toContain("By competitor");
    expect(html).toContain("By area");
    expect(html).toContain("Rapid Restore");
    expect(html).toContain("North Zone");
    expect(html).toContain("Most recent");
    expect(html).toContain("logged by Dana Chaser");
    expect(html).toContain("logged by Lee Runner");
    expect(html).toContain("logged by unknown");
    // 3 now vs 1 before: up is bad.
    expect(html).toContain("+2 (+200%)");
    expect(html).toContain("vs previous period (1)");
    expect(html).toContain('href="/chase/search"');
    expect(html).toContain("View map");
    expect(html).not.toContain("No competitor sightings");
  });

  it("orders the competitor breakdown by count", () => {
    state.byWindow.set(key(from7, to), [
      sighting("1", "BlueLine", "A", "2026-10-14T18:00:00.000Z"),
      sighting("2", "Rapid Restore", "A", "2026-10-13T18:00:00.000Z"),
      sighting("3", "Rapid Restore", "B", "2026-10-12T18:00:00.000Z"),
    ]);
    const html = render(from7, "Last 7 days");
    const breakdown = html.slice(html.indexOf("By competitor"), html.indexOf("By area"));
    expect(breakdown.indexOf("Rapid Restore")).toBeLessThan(breakdown.indexOf("BlueLine"));
  });

  it("explains how sightings get logged when there are none", () => {
    state.byWindow.set(key(prev7, from7), [
      sighting("p1", "BlueLine", "North Zone", "2026-10-05T09:00:00.000Z"),
    ]);
    const html = render(from7, "Last 7 days");
    expect(html).toContain("No competitor sightings logged in this period.");
    expect(html).toContain("Log outcome");
    expect(html).toContain("Another company signed");
    expect(html).toContain("−1 (−100%)");
    expect(html).toContain("View map");
    expect(html).not.toContain("Most recent");
  });

  it("follows the page's period: new range, new query and new numbers", () => {
    state.byWindow.set(key(from7, to), [
      sighting("1", "BlueLine", "A", "2026-10-14T18:00:00.000Z"),
    ]);
    state.byWindow.set(key(from30, to), [
      sighting("1", "BlueLine", "A", "2026-10-14T18:00:00.000Z"),
      sighting("2", "Rapid Restore", "B", "2026-09-20T18:00:00.000Z"),
    ]);
    state.byWindow.set(key(prev30, from30), [
      sighting("p", "BlueLine", "A", "2026-09-01T18:00:00.000Z"),
      sighting("q", "BlueLine", "A", "2026-08-30T18:00:00.000Z"),
    ]);

    const week = render(from7, "Last 7 days");
    expect(week).toContain("Last 7 days");
    expect(week).not.toContain("Rapid Restore");

    state.keys = [];
    const month = render(from30, "Last 30 days");
    expect(state.keys.map((k) => k[1])).toEqual([key(from30, to), key(prev30, from30)]);
    expect(month).toContain("Last 30 days");
    expect(month).toContain("Rapid Restore");
    expect(month).toContain("No change");
  });

  it("carries the office scope into the query key (View As / branch filter)", () => {
    render(from7, "Last 7 days", ["nwk", "phl"]);
    expect(state.keys[0]).toEqual(["competitor-activity", key(from7, to), "nwk,phl"]);
    state.keys = [];
    render(from7, "Last 7 days", null);
    expect(state.keys[0]?.[2]).toBe("rls");
  });

  it("does not show an empty state while loading or on error", () => {
    state.loading = true;
    expect(render(from7, "Last 7 days")).not.toContain("No competitor sightings");
    state.loading = false;
    state.error = true;
    const html = render(from7, "Last 7 days");
    expect(html).toContain("Could not load competitor activity.");
    expect(html).not.toContain("No competitor sightings");
  });
});
