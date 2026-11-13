/**
 * What the shared scan dialog (`CodeScanDialog`) does with a decoded value.
 *
 * Kept out of the component file so it can be tested without a camera and so
 * the component file exports only the component.
 */

/** Returned from `onScanned` to say the code was read but leads nowhere. */
export type ScanRejection = { rejected: true; title?: string; message: string };

/** What the dialog does with a decoded value, given what the caller said. */
export type ScanSettlement =
  { close: true } | { close: false; code: string; title: string; message: string };

export const NO_MATCH_TITLE = "No matching item found";

/**
 * Pure, so the "never close on a miss" rule is tested without a camera.
 * Anything other than an explicit rejection is the old behaviour: accepted,
 * close.
 */
export function settleScan(code: string, verdict: ScanRejection | void): ScanSettlement {
  if (verdict && verdict.rejected) {
    return { close: false, code, title: verdict.title ?? NO_MATCH_TITLE, message: verdict.message };
  }
  return { close: true };
}
