/**
 * OFFICE-AWARE MONEY VALUES — the shape behind Billing & Costs (prompt 1 of 5).
 *
 * One value per item × measure × office × effective date, in `money_values`
 * (migration 20261029120000). Office `null` is the company default; an office
 * row overrides it for that office from its date. Rows are never edited: a
 * change is a new dated row, so what a value was on any day stays answerable.
 *
 * Resolution, the one rule the T&M and Cost tabs (prompts 2 and 3) will read
 * through:
 *   1. the office's own latest row on or before the date — if it has a value;
 *   2. else the default's latest row on or before the date;
 *   3. else nothing (the caller says "not set"; never a silent zero).
 * An office row with a `null` value ends that office's override from its
 * date, handing it back to the default.
 *
 * This is the TypeScript twin of `public.resolve_money_value()`. The two are
 * held to the same cases by office-values.test.ts and
 * supabase/tests/billing-costs-foundation.pglite.mjs. No money arithmetic
 * happens here — a value is passed through exactly as stored.
 */

export type MoneyBook = "general_rules" | "tm_rates" | "cost" | "client_agreements" | "overhead";

export type MoneyValueRow = {
  book: MoneyBook;
  item_key: string;
  measure: string;
  /** null = the company default. */
  office_id: string | null;
  /** YYYY-MM-DD. */
  effective_from: string;
  /** null only on an office row: "back to the default from this date". */
  value: number | null;
};

export type ResolvedValue = {
  value: number;
  source: "office" | "default";
  effective_from: string;
};

function latestOnOrBefore(
  rows: readonly MoneyValueRow[],
  on: string,
  office: string | null,
): MoneyValueRow | undefined {
  let best: MoneyValueRow | undefined;
  for (const r of rows) {
    if (r.office_id !== office || r.effective_from > on) continue;
    if (!best || r.effective_from > best.effective_from) best = r;
  }
  return best;
}

/**
 * The value in force for one item and measure, at an office, on a date.
 * `rows` may hold other items and measures; only the matching ones count.
 */
export function resolveOfficeValue(
  rows: readonly MoneyValueRow[],
  key: { book: MoneyBook; item_key: string; measure: string },
  officeId: string | null,
  on: string,
): ResolvedValue | null {
  const mine = rows.filter(
    (r) => r.book === key.book && r.item_key === key.item_key && r.measure === key.measure,
  );
  if (officeId) {
    const own = latestOnOrBefore(mine, on, officeId);
    if (own && own.value !== null) {
      return { value: own.value, source: "office", effective_from: own.effective_from };
    }
  }
  const dflt = latestOnOrBefore(mine, on, null);
  if (dflt && dflt.value !== null) {
    return { value: dflt.value, source: "default", effective_from: dflt.effective_from };
  }
  return null;
}
