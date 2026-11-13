import { useQuery } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { useAppContext } from "@/components/app-context";
import { isPrivileged } from "@/lib/roles";
import { isMissingSchema } from "@/lib/schema-fallback";
import { fetchManagesOffice } from "@/lib/pipeline-reversion";

/**
 * Editing a client in place from the Client 360 panel.
 *
 * Mark, 2026-09-09: "you should be able to edit anything you want over there
 * except for the history." So the panel's own facts about the client — name,
 * address, when they became a client, the health band, the satisfaction score,
 * their reminders — became editable, and everything that is a RECORD OF WHAT
 * HAPPENED stayed read-only. That distinction is the whole design, so it is
 * written down here as data rather than left implicit in JSX, and tested.
 *
 * Two rules the writes obey:
 *
 *  - Nothing bypasses an existing control. The health band goes through
 *    `applyClientHealthStage` (src/lib/client-health-move.ts), the same path
 *    the Kanban drag uses, so the override still files its `account_stage_history`
 *    row and still refuses a move below the metric band. "Client since" writes
 *    its own `accounts.client_since` column rather than forging `created_at`,
 *    which is an audit stamp and the health clock's fallback.
 *  - Nothing claims a save that did not happen. Every field reports pending,
 *    saved or the real database error; there is no optimistic value left on
 *    screen after a failure.
 */

/* ----------------------------------------------------- what is editable */

export type Client360SectionKey =
  | "identity"
  | "satisfaction"
  | "reminders"
  | "claim_details"
  | "touch_history"
  | "milestones"
  | "tasks"
  | "messages"
  | "invoices";

export type Client360Section = {
  key: Client360SectionKey;
  /** The heading as it reads in the panel. */
  title: string;
  editable: boolean;
  /** Why not, shown to the reader. Present exactly when `editable` is false. */
  readOnlyReason?: string;
};

export const CLIENT_360_SECTIONS: readonly Client360Section[] = [
  { key: "identity", title: "Client", editable: true },
  { key: "satisfaction", title: "Satisfaction", editable: true },
  { key: "reminders", title: "Reminders", editable: true },
  { key: "claim_details", title: "Claim Details", editable: true },
  {
    key: "touch_history",
    title: "Touch history",
    editable: false,
    readOnlyReason: "The record of what happened. Log a touchpoint to add to it.",
  },
  {
    key: "milestones",
    title: "Milestones",
    editable: false,
    readOnlyReason: "Derived from the job's status history — move the job to change them.",
  },
  {
    key: "tasks",
    title: "Open Tasks",
    editable: false,
    readOnlyReason: "Edited on the task itself, where assignment and reminders follow the change.",
  },
  {
    key: "messages",
    title: "Recent Messages",
    editable: false,
    readOnlyReason: "The record of what was sent.",
  },
  {
    key: "invoices",
    title: "Invoices",
    editable: false,
    readOnlyReason: "Billing is edited on the invoice, where the ledger stays balanced.",
  },
] as const;

const SECTION_BY_KEY = new Map(CLIENT_360_SECTIONS.map((s) => [s.key, s]));

export function client360Section(key: Client360SectionKey): Client360Section {
  const found = SECTION_BY_KEY.get(key);
  if (!found) throw new Error(`Unknown Client 360 section: ${key}`);
  return found;
}

export function isClient360SectionEditable(key: Client360SectionKey): boolean {
  return client360Section(key).editable;
}

/** Account columns Client 360 writes. Anything not listed is not editable here. */
export type EditableAccountField =
  "name" | "address_line1" | "city" | "state" | "postal_code" | "client_since";

export const EDITABLE_ACCOUNT_FIELDS: readonly EditableAccountField[] = [
  "name",
  "address_line1",
  "city",
  "state",
  "postal_code",
  "client_since",
] as const;

export function isEditableAccountField(key: string): key is EditableAccountField {
  return (EDITABLE_ACCOUNT_FIELDS as readonly string[]).includes(key);
}

/* --------------------------------------------------------- who may edit */

export const ACCOUNT_EDIT_CHECKING_REASON = "Checking your permissions…";
export const ACCOUNT_EDIT_DENIED_REASON =
  "Only this account's rep or a manager of its office can edit these fields";

export type EditRights = { allowed: boolean; reason: string | null };

