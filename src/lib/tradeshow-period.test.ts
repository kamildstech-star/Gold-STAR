import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import {
  isShowPeriod,
  periodTotals,
  previousPeriodLabel,
  showInWindow,
  showPeriodLabel,
  showWindowFor,
  showsInPeriod,
  showsInPreviousPeriod,
} from "@/lib/tradeshow-period";
import type { Tradeshow, TradeshowRoi } from "@/lib/tradeshows";

/**
 * Mark, from a screenshot of "$71,780 SPENT — $17,945 per account": "is this
 * a running total? Is this all time, or should we put by quarter, year etc?
 * Like how much did we spend in 2023 on shows etc etc"
 *
 * The window arithmetic is pinned on a fixed clock, then the rule that "per
 * account" divides by the accounts the period's own shows produced.
 */

/** A Wednesday in Q3, well clear of any month, quarter or DST edge. */
const NOW = new Date(2026, 8, 16, 14, 30);

describe("period windows", () => {
  it("all time has no window", () => {
    expect(showWindowFor("all", null, NOW)).toBeNull();
  });

  it("this year is the whole calendar year, compared with the year before", () => {
    expect(showWindowFor("year", null, NOW)).toEqual({
      from: "2026-01-01",
      to: "2026-12-31",
      prevFrom: "2025-01-01",
      prevTo: "2025-12-31",
    });
  });

  it("last year is the previous calendar year, compared with the one before it", () => {
    expect(showWindowFor("last_year", null, NOW)).toEqual({
      from: "2025-01-01",
      to: "2025-12-31",
      prevFrom: "2024-01-01",
      prevTo: "2024-12-31",
    });
  });

  it("this quarter runs to the quarter's last day, compared with the previous quarter", () => {
    expect(showWindowFor("quarter", null, NOW)).toEqual({
      from: "2026-07-01",
      to: "2026-09-30",
      prevFrom: "2026-04-01",
      prevTo: "2026-06-30",
    });
  });

  it("last quarter is the previous quarter, compared with the one before it", () => {
    expect(showWindowFor("last_quarter", null, NOW)).toEqual({
      from: "2026-04-01",
      to: "2026-06-30",
      prevFrom: "2026-01-01",
      prevTo: "2026-03-31",
    });
  });

  it("Q1's previous quarters cross into the year before", () => {
    const jan = new Date(2027, 0, 10);
    expect(showWindowFor("quarter", null, jan)).toMatchObject({
      from: "2027-01-01",
      to: "2027-03-31",
      prevFrom: "2026-10-01",
      prevTo: "2026-12-31",
    });
    expect(showWindowFor("last_quarter", null, jan)).toMatchObject({
      from: "2026-10-01",
      to: "2026-12-31",
      prevFrom: "2026-07-01",
      prevTo: "2026-09-30",
    });
  });

  it("a custom range is inclusive of both days and compares with the same span before it", () => {
    expect(showWindowFor("custom", { from: "2023-01-01", to: "2023-12-31" }, NOW)).toEqual({
      from: "2023-01-01",
      to: "2023-12-31",
      prevFrom: "2022-01-01",
      prevTo: "2022-12-31",
    });
    // Q3 is 92 days, so the comparison span is 92 days too — one day into
    // March — rather than the calendar quarter. The "This quarter" preset is
    // the one that compares quarter with quarter.
    expect(showWindowFor("custom", { from: "2024-07-01", to: "2024-09-30" }, NOW)).toEqual({
      from: "2024-07-01",
      to: "2024-09-30",
      prevFrom: "2024-03-31",
      prevTo: "2024-06-30",
    });
  });

  it("custom without a usable pair of days is all time, not an empty page", () => {
    expect(showWindowFor("custom", null, NOW)).toBeNull();
    expect(showWindowFor("custom", { from: "2024-09-30", to: "2024-07-01" }, NOW)).toBeNull();
    expect(showWindowFor("custom", { from: "nope", to: "2024-07-01" }, NOW)).toBeNull();
  });

  it("only the URL's own words are periods", () => {
    for (const p of ["all", "year", "last_year", "quarter", "last_quarter", "custom"]) {
      expect(isShowPeriod(p)).toBe(true);
    }
    expect(isShowPeriod("month")).toBe(false);
    expect(isShowPeriod("")).toBe(false);
    expect(isShowPeriod(undefined)).toBe(false);
  });
});

