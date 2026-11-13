/**
 * The tradeshows page's period: which shows the KPI strip and the list count.
 *
 * Mark, from a screenshot of the strip reading "$71,780 SPENT — $17,945 per
 * account": "is this a running total? Is this all time, or should we put by
 * quarter, year etc? Like how much did we spend in 2023 on shows etc etc"
 *
 * It was all time. `tradeshow_roi()` has no date filter, and the page summed
 * `cost` over every non-archived show and divided by every account ever
 * attributed to any of them. Nothing on the page said so, and there was no
 * way to ask "2023".
 *
 * A show belongs to a period by its `starts_on` date. A show that runs across
 * a boundary goes with the year or quarter it started in, and a show with no
 * start date can only be counted under "All time". Periods are whole calendar
 * spans, not to-date: "2026" is every show starting in 2026, including the
 * ones still ahead on the calendar, because the booth fee is committed the
 * day the show is booked and "how much did we spend in 2023" means the whole
 * of 2023. "All time" is the default and reads exactly as the page always did.
 *
 * The comparison window is the previous calendar year or quarter; a custom
 * range compares with the same number of days immediately before it, which is
 * the rule the leaderboard's custom range already uses (`customWindow`).
 */
import { customWindow, isDay } from "@/lib/leaderboard-window";
import { toDateStr } from "@/lib/period";
import {
  tradeshowLeadCount,
  type Tradeshow,
  type TradeshowLeadCount,
  type TradeshowRoi,
} from "@/lib/tradeshows";

export type ShowPeriod = "all" | "year" | "last_year" | "quarter" | "last_quarter" | "custom";

/** The buttons, in order. Custom is a separate button that opens the dialog. */
export const SHOW_PERIOD_PRESETS: { key: Exclude<ShowPeriod, "custom">; label: string }[] = [
  { key: "all", label: "All time" },
  { key: "year", label: "This year" },
  { key: "last_year", label: "Last year" },
  { key: "quarter", label: "This quarter" },
  { key: "last_quarter", label: "Last quarter" },
];

export function isShowPeriod(v: unknown): v is ShowPeriod {
  return v === "custom" || SHOW_PERIOD_PRESETS.some((p) => p.key === v);
}

/**
 * Calendar days, `YYYY-MM-DD`, inclusive on both ends — the same shape as
 * `starts_on`, so membership is a string comparison with no timezone in it.
 * `null` is "All time": no window at all.
 */
export type ShowWindow = { from: string; to: string; prevFrom: string; prevTo: string } | null;

export type CustomDays = { from: string; to: string } | null;

const day = (y: number, m: number, d: number) => toDateStr(new Date(y, m, d));

/**
 * Resolves the URL's choice to a window on a given clock. "custom" without a
 * usable pair of days behaves as "All time" — a shared link with the dates
 * stripped shows the page as it always was rather than an empty strip.
 */
export function showWindowFor(
  period: ShowPeriod,
  custom: CustomDays = null,
  now = new Date(),
): ShowWindow {
  const y = now.getFullYear();
  const q = Math.floor(now.getMonth() / 3) * 3;
  switch (period) {
    case "year":
      return {
        from: day(y, 0, 1),
        to: day(y, 11, 31),
        prevFrom: day(y - 1, 0, 1),
        prevTo: day(y - 1, 11, 31),
      };
    case "last_year":
      return {
        from: day(y - 1, 0, 1),
        to: day(y - 1, 11, 31),
        prevFrom: day(y - 2, 0, 1),
        prevTo: day(y - 2, 11, 31),
      };
    case "quarter":
      // `new Date(y, m + 3, 0)` is the last day of the quarter's third month.
      return {
        from: day(y, q, 1),
        to: day(y, q + 3, 0),
        prevFrom: day(y, q - 3, 1),
        prevTo: day(y, q, 0),
      };
    case "last_quarter":
      return {
        from: day(y, q - 3, 1),
        to: day(y, q, 0),
        prevFrom: day(y, q - 6, 1),
        prevTo: day(y, q - 3, 0),
      };
    case "custom": {
      if (!custom || !isDay(custom.from) || !isDay(custom.to)) return null;
      const w = customWindow(custom.from, custom.to);
      if (!w) return null;
      // customWindow's ends are exclusive midnights; step back into the last day.
      const lastDay = (exclusive: Date) => toDateStr(new Date(exclusive.getTime() - 1));
      return {
        from: toDateStr(w.from),
        to: lastDay(w.to),
        prevFrom: toDateStr(w.prevFrom),
        prevTo: lastDay(w.prevTo),
      };
    }
    default:
      return null;
  }
}