/**
 * Mirrors the `accounts_update` row policy —
 * `can_manage_location(uid, location_id) OR assigned_rep = uid` — plus the
 * privileged escape hatch, which `can_manage_location` does not cover for an
 * account with no office at all.
 *
 * The database is the guard; this is the courtesy that disables a control with
 * a reason instead of letting the save come back 403. An outstanding check is
 * never a yes.
 */
export function accountEditRights(input: {
  privileged: boolean;
  userId: string | null;
  locationId: string | null | undefined;
  assignedRep: string | null | undefined;
  /** `can_manage_location` for this office; null until it answers. */
  managesOffice: boolean | null;
  /** Roles/session still loading. */
  loading?: boolean;
}): EditRights {
  if (input.loading || !input.userId) {
    return { allowed: false, reason: ACCOUNT_EDIT_CHECKING_REASON };
  }
  if (input.privileged) return { allowed: true, reason: null };
  if (input.assignedRep && input.assignedRep === input.userId) {
    return { allowed: true, reason: null };
  }
  if (!input.locationId) return { allowed: false, reason: ACCOUNT_EDIT_DENIED_REASON };
  if (input.managesOffice === null) {
    return { allowed: false, reason: ACCOUNT_EDIT_CHECKING_REASON };
  }
  return input.managesOffice
    ? { allowed: true, reason: null }
    : { allowed: false, reason: ACCOUNT_EDIT_DENIED_REASON };
}

/** The gate every editable account field in Client 360 reads. */
export function useAccountEditRights(input: {
  locationId: string | null | undefined;
  assignedRep: string | null | undefined;
}): EditRights {
  const app = useAppContext();
  const privileged = isPrivileged(app.roles);
  const ownRecord = Boolean(app.userId) && input.assignedRep === app.userId;
  const q = useQuery({
    queryKey: ["manages-office", app.userId, input.locationId],
    enabled:
      Boolean(app.userId) && Boolean(input.locationId) && !privileged && !ownRecord && !app.loading,
    staleTime: 5 * 60_000,
    queryFn: () => fetchManagesOffice(app.userId as string, input.locationId as string),
  });
  // A failed check is a "no", never a stale yes.
  const managesOffice = q.isSuccess ? q.data : q.isError ? false : null;
  return accountEditRights({
    privileged,
    userId: app.userId,
    locationId: input.locationId,
    assignedRep: input.assignedRep,
    managesOffice,
    loading: app.loading,
  });
}

/* --------------------------------------------------------- validation */

/** Null when the value is acceptable; otherwise the sentence to show. */
export type FieldProblem = string | null;