describe("which shows a period counts", () => {
  const show = (id: string, starts_on: string | null): Tradeshow =>
    ({ id, starts_on, cost: 0, leads_captured: 0 }) as Tradeshow;

  it("a show belongs to the period its start date falls in", () => {
    expect(showInWindow(show("a", "2026-03-31"), "2026-01-01", "2026-03-31")).toBe(true);
    expect(showInWindow(show("a", "2026-04-01"), "2026-01-01", "2026-03-31")).toBe(false);
    expect(showInWindow(show("a", "2025-12-31"), "2026-01-01", "2026-03-31")).toBe(false);
  });

  it("a show spanning a boundary goes with its start, and a show with no start is only all time", () => {
    const w = showWindowFor("last_year", null, NOW);
    const yearEnd = show("ny", "2025-12-30");
    const undated = show("tbd", null);
    expect(showsInPeriod([yearEnd, undated], w)).toEqual([yearEnd]);
    expect(showsInPeriod([yearEnd, undated], null)).toEqual([yearEnd, undated]);
  });

  it("the previous period reads the comparison half of the window", () => {
    const w = showWindowFor("year", null, NOW);
    const thisYear = show("now", "2026-05-01");
    const lastYear = show("then", "2025-05-01");
    expect(showsInPeriod([thisYear, lastYear], w)).toEqual([thisYear]);
    expect(showsInPreviousPeriod([thisYear, lastYear], w)).toEqual([lastYear]);
    expect(showsInPreviousPeriod([thisYear, lastYear], null)).toEqual([]);
  });
});

describe("per account uses the period's own accounts", () => {
  const show = (id: string, starts_on: string, cost: number): Tradeshow =>
    ({ id, starts_on, cost, leads_captured: 99 }) as Tradeshow;
  const roi = (accounts_created: number, jobs_won = 0) =>
    ({ accounts_created, jobs_won }) as TradeshowRoi;

  const shows = [
    show("s23", "2023-03-01", 10_000),
    show("s24", "2024-03-01", 20_000),
    show("s25", "2025-03-01", 41_780),
  ];
  const roiById = new Map([
    ["s23", roi(2, 1)],
    ["s24", roi(1)],
    ["s25", roi(1, 3)],
  ]);

  it("all time is the number the page always showed", () => {
    const t = periodTotals(shows, roiById);
    expect(t.cost).toBe(71_780);
    expect(t.accounts).toBe(4);
    expect(t.costPerAccount).toBe(17_945);
    expect(t.jobs).toBe(4);
    expect(t.usingLegacyLeadFallback).toBe(false);
  });

  it("2023's per-account divides 2023's spend by 2023's accounts, not every account ever", () => {
    const w = showWindowFor("custom", { from: "2023-01-01", to: "2023-12-31" }, NOW);
    const t = periodTotals(showsInPeriod(shows, w), roiById);
    expect(t.shows).toBe(1);
    expect(t.cost).toBe(10_000);
    expect(t.accounts).toBe(2);
    expect(t.costPerAccount).toBe(5_000);
    expect(t.costPerLead).toBe(5_000);
    expect(t.jobs).toBe(1);
  });

  it("no accounts in the period means no per-account figure rather than a division by zero", () => {
    const t = periodTotals([show("x", "2026-01-01", 500)], new Map([["x", roi(0)]]));
    expect(t.cost).toBe(500);
    expect(t.costPerAccount).toBeNull();
    expect(t.costPerLead).toBeNull();
  });

  it("a show without an ROI row falls back to its hand-entered leads and says so", () => {
    const t = periodTotals([show("x", "2026-01-01", 500)], new Map());
    expect(t.leads).toBe(99);
    expect(t.accounts).toBe(0);
    expect(t.usingLegacyLeadFallback).toBe(true);
  });
});

