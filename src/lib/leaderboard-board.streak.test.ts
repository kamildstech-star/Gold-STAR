import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { computeStreaks, STREAK_LOOKBACK_DAYS, streakLength } from "./leaderboard-board";

/**
 * Mark: "it needs to exclude weekends and jewsih holidays" — "as well as
 * federal holidays". Calendar facts used below (all America/New_York dates):
 *
 *   Fri Sep 11 2026 · Sat 12 + Sun 13 = Rosh Hashanah 5787 (a weekend anyway)
 *   Mon Sep 21 2026 = Yom Kippur              Mon Sep 7 2026 = Labor Day
 *   Thu Apr 22 + Fri Apr 23 2027 = Pesach I/II
 *   Thu Sep 21 + Fri Sep 22 2028 = Rosh Hashanah 5789
 */
const days = (...keys: string[]) => new Set(keys);

describe("streakLength — working days only", () => {
  it("Friday + Monday is an unbroken streak of two across the weekend", () => {
    expect(streakLength(days("2026-09-11", "2026-09-14"), { today: "2026-09-14" })).toBe(2);
  });

  it("a streak survives Rosh Hashanah on a Thursday–Friday plus the weekend after it", () => {
    // Wed Sep 20 2028, then RH Thu–Fri, then the weekend, then Mon Sep 25.
    expect(streakLength(days("2028-09-20", "2028-09-25"), { today: "2028-09-25" })).toBe(2);
  });

  it("a streak survives Yom Kippur on a Monday and Pesach on a Thursday–Friday", () => {
    expect(streakLength(days("2026-09-18", "2026-09-22"), { today: "2026-09-22" })).toBe(2);
    expect(streakLength(days("2027-04-21", "2027-04-26"), { today: "2027-04-26" })).toBe(2);
  });

  it("a streak survives a federal holiday", () => {
    // Fri Sep 4, Labor Day Mon Sep 7, Tue Sep 8.
    expect(streakLength(days("2026-09-04", "2026-09-08"), { today: "2026-09-08" })).toBe(2);
  });

  it("a working day with nothing logged ends the streak", () => {
    // Mon 14 and Wed 16 logged, Tue 15 empty, today Wed 16: only Wednesday counts.
    expect(
      streakLength(days("2026-09-10", "2026-09-11", "2026-09-14", "2026-09-16"), {
        today: "2026-09-16",
      }),
    ).toBe(1);
  });

  it("today may be empty (grace), but only today", () => {
    // Nothing yet on Monday morning; Friday was logged.
    expect(streakLength(days("2026-09-10", "2026-09-11"), { today: "2026-09-14" })).toBe(2);
    // Friday itself was missed: the grace does not reach back a working day.
    expect(streakLength(days("2026-09-10"), { today: "2026-09-14" })).toBe(0);
  });

  it("a touchpoint logged on a Saturday counts as a bonus day, and an empty Saturday never breaks", () => {
    // Saturday only, nothing Friday: the Saturday counts, Friday ends it.
    expect(streakLength(days("2026-09-12"), { today: "2026-09-14" })).toBe(1);
    // Friday, Saturday, Monday: three.
    expect(
      streakLength(days("2026-09-11", "2026-09-12", "2026-09-14"), { today: "2026-09-14" }),
    ).toBe(3);
  });

  it("today being a holiday is skipped like any other closed day", () => {
    // Today is Yom Kippur; Friday was logged.
    expect(streakLength(days("2026-09-17", "2026-09-18"), { today: "2026-09-21" })).toBe(2);
    // Today is a Sunday; Friday was missed, Thursday logged: Friday still breaks it.
    expect(streakLength(days("2026-09-17"), { today: "2026-09-20" })).toBe(0);
  });

  it("a company closure is skipped", () => {
    const closures = new Set(["2026-09-16"]);
    const logged = days("2026-09-15", "2026-09-17");
    expect(streakLength(logged, { today: "2026-09-17" })).toBe(1);
    expect(streakLength(logged, { today: "2026-09-17", closures })).toBe(2);
  });

  it("nothing logged is zero, and the walk is bounded by the lookback window", () => {
    expect(streakLength(days(), { today: "2026-09-16" })).toBe(0);
    const everyDay = new Set<string>();
    for (let i = 0; i < 400; i += 1) {
      const d = new Date(Date.UTC(2026, 8, 16) - i * 86_400_000).toISOString().slice(0, 10);
      everyDay.add(d);
    }
    expect(streakLength(everyDay, { today: "2026-09-16" })).toBe(STREAK_LOOKBACK_DAYS);
  });

  it("computeStreaks scores every rep with the same today", () => {
    expect(
      computeStreaks(
        { a: days("2026-09-11", "2026-09-14"), b: days("2026-09-10") },
        { today: "2026-09-14" },
      ),
    ).toEqual({ a: 2, b: 0 });
  });
});

describe("fetchActivityDays — the raw-row fallback", () => {
  const SOURCE = readFileSync(resolve(__dirname, "leaderboard-board.ts"), "utf8").replace(
    /\r\n/g,
    "\n",
  );
  const chain = SOURCE.match(/\.from\("touchpoints"\)[\s\S]*?\.range\([^)]*\)/)?.[0];

  it("pages the rows instead of a single capped select", () => {
    expect(chain).toBeDefined();
    expect(chain).not.toContain(".limit(");
    expect(chain).toContain('.order("occurred_at"');
  });

  it("buckets by the office day, never by the UTC date", () => {
    const streakSection = SOURCE.slice(SOURCE.indexOf("export async function fetchActivityDays"));
    const fn = streakSection.slice(0, streakSection.indexOf("export async function fetchStreaks"));
    expect(fn).toContain("localDayKey(row.occurred_at, OFFICE_TIME_ZONE)");
    expect(fn).not.toMatch(/occurred_at\.slice\(0, 10\)/);
  });
});
