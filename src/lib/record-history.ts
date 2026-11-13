/**
 * Delete and edit history on a job, and the Restore that reads it.
 *
 * Mark, on a job: "in timeline have a restore button for each item that gets
 * removed or changed".
 *
 * The history is written by a database trigger (`record_history_capture`,
 * migration 20261006150000), not by this module, so it catches a delete from
 * anywhere — the app, Lovable, the SQL editor, an offline replay. What this
 * module does is read the display half of it for the job Timeline, ask the
 * database what a Restore would do (`record_history_preview`) and ask it to
 * do it (`restore_record_history`). Every permission decision is the
 * database's; nothing here decides who may restore.
 *
 * `record_history` grants `authenticated` its display columns only — the
 * before-image can hold a column the reader may not see (an estimate line's
 * unit cost) — so it is always selected by the explicit list below, never
 * `select("*")`, which the database refuses.
 *
 * Until the migration is applied the table does not exist; the Timeline then
 * shows exactly what it showed before, with no Restore anywhere.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { supabase } from "@/integrations/supabase/client";
import type { ActivityEntry } from "@/lib/activity";

/** The tables the trigger covers, as the history names them. */
export type HistoryTable =
  | "job_notes"
  | "job_section_notes"
  | "job_contacts"
  | "tasks"
  | "estimates"
  | "estimate_scopes"
  | "estimate_lines"
  /** Quick Estimates, added by 20261006163000 (estimate delete). */
  | "job_calculations"
  /** The second set, 20261006200000. */
  | "photos"
  | "job_assignments"
  | "job_contact_methods"
  | "job_intake_answers"
  | "job_drying_readings"
  | "job_moisture_points"
  | "job_moisture_readings";

export type HistoryOp = "delete" | "update" | "restore";

export type HistoryChange = { before: unknown; after: unknown };

export type HistoryRow = {
  id: string;
  seq: number;
  occurred_at: string;
  table_name: HistoryTable;
  row_pk: string;
  op: HistoryOp;
  job_id: string;
  actor_id: string | null;
  summary: string;
  changes: Record<string, HistoryChange> | null;
  changed_columns: string[] | null;
  parent_id: string | null;
  restores_id: string | null;
};

/** Exactly the columns `authenticated` may select. Keep in step with the GRANT. */
export const HISTORY_COLUMNS =
  "id, seq, occurred_at, table_name, row_pk, op, job_id, actor_id, summary, changes, changed_columns, parent_id, restores_id";

/** What the confirm dialog is told. Mirrors `record_history_state`. */
export type HistoryStatus =
  | "ready"
  | "already_restored"
  | "already_present"
  | "already_reverted"
  | "gone"
  | "conflict"
  | "not_allowed"
  | "child"
  | "purged"
  | "restore"
  | "restored";

export type HistoryField = {
  column: string;
  before: unknown;
  after: unknown;
  now: unknown;
  moved: boolean;
};

export type HistoryPreview = {
  id: string;
  op: HistoryOp;
  table_name: HistoryTable;
  summary?: string;
  status: HistoryStatus;
  detail?: Record<string, unknown>;
  /** What comes back with it: an estimate's scopes and lines, the rest of a
   * batch of photos, a moisture point's readings. Absent keys mean none. */
  children?: { scopes?: number; lines?: number; photos?: number; readings?: number } | null;
  fields?: HistoryField[];
  restored_at?: string;
  restored_by?: string;
};

const db = () => supabase as unknown as SupabaseClient;

/** 42P01 / PGRST205 / PGRST202 mean the migration is outstanding, not a bad query. */
export function historyUnavailable(err: unknown): boolean {
  const e = err as { code?: string; message?: string; details?: string } | null;
  if (!e) return false;
  if (e.code === "42P01" || e.code === "PGRST205" || e.code === "PGRST202") return true;
  return /does not exist|could not find the (table|function)/i.test(
    `${e.message ?? ""} ${e.details ?? ""}`,
  );
}

/**
 * The job's deletes, edits and restores, newest first, with the actor's
 * name. Empty — never an error — when the migration is not applied yet.
 */
export async function fetchJobHistory(
  jobId: string,
): Promise<{ available: boolean; rows: (HistoryRow & { actor_name: string | null })[] }> {
  const { data, error } = await db()
    .from("record_history")
    .select(HISTORY_COLUMNS)
    .eq("job_id", jobId)
    .order("occurred_at", { ascending: false })
    .order("seq", { ascending: false })
    .limit(400);
  if (error) {
    if (historyUnavailable(error)) return { available: false, rows: [] };
    throw error;
  }
  const rows = (data ?? []) as unknown as HistoryRow[];
  const ids = [...new Set(rows.map((r) => r.actor_id).filter(Boolean))] as string[];
  const names = new Map<string, string | null>();
  if (ids.length) {
    const { data: people } = await supabase
      .from("profiles")
      .select("user_id, full_name")
      .in("user_id", ids);
    for (const p of people ?? []) names.set(p.user_id, p.full_name);
  }
  return {
    available: true,
    rows: rows.map((r) => ({
      ...r,
      actor_name: r.actor_id ? (names.get(r.actor_id) ?? null) : null,
    })),
  };
}

