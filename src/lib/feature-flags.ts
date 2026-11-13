/**
 * Build-time feature flags. Flip a value here to switch a whole surface back
 * on — the code, routes and tables stay in place while a flag is off.
 */
export const FEATURES = {
  /**
   * Chase → Dispatch board. Turned off at the client's request; the route,
   * `src/lib/dispatch.ts` and the dispatch tables are untouched, so setting
   * this to `true` restores the page and its sidebar entry.
   */
  dispatch: false,
  /**
   * Rooms › Takeoffs (Moshe's paused room-capture summary). Hidden on the
   * 6 Nov call — nobody could say what it was for and it confused David;
   * "once we move to phase two, room capture more in depth, then maybe we
   * will need something like this." The takeoff model, CSV and Excel export
   * stay in place; `true` puts the section back.
   */
  takeoffs: false,
} as const;

export type FeatureName = keyof typeof FEATURES;

export function isFeatureEnabled(name: FeatureName): boolean {
  return FEATURES[name];
}
