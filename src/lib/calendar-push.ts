/**
 * Outbound calendar sync — the decisions, with no I/O in them.
 *
 * `calendar.ts` has always stamped `sync_state: 'pending_push'` on every local
 * edit, and until now nothing read it back. Creation reached Outlook
 * (`createGraphMeeting` → `createCalendarEvent`) and nothing else did, so a
 * rescheduled inspection kept its original time in every attendee's mailbox
 * and a cancelled job still had people turning up. This module is the half of
 * the fix that can be reasoned about on its own: what counts as a change worth
 * telling Microsoft about, what the Graph payload for that change looks like,
 * and whether a row wants creating, patching, cancelling or deleting.
 *
 * The transport and the queue drain live in `calendar-push.server.ts`.
 */

/** An attendee as `calendar_events.attendees` stores it (jsonb). */
export type PushAttendee = {
  email?: string | null;
  name?: string | null;
  response?: string | null;
};

/** The columns the push layer reads. Deliberately narrower than CalendarEvent. */
export type CalendarPushRow = {
  id: string;
  provider?: string | null;
  external_id?: string | null;
  subject?: string | null;
  body_preview?: string | null;
  notes?: string | null;
  location_text?: string | null;
  starts_at?: string | null;
  ends_at?: string | null;
  is_all_day?: boolean | null;
  is_cancelled?: boolean | null;
  is_demo?: boolean | null;
  attendees?: unknown;
  organizer_email?: string | null;
  sync_direction?: string | null;
};

/* ------------------------------------------------------------------ */
/* Normalising                                                         */
/* ------------------------------------------------------------------ */

/**
 * Attendee addresses, lower-cased, de-duplicated and sorted.
 *
 * Sorted because this list is compared for equality far more often than it is
 * read, and Outlook does not care what order the invitees arrive in. The
 * column is jsonb written by two different writers — `ingestEvents` stores
 * objects, a caller may hand us plain strings — so both shapes are accepted.
 */
export function attendeeEmails(attendees: unknown): string[] {
  if (!Array.isArray(attendees)) return [];
  const out = new Set<string>();
  for (const entry of attendees) {
    const raw =
      typeof entry === "string"
        ? entry
        : ((entry as PushAttendee | null)?.email ??
          (entry as { emailAddress?: { address?: string } } | null)?.emailAddress?.address ??
          null);
    const email = (raw ?? "").trim().toLowerCase();
    if (email.includes("@")) out.add(email);
  }
  return [...out].sort();
}

const text = (v: string | null | undefined): string => (v ?? "").trim();

/** null, "" and whitespace are the same absence; anything else is the instant. */
function instant(v: string | null | undefined): number | null {
  if (!v) return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : ms;
}

/** The body Outlook shows. Local edits write `notes`; Graph fills body_preview. */
export function eventBody(row: CalendarPushRow): string {
  return text(row.notes) || text(row.body_preview);
}

/* ------------------------------------------------------------------ */
/* What is worth pushing                                               */
/* ------------------------------------------------------------------ */

/**
 * The fields an attendee would notice. `event_type`, `job_id`, `account_id`
 * and `location_id` are CRM filing — re-sending an invite because someone
 * re-tagged a meeting to a different account would train people to ignore
 * update notices, which is how a real time change gets missed.
 */
export const PUSHABLE_FIELDS = [
  "subject",
  "starts_at",
  "ends_at",
  "is_all_day",
  "location_text",
  "body",
  "attendees",
  "is_cancelled",
] as const;

export type PushableField = (typeof PUSHABLE_FIELDS)[number];

/** Which of the attendee-visible fields actually differ. Order is stable. */
export function changedPushFields(
  before: CalendarPushRow | null | undefined,
  after: CalendarPushRow,
): PushableField[] {
  // No "before" means nothing to compare against — treat everything as new.
  if (!before) return [...PUSHABLE_FIELDS];

  const changed: PushableField[] = [];
  if (text(before.subject) !== text(after.subject)) changed.push("subject");
  if (instant(before.starts_at) !== instant(after.starts_at)) changed.push("starts_at");
  if (instant(before.ends_at) !== instant(after.ends_at)) changed.push("ends_at");
  if (Boolean(before.is_all_day) !== Boolean(after.is_all_day)) changed.push("is_all_day");
  if (text(before.location_text) !== text(after.location_text)) changed.push("location_text");
  if (eventBody(before) !== eventBody(after)) changed.push("body");
  if (attendeeEmails(before.attendees).join(",") !== attendeeEmails(after.attendees).join(",")) {
    changed.push("attendees");
  }
  if (Boolean(before.is_cancelled) !== Boolean(after.is_cancelled)) changed.push("is_cancelled");

  return changed.sort((a, b) => PUSHABLE_FIELDS.indexOf(a) - PUSHABLE_FIELDS.indexOf(b));
}

