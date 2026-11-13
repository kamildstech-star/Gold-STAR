import { supabase } from "@/integrations/supabase/client";
import { localDayKey } from "@/lib/pipeline-rules";

/**
 * The office calendar: which dates count as working days.
 *
 * Mark, on the leaderboard streak: "it needs to exclude weekends and jewsih
 * holidays" — "as well as federal holidays". Gold Star is a Jewish-owned
 * business in Crown Heights; the office is closed on Shabbat, on yom tov and
 * on the federal holidays, so a rep who logged nothing on those days did not
 * skip a day, they had no day to skip.
 *
 * Everything here is a whole calendar DATE in `America/New_York`, written as
 * "2026-09-12". There are no instants and no hours. In particular a Jewish
 * holiday really begins at sundown the evening before, and the office closes
 * early on erev yom tov — but a streak is scored in whole days, so the DATE the
 * holiday falls on is what matters and the evening before is treated as a
 * normal (short) working day. That is a deliberate simplification.
 *
 * Three calendars are combined, in this order of authority:
 *
 *   1. Weekends — Saturday and Sunday.
 *   2. US federal holidays — computed from the rules, never a year list, with
 *      the federal observed-day rule (a Saturday holiday is observed on the
 *      Friday before, a Sunday one on the Monday after).
 *   3. Jewish holidays — the yom tov days on which work is traditionally
 *      prohibited, by diaspora reckoning (two-day observance). Fast days,
 *      Chanukah, Purim and chol hamoed are NOT closures by default; the
 *      groups exist in `OPTIONAL_JEWISH_OBSERVANCES` for a caller that wants
 *      them.
 *   4. Company closures — a small admin-kept list of extra dates
 *      (`company_holidays`), for a snow day or a company retreat. Absent
 *      table, empty table and a failed read all mean "no extra closures".
 *
 * Why no hebcal. `@hebcal/core` (and its `@hebcal/hdate` core) is GPL-2.0.
 * This is a proprietary app and its dependency tree has no copyleft licence in
 * it today; a GPL library in the browser bundle would be the first, and that is
 * a legal decision, not an engineering one. The Hebrew date of a civil day is
 * something every modern JS engine already computes through ICU
 * (`Intl.DateTimeFormat` with the `hebrew` calendar), so the holidays are
 * derived from that with no dependency at all. The dates were checked against
 * hebcal for 2026–2028 when this was written; the tests pin them.
 */

export const OFFICE_TIME_ZONE = "America/New_York";

/** A calendar date in the office time zone, "YYYY-MM-DD". */
export type DateKey = string;

/* ------------------------------------------------------------ date keys */

const DAY_MS = 86_400_000;

/** Today's date in the office time zone. */
export function todayKey(now: number = Date.now()): DateKey {
  return localDayKey(new Date(now).toISOString(), OFFICE_TIME_ZONE);
}

/**
 * The key `days` calendar days after `key` (negative walks back). Done as UTC
 * arithmetic on the key itself so a DST change can never make a day 23 or 25
 * hours long and skip or repeat a date.
 */
