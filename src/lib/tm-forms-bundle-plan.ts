/**
 * Which T&M sheets go into the "Download all" PDF, and in what order.
 *
 * The pure half of src/lib/tm-forms-bundle.ts, kept apart so the dialog can
 * count sheets and name the file without loading pdf-lib.
 */
import { TM_FORM_KINDS, type TmFormKind, type TmFormSummary } from "@/lib/tm-forms";

/** Inclusive `yyyy-mm-dd` bounds; null is open on that side (the whole job). */
export type TmBundleRange = { from: string | null; to: string | null };

export const WHOLE_JOB: TmBundleRange = { from: null, to: null };

/** What the carrier calls each group, plural, on the divider and in the summary. */
export const TM_BUNDLE_GROUP_TITLE: Readonly<Record<TmFormKind, string>> = {
  sign_in: "Crew sign-in sheets",
  crew_chief: "Daily crew chief reports",
  supply_list: "Daily supply lists",
};

export type TmBundleGroup = {
  kind: TmFormKind;
  title: string;
  /** Oldest first. */
  days: string[];
};

const isDay = (s: string | null | undefined): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);

/**
 * The range as the user meant it. A blank side is open; a range typed
 * backwards (To before From) is read the right way round rather than
 * returning nothing, which would look like a job with no paper.
 */
export function normaliseRange(range: TmBundleRange): TmBundleRange {
  const from = isDay(range.from) ? range.from : null;
  const to = isDay(range.to) ? range.to : null;
  if (from && to && from > to) return { from: to, to: from };
  return { from, to };
}

export function inRange(day: string, range: TmBundleRange): boolean {
  const r = normaliseRange(range);
  if (r.from && day < r.from) return false;
  if (r.to && day > r.to) return false;
  return true;
}

/** First and last day with any sheet, for the dialog's defaults. Null when there are none. */
export function tmJobSpan(
  rows: readonly Pick<TmFormSummary, "form_date">[],
): { first: string; last: string } | null {
  const days = rows
    .map((r) => r.form_date)
    .filter(isDay)
    .sort();
  return days.length ? { first: days[0]!, last: days[days.length - 1]! } : null;
}

/**
 * The sheets that go in, grouped by kind in the order the sheets are kept,
 * oldest day first. Kinds with nothing in range are left out entirely — an
 * empty divider page says "we lost these", which is not true. `kinds` limits
 * the bundle to some of the three (all of them by default).
 */
export function groupTmForms(
  rows: readonly Pick<TmFormSummary, "kind" | "form_date">[],
  range: TmBundleRange = WHOLE_JOB,
  kinds: readonly TmFormKind[] = TM_FORM_KINDS,
): TmBundleGroup[] {
  const out: TmBundleGroup[] = [];
  for (const kind of TM_FORM_KINDS) {
    if (!kinds.includes(kind)) continue;
    const days = [
      ...new Set(
        rows
          .filter((r) => r.kind === kind && isDay(r.form_date) && inRange(r.form_date, range))
          .map((r) => r.form_date),
      ),
    ].sort();
    if (days.length) out.push({ kind, title: TM_BUNDLE_GROUP_TITLE[kind], days });
  }
  return out;
}

/** `tm-field-forms-<job>-<from>-to-<to>.pdf`, or `-all` for the whole job. */
export function tmBundleFilename(jobNumber: string | null | undefined, range: TmBundleRange) {
  const job = (jobNumber ?? "").replace(/[^A-Za-z0-9-]+/g, "");
  const r = normaliseRange(range);
  const span =
    !r.from && !r.to
      ? "all"
      : r.from === r.to
        ? r.from
        : `${r.from ?? "start"}-to-${r.to ?? "latest"}`;
  return `tm-field-forms${job ? `-${job}` : ""}-${span}.pdf`;
}
