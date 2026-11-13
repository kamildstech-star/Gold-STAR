import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  ALL_OFFICES_PARAM,
  officeFilterOf,
  officesParam,
  officesSearchValue,
  parseOfficesParam,
  resolveOfficeIds,
  sortedIdList,
} from "@/lib/leaderboard-offices";

/**
 * Mark, on the leaderboard's office dropdown: "this should allow multiple
 * selections as well". The pick rides the URL as `offices=<id>,<id>` so a
 * manager can bookmark "leaderboard for NJ + NY"; `offices=all` is the
 * deliberate "every office", and no param at all means "my office", the
 * way the page always opened.
 */

const NJ = "11111111-1111-1111-1111-111111111111";
const NY = "22222222-2222-2222-2222-222222222222";
const CA = "33333333-3333-3333-3333-333333333333";
const GONE = "99999999-9999-9999-9999-999999999999";
const visible = [NJ, NY, CA];

describe("the offices URL param", () => {
  it("round-trips a multi-office pick, sorted, whichever order it was ticked in", () => {
    const written = officesParam([NY, NJ]);
    expect(written).toBe(`${NJ},${NY}`);
    expect(parseOfficesParam(written)).toEqual({ kind: "some", ids: [NJ, NY] });
    expect(officesParam([NJ, NY])).toBe(written);
  });

  it("writes an empty pick as the word 'all', so clearing survives a reload", () => {
    expect(officesParam([])).toBe(ALL_OFFICES_PARAM);
    expect(parseOfficesParam(ALL_OFFICES_PARAM)).toEqual({ kind: "all" });
  });

  it("treats no param, or junk, as 'nobody chose'", () => {
    expect(parseOfficesParam("")).toEqual({ kind: "default" });
    expect(parseOfficesParam("  ")).toEqual({ kind: "default" });
    expect(parseOfficesParam(", ,")).toEqual({ kind: "default" });
  });

  it("de-duplicates and trims", () => {
    expect(sortedIdList(` ${NY}, ${NJ},${NJ},`)).toEqual([NJ, NY]);
    expect(officesParam([NJ, NJ, NY])).toBe(`${NJ},${NY}`);
  });

  it("accepts the router handing the param as a string or an array", () => {
    expect(officesSearchValue(`${NJ},${NY}`)).toBe(`${NJ},${NY}`);
    expect(officesSearchValue([NJ, NY])).toBe(`${NJ},${NY}`);
    expect(officesSearchValue(undefined)).toBe("");
    expect(officesSearchValue(42)).toBe("");
  });
});

describe("which offices the board ranks", () => {
  it("uses the URL's offices when they are ones the viewer may see", () => {
    expect(resolveOfficeIds({ kind: "some", ids: [NJ, NY] }, visible, CA)).toEqual([NJ, NY]);
  });

  it("drops an office the viewer can no longer see, and falls through when none remain", () => {
    expect(resolveOfficeIds({ kind: "some", ids: [GONE, NY] }, visible, CA)).toEqual([NY]);
    expect(resolveOfficeIds({ kind: "some", ids: [GONE] }, visible, CA)).toEqual([CA]);
  });

  it("'all' is every office, which the query expresses as no filter", () => {
    expect(resolveOfficeIds({ kind: "all" }, visible, CA)).toEqual([]);
    expect(officeFilterOf([])).toBeNull();
  });

  it("with nothing in the URL, opens on the viewer's own office — or all, if that is their default", () => {
    expect(resolveOfficeIds({ kind: "default" }, visible, NJ)).toEqual([NJ]);
    expect(resolveOfficeIds({ kind: "default" }, visible, ALL_OFFICES_PARAM)).toEqual([]);
    expect(resolveOfficeIds({ kind: "default" }, visible, GONE)).toEqual([]);
  });

  it("hands the RPC the list itself", () => {
    expect(officeFilterOf([NJ, NY])).toEqual([NJ, NY]);
  });
});

