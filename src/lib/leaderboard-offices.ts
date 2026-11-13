/**
 * Which offices the leaderboard is ranking.
 *
 * Mark, on the office dropdown in the leaderboard header: "this should allow
 * multiple selections as well". So the picker is the shared multi-select, and
 * the choice rides the URL as `offices=<id>,<id>` so a manager can bookmark
 * "leaderboard for NJ + NY" the same way they bookmark a custom date range.
 *
 * Three states, and they are not the same thing:
 *   - `offices` absent  — nobody chose; open on the viewer's own office (or
 *     every office when the sidebar switcher says "All my locations"), the
 *     way the page always has;
 *   - `offices=all`     — the viewer deliberately widened to every office they
 *     can see, and that must survive a reload, which is why it is a word and
 *     not an empty string (an empty param is indistinguishable from absent);
 *   - `offices=a,b,c`   — exactly those offices.
 *
 * The selection is always sorted before it is serialised or used as a query
 * key, so "NJ then NY" and "NY then NJ" are one bookmark and one cache entry.
 *
 * Pure, so it can be tested without React or the router.
 */

import { ALL_LOCATIONS } from "@/lib/report-location";

/**
 * The URL word for "every office I can see", as opposed to "nothing chosen".
 * The same word the single-office reports use, so the two never drift.
 */
export const ALL_OFFICES_PARAM: string = ALL_LOCATIONS;

export type OfficesParam =
  /** Nothing in the URL: fall back to the viewer's own office. */
  | { kind: "default" }
  /** `offices=all`. */
  | { kind: "all" }
  /** `offices=a,b`; ids are sorted and de-duplicated. */
  | { kind: "some"; ids: string[] };

/** The raw search value, whatever the router hands us, as a single string. */
export function officesSearchValue(raw: unknown): string {
  if (Array.isArray(raw)) {
    return raw.filter((v): v is string => typeof v === "string").join(",");
  }
  return typeof raw === "string" ? raw : "";
}

/** `"b,a,a"` → `["a", "b"]`. Whitespace and empty segments are ignored. */
export function sortedIdList(param: string): string[] {
  return Array.from(
    new Set(
      param
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ).sort();
}

export function parseOfficesParam(param: string): OfficesParam {
  const trimmed = param.trim();
  if (!trimmed) return { kind: "default" };
  if (trimmed === ALL_OFFICES_PARAM) return { kind: "all" };
  const ids = sortedIdList(trimmed);
  return ids.length ? { kind: "some", ids } : { kind: "default" };
}

/**
 * What to write back to the URL after the picker changes. An empty pick is
 * the picker's "no filter", which here means every office — so it is written
 * as the word, never as an empty string that would snap back to the default.
 */
export function officesParam(ids: readonly string[]): string {
  const sorted = sortedIdList(ids.join(","));
  return sorted.length ? sorted.join(",") : ALL_OFFICES_PARAM;
}

/**
 * The office ids the queries should be pinned to, bounded by what the viewer
 * may see. `null` means "let RLS decide", exactly what the single-select's
 * "All offices" sent before.
 *
 * `fallback` is the resolved own-office choice (`"all"` or an id) used when
 * the URL says nothing. A URL naming only offices the viewer can no longer
 * see falls through to it too, rather than showing an empty board.
 */
export function resolveOfficeIds(
  param: OfficesParam,
  visibleIds: readonly string[],
  fallback: string,
): string[] {
  if (param.kind === "all") return [];
  if (param.kind === "some") {
    const visible = new Set(visibleIds);
    const kept = param.ids.filter((id) => visible.has(id));
    if (kept.length) return kept;
  }
  return fallback === ALL_OFFICES_PARAM || !visibleIds.includes(fallback) ? [] : [fallback];
}

/** `[]` → null, otherwise the sorted list — the RPC's `_location_ids` shape. */
export function officeFilterOf(ids: readonly string[]): string[] | null {
  return ids.length ? [...ids] : null;
}