/** Is this edit one Microsoft needs to hear about at all? */
export function isPushWorthy(
  before: CalendarPushRow | null | undefined,
  after: CalendarPushRow,
): boolean {
  return changedPushFields(before, after).length > 0;
}

/* ------------------------------------------------------------------ */
/* The payloads                                                        */
/* ------------------------------------------------------------------ */

export type GraphEventPatch = {
  subject?: string;
  body?: { contentType: "Text"; content: string };
  start?: { dateTime: string; timeZone: "UTC" };
  end?: { dateTime: string; timeZone: "UTC" };
  isAllDay?: boolean;
  location?: { displayName: string };
  attendees?: { emailAddress: { address: string }; type: "required" }[];
};

/**
 * A PATCH body for an event that already exists in Outlook.
 *
 * Same shape and the same UTC/Text conventions `createCalendarEvent` uses, so
 * an event reads identically whichever end of its life wrote it. A field with
 * nothing in it is omitted rather than sent as null: Graph treats an explicit
 * null on `location` as "clear it", and clearing a location the CRM simply
 * never captured would be a regression dressed up as a sync.
 */
export function buildEventPatch(row: CalendarPushRow): GraphEventPatch {
  const patch: GraphEventPatch = {};
  const subject = text(row.subject);
  if (subject) patch.subject = subject;

  patch.body = { contentType: "Text", content: eventBody(row) };

  if (row.starts_at) patch.start = { dateTime: row.starts_at, timeZone: "UTC" };
  if (row.ends_at) patch.end = { dateTime: row.ends_at, timeZone: "UTC" };
  patch.isAllDay = Boolean(row.is_all_day);

  const where = text(row.location_text);
  if (where) patch.location = { displayName: where };

  patch.attendees = attendeeEmails(row.attendees).map((address) => ({
    emailAddress: { address },
    type: "required" as const,
  }));

  return patch;
}

/** The argument shape `createCalendarEvent` already takes. */
export function buildEventCreate(row: CalendarPushRow): {
  subject: string;
  body: string;
  startIso: string;
  endIso: string;
  attendees: string[];
  locationText: string | null;
} | null {
  if (!row.starts_at || !row.ends_at) return null;
  return {
    subject: text(row.subject) || "(no subject)",
    body: eventBody(row),
    startIso: row.starts_at,
    endIso: row.ends_at,
    attendees: attendeeEmails(row.attendees),
    locationText: text(row.location_text) || null,
  };
}

/* ------------------------------------------------------------------ */
/* Create / update / cancel / delete                                   */
/* ------------------------------------------------------------------ */

export type PushAction = "create" | "update" | "cancel" | "delete" | "skip" | "blocked";

export type PushDecision = {
  action: PushAction;
  /** Always populated — it is what the admin screen and the row's error show. */
  reason: string;
};

/**
 * What, if anything, Outlook should be told about this row.
 *
 * The two judgement calls worth stating out loud:
 *
 *  - **Cancel versus delete.** Graph's `/cancel` sends the "this meeting has
 *    been cancelled" notice every attendee needs, but it is only valid on a
 *    meeting the caller organises — on a solo appointment with no invitees it
 *    is an error, and `DELETE` is the correct verb. So the attendee list, not
 *    the caller's intent, picks the verb.
 *  - **Somebody else's meeting.** App-only Graph can reach the organiser's
 *    copy. If the row was ingested from a meeting somebody outside the
 *    connected mailbox organised, editing it in the CRM cannot and must not
 *    rewrite their invite; the row is left alone rather than failing forever.
 *
 * `blocked` means we wanted to push and could not — that is the state a human
 * has to see. `skip` means there was genuinely nothing for Outlook to hear.
 */