export function shiftDateKey(key: DateKey, days: number): DateKey {
  return new Date(Date.parse(`${key}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday, for a date key. */
export function weekdayOf(key: DateKey): number {
  return new Date(`${key}T00:00:00Z`).getUTCDay();
}

export function isWeekend(key: DateKey): boolean {
  const d = weekdayOf(key);
  return d === 0 || d === 6;
}

/* ------------------------------------------------------ federal holidays */

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function keyOf(year: number, month: number, day: number): DateKey {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/** The `n`th (1-based) given weekday of a month; `n = -1` is the last one. */
function nthWeekday(year: number, month: number, weekday: number, n: number): DateKey {
  if (n > 0) {
    const first = weekdayOf(keyOf(year, month, 1));
    const day = 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
    return keyOf(year, month, day);
  }
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const last = weekdayOf(keyOf(year, month, lastDay));
  return keyOf(year, month, lastDay - ((last - weekday + 7) % 7));
}

/** The federal observed-day rule: Saturday → the Friday before, Sunday → the Monday after. */
function observed(key: DateKey): DateKey {
  const d = weekdayOf(key);
  if (d === 6) return shiftDateKey(key, -1);
  if (d === 0) return shiftDateKey(key, 1);
  return key;
}

function federalHolidaysNominal(year: number): [DateKey, string][] {
  return [
    [observed(keyOf(year, 1, 1)), "New Year's Day"],
    [nthWeekday(year, 1, 1, 3), "Martin Luther King Jr. Day"],
    [nthWeekday(year, 2, 1, 3), "Presidents' Day"],
    [nthWeekday(year, 5, 1, -1), "Memorial Day"],
    [observed(keyOf(year, 6, 19)), "Juneteenth"],
    [observed(keyOf(year, 7, 4)), "Independence Day"],
    [nthWeekday(year, 9, 1, 1), "Labor Day"],
    [nthWeekday(year, 10, 1, 2), "Columbus Day"],
    [observed(keyOf(year, 11, 11)), "Veterans Day"],
    [nthWeekday(year, 11, 4, 4), "Thanksgiving"],
    [observed(keyOf(year, 12, 25)), "Christmas Day"],
  ];
}

const federalCache = new Map<number, Map<DateKey, string>>();

/**
 * Every US federal holiday OBSERVED in a calendar year, date → name. A New
 * Year's Day that falls on a Saturday is observed on December 31 of the year
 * before, which is why the next year's list is consulted too.
 */
export function federalHolidays(year: number): Map<DateKey, string> {
  const hit = federalCache.get(year);
  if (hit) return hit;
  const out = new Map<DateKey, string>();
  for (const [key, name] of [
    ...federalHolidaysNominal(year),
    ...federalHolidaysNominal(year + 1),
  ]) {
    if (key.startsWith(`${year}-`)) out.set(key, name);
  }
  federalCache.set(year, out);
  return out;
}

export function federalHolidayName(key: DateKey): string | null {
  return federalHolidays(Number(key.slice(0, 4))).get(key) ?? null;
}

/* ------------------------------------------------------- hebrew calendar */

export type HebrewMonth =
  | "tishri"
  | "heshvan"
  | "kislev"
  | "tevet"
  | "shevat"
  | "adar-i"
  | "adar"
  | "adar-ii"
  | "nisan"
  | "iyar"
  | "sivan"
  | "tamuz"
  | "av"
  | "elul";

export type HebrewDate = { year: number; month: HebrewMonth; day: number };

/**
 * ICU spells the months "Tishri", "Heshvan", "Adar I", "Adar II"… in English
 * CLDR data, but the spelling is locale data, not an API contract, so the
 * match is on a prefix rather than the whole word.
 */
function hebrewMonthOf(label: string): HebrewMonth | null {
  const s = label.toLowerCase().replace(/[^a-z]/g, "");
  if (s.startsWith("tish")) return "tishri";
  if (s.startsWith("hesh") || s.startsWith("chesh") || s.startsWith("mar")) return "heshvan";
  if (s.startsWith("kis")) return "kislev";
  if (s.startsWith("tev")) return "tevet";
  if (s.startsWith("shv") || s.startsWith("shev")) return "shevat";
  if (s === "adarii" || s === "adar2") return "adar-ii";
  if (s === "adari" || s === "adar1") return "adar-i";
  if (s.startsWith("adar")) return "adar";
  if (s.startsWith("nis")) return "nisan";
  if (s.startsWith("iy")) return "iyar";
  if (s.startsWith("siv")) return "sivan";
  if (s.startsWith("tam")) return "tamuz";
  if (s === "av") return "av";
  if (s.startsWith("el")) return "elul";
  return null;
}

let hebrewFormatter: Intl.DateTimeFormat | null | undefined;
const hebrewCache = new Map<DateKey, HebrewDate | null>();

/**
 * The Hebrew date a civil date falls on (midnight to midnight — see the header
 * for why the sundown start is ignored). `null` only when the engine has no
 * Hebrew calendar, in which case no Jewish holiday is recognised rather than
 * every day being one.
 */
export function hebrewDateOf(key: DateKey): HebrewDate | null {
  const hit = hebrewCache.get(key);
  if (hit !== undefined) return hit;
  if (hebrewFormatter === undefined) {
    try {
      hebrewFormatter = new Intl.DateTimeFormat("en-u-ca-hebrew", {
        timeZone: "UTC",
        year: "numeric",
        month: "long",
        day: "numeric",
      });
    } catch {
      hebrewFormatter = null;
    }
  }
  let out: HebrewDate | null = null;
  if (hebrewFormatter) {
    let year = 0;
    let day = 0;
    let month: HebrewMonth | null = null;
    for (const part of hebrewFormatter.formatToParts(new Date(`${key}T00:00:00Z`))) {
      if (part.type === "year") year = Number(part.value.replace(/\D/g, ""));
      else if (part.type === "day") day = Number(part.value.replace(/\D/g, ""));
      else if (part.type === "month") month = hebrewMonthOf(part.value);
    }
    if (year && day && month) out = { year, month, day };
  }
  if (hebrewCache.size > 4000) hebrewCache.clear();
  hebrewCache.set(key, out);
  return out;
}

/**
 * A Hebrew-calendar observance. `month: "adar-final"` is Adar in a common year
 * and Adar II in a leap year, which is where Purim goes. `length` makes it a
 * run of days starting at the date (Chanukah). `ifShabbat` moves the day when
 * the nominal date is a Saturday — the fast days are postponed to Sunday
 * (+1), except Ta'anit Esther, which is brought forward to Thursday (-2).
 */
export type HebrewDateRule = {
  name: string;
  month: HebrewMonth | "adar-final";
  day: number;
  length?: number;
  ifShabbat?: number;
};

function ruleMonthMatches(rule: HebrewDateRule, actual: HebrewMonth): boolean {
  if (rule.month === "adar-final") return actual === "adar" || actual === "adar-ii";
  return rule.month === actual;
}

function isNominalDay(rule: HebrewDateRule, key: DateKey): boolean {
  const h = hebrewDateOf(key);
  return !!h && h.day === rule.day && ruleMonthMatches(rule, h.month);
}

function ruleMatches(rule: HebrewDateRule, key: DateKey): boolean {
  if (rule.length && rule.length > 1) {
    for (let i = 0; i < rule.length; i += 1)
      if (isNominalDay(rule, shiftDateKey(key, -i))) return true;
    return false;
  }
  if (rule.ifShabbat) {
    // Observed on the shifted day when the nominal day is a Saturday, and on
    // the nominal day itself otherwise; never on both.
    const nominal = shiftDateKey(key, -rule.ifShabbat);
    if (weekdayOf(nominal) === 6 && isNominalDay(rule, nominal)) return true;
    return weekdayOf(key) !== 6 && isNominalDay(rule, key);
  }
  return isNominalDay(rule, key);
}

/**
 * The days the office is closed: yom tov by diaspora reckoning. Every one of
 * these is a day on which work is traditionally prohibited.
 */
export const YOM_TOV: readonly HebrewDateRule[] = [
  { name: "Rosh Hashanah", month: "tishri", day: 1 },
  { name: "Rosh Hashanah II", month: "tishri", day: 2 },
  { name: "Yom Kippur", month: "tishri", day: 10 },
  { name: "Sukkot I", month: "tishri", day: 15 },
  { name: "Sukkot II", month: "tishri", day: 16 },
  { name: "Shemini Atzeret", month: "tishri", day: 22 },
  { name: "Simchat Torah", month: "tishri", day: 23 },
  { name: "Pesach I", month: "nisan", day: 15 },
  { name: "Pesach II", month: "nisan", day: 16 },
  { name: "Pesach VII", month: "nisan", day: 21 },
  { name: "Pesach VIII", month: "nisan", day: 22 },
  { name: "Shavuot I", month: "sivan", day: 6 },
  { name: "Shavuot II", month: "sivan", day: 7 },
];

/**
 * Observances the office does NOT close for by default. They are here so
 * adding one is a one-line change to `DEFAULT_JEWISH_GROUPS` (or an option
 * to `isWorkingDay`) rather than a calendar project.
 */
export const OPTIONAL_JEWISH_OBSERVANCES: Readonly<
  Record<"cholHamoed" | "chanukah" | "purim" | "fastDays", readonly HebrewDateRule[]>
> = {
  cholHamoed: [
    { name: "Chol Hamoed Sukkot", month: "tishri", day: 17, length: 5 },
    { name: "Chol Hamoed Pesach", month: "nisan", day: 17, length: 4 },
  ],
  chanukah: [{ name: "Chanukah", month: "kislev", day: 25, length: 8 }],
  purim: [{ name: "Purim", month: "adar-final", day: 14 }],
  fastDays: [
    { name: "Tzom Gedaliah", month: "tishri", day: 3, ifShabbat: 1 },
    { name: "Asara B'Tevet", month: "tevet", day: 10 },
    { name: "Ta'anit Esther", month: "adar-final", day: 13, ifShabbat: -2 },
    { name: "Shiva Asar B'Tammuz", month: "tamuz", day: 17, ifShabbat: 1 },
    { name: "Tisha B'Av", month: "av", day: 9, ifShabbat: 1 },
  ],
};

export type JewishObservanceGroup = keyof typeof OPTIONAL_JEWISH_OBSERVANCES;

/** The extra groups the office closes for. None today; see `OPTIONAL_JEWISH_OBSERVANCES`. */
export const DEFAULT_JEWISH_GROUPS: readonly JewishObservanceGroup[] = [];

export function jewishHolidayName(
  key: DateKey,
  groups: readonly JewishObservanceGroup[] = DEFAULT_JEWISH_GROUPS,
): string | null {
  for (const rule of YOM_TOV) if (ruleMatches(rule, key)) return rule.name;
  for (const g of groups) {
    for (const rule of OPTIONAL_JEWISH_OBSERVANCES[g]) if (ruleMatches(rule, key)) return rule.name;
  }
  return null;
}

/* ---------------------------------------------------------- working days */

export type WorkingDayOptions = {
  /** Extra closure dates from `company_holidays` (or anywhere else). */
  closures?: ReadonlySet<DateKey>;
  /** Jewish observance groups beyond yom tov that also close the office. */
  jewishGroups?: readonly JewishObservanceGroup[];
};

/** Why a date is not a working day, or `null` when it is one. */
export function nonWorkingReason(key: DateKey, opts: WorkingDayOptions = {}): string | null {
  if (opts.closures?.has(key)) return "Company closure";
  const d = weekdayOf(key);
  if (d === 6) return "Saturday";
  if (d === 0) return "Sunday";
  return federalHolidayName(key) ?? jewishHolidayName(key, opts.jewishGroups);
}

export function isWorkingDay(key: DateKey, opts: WorkingDayOptions = {}): boolean {
  return nonWorkingReason(key, opts) === null;
}

/**
 * The nearest working day strictly before `key`. Bounded so a broken calendar
 * (every day a closure) cannot loop forever: after 60 calendar days it gives
 * up and returns the plain previous day.
 */
export function previousWorkingDay(key: DateKey, opts: WorkingDayOptions = {}): DateKey {
  let k = key;
  for (let i = 0; i < 60; i += 1) {
    k = shiftDateKey(k, -1);
    if (isWorkingDay(k, opts)) return k;
  }
  return shiftDateKey(key, -1);
}

/**
 * Working days walking back from `from` (inclusive when it is one), newest
 * first, `limit` days at most. This is the spine of the streak: the streak
 * walks this sequence and stops at the first day with nothing logged.
 */
export function* workingDaysBack(
  from: DateKey,
  limit: number,
  opts: WorkingDayOptions = {},
): Generator<DateKey> {
  let k = isWorkingDay(from, opts) ? from : previousWorkingDay(from, opts);
  for (let i = 0; i < limit; i += 1) {
    yield k;
    k = previousWorkingDay(k, opts);
  }
}

/* ------------------------------------------------------ company closures */

/**
 * The admin-kept extra closures. Reads `company_holidays`, which is added by
 * migration `20260916120000_company_holidays.sql`; until that is applied the
 * table is absent and this returns an empty set. A failed read is also an
 * empty set, with a warning: a streak that ignores a snow day is a smaller
 * wrong than a leaderboard whose streak column is blank for everyone, and
 * `useQuery` would turn a thrown error into exactly that.
 *
 * The table postdates the generated Supabase types, hence the untyped client
 * (same as `email-events.ts`) rather than a hand edit of generated output.
 */
export async function fetchCompanyClosures(): Promise<Set<DateKey>> {
  const db = supabase as unknown as {
    from: (table: string) => {
      select: (cols: string) => PromiseLike<{
        data: { holiday_date: string }[] | null;
        error: { code?: string; message?: string } | null;
      }>;
    };
  };
  try {
    const { data, error } = await db.from("company_holidays").select("holiday_date");
    if (error) {
      const outstanding =
        error.code === "42P01" ||
        error.code === "PGRST205" ||
        /does not exist|could not find the table/i.test(error.message ?? "");
      if (!outstanding)
        console.warn("company_holidays read failed; streaks ignore closures", error);
      return new Set();
    }
    return new Set((data ?? []).map((r) => String(r.holiday_date).slice(0, 10)));
  } catch (err) {
    console.warn("company_holidays read failed; streaks ignore closures", err);
    return new Set();
  }
}
