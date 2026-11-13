/**
 * The leaderboard's ranking window and the window it is compared against.
 *
 * Mark: "on hte leaderboard page, add a customs date range picker".
 *
 * Week, month and quarter are unchanged from when they lived inside the route
 * file: they run from the start of the current period (UTC, the way the
 * standings RPC has always been asked) up to now, and compare against the
 * whole previous period. They sit here, out of React, so the arithmetic can
 * be tested on a fixed clock.
 *
 * A custom range is two calendar days off a date input, inclusive on both
 * ends. The standings RPC takes an exclusive `to`, so the window ends at the
 * midnight after the chosen last day. Its comparison window is the same
 * number of days immediately before `from`: a manager reading "Sep 1 – Sep
 * 15" against "Aug 17 – Aug 31" is comparing like with like, which a
 * calendar-month comparison would not give them.
 */
import { parseDateStr } from "@/lib/period";

export type Period = "week" | "month" | "quarter" | "custom";
export type PresetPeriod = Exclude<Period, "custom">;

export const PRESET_PERIODS: PresetPeriod[] = ["week", "month", "quarter"];

export function isPeriod(v: unknown): v is Period {
  return v === "custom" || PRESET_PERIODS.includes(v as PresetPeriod);
}

/** `to` and `prevTo` are exclusive — the standings RPC filters `< _to`. */
export type Window = { from: Date; to: Date; prevFrom: Date; prevTo: Date };

/** The same `YYYY-MM-DD` shape a date input emits and the URL carries. */
export function isDay(s: unknown): s is string {
  return typeof s === "string" && parseDateStr(s) !== null;
}

export function presetWindow(period: PresetPeriod, now = new Date()): Window {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  if (period === "week") {
    const dow = (now.getUTCDay() + 6) % 7;
    const from = new Date(Date.UTC(y, m, now.getUTCDate() - dow));
    return { from, to: now, prevFrom: new Date(from.getTime() - 7 * 86400000), prevTo: from };
  }
  if (period === "month") {
    const from = new Date(Date.UTC(y, m, 1));
    return { from, to: now, prevFrom: new Date(Date.UTC(y, m - 1, 1)), prevTo: from };
  }
  const q = Math.floor(m / 3) * 3;
  const from = new Date(Date.UTC(y, q, 1));
  return { from, to: now, prevFrom: new Date(Date.UTC(y, q - 3, 1)), prevTo: from };
}

/**
 * Both days are read as local calendar days, the way the person who typed
 * them into a date input meant them. Returns null when either day is
 * malformed or the range runs backwards, so the caller falls back to a
 * preset rather than ranking an empty or inverted window.
 */
export function customWindow(fromDay: string, toDay: string): Window | null {
  const from = parseDateStr(fromDay);
  const lastDay = parseDateStr(toDay);
  if (!from || !lastDay || from > lastDay) return null;
  const to = new Date(lastDay);
  to.setDate(to.getDate() + 1);
  // setDate keeps the count in calendar days, so a DST change inside the
  // range does not shave an hour off the comparison window.
  const days = Math.round((to.getTime() - from.getTime()) / 86400000);
  const prevFrom = new Date(from);
  prevFrom.setDate(prevFrom.getDate() - days);
  return { from, to, prevFrom, prevTo: from };
}

export type Custom = { from: string; to: string } | null;

/**
 * Resolves the URL's choice to a window. "custom" without a usable pair of
 * days behaves as the default month, which is what a shared link with the
 * dates stripped should do rather than break the page.
 */
export function windowFor(period: Period, custom: Custom, now = new Date()): Window {
  if (period === "custom" && custom) {
    const w = customWindow(custom.from, custom.to);
    if (w) return w;
  }
  return presetWindow(period === "custom" ? "month" : period, now);
}

const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * "Sep 1 – Sep 15", spelled from the first day to the last day inclusive.
 * Takes the window's exclusive end and steps back into the last day it
 * covers, so the label matches what the person picked. The year only appears
 * when the two ends fall in different years.
 */
export function rangeLabel(from: Date, toExclusive: Date): string {
  const last = new Date(toExclusive.getTime() - 1);
  const day = (d: Date, withYear: boolean) =>
    `${MONTH[d.getMonth()]} ${d.getDate()}${withYear ? `, ${d.getFullYear()}` : ""}`;
  const crossesYear = from.getFullYear() !== last.getFullYear();
  return `${day(from, crossesYear)} – ${day(last, crossesYear)}`;
}

/** What the header says the board covers, and what the arrows compare it to. */
export function windowLabels(period: Period, w: Window): { current: string; previous: string } {
  if (period === "custom") {
    return {
      current: rangeLabel(w.from, w.to),
      previous: `vs ${rangeLabel(w.prevFrom, w.prevTo)}`,
    };
  }
  return { current: `This ${period}`, previous: `vs last ${period}` };
}