export function decideCalendarPush(
  row: CalendarPushRow,
  ctx: { mailboxUpn: string | null },
): PushDecision {
  if (row.sync_direction === "local")
    return {
      action: "skip",
      reason: "Local events stay in Goldstar and are not pushed to Outlook.",
    };
  if (row.is_demo) return { action: "skip", reason: "Demo data is never pushed to Outlook." };

  const live = Boolean(row.external_id);
  const attendees = attendeeEmails(row.attendees);
  const upn = (ctx.mailboxUpn ?? "").trim().toLowerCase();

  if (!upn) {
    return live
      ? {
          action: "blocked",
          reason:
            "This event exists in Outlook but no connected mailbox owns it any more, so the change cannot be sent.",
        }
      : {
          action: "skip",
          reason: "No connected mailbox — the event stays in Recovery Hub only.",
        };
  }

  const organizer = (row.organizer_email ?? "").trim().toLowerCase();
  if (organizer && organizer !== upn) {
    return {
      action: "skip",
      reason: `Organized by ${organizer} in Outlook — Recovery Hub cannot change someone else's invite.`,
    };
  }

  if (row.is_cancelled) {
    if (!live) {
      return { action: "skip", reason: "Canceled before it ever reached Outlook." };
    }
    return attendees.length > 0
      ? { action: "cancel", reason: "Canceled — attendees get the cancellation notice." }
      : { action: "delete", reason: "Canceled — no attendees, so the entry is removed." };
  }

  if (!live) {
    if (attendees.length === 0) {
      return {
        action: "skip",
        reason: "No attendees — nothing to invite, so it stays a Recovery Hub entry.",
      };
    }
    if (!row.starts_at || !row.ends_at) {
      return { action: "blocked", reason: "An Outlook invite needs both a start and an end time." };
    }
    return { action: "create", reason: "New event with attendees — sending the invite." };
  }

  return { action: "update", reason: "Updating the Outlook event and re-notifying attendees." };
}

/**
 * The rows `decideCalendarPush` skips whatever mailbox it is handed: nothing
 * about them would ever reach Outlook, so they settle without asking the
 * database whose authority the push runs under. The worker checks this first
 * because a refusal from `calendar_push_authorized_event` is reported as
 * blocked, and "you may not push this" is noise on a row nobody wanted
 * pushed — a local note, demo data, a draft with no invitees.
 *
 * Every answer here must be one `decideCalendarPush` gives too, for any
 * mailbox; `calendar-push.test.ts` holds the two together.
 */
export function settlesWithoutOutlook(row: CalendarPushRow): PushDecision | null {
  if (row.sync_direction === "local" || row.is_demo) {
    return decideCalendarPush(row, { mailboxUpn: null });
  }
  if (row.external_id) return null;
  if (row.is_cancelled) {
    return { action: "skip", reason: "Canceled before it ever reached Outlook." };
  }
  if (attendeeEmails(row.attendees).length === 0) {
    return {
      action: "skip",
      reason: "No attendees — nothing to invite, so it stays a Recovery Hub entry.",
    };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Retry policy                                                        */
/* ------------------------------------------------------------------ */

/** After this many consecutive failures a row is stuck and stops retrying. */
export const MAX_PUSH_ATTEMPTS = 5;

/**
 * Minutes to wait before attempt n+1. Graph's own throttling is handled inside
 * `graphFetch`; this backoff is for the failures that survive it — a mailbox
 * that lost its licence, a permission that was revoked — where hammering the
 * tenant every cron tick is how an integration gets blocked outright.
 */
export function retryDelayMinutes(attempts: number): number {
  return Math.min(2 ** Math.max(0, attempts), 60);
}

/** Is this row's backoff over? A row that has never been tried is always due. */
export function isRetryDue(
  row: { sync_attempts?: number | null; last_push_at?: string | null },
  now: number,
): boolean {
  const attempts = row.sync_attempts ?? 0;
  if (attempts <= 0) return true;
  const last = instant(row.last_push_at);
  if (last === null) return true;
  return now - last >= retryDelayMinutes(attempts) * 60_000;
}
