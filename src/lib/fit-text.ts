/**
 * The scale that makes one run of text fit its box.
 *
 * Mark, from a screenshot of the dashboard where OUTSTANDING A/R read
 * "$394,…": "we need the words to be auto resizing so there are no ...
 * anywhere"
 *
 * This is the whole decision, kept pure so it can be unit-tested without a
 * DOM: given how wide the text wants to be and how wide the box is, how much
 * do we shrink it. Text that fits is left exactly alone (scale 1), so nothing
 * that was fine before changes. Text that does not fit is scaled by the ratio,
 * down to a floor — below the floor the numeral would be smaller than its own
 * caption, which breaks the "number is the element" rule harder than a second
 * line does, so the component stops shrinking there and wraps instead.
 */

/**
 * Half the caption size. A 32px metric numeral bottoms out at 16px, still
 * bigger than its 11px label.
 */
export const FIT_FLOOR = 0.5;

/**
 * ResizeObserver reports fractional widths. Anything within half a pixel is
 * "fits" — scaling a numeral by 0.998 to chase a rounding error just makes it
 * shimmer.
 */
const SLACK = 0.5;

/** Scales are kept to three places so a re-measure that lands on the same
 *  number is a no-op render, and floored rather than rounded so the result
 *  never comes out half a pixel too wide. */
function settle(scale: number): number {
  return Math.floor(scale * 1000) / 1000;
}

/**
 * @param naturalWidth  how wide the text is at its normal size, on one line
 * @param availableWidth how wide the box is
 * @returns 1 when it already fits; otherwise the shrink ratio, never below
 *   `minScale`. Unmeasured boxes (a hidden tab reports 0) return 1 so nothing
 *   shrinks into a box it cannot see.
 */
export function fitScale(
  naturalWidth: number,
  availableWidth: number,
  minScale: number = FIT_FLOOR,
): number {
  if (!(naturalWidth > 0) || !(availableWidth > 0)) return 1;
  if (naturalWidth <= availableWidth + SLACK) return 1;
  const floor = Math.min(1, Math.max(0, minScale));
  return Math.max(floor, settle(availableWidth / naturalWidth));
}

/**
 * True when even the floor is not enough: the text would still spill at
 * `minScale`. The component uses this to give up on one line and wrap.
 */
export function overflowsAtFloor(
  naturalWidth: number,
  availableWidth: number,
  minScale: number = FIT_FLOOR,
): boolean {
  if (!(naturalWidth > 0) || !(availableWidth > 0)) return false;
  return naturalWidth * Math.min(1, Math.max(0, minScale)) > availableWidth + SLACK;
}