export async function fetchHistoryPreview(historyId: string): Promise<HistoryPreview> {
  const { data, error } = await db().rpc("record_history_preview", { _history_id: historyId });
  if (error) throw error;
  return data as HistoryPreview;
}

export async function restoreHistory(historyId: string): Promise<HistoryPreview> {
  const { data, error } = await db().rpc("restore_record_history", { _history_id: historyId });
  if (error) throw error;
  return data as HistoryPreview;
}

/* ------------------------------------------------------------------ *
 * Pure: how an entry reads
 * ------------------------------------------------------------------ */

const KIND: Record<HistoryTable, string> = {
  job_notes: "note",
  job_section_notes: "note",
  job_contacts: "contact",
  tasks: "task",
  estimates: "estimate",
  estimate_scopes: "scope",
  estimate_lines: "line",
  job_calculations: "Quick Estimate",
  photos: "photo",
  job_assignments: "crew member",
  job_contact_methods: "contact method",
  job_intake_answers: "answer",
  job_drying_readings: "drying reading",
  job_moisture_points: "moisture point",
  job_moisture_readings: "moisture reading",
};

export function historyKind(table: HistoryTable): string {
  return KIND[table] ?? "item";
}

/** Field names as a person says them. Unknown columns fall back to words. */
export const COLUMN_LABEL: Record<string, string> = {
  body: "Note",
  title: "Title",
  description: "Description",
  assignee: "Assigned to",
  due_date: "Due date",
  due_time: "Due time",
  priority: "Priority",
  role: "Role",
  full_name: "Name",
  email: "Email",
  phone: "Phone",
  notes: "Notes",
  is_default_contact: "Default contact",
  // 20261006200000's tables.
  taken: "Taken",
  person: "Person",
  start_date: "Start",
  end_date: "End",
  kind: "Kind",
  label: "Label",
  value: "Value",
  extension: "Extension",
  question: "Question",
  answer: "Answer",
  answer_text: "Answer",
  answer_bool: "Answer (yes/no)",
  answer_date: "Answer (date)",
  reading_date: "Reading date",
  point: "Point",
  temperature_f: "Temperature (°F)",
  relative_humidity: "Relative humidity (%)",
  dew_point_f: "Dew point (°F)",
  grains_per_pound: "GPP",
  material: "Material",
  location: "Location",
  dry_standard: "Dry standard",
  removed_at: "Removed",
  moisture_pct: "Moisture (%)",
};

