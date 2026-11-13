import { describe, expect, it } from "vitest";

import {
  customWindow,
  isDay,
  isPeriod,
  presetWindow,
  rangeLabel,
  windowFor,
  windowLabels,
} from "@/lib/leaderboard-window";

/**
 * Mark: "on hte leaderboard page, add a customs date range picker".
 *
 * The presets are pinned first — moving the arithmetic out of the route
 * must not shift a single boundary — then the custom range and its "same
 * number of days immediately before" comparison window.
 */

/** A Wednesday in the third quarter, well clear of any month or DST edge. */
const NOW = new Date(Date.UTC(2026, 8, 16, 14, 30));

const localDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

describe("preset windows", () => {
  it("week starts on the UTC Monday and compares with the seven days before", () => {
    const w = presetWindow("week", NOW);
    expect(w.from.toISOString()).toBe("2026-09-14T00:00:00.000Z");
    expect(w.to).toBe(NOW);
    expect(w.prevFrom.toISOString()).toBe("2026-09-07T00:00:00.000Z");
    expect(w.prevTo).toEqual(w.from);
  });

  it("month starts on the 1st and compares with the whole previous month", () => {
    const w = presetWindow("month", NOW);
    expect(w.from.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(w.to).toBe(NOW);
    expect(w.prevFrom.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(w.prevTo).toEqual(w.from);
  });

  it("quarter starts on the quarter's first day and compares with the previous quarter", () => {
    const w = presetWindow("quarter", NOW);
    expect(w.from.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(w.to).toBe(NOW);
    expect(w.prevFrom.toISOString()).toBe("2026-04-01T00:00:00.000Z");
    expect(w.prevTo).toEqual(w.from);
  });

  it("January's previous month is December of the year before", () => {
    const w = presetWindow("month", new Date(Date.UTC(2027, 0, 10)));
    expect(w.prevFrom.toISOString()).toBe("2026-12-01T00:00:00.000Z");
  });
});

describe("custom windows", () => {
  it("covers both chosen days inclusively, with an exclusive end for the RPC", () => {
    const w = customWindow("2026-09-01", "2026-09-15")!;
    expect(localDay(w.from)).toBe("2026-09-01");
    expect(w.from.getHours()).toBe(0);
    // Exclusive end: the midnight after Sep 15, so Sep 15's records count.
    expect(localDay(w.to)).toBe("2026-09-16");
    expect(w.to.getHours()).toBe(0);
  });

  it("compares against the same number of days immediately before", () => {
    // Sep 1–15 is fifteen days; the fifteen days before end on Aug 31.
    const w = customWindow("2026-09-01", "2026-09-15")!;
    expect(localDay(w.prevFrom)).toBe("2026-08-17");
    expect(w.prevTo).toEqual(w.from);
  });

  it("a single day compares against the day before", () => {
    const w = customWindow("2026-09-10", "2026-09-10")!;
    expect(localDay(w.from)).toBe("2026-09-10");
    expect(localDay(w.to)).toBe("2026-09-11");
    expect(localDay(w.prevFrom)).toBe("2026-09-09");
  });

  it("keeps the count in calendar days across a DST change", () => {
    // In US zones the clocks go back on 2026-11-01; in zones without DST
    // this is just another 31-day range. Either way the previous window is
    // exactly 31 calendar days.
    const w = customWindow("2026-10-20", "2026-11-19")!;
    expect(localDay(w.prevFrom)).toBe("2026-09-19");
    expect(w.prevFrom.getHours()).toBe(0);
  });

  it("rejects a range that runs backwards", () => {
    expect(customWindow("2026-09-15", "2026-09-01")).toBeNull();
  });

  it("rejects a malformed day", () => {
    expect(customWindow("2026-9-1", "2026-09-15")).toBeNull();
    expect(customWindow("", "2026-09-15")).toBeNull();
    expect(customWindow("2026-09-01", "next tuesday")).toBeNull();
  });
});

describe("windowFor", () => {
  it("hands presets through untouched", () => {
    expect(windowFor("week", null, NOW)).toEqual(presetWindow("week", NOW));
    expect(windowFor("month", null, NOW)).toEqual(presetWindow("month", NOW));
    expect(windowFor("quarter", null, NOW)).toEqual(presetWindow("quarter", NOW));
  });

  it("ignores stray from/to when a preset is chosen", () => {
    const custom = { from: "2026-09-01", to: "2026-09-15" };
    expect(windowFor("week", custom, NOW)).toEqual(presetWindow("week", NOW));
  });

  it("uses the custom range when it is valid", () => {
    const custom = { from: "2026-09-01", to: "2026-09-15" };
    expect(windowFor("custom", custom, NOW)).toEqual(customWindow(custom.from, custom.to));
  });

  it("falls back to this month when 'custom' arrives without usable days", () => {
    expect(windowFor("custom", null, NOW)).toEqual(presetWindow("month", NOW));
    expect(windowFor("custom", { from: "2026-09-15", to: "2026-09-01" }, NOW)).toEqual(
      presetWindow("month", NOW),
    );
  });
});

describe("labels", () => {
  it("spells a custom range from first day to last day", () => {
    const w = customWindow("2026-09-01", "2026-09-15")!;
    expect(rangeLabel(w.from, w.to)).toBe("Sep 1 – Sep 15");
    expect(rangeLabel(w.prevFrom, w.prevTo)).toBe("Aug 17 – Aug 31");
  });

  it("adds the year only when the range crosses one", () => {
    const w = customWindow("2026-12-20", "2027-01-05")!;
    expect(rangeLabel(w.from, w.to)).toBe("Dec 20, 2026 – Jan 5, 2027");
  });

  it("names a preset, and a custom range by its dates — never 'custom'", () => {
    expect(windowLabels("month", presetWindow("month", NOW))).toEqual({
      current: "This month",
      previous: "vs last month",
    });
    const w = customWindow("2026-09-01", "2026-09-15")!;
    const l = windowLabels("custom", w);
    expect(l).toEqual({ current: "Sep 1 – Sep 15", previous: "vs Aug 17 – Aug 31" });
    expect(JSON.stringify(l).toLowerCase()).not.toContain("custom");
  });
});

describe("URL guards", () => {
  it("accepts only the four period names", () => {
    for (const p of ["week", "month", "quarter", "custom"]) expect(isPeriod(p)).toBe(true);
    expect(isPeriod("year")).toBe(false);
    expect(isPeriod(undefined)).toBe(false);
  });

  it("accepts only real YYYY-MM-DD days", () => {
    expect(isDay("2026-09-01")).toBe(true);
    expect(isDay("2026-9-1")).toBe(false);
    expect(isDay("")).toBe(false);
    expect(isDay(20260901)).toBe(false);
  });
});