/** Membership by `starts_on`. No window means every show; no start date means only "All time". */
export function showInWindow(
  show: Pick<Tradeshow, "starts_on">,
  from: string | null,
  to: string | null,
): boolean {
  if (from == null || to == null) return true;
  const start = show.starts_on?.slice(0, 10);
  return !!start && start >= from && start <= to;
}

export function showsInPeriod<T extends Pick<Tradeshow, "starts_on">>(
  shows: T[],
  w: ShowWindow,
): T[] {
  return w ? shows.filter((s) => showInWindow(s, w.from, w.to)) : shows;
}

export function showsInPreviousPeriod<T extends Pick<Tradeshow, "starts_on">>(
  shows: T[],
  w: ShowWindow,
): T[] {
  return w ? shows.filter((s) => showInWindow(s, w.prevFrom, w.prevTo)) : [];
}

export type PeriodTotals = {
  shows: number;
  cost: number;
  leads: number;
  accounts: number;
  jobs: number;
  /** Cost in the period ÷ accounts won from shows in the period. */
  costPerAccount: number | null;
  costPerLead: number | null;
  /** True when at least one counted show fell back to its hand-entered lead total. */
  usingLegacyLeadFallback: boolean;
};

/**
 * The strip's numbers over one set of shows. Accounts are attributed to a
 * show on the account's own record (`accounts.tradeshow_id`), and the ROI
 * RPC counts them per show, so scoping the shows scopes the accounts with
 * them: "per account" for 2023 is 2023's spend over the accounts 2023's
 * shows produced, never over every account the company has ever won.
 */
export function periodTotals(
  shows: Pick<Tradeshow, "id" | "cost" | "leads_captured">[],
  roiById: Map<string, Pick<TradeshowRoi, "accounts_created" | "jobs_won">>,
): PeriodTotals {
  let cost = 0;
  let leads = 0;
  let accounts = 0;
  let jobs = 0;
  let usingLegacyLeadFallback = false;
  for (const show of shows) {
    const r = roiById.get(show.id);
    const lead: TradeshowLeadCount = tradeshowLeadCount(show, r);
    cost += Number(show.cost ?? 0);
    leads += lead.count;
    accounts += Math.max(0, Number(r?.accounts_created) || 0);
    jobs += Math.max(0, Number(r?.jobs_won) || 0);
    if (lead.source === "legacy") usingLegacyLeadFallback = true;
  }
  return {
    shows: shows.length,
    cost,
    leads,
    accounts,
    jobs,
    costPerAccount: accounts > 0 ? cost / accounts : null,
    costPerLead: leads > 0 ? cost / leads : null,
    usingLegacyLeadFallback,
  };
}

/* ------------------------------------------------------------------ */
/* Labels                                                              */
/* ------------------------------------------------------------------ */

const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function spellDays(from: string, to: string): string {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  // The year is the whole point of asking, so it is always spelled.
  if (fy === ty) return `${MONTH[fm - 1]} ${fd} – ${MONTH[tm - 1]} ${td}, ${ty}`;
  return `${MONTH[fm - 1]} ${fd}, ${fy} – ${MONTH[tm - 1]} ${td}, ${ty}`;
}

/** "All time", "2026", "Q3 2026", "Jan 1 – Mar 31, 2023" — what the tile covers. */
export function showPeriodLabel(period: ShowPeriod, w: ShowWindow): string {
  return spanLabel(period, w, "from", "to") ?? "All time";
}

/** The same spelling for the comparison window: "2025", "Q2 2026", "Oct 3 – Dec 31, 2022". */
export function previousPeriodLabel(period: ShowPeriod, w: ShowWindow): string | null {
  return spanLabel(period, w, "prevFrom", "prevTo");
}

function spanLabel(
  period: ShowPeriod,
  w: ShowWindow,
  fromKey: "from" | "prevFrom",
  toKey: "to" | "prevTo",
): string | null {
  if (!w) return null;
  const from = w[fromKey];
  const to = w[toKey];
  const year = from.slice(0, 4);
  if (period === "year" || period === "last_year") return year;
  if (period === "quarter" || period === "last_quarter") {
    const q = Math.floor((Number(from.slice(5, 7)) - 1) / 3) + 1;
    return `Q${q} ${year}`;
  }
  return spellDays(from, to);
}
