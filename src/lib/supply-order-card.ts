/**
 * What an order card says about its items.
 *
 * David, 22 Sep: "If there's only one item, two items, that should come up
 * here. If not, then it should say view items and click on it." So a card
 * names one or two lines in full and, past that, only counts them — the list
 * itself is one tap away on the order.
 */

export const INLINE_LINES = 2;

export type CardLine = { label: string; quantity: string };

export type CardSummary =
  { kind: "inline"; lines: CardLine[] } | { kind: "collapsed"; count: number; first: CardLine };

export function orderCardSummary(lines: readonly CardLine[]): CardSummary | null {
  if (lines.length === 0) return null;
  if (lines.length <= INLINE_LINES) return { kind: "inline", lines: [...lines] };
  return { kind: "collapsed", count: lines.length, first: lines[0]! };
}

/**
 * A quantity a manager may set on a line: a positive number, and never below
 * what has already been delivered against it — the shelf has those already,
 * and asking for fewer than arrived would make the delivery count lie.
 */
export function adjustedQuantityProblem(next: number | null, delivered: number): string | null {
  if (next == null || !Number.isFinite(next) || next <= 0)
    return "A line needs a quantity above zero.";
  if (next < delivered) return `${delivered} already arrived — the quantity cannot go below that.`;
  return null;
}