export function validateClientName(raw: string): FieldProblem {
  const name = raw.trim();
  if (!name) return "A client needs a name.";
  if (name.length > 200) return "Keep the name under 200 characters.";
  return null;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Today in the viewer's own timezone, as yyyy-mm-dd — what a date input shows. */
export function todayIsoDay(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * "Client since" is a stated day. Empty clears it back to the created_at
 * fallback; a future day is refused, because nobody became a client tomorrow.
 */
export function validateClientSince(raw: string, today: string = todayIsoDay()): FieldProblem {
  const value = raw.trim();
  if (!value) return null;
  if (!ISO_DAY.test(value)) return "Use a date in the form YYYY-MM-DD.";
  const parsed = new Date(`${value}T00:00:00`);
  if (!Number.isFinite(parsed.getTime())) return "That is not a real date.";
  // Round-trip catches 2026-02-31, which Date happily rolls into March.
  if (todayIsoDay(parsed) !== value) return "That is not a real date.";
  if (value > today) return "A client cannot have become one in the future.";
  if (value < "1900-01-01") return "That date is too far back to be right.";
  return null;
}

/** yyyy-mm-dd for the input, or "" — accepts the date and timestamp shapes. */
export function toIsoDay(value: string | null | undefined): string {
  if (!value) return "";
  if (ISO_DAY.test(value)) return value;
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return "";
  return todayIsoDay(d);
}

export const SATISFACTION_MIN = 1;
export const SATISFACTION_MAX = 5;

/** Whole stars only, or null to clear the score. */
export function validateSatisfaction(score: number | null): FieldProblem {
  if (score === null) return null;
  if (!Number.isFinite(score)) return "Pick a rating from 1 to 5 stars.";
  if (!Number.isInteger(score)) return "Satisfaction is whole stars.";
  if (score < SATISFACTION_MIN || score > SATISFACTION_MAX) {
    return `Satisfaction runs from ${SATISFACTION_MIN} to ${SATISFACTION_MAX} stars.`;
  }
  return null;
}

/** Clicking the star already lit clears the score rather than re-writing it. */
export function nextSatisfaction(current: number | null, clicked: number): number | null {
  return current !== null && Math.round(current) === clicked ? null : clicked;
}

export function validateReminderAt(raw: string, now: Date = new Date()): FieldProblem {
  const value = raw.trim();
  if (!value) return "A reminder needs a date and time.";
  const at = new Date(value);
  if (!Number.isFinite(at.getTime())) return "That is not a real date and time.";
  if (at.getTime() < now.getTime() - 60_000) return "Pick a time that has not already passed.";
  return null;
}

/* ------------------------------------------------------------- writing */

export const CLIENT_SINCE_UNMIGRATED =
  'Saved everything except "Client since" — that column is not in the database yet. ' +
  "Apply migration 20260909200000_accounts_client_since.sql.";

/**
 * One account column, written on its own.
 *
 * Field-at-a-time on purpose: a panel-wide Save would make one bad value lose
 * five good ones, and the reader could not tell which of the six actually
 * reached the database.
 */
/** Build the one-column patch, typed — no dynamic key into the table Update. */
function accountPatch(
  field: EditableAccountField,
  value: string | null,
): Database["public"]["Tables"]["accounts"]["Update"] {
  switch (field) {
    case "name": {
      const problem = validateClientName(value ?? "");
      if (problem) throw new Error(problem);
      return { name: (value ?? "").trim() };
    }
    case "address_line1":
      return { address_line1: value };
    case "city":
      return { city: value };
    case "state":
      return { state: value };
    case "postal_code":
      return { postal_code: value };
    case "client_since": {
      const problem = validateClientSince(value ?? "");
      if (problem) throw new Error(problem);
      return { client_since: value };
    }
  }
}

export async function saveAccountField(
  accountId: string,
  field: EditableAccountField,
  value: string | null,
): Promise<void> {
  const { error } = await supabase
    .from("accounts")
    .update(accountPatch(field, value))
    .eq("id", accountId);
  if (!error) return;
  // The one field whose column may not have shipped yet says so plainly
  // instead of surfacing a raw PostgREST "column does not exist".
  if (field === "client_since" && isMissingSchema(error)) {
    throw new Error(CLIENT_SINCE_UNMIGRATED);
  }
  throw error;
}

/** The satisfaction star row. Stamps who scored it, like the column expects. */
export async function saveSatisfaction(
  accountId: string,
  score: number | null,
  userId: string | null,
): Promise<void> {
  const problem = validateSatisfaction(score);
  if (problem) throw new Error(problem);
  const { error } = await supabase
    .from("accounts")
    .update({
      satisfaction_score: score,
      satisfaction_updated_at: score === null ? null : new Date().toISOString(),
      satisfaction_updated_by: score === null ? null : userId,
    })
    .eq("id", accountId);
  if (error) throw error;
}

/** Move a pending reminder. `reminders` RLS is "own rows only". */
export async function saveReminderAt(reminderId: string, remindAt: string): Promise<void> {
  const { error } = await supabase
    .from("reminders")
    .update({ remind_at: new Date(remindAt).toISOString() })
    .eq("id", reminderId);
  if (error) throw error;
}

/**
 * Mark a reminder handled. Not a delete — `sent_at` is what the reminder sweep
 * and every list here already read as "this one is done", so the row stays.
 */
export async function dismissReminder(reminderId: string): Promise<void> {
  const { error } = await supabase
    .from("reminders")
    .update({ sent_at: new Date().toISOString() })
    .eq("id", reminderId);
  if (error) throw error;
}

/** A reminder belonging to someone else is theirs to move, not yours. */
export const REMINDER_NOT_YOURS_REASON = "This reminder belongs to someone else";

export function reminderEditRights(input: {
  ownerId: string | null | undefined;
  userId: string | null;
}): EditRights {
  if (!input.userId) return { allowed: false, reason: ACCOUNT_EDIT_CHECKING_REASON };
  if (!input.ownerId || input.ownerId !== input.userId) {
    return { allowed: false, reason: REMINDER_NOT_YOURS_REASON };
  }
  return { allowed: true, reason: null };
}
