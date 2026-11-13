/**
 * The office a report screen is looking at.
 *
 * Gold Star runs twelve offices. Somebody who can see all of them was shown
 * every office's data at once with no way to narrow it — Melly: "if he only
 * wants to see jobs from a specific location, I'm going to want him to have a
 * dropdown to select a location, basically it's just a filter."
 *
 * The rules that matter:
 *   - the filter defaults to the user's *own* office, not to "everything";
 *   - it only ever offers offices the user may already see, so it can never
 *     widen access — narrowing only, on top of whatever RLS allows;
 *   - one resolved choice feeds the figures at the top, the rows underneath
 *     and the Excel export, so the three cannot disagree.
 *
 * Pure, so it can be tested without React or Supabase.
 */

/** `"all"` means every office the viewer may see; otherwise a location id. */
export type LocationChoice = string;

export const ALL_LOCATIONS: LocationChoice = "all";

export type LocationInput = {
  /** Offices the viewer may see, in display order. */
  visibleIds: readonly string[];
  /** An explicit choice already in the URL / component state. */
  explicit?: string | null;
  /** The sidebar Context switcher, or null when it is set to "All". */
  currentLocationId?: string | null;
  /**
   * `profiles.primary_location_id` — the user's own office. Optional so a
   * caller with no notion of a primary office still gets the sidebar choice
   * and the membership fallbacks.
   */
  primaryLocationId?: string | null;
  /** Direct office memberships, in no particular order. */
  membershipIds?: readonly string[];
};

/**
 * Which office the screen opens on:
 *   1. an explicit choice the user already made (URL or dropdown) — including
 *      a deliberate "all";
 *   2. the office selected in the sidebar Context switcher, because "I am
 *      working in X right now" beats a standing preference — and that includes
 *      the switcher sitting on "All my locations", which arrives here as null;
 *   3. the user's primary office;
 *   4. their single membership, when they only have one;
 *   5. otherwise "all" — someone who genuinely spans offices and has told us
 *      nothing gets the full picture rather than an arbitrary office.
 *
 * The order is deliberately the same one `resolveDefaultLocationId` uses for
 * new records, so "which office am I in" means one thing across the app.
 *
 * Every branch is bounded by `visibleIds`, so a stale URL naming an office the
 * user may no longer see falls through instead of showing an empty report.
 */
export function resolveLocationChoice(input: LocationInput): LocationChoice {
  const visible = new Set(input.visibleIds);
  const usable = (id: string | null | undefined): id is string => !!id && visible.has(id);

  if (input.explicit === ALL_LOCATIONS) return ALL_LOCATIONS;
  if (usable(input.explicit)) return input.explicit;
  if (usable(input.currentLocationId)) return input.currentLocationId;
  /*
   * A switcher set to "All" is an answer, not a silence.
   *
   * `currentLocationId === null` is what the sidebar stores for "All my
   * locations", and that is the label the user is reading while the page
   * loads. Falling through to the primary office from here made the screen
   * contradict its own switcher: an admin on "All my locations" opened Jobs
   * and saw "NC · NC — 2 jobs" out of a twelve-office workspace, with no hint
   * that anything had been narrowed.
   *
   * Strictly `null`, so an id the viewer may no longer see still falls through
   * to the fallbacks below rather than silently widening to every office.
   */
  if (input.currentLocationId === null) return ALL_LOCATIONS;
  if (usable(input.primaryLocationId)) return input.primaryLocationId;

  const memberships = (input.membershipIds ?? []).filter((id) => visible.has(id));
  if (memberships.length === 1) return memberships[0]!;

  return ALL_LOCATIONS;
}

/**
 * The office id a query should be pinned to, or `null` for "leave the query
 * alone and let RLS decide". Every caller narrows figures, rows and export
 * through this one value, which is what keeps the three in agreement.
 */
export function locationIdOf(choice: LocationChoice): string | null {
  return choice === ALL_LOCATIONS ? null : choice;
}

/**
 * How one office reads in a picker or a heading.
 *
 * Most offices are named after their code, so "code · name" printed
 * "NC · NC", "CA · CA", "GA · GA" all the way down the list — Mark's
 * screenshot of the leaderboard dropdown was twelve rows of that. The name
 * carries the meaning, so it leads; the code is appended only when it says
 * something the name does not ("NY-Upstate · NY-UP", "HTX · TX").
 */
export function officeLabel(office: { code: string; name: string }): string {
  const name = office.name.trim() || office.code.trim();
  const code = office.code.trim();
  return !code || code.toLowerCase() === name.toLowerCase() ? name : `${name} · ${code}`;
}

/** "All offices", or "Jersey · GS-NJ" — used in headings and export filters. */
export function locationLabel(
  choice: LocationChoice,
  locations: readonly { id: string; code: string; name: string }[],
): string {
  if (choice === ALL_LOCATIONS) return "All offices";
  const found = locations.find((l) => l.id === choice);
  return found ? officeLabel(found) : "Unknown office";
}

/**
 * The same, for a set: "All offices", one office's label, up to three names
 * joined, and past that a count — a heading cannot hold twelve names.
 */
export function officesLabel(
  ids: readonly string[],
  locations: readonly { id: string; code: string; name: string }[],
): string {
  if (ids.length === 0) return "All offices";
  const found = ids
    .map((id) => locations.find((l) => l.id === id))
    .filter((l): l is { id: string; code: string; name: string } => !!l);
  if (found.length === 0) return "Unknown office";
  if (found.length === 1) return officeLabel(found[0]!);
  if (found.length <= 3) return found.map((l) => l.name.trim() || l.code).join(", ");
  return `${found.length} offices`;
}
