/**
 * One date format for everything a person reads: MM/DD/YYYY, US order.
 *
 * Calling toLocaleDateString() with no locale formats in the *viewer's* locale,
 * so an office machine set to English (UK) showed the Jobs list's call date as
 * 25/10/2026. Every user-facing date — screens, PDFs, reports, invoices and
 * emails — goes through here or through DATE_LOCALE + US_DATE, never through
 * the browser's default locale.
 */

export const DATE_LOCALE = "en-US";

/** Options that render MM/DD/YYYY with toLocaleDateString(DATE_LOCALE, …). */
export const US_DATE: Intl.DateTimeFormatOptions = {
  month: "2-digit",
  day: "2-digit",
  year: "numeric",
};

/** MM/DD/YYYY, h:mm AM — for timestamps. */
export const US_DATE_TIME: Intl.DateTimeFormatOptions = {
  ...US_DATE,
  hour: "numeric",
  minute: "2-digit",
};

type DateInput = string | number | Date | null | undefined;

/**
 * A bare `YYYY-MM-DD` from a `date` column parses as UTC midnight, which is the
 * previous day for anyone west of Greenwich. Anchor it to local noon so the
 * calendar day survives every US time zone.
 */
function toDate(v: DateInput): Date | null {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const d = new Date(`${v}T12:00:00`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** MM/DD/YYYY, or `fallback` when the value is empty or unparseable. */
export function formatDateUS(v: DateInput, fallback = "—", timeZone?: string): string {
  const d = toDate(v);
  if (!d) return fallback;
  return d.toLocaleDateString(DATE_LOCALE, timeZone ? { ...US_DATE, timeZone } : US_DATE);
}

/** MM/DD/YYYY, h:mm AM, or `fallback` when the value is empty or unparseable. */
export function formatDateTimeUS(v: DateInput, fallback = "—", timeZone?: string): string {
  const d = toDate(v);
  if (!d) return fallback;
  return d.toLocaleString(DATE_LOCALE, timeZone ? { ...US_DATE_TIME, timeZone } : US_DATE_TIME);
}
