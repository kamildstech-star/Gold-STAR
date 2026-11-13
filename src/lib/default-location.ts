/**
 * Which office a new record should default to.
 *
 * A user can belong to many offices, but one of them is *theirs*
 * (`profiles.primary_location_id`). The rule from the client: "Jersey should
 * still be the top of the line even for people that have multiple locations."
 * Before this, the default was whichever membership row the database returned
 * first, which is how Baltimore ended up pre-filled for a Jersey rep.
 *
 * Pure so it can be tested without React or Supabase.
 */

export type DefaultLocationInput = {
  /** Offices the user may write to, in the order they will be shown. */
  writableIds: readonly string[];
  /** The office picked in the sidebar Context switcher, or null for "All". */
  currentLocationId?: string | null;
  /** `profiles.primary_location_id`. */
  primaryLocationId?: string | null;
  /** Direct memberships, in no particular order. */
  membershipIds?: readonly string[];
};

/**
 * 1. the office explicitly selected in the sidebar Context switcher — an
 *    active "I am working in X right now" beats a standing preference;
 * 2. the user's primary office;
 * 3. any direct membership;
 * 4. the first office on offer.
 * Always bounded by what the user can actually write to.
 */
export function resolveDefaultLocationId(input: DefaultLocationInput): string | null {
  const { writableIds } = input;
  if (writableIds.length === 0) return null;
  const ids = new Set(writableIds);
  const current = input.currentLocationId ?? null;
  if (current && ids.has(current)) return current;
  const primary = input.primaryLocationId ?? null;
  if (primary && ids.has(primary)) return primary;
  const member = (input.membershipIds ?? []).find((id) => ids.has(id));
  if (member) return member;
  return writableIds[0] ?? null;
}

/**
 * Pickers list the primary office first and the rest in the given order, so
 * the office a person uses every day is never scrolled for.
 */
export function orderPrimaryFirst<T extends { id: string }>(
  locations: readonly T[],
  primaryLocationId: string | null | undefined,
): T[] {
  if (!primaryLocationId) return [...locations];
  const primary = locations.filter((l) => l.id === primaryLocationId);
  if (primary.length === 0) return [...locations];
  return [...primary, ...locations.filter((l) => l.id !== primaryLocationId)];
}