export function columnLabel(column: string): string {
  return COLUMN_LABEL[column] ?? column.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

/** A stored value as text: "—" for empty, Yes/No, strings as they are. */
export function displayValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

/**
 * "3 lines in 1 scope", "11 more photos", "2 readings" — what comes back
 * with an entry, or null when nothing does.
 */
export function childrenLabel(c: HistoryPreview["children"]): string | null {
  if (!c) return null;
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const parts: string[] = [];
  const lines = Number(c.lines ?? 0);
  const scopes = Number(c.scopes ?? 0);
  if (lines > 0) {
    parts.push(plural(lines, "line") + (scopes > 0 ? ` in ${plural(scopes, "scope")}` : ""));
  } else if (scopes > 0) {
    parts.push(plural(scopes, "scope"));
  }
  const photos = Number(c.photos ?? 0);
  if (photos > 0) parts.push(`${photos} more ${photos === 1 ? "photo" : "photos"}`);
  const readings = Number(c.readings ?? 0);
  if (readings > 0) parts.push(plural(readings, "reading"));
  return parts.length ? parts.join(", ") : null;
}

/** "Sarah deleted note "Water in…"", "Mike changed task "Pull dehus"". */
export function historyHeadline(row: Pick<HistoryRow, "op" | "summary">, actor: string | null) {
  const who = actor ?? "Someone";
  const verb = row.op === "delete" ? "deleted" : row.op === "update" ? "changed" : "restored";
  return `${who} ${verb} ${row.summary}`;
}

/** The button's word: un-delete is Restore, undoing an edit is Revert. */
export function restoreVerb(op: HistoryOp): "Restore" | "Revert" {
  return op === "update" ? "Revert" : "Restore";
}

/**
 * One line the dialog can show for a status that is not "ready" — the
 * reason the button is off. The database's own error text is used when a
 * restore is refused after the dialog opened.
 */
export function statusMessage(
  p: Pick<HistoryPreview, "status" | "op" | "restored_by">,
): string | null {
  switch (p.status) {
    case "ready":
      return null;
    case "already_restored":
    case "restored":
      return `Already ${p.op === "update" ? "reverted" : "restored"}${p.restored_by ? ` by ${p.restored_by}` : ""}.`;
    case "already_present":
      return "It's already back — nothing to restore.";
    case "already_reverted":
      return "Every field already has its old value again — nothing to revert.";
    case "gone":
      return "It was deleted after this change. Restore the deletion first.";
    case "conflict":
      return "Changed again since — reverting would overwrite the newer edit, so it's off. Edit it by hand instead.";
    case "not_allowed":
      return "You can't restore this. Only someone who could have removed or edited it can.";
    case "child":
      return "This came off with something else. Restore that entry to bring it back.";
    case "purged":
      return "That photo has since been deleted for good — there's nothing left to restore.";
    default:
      return "Restore isn't available for this entry.";
  }
}

/**
 * A refused restore, in words. The database's own messages are written for
 * the person at the screen ("Changed again since (title)…", "another estimate
 * on this job now has that number"), so they are shown as they are — unlike
 * `toastDbError`, which would flatten them to "conflicts with an existing
 * record". Only the bare Postgres refusals are reworded.
 */
export function restoreErrorMessage(err: unknown): string {
  const e = err as { message?: string } | null;
  const raw = (e?.message ?? "").trim();
  if (!raw) return "Restore failed. Try again.";
  if (/^permission denied/i.test(raw) || /row-level security/i.test(raw)) {
    return "Restore was blocked by database permissions.";
  }
  return raw;
}

export type HistoryItem = HistoryRow & {
  actor_name: string | null;
  /** On a delete or edit: the restore that undid it, if any. */
  restoredBy?: { actor_name: string | null; occurred_at: string } | null;
};

/**
 * Hang each restore marker on the entry it restored, so the entry can say
 * "Restored by Sarah, Oct 6" and drop its button. The markers stay in the
 * list too — the restore is an event of its own on the Timeline. Children
 * (an estimate's lines) are never in the list; the database does not return
 * them.
 */
export function buildHistoryItems(
  rows: (HistoryRow & { actor_name: string | null })[],
): HistoryItem[] {
  const restoredBy = new Map<string, { actor_name: string | null; occurred_at: string }>();
  for (const r of rows) {
    if (r.op === "restore" && r.restores_id) {
      restoredBy.set(r.restores_id, { actor_name: r.actor_name, occurred_at: r.occurred_at });
    }
  }
  return rows
    .filter((r) => !r.parent_id)
    .map((r) => ({ ...r, restoredBy: r.op === "restore" ? null : (restoredBy.get(r.id) ?? null) }));
}

export type TimelineItem =
  | { kind: "activity"; at: string; entry: ActivityEntry }
  | { kind: "history"; at: string; entry: HistoryItem };

/**
 * The job Timeline is the server's activity feed plus this history, newest
 * first. One overlap is removed: the old generic row logger
 * (`log_row_activity`) also writes "Estimate deleted — …" for an estimate,
 * and the history entry for the same delete says the same thing with a
 * Restore button, so the plain one goes.
 */
export function mergeTimeline(activity: ActivityEntry[], history: HistoryItem[]): TimelineItem[] {
  const deleted = new Set(history.filter((h) => h.op === "delete").map((h) => h.row_pk));
  // Removed photos: once 20261006200000 is in, every removed photo has a
  // history entry (new ones by trigger, older ones backfilled), so the
  // feed's plain "Photo deleted" rows — which carry no photo id to match on
  // — are the same events told twice. Before it, there are no photo entries
  // and the plain rows stay.
  const photosCovered = history.some((h) => h.table_name === "photos");
  const items: TimelineItem[] = [
    ...activity
      .filter((e) => {
        if (e.event_type === "photo.deleted") return !photosCovered;
        if (!e.event_type.endsWith(".delete")) return true;
        const rowId = (e.detail as { row_id?: unknown } | null)?.row_id;
        return !(typeof rowId === "string" && deleted.has(rowId));
      })
      .map((e) => ({ kind: "activity" as const, at: e.occurred_at, entry: e })),
    ...history.map((h) => ({ kind: "history" as const, at: h.occurred_at, entry: h })),
  ];
  return items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

/** The text a history entry is searched by, the way activity rows are. */
export function historySearchText(h: HistoryItem): string {
  return [
    historyHeadline(h, h.actor_name),
    h.actor_name,
    ...Object.entries(h.changes ?? {}).flatMap(([k, c]) => [
      columnLabel(k),
      displayValue(c.before),
      displayValue(c.after),
    ]),
  ]
    .join(" ")
    .toLowerCase();
}