describe("what the tile says it covers", () => {
  it("names the year, the quarter, or the days", () => {
    expect(showPeriodLabel("all", null)).toBe("All time");
    expect(showPeriodLabel("year", showWindowFor("year", null, NOW))).toBe("2026");
    expect(showPeriodLabel("last_year", showWindowFor("last_year", null, NOW))).toBe("2025");
    expect(showPeriodLabel("quarter", showWindowFor("quarter", null, NOW))).toBe("Q3 2026");
    expect(showPeriodLabel("last_quarter", showWindowFor("last_quarter", null, NOW))).toBe(
      "Q2 2026",
    );
    const q1 = showWindowFor("custom", { from: "2023-01-01", to: "2023-03-31" }, NOW);
    expect(showPeriodLabel("custom", q1)).toBe("Jan 1 – Mar 31, 2023");
    const straddle = showWindowFor("custom", { from: "2025-12-01", to: "2026-01-31" }, NOW);
    expect(showPeriodLabel("custom", straddle)).toBe("Dec 1, 2025 – Jan 31, 2026");
  });

  it("names the comparison period the same way, and has none for all time", () => {
    expect(previousPeriodLabel("all", null)).toBeNull();
    expect(previousPeriodLabel("year", showWindowFor("year", null, NOW))).toBe("2025");
    expect(previousPeriodLabel("quarter", showWindowFor("quarter", null, NOW))).toBe("Q2 2026");
    expect(
      previousPeriodLabel("quarter", showWindowFor("quarter", null, new Date(2027, 0, 10))),
    ).toBe("Q4 2026");
    const q1 = showWindowFor("custom", { from: "2023-01-01", to: "2023-03-31" }, NOW);
    expect(previousPeriodLabel("custom", q1)).toBe("Oct 3 – Dec 31, 2022");
  });
});

/* -------------------------------------------------------------------- */
/* Source guards — no DOM testing library in this repo                    */
/* -------------------------------------------------------------------- */

const ROUTE = readFileSync(
  join(process.cwd(), "src/routes/_authenticated/tradeshows.index.tsx"),
  "utf8",
).replace(/\r\n/g, "\n");

describe("tradeshows page wiring", () => {
  it("carries the period and the custom days in the URL", () => {
    const validate = ROUTE.match(/validateSearch:[\s\S]*?\n\s*\}\),/);
    expect(validate).not.toBeNull();
    expect(validate![0]).toMatch(/period: \(isShowPeriod\(raw\.period\) \? raw\.period : "all"\)/);
    expect(validate![0]).toMatch(/from: isDay\(raw\.from\) \? raw\.from : ""/);
    expect(validate![0]).toMatch(/to: isDay\(raw\.to\) \? raw\.to : ""/);
  });

  it("a preset button writes the period and clears the custom days", () => {
    const click = ROUTE.match(/onClick=\{\(\) => update\(\{ period: p\.key[^}]*\}\)\}/);
    expect(click).not.toBeNull();
    expect(click![0]).toContain('from: ""');
    expect(click![0]).toContain('to: ""');
  });

  it("the custom range is the shared dialog, applied on confirm", () => {
    expect(ROUTE).toContain('import { DateRangeDialog } from "@/components/date-range-dialog"');
    const dialog = ROUTE.match(/<DateRangeDialog[\s\S]*?\/>/);
    expect(dialog).not.toBeNull();
    expect(dialog![0]).toMatch(
      /onApply=\{\(\{ from, to \}\) => update\(\{ period: "custom", from, to \}\)\}/,
    );
  });

  it("the Spent tile's caption says what period it covers, and what it is compared with", () => {
    const label = ROUTE.match(/label: `Spent · \$\{periodLabel\}`/);
    expect(label).not.toBeNull();
    const vs = ROUTE.match(/vs \{prevLabel\}: \{money\(prevTotals\.cost\)\}/);
    expect(vs).not.toBeNull();
    // Guarded on the window, so "All time" carries no comparison line.
    const guard = ROUTE.match(/\{prevTotals && prevLabel && \(/);
    expect(guard).not.toBeNull();
  });

  it("the strip and the list read the period's shows; the calendar reads every show", () => {
    expect(ROUTE).toMatch(/const shows = showsInPeriod\(allShows, periodWindow\)/);
    expect(ROUTE).toMatch(/const totals = periodTotals\(shows, roiById\)/);
    const calendar = ROUTE.match(/<MonthCalendar[\s\S]*?shows=\{(\w+)\}/);
    expect(calendar?.[1]).toBe("allShows");
  });
});
