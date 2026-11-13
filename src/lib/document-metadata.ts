/**
 * "Who filed this, and when" — the first question anyone asks about a document
 * on a restoration job, and the one the Documents tab could not answer.
 *
 * The composition lives here rather than in the panel so the wording and the
 * id-to-name resolution are testable, and rather than in documents.ts so a
 * test does not have to pull in pdf-lib and the storage layer to check a
 * string. Both the document list and the signature requests beneath it use
 * these helpers, so the two sections say the same thing the same way.
 */
import { relativeTime, shortStamp } from "@/lib/account-timeline";
import { personLabel, type PersonProfile } from "@/lib/chat";

/**
 * What a row shows when nothing recorded who put the document there: an
 * import, a system-generated packet, or a row written before `created_by` was
 * populated. Never blank and never the string "null" — an evidence trail that
 * hides its own gaps is worse than one that admits them.
 */
export const UNKNOWN_PERSON = "Unknown";

/** user_id → display name, built once per load and shared by every row. */
export type PersonNames = Map<string, string>;

type ProfileRow = { user_id: string } & PersonProfile;

/** One map for a whole list, built from a single profiles read. */
export function buildPersonNames(rows: readonly ProfileRow[] | null | undefined): PersonNames {
  const out: PersonNames = new Map();
  for (const row of rows ?? []) {
    if (row?.user_id) out.set(row.user_id, personLabel(row));
  }
  return out;
}

/**
 * Resolves an author id to something a person can read. Three cases, kept
 * deliberately distinct:
 *
 *  - no id at all       → "Unknown": nothing was ever recorded.
 *  - id with a profile  → that person's name, via the app-wide `personLabel`,
 *    which also covers a profile that exists but was never named.
 *  - id with no profile → "Unknown", *not* `personLabel`'s "Removed user".
 *    RLS narrows the profiles read to the offices the viewer can see, so an id
 *    that does not resolve here is far more often hidden than deleted, and
 *    telling a manager a colleague was removed would be a lie.
 */
export function personName(userId: string | null | undefined, names: PersonNames): string {
  if (!userId) return UNKNOWN_PERSON;
  return names.get(userId) ?? UNKNOWN_PERSON;
}

/**
 * `new Date("2026-09-01")` is parsed as UTC midnight, which formats as 31
 * August in every US office — the bug src/lib/merge-keys.ts fixes by anchoring
 * a date-only value at noon. `documents.created_at` is `timestamptz` and so
 * always carries a time, but this is the single point where a stamp reaches
 * the panel, so it anchors defensively rather than trusting the column type to
 * stay what it is today.
 *
 * Returns null for anything unparseable, so a corrupt value renders as no line
 * at all rather than "Invalid Date".
 */
export function normalizeStamp(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = String(raw).trim();
  if (!value) return null;
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00` : value;
  return Number.isNaN(new Date(iso).getTime()) ? null : iso;
}

export type UploadedStamp = {
  /** "today", "13 days ago" — what the row shows. */
  relative: string;
  /** "Aug 25, 2026, 11:44 AM" — what the tooltip shows. */
  exact: string;
};

/**
 * Relative label for the row, exact timestamp for its tooltip — the same pair
 * the account timeline uses, reusing its formatters rather than adding a
 * second set that could drift.
 */
export function uploadedStamp(raw: string | null | undefined): UploadedStamp | null {
  const iso = normalizeStamp(raw);
  if (!iso) return null;
  return { relative: relativeTime(iso), exact: shortStamp(iso) };
}

export type MetadataLine = {
  /** Short form for the row: "13 days ago · David Stern". */
  text: string;
  /** Full form for the tooltip: "Uploaded Aug 25, 2026, 11:44 AM by David Stern". */
  title: string;
};

/**
 * Builds the "when · who" line under a document or a signature request.
 *
 * `uploaderKnown: false` means the database has no `created_by` column to read
 * at all — not that this row lacks a value. In that case the line drops the
 * person entirely instead of printing a column of "Unknown", which would claim
 * the uploader was lost rather than never asked for.
 */
export function metadataLine(
  raw: string | null | undefined,
  userId: string | null | undefined,
  names: PersonNames,
  opts: { uploaderKnown?: boolean; verb?: string } = {},
): MetadataLine | null {
  const { uploaderKnown = true, verb = "Uploaded" } = opts;
  const stamp = uploadedStamp(raw);
  const who = uploaderKnown ? personName(userId, names) : null;
  const text = [stamp?.relative, who].filter(Boolean).join(" · ");
  if (!text) return null;
  const title = [verb, stamp?.exact, who ? `by ${who}` : null].filter(Boolean).join(" ");
  return { text, title };
}
