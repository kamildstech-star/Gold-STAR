/**
 * Scope of work, room by room.
 *
 * David, 12 Oct: on the Rooms tab each room has a Scope (the field that was
 * "Notes"), typed straight in, one line per piece of work — "demo drywall",
 * "flood cuts", "remove cabinets". "Generate Scope" pulls every room's lines
 * into one Scope-of-Work report, a plain bullet list per room, that the office
 * downloads and the crew sees on the job.
 *
 * STORAGE: the room's existing `job_rooms.notes` column, one line per item.
 * No migration — the column was already the room's free text, and anything
 * typed into it before reads as that room's scope.
 *
 * THE TASKS SEAM. David has not decided whether scope lines become checkable
 * field tasks. They are a list for now, but every line already comes out of
 * here as a `ScopeItem` with a stable `key` (room id + the line's own text).
 * A later "scope tasks" feature keys its checkbox state on that, so ticking a
 * line survives lines being added or reordered around it — and nothing here
 * changes when it arrives.
 */
import { roomLabel, sortRooms, type JobRoom } from "@/lib/job-rooms";

/** One line of a room's scope. */
export type ScopeItem = {
  /**
   * Stable identity for the future tasks-with-checkboxes: the room and the
   * line's text, normalised. See the header.
   */
  key: string;
  roomId: string;
  text: string;
};

/** One room's section of the report. */
export type RoomScope = {
  roomId: string;
  /** "Kitchen", or "Unit 4B · Kitchen" in a multi-unit building. */
  label: string;
  items: ScopeItem[];
};

/** A leading bullet someone typed by habit: "- ", "• ", "* ", "1. ". */
const LEADING_BULLET = /^\s*(?:[-–—•*·]+|\d+[.)])\s*/;

/** The room's scope as lines: one per item, bullets and blanks dropped. */
export function scopeLines(notes: string | null | undefined): string[] {
  return (notes ?? "")
    .split(/\r?\n/)
    .map((l) => l.replace(LEADING_BULLET, "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/** Lines back to the column's text. Null when there are none. */
export function joinScopeLines(lines: readonly string[]): string | null {
  const kept = lines.map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  return kept.length ? kept.join("\n") : null;
}

/**
 * Add what was typed. A paste of several lines adds each one; a blank adds
 * nothing and returns the notes unchanged.
 */
export function addScopeLine(notes: string | null | undefined, typed: string): string | null {
  const add = scopeLines(typed);
  return joinScopeLines([...scopeLines(notes), ...add]);
}

export function updateScopeLine(
  notes: string | null | undefined,
  index: number,
  text: string,
): string | null {
  const lines = scopeLines(notes);
  if (index < 0 || index >= lines.length) return joinScopeLines(lines);
  const next = scopeLines(text);
  lines.splice(index, 1, ...next);
  return joinScopeLines(lines);
}

export function removeScopeLine(notes: string | null | undefined, index: number): string | null {
  const lines = scopeLines(notes);
  if (index >= 0 && index < lines.length) lines.splice(index, 1);
  return joinScopeLines(lines);
}

export function scopeItemKey(roomId: string, text: string): string {
  return `${roomId}:${text.trim().toLowerCase().replace(/\s+/g, " ")}`;
}

/**
 * Every room that has scope, in the Rooms tab's order (unit, then the order
 * the rooms were added). A room with no lines is left out — the report is
 * what is to be done, not a list of rooms.
 */
export function buildScopeOfWork(
  rooms: readonly Pick<JobRoom, "id" | "unit" | "name" | "notes" | "sort_order">[],
): RoomScope[] {
  const ordered = sortRooms(
    [...rooms].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)) as JobRoom[],
  );
  const out: RoomScope[] = [];
  for (const r of ordered) {
    const lines = scopeLines(r.notes);
    if (!lines.length) continue;
    const seen = new Set<string>();
    const items: ScopeItem[] = [];
    for (const text of lines) {
      const key = scopeItemKey(r.id, text);
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ key, roomId: r.id, text });
    }
    out.push({ roomId: r.id, label: roomLabel(r), items });
  }
  return out;
}

/** How many lines of scope the job has in all. */
export function scopeItemCount(scope: readonly RoomScope[]): number {
  return scope.reduce((n, r) => n + r.items.length, 0);
}

/**
 * The report as plain text — the same layout as the PDF, for copying into an
 * email or a message to the crew:
 *
 *   Living room
 *   - demo drywall
 *   - flood cuts
 */
export function scopeOfWorkText(scope: readonly RoomScope[]): string {
  return scope.map((r) => [r.label, ...r.items.map((i) => `- ${i.text}`)].join("\n")).join("\n\n");
}
