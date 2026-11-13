/**
 * A person's name in two boxes, and the one composed string the app reads.
 *
 * David asked for first and last name as separate fields. `contacts.full_name`
 * is NOT NULL and is read by roughly every screen, every PDF merge key and
 * several SQL seeders, so it does not go anywhere: the pair is added beside it
 * and `full_name` stays the composed value.
 *
 * THE SPLIT RULE IS DELIBERATELY DUMB, and it is duplicated — once here for
 * the UI and once in SQL for the backfill (20260913120000). Both split on the
 * FIRST space: "David Stern" -> David / Stern, "Mary Ann Van Der Berg" ->
 * Mary / "Ann Van Der Berg", "Cher" -> Cher / "". A cleverer rule would have
 * to guess at particles ("van", "de", "bin"), suffixes ("Jr."), and inverted
 * "Stern, David" — and every guess it got wrong would be a person's name
 * silently rewritten in the CRM. First-space is wrong in predictable, visible
 * ways that somebody can correct in one edit, which is the right kind of wrong
 * for a field nobody has ever filled in before.
 *
 * The two implementations must agree, so the SQL is written to mirror these
 * functions line for line and the migration header says so.
 */

export interface PersonName {
  firstName: string;
  lastName: string;
}

/**
 * Split an existing `full_name` into the pair.
 *
 * Everything after the first space is the last name, INCLUDING further spaces
 * — "Ann Van Der Berg" stays together rather than losing "Van Der Berg" to a
 * middle-name field that does not exist.
 */
export function splitFullName(full: string | null | undefined): PersonName {
  const text = (full ?? "").trim().replace(/\s+/g, " ");
  if (!text) return { firstName: "", lastName: "" };
  const at = text.indexOf(" ");
  if (at === -1) return { firstName: text, lastName: "" };
  return { firstName: text.slice(0, at), lastName: text.slice(at + 1) };
}

/**
 * The pair back into one string. Either side may be empty — a mononym is a
 * real name, and a contact entered as last-name-only is a real record too.
 */
export function composeFullName(
  firstName: string | null | undefined,
  lastName: string | null | undefined,
): string {
  return [(firstName ?? "").trim(), (lastName ?? "").trim()].filter(Boolean).join(" ");
}

/**
 * What to write for a person, given what is in the two boxes.
 *
 * `full_name` is never allowed to go empty: it is NOT NULL in the database and
 * a nameless contact is unfindable. When both boxes are blank the caller's
 * existing name is kept, which is what makes this safe to call from an editor
 * where somebody has cleared a field mid-edit.
 */
export function personNameWrite(
  firstName: string,
  lastName: string,
  existingFullName?: string | null,
): { first_name: string | null; last_name: string | null; full_name: string } {
  const composed = composeFullName(firstName, lastName);
  return {
    // Empty boxes are stored as NULL, not "": the trigger treats NULL as
    // "nobody has filled these in" and leaves `full_name` alone.
    first_name: firstName.trim() || null,
    last_name: lastName.trim() || null,
    full_name: composed || (existingFullName ?? "").trim(),
  };
}