/* -------------------------------------------------------------------- */
/* Wiring — read the route source, assert on extracted fragments         */
/* -------------------------------------------------------------------- */

const ROUTE = readFileSync(
  new URL("../routes/_authenticated/leaderboard.index.tsx", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");

describe("leaderboard header wiring", () => {
  it("the office picker is the shared multi-select, not a bespoke one", () => {
    expect(ROUTE).toMatch(/import \{ MultiSelect,[^}]*\} from "@\/components\/ui\/multi-select"/);
    const picker = ROUTE.match(/<MultiSelect\s[\s\S]*?\/>/);
    expect(picker).not.toBeNull();
    expect(picker![0]).toContain('noun="office"');
    expect(picker![0]).toContain('emptyLabel="All offices"');
    expect(picker![0]).toContain("value={officeIds}");
    expect(picker![0]).toMatch(
      /onChange=\{\(next\) => update\(\{ offices: officesParam\(next\) \}\)\}/,
    );
    expect(ROUTE).not.toContain("<ReportLocationSelect");
  });

  it("the subtitle links to the points editor", () => {
    // Mark: "where is the points editor?"
    const link = ROUTE.match(/<Link to="\/admin\/scorecard"[^>]*>\s*edit them here\s*<\/Link>/);
    expect(link).not.toBeNull();
  });

  it("the selection is a URL search param", () => {
    const schema = ROUTE.match(/validateSearch: [\s\S]*?\n  \}\),/);
    expect(schema).not.toBeNull();
    expect(schema![0]).toContain("offices: officesSearchValue(raw.offices)");
  });

  it("the RPC receives the list, and null for all", () => {
    expect(ROUTE).toMatch(/const locFilter = officeFilterOf\(officeIds\);/);
    expect(ROUTE).toMatch(/fetchStandings\(w\.from, w\.to, locFilter\)/);
    expect(ROUTE).toMatch(/fetchStandings\(w\.prevFrom, w\.prevTo, locFilter\)/);
    expect(ROUTE).toMatch(/fetchWins\(6, locFilter\)/);
  });

  it("every office-scoped query is keyed on the id list, not a single id", () => {
    // `\s*` after the bracket: Prettier breaks a long key across lines.
    const keys = ROUTE.match(
      /queryKey: \[\s*"lb-(?:standings|standings-prev|action-counts|action-counts-prev|wins)"[^\]]*\]/g,
    );
    expect(keys).toHaveLength(5);
    for (const k of keys!) {
      expect(k).toContain("officeIds");
      expect(k).not.toContain("locationId");
    }
  });

  it("the trigger and the period pills share a top edge from sm up", () => {
    // The controls row must not centre the trigger against the taller
    // pills-plus-caption column — that was the original misalignment, and it
    // still holds at the width where the two sit side by side.
    const row = ROUTE.match(
      /<div className="[^"]*sm:flex-row[^"]*sm:items-start">\s*\{officeOptions/,
    );
    expect(row).not.toBeNull();
    const column = ROUTE.match(/<div className="flex flex-col items-stretch gap-1 sm:items-end">/);
    expect(column).not.toBeNull();
  });

  it("stacks both controls full width on a phone instead of letting them drift", () => {
    /*
     * Melly, 17 Sep, relaying Mindy: "it's still not centered or aligned."
     * The row was `flex-wrap items-start` with a fixed-width trigger, so once
     * it wrapped the trigger sat left, the pills sat wherever they landed, and
     * the two no longer shared an edge. One column below sm, the original row
     * above it.
     */
    const row = ROUTE.match(/<div className="flex w-full flex-col[^"]*">\s*\{officeOptions/);
    expect(row).not.toBeNull();
    expect(row![0]).toContain("items-stretch");
    expect(row![0]).toContain("sm:w-auto");
    // The trigger fills the phone row rather than keeping its desktop width.
    expect(ROUTE).toContain('className="h-8 w-full text-[12px] sm:w-[190px]"');
  });
});
