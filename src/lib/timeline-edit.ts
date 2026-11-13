/**
 * What a rep may change on each kind of Timeline row, and the writes behind it.
 *
 * Mark, with a screenshot of the account Timeline: "this needs major work, it
 * just doesnt look good or act like its editable". And on a task row: "tasks
 * need to be smarter and needs to act as a task this is just a non actionable
 * item which needs to change".
 *
 * The rule, per row, mirrors the row policies in the database — the database
 * is the guard; this is the courtesy that hides or disables a control instead
 * of letting the save come back 403. Every clause below names the policy it
 * copies so the two can be checked against each other:
 *
 *   account_notes   update: creator, privileged, or a manager of the office
 *                   delete: creator or privileged            (20260806171901)
 *   touchpoints     update/delete: creator or privileged     (20260728041824)
 *   captured_comms  update: the user it was captured for, or privileged;
 *                   no DELETE grant at all                   (20260821175812)
 *   tasks           update: assignee, creator, or a manager of the office
 *                                                            (20260806211227)
 *   stage history, documents, invoices, jobs, gifts, photos: history. Read-only.
 *
 * A captured call or email is the system's record: its direction, time,
 * length, addresses, subject, outcome and recording came off the wire and
 * stay as they came. What a rep owns on it is their note, which lives on the
 * touchpoint the capture wrote alongside itself — so "edit" on a Dialer call
 * edits that note and nothing else, and the editor says which fields are
 * locked and why.
 */
import { supabase } from "@/integrations/supabase/client";
import type { TimelineEntry } from "@/lib/account-timeline";

/** Who is looking, as far as the row policies care. */
export type TimelineViewer = {
  userId: string | null;
  /** `is_privileged(uid)` — owner or admin. */
  privileged: boolean;
  /**
   * `can_manage_location(uid, account.location_id)`: true/false once it has
   * answered, null while outstanding. An outstanding check is never a yes.
   */
  managesOffice: boolean | null;
};

export type EditableField =
  /** A task's title. */
  | "title"
  /** A note's body, a touchpoint's notes, a task's description, a capture's note. */
  | "body"
  /** A touchpoint's `occurred_at`. */
  | "when"
  /** A task's due date. */
  | "due"
  /** A task's assignee. */
  | "assignee"
  /** A note's pin. */
  | "pin";

export type EntryPolicy = {
  /** Fields the viewer may change on this row. Empty means read-only. */
  fields: EditableField[];
  /** Open task the viewer may tick. */
  canComplete: boolean;
  /** Done task the viewer may un-tick. */
  canReopen: boolean;
  canDelete: boolean;
  /** The fields the system owns on this row, and why they stay as they are. */
  locked: { fields: string[]; reason: string } | null;
  /** A permission answer is still outstanding — offer nothing yet. */
  pending: boolean;
  /** Why the row is read-only for this viewer, when it is one they might expect to edit. */
  reason: string | null;
};

const READ_ONLY: EntryPolicy = {
  fields: [],
  canComplete: false,
  canReopen: false,
  canDelete: false,
  locked: null,
  pending: false,
  reason: null,
};

export const NOT_YOURS = "Only the person who wrote this, or a manager, can change it";
export const CHECKING = "Checking your permissions…";

/** Which fields a captured record keeps, by how it was captured. */
export function capturedLock(entry: TimelineEntry): { fields: string[]; reason: string } {
  const source = entry.source ?? "the system";
  const fields =
    entry.kind === "call"
      ? ["direction", "time", "length", "outcome", "recording"]
      : entry.kind === "email"
        ? ["from", "to", "subject", "time", "body"]
        : ["direction", "time", "body"];
  return {
    fields,
    reason: `Captured by ${source} — the record is the system's; the note on it is yours.`,
  };
}

/**
 * True/false/null for "does the viewer manage the account's office", with
 * the privileged escape hatch — mirrors `is_privileged(uid) OR
 * can_manage_location(uid, location_id)`.
 */
function manager(viewer: TimelineViewer): boolean | null {
  if (viewer.privileged) return true;
  return viewer.managesOffice;
}

export function entryPolicy(entry: TimelineEntry, viewer: TimelineViewer): EntryPolicy {
  const uid = viewer.userId;
  if (!uid) return READ_ONLY;

  switch (entry.kind) {
    case "note": {
      const n = entry.note;
      if (!n) return READ_ONLY;
      const own = n.created_by === uid;
      const mgr = manager(viewer);
      if (own || mgr === true) {
        return {
          ...READ_ONLY,
          fields: ["body", "pin"],
          // account_notes_delete stops at the creator or privileged: a
          // location manager may rewrite a note but not remove it.
          canDelete: own || viewer.privileged,
        };
      }
      if (mgr === null) return { ...READ_ONLY, pending: true, reason: CHECKING };
      return { ...READ_ONLY, reason: NOT_YOURS };
    }

    case "task": {
      const t = entry.task;
      if (!t) return READ_ONLY;
      const own = t.assignee === uid || t.createdBy === uid;
      const mgr = manager(viewer);
      if (own || mgr === true) {
        const open = t.status === "open" || t.status === "in_progress";
        return {
          ...READ_ONLY,
          fields: ["title", "body", "due", "assignee"],
          canComplete: open,
          canReopen: t.status === "done",
        };
      }
      if (mgr === null) return { ...READ_ONLY, pending: true, reason: CHECKING };
      return {
        ...READ_ONLY,
        reason: "Only its assignee, its creator or a manager can change a task",
      };
    }

    case "call":
    case "email":
    case "sms":
    case "meeting":
    case "gift": {
      // A captured record first: the fields are the system's.
      if (entry.comm) {
        const locked = capturedLock(entry);
        const c = entry.comm;
        if (!c.touchpointId) {
          // Nothing to hang a note on — the capture never wrote a touchpoint.
          return { ...READ_ONLY, locked };
        }
        const own = c.touchCreatedBy === uid || c.userId === uid;
        if (own || viewer.privileged) return { ...READ_ONLY, fields: ["body"], locked };
        return { ...READ_ONLY, locked, reason: NOT_YOURS };
      }
      // A touchpoint logged by hand: the rep's own record of what happened.
      const t = entry.touch;
      if (!t) return READ_ONLY;
      if (t.createdBy === uid || viewer.privileged) {
        return { ...READ_ONLY, fields: ["body", "when"], canDelete: true };
      }
      return { ...READ_ONLY, reason: NOT_YOURS };
    }

    // History. A stage move, a document, an invoice, a job, a photo batch —
    // the row records that something happened; the thing itself lives
    // elsewhere and the row links to it.
    case "stage":
    case "document":
    case "invoice":
    case "job":
    case "photo":
      return READ_ONLY;
  }
}

/** The rows a rep may act on at all — what the hover row exists for. */
export function isActionable(policy: EntryPolicy): boolean {
  return policy.fields.length > 0 || policy.canComplete || policy.canReopen || policy.canDelete;
}

/** What "Delete" asks before it does anything. Destructive actions confirm. */
export function deleteConfirmText(entry: TimelineEntry): { title: string; body: string } {
  if (entry.kind === "note") {
    return {
      title: "Delete this note?",
      body: "It comes off the timeline for everyone. This cannot be undone.",
    };
  }
  return {
    title: `Delete this ${entry.kind === "meeting" ? "meeting" : "activity"}?`,
    body: "It comes off the timeline and stops counting toward cadence. This cannot be undone.",
  };
}

/* ------------------------------------------------------------------ writes */

export type EntryEdit = {
  title?: string;
  body?: string | null;
  /** ISO instant. */
  when?: string;
  /** YYYY-MM-DD, or null to clear. */
  due?: string | null;
  assignee?: string | null;
  pin?: boolean;
};

function fail(error: { message: string } | null) {
  if (error) throw error;
}

/**
 * One save for every editable row. The policy decides what the editor
 * offered; this writes only what the row's table has a column for, so a
 * value the policy never exposed cannot leak into a table it does not fit.
 */
export async function saveEntryEdit(entry: TimelineEntry, edit: EntryEdit): Promise<void> {
  switch (entry.kind) {
    case "note": {
      if (!entry.note) return;
      const patch: { body?: string; is_pinned?: boolean } = {};
      if (edit.body != null) patch.body = edit.body.trim();
      if (edit.pin != null) patch.is_pinned = edit.pin;
      if (Object.keys(patch).length === 0) return;
      fail((await supabase.from("account_notes").update(patch).eq("id", entry.note.id)).error);
      return;
    }
    case "task": {
      if (!entry.task) return;
      const patch: {
        title?: string;
        description?: string | null;
        due_date?: string | null;
        assignee?: string | null;
      } = {};
      if (edit.title != null && edit.title.trim()) patch.title = edit.title.trim();
      if (edit.body !== undefined) patch.description = edit.body?.trim() || null;
      if (edit.due !== undefined) patch.due_date = edit.due || null;
      if (edit.assignee !== undefined) patch.assignee = edit.assignee;
      if (Object.keys(patch).length === 0) return;
      fail((await supabase.from("tasks").update(patch).eq("id", entry.task.id)).error);
      return;
    }
    default: {
      // The rep's note on a captured record lives on its touchpoint; a
      // hand-logged touchpoint is its own row. Either way it is `touchpoints`.
      const touchId = entry.comm?.touchpointId ?? entry.touch?.id ?? null;
      if (!touchId) return;
      const patch: { notes?: string | null; occurred_at?: string } = {};
      if (edit.body !== undefined) patch.notes = edit.body?.trim() || null;
      // Time is the system's on a capture; only a hand-logged row moves.
      if (edit.when && !entry.comm) patch.occurred_at = edit.when;
      if (Object.keys(patch).length === 0) return;
      fail((await supabase.from("touchpoints").update(patch).eq("id", touchId)).error);
    }
  }
}

export async function deleteEntry(entry: TimelineEntry): Promise<void> {
  if (entry.kind === "note" && entry.note) {
    fail((await supabase.from("account_notes").delete().eq("id", entry.note.id)).error);
    return;
  }
  if (entry.touch && !entry.comm) {
    fail((await supabase.from("touchpoints").delete().eq("id", entry.touch.id)).error);
    return;
  }
  throw new Error("This entry cannot be deleted");
}

/** `datetime-local` wants local wall time without the zone; ISO wants UTC. */
export function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
