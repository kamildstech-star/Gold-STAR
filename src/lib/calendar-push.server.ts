/**
 * Draining `calendar_events.sync_state = 'pending_push'` into Microsoft Graph.
 *
 * `pending_push` was written by four places in `calendar.ts` and read by
 * nowhere, so every edit and every cancellation stopped at our own table. This
 * is the reader. It is a queue drain rather than an inline call on purpose:
 *
 *  - the user's save must land in Postgres whether or not Microsoft answers,
 *    so the write and the push are separate steps and only the write is on the
 *    critical path;
 *  - a push that fails is retried by the same nightly job that already
 *    reconciles the mailboxes (`/api/public/hooks/graph-sync`), with backoff;
 *  - a row that keeps failing goes to `sync_state = 'error'` and shows up on
 *    the Microsoft 365 admin screen with the provider's own message. A silently
 *    stuck row is the failure mode this whole exercise exists to end.
 *
 * No Graph permission beyond the `Calendars.ReadWrite` the create path
 * already needs: PATCH, /cancel and DELETE on an event are all covered by it.
 *
 * WHOSE TOKEN: the mailbox's holder, from graph-auth.server.ts — the company
 * credential in application mode, the mailbox's own person (or a shared
 * mailbox's owner) in delegated mode. A mailbox nobody can currently speak
 * for leaves its rows queued and untouched (`waiting`), the same way an
 * unconfigured tenant does: that is a person to chase, not five failed
 * attempts that bury the real errors.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { isMissingSchema } from "@/lib/schema-fallback";
import {
  MAX_PUSH_ATTEMPTS,
  attendeeEmails,
  buildEventCreate,
  buildEventPatch,
  decideCalendarPush,
  isRetryDue,
  settlesWithoutOutlook,
  type CalendarPushRow,
  type PushAction,
} from "@/lib/calendar-push";
import { GraphError, graphConfigured } from "@/lib/graph.server";

/** Columns that exist today. */
const BASE_COLUMNS =
  "id,provider,external_id,subject,body_preview,notes,location_text,starts_at,ends_at,is_all_day,is_cancelled,is_demo,attendees,organizer_email,sync_direction,sync_state,user_id,location_id,mailbox_id,updated_at";

/**
 * Added by 20260904120000. The migration is written, not applied — so every
 * read and write of these three falls back to the older shape rather than
 * taking the whole queue down while the schema catches up.
 */
const PUSH_COLUMNS = "sync_attempts,last_push_at,sync_error";

type QueueRow = CalendarPushRow & {
  user_id: string | null;
  location_id: string | null;
  mailbox_id: string | null;
  updated_at?: string | null;
  sync_state?: string | null;
  sync_attempts?: number | null;
  last_push_at?: string | null;
  sync_error?: string | null;
};

async function selectQueue(state: string, limit: number, ids?: string[]): Promise<QueueRow[]> {
  const read = async (columns: string) => {
    let q = supabaseAdmin.from("calendar_events").select(columns).eq("sync_state", state);
    // Asking for named rows must not depend on them landing inside the first
    // page of the queue — the one row a user just saved is exactly the one a
    // busy queue would push off the end.
    if (ids?.length) q = q.in("id", ids);
    return q.order("updated_at", { ascending: true }).limit(limit);
  };

  const full = await read(`${BASE_COLUMNS},${PUSH_COLUMNS}`);
  if (!full.error) return (full.data ?? []) as unknown as QueueRow[];
  if (!isMissingSchema(full.error)) throw full.error;

  const base = await read(BASE_COLUMNS);
  if (base.error) throw base.error;
  return (base.data ?? []) as unknown as QueueRow[];
}

/**
 * Write a row patch, dropping the columns the database has not grown yet.
 * `sync_state` always lands; the bookkeeping is best effort.
 */
async function patchRow(
  id: string,
  base: Record<string, unknown>,
  bookkeeping: Record<string, unknown>,
): Promise<void> {
  const attempt = await supabaseAdmin
    .from("calendar_events")
    .update({ ...base, ...bookkeeping } as never)
    .eq("id", id);
  if (!attempt.error) return;
  if (!isMissingSchema(attempt.error)) throw attempt.error;
  const { error } = await supabaseAdmin
    .from("calendar_events")
    .update(base as never)
    .eq("id", id);
  if (error) throw error;
}

/* ------------------------------------------------------------------ */
/* Which mailbox speaks for this event                                 */
/* ------------------------------------------------------------------ */

export type PushMailbox = { id: string; upn: string };

/**
 * The mailbox whose calendar this event lives in. Only enabled mailboxes with
 * calendar sync on are eligible — turning calendar sync off has to actually
 * stop writes.
 *
 * An event that already has a home NEVER moves. This used to fall through to
 * the organiser's address, the person's own mailbox and finally any mailbox
 * in the office whenever the event's own mailbox was disabled, so switching a
 * mailbox off redirected its events through somebody else's: an update for
 * an Outlook id that mailbox does not own, or a create that put the meeting
 * on another person's calendar and re-stamped `mailbox_id` to match. Now:
 *
 *  - `mailbox_id` set: that mailbox or nothing. Disabled or calendar sync
 *    off means the push waits (blocked, retried) until it is switched back.
 *  - no mailbox but already in Outlook (`external_id` / `provider`): nothing.
 *    A provider id belongs to the mailbox that created it, and we no longer
 *    know which one that was.
 *  - a local event that has never been pushed: the person's own mailbox,
 *    else a SHARED office mailbox (no owner) for its location. Never a
 *    colleague's personal mailbox, and never chosen by `organizer_email`,
 *    which is just a string on the row.
 *
 * Same rules as `calendar_push_authorized_event()` (20260908012000, replaced
 * by 20261007140000). The database decides; this is the second opinion
 * `authorizeCalendarPush` asks for, so a later edit that loosens the function
 * cannot quietly widen where the worker writes.
 */
export async function resolveMailboxForEvent(row: QueueRow): Promise<PushMailbox | null> {
  const eligible = () =>
    supabaseAdmin
      .from("graph_mailboxes")
      .select("id, upn")
      .eq("enabled", true)
      .eq("sync_calendar", true);
  const one = async (q: ReturnType<typeof eligible>): Promise<PushMailbox | null> => {
    const { data } = await q.order("id").limit(1).maybeSingle();
    return data ? { id: data.id, upn: data.upn } : null;
  };

  if (row.mailbox_id) return one(eligible().eq("id", row.mailbox_id));
  if (row.external_id || row.provider) return null;
  if (row.user_id) {
    const own = await one(eligible().eq("user_id", row.user_id));
    if (own) return own;
  }
  if (row.location_id) {
    return one(eligible().is("user_id", null).eq("location_id", row.location_id));
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* One row                                                             */
/* ------------------------------------------------------------------ */

export type PushOutcome = {
  id: string;
  action: PushAction;
  reason: string;
  ok: boolean;
  /** Set when the row is now stuck and needs a human. */
  stuck?: boolean;
  /**
   * Delegated mode: nobody connected can write to this mailbox right now.
   * The row is left exactly as it was — no attempt counted.
   */
  waiting?: boolean;
  error?: string;
};

const nowIso = () => new Date().toISOString();

async function succeed(
  row: QueueRow,
  action: PushAction,
  reason: string,
  extra: Record<string, unknown> = {},
): Promise<PushOutcome> {
  await patchRow(
    row.id,
    { sync_state: action === "skip" ? "clean" : "pushed", ...extra },
    { sync_attempts: 0, last_push_at: nowIso(), sync_error: null },
  );
  return { id: row.id, action, reason, ok: true };
}

async function fail(row: QueueRow, action: PushAction, message: string): Promise<PushOutcome> {
  const attempts = (row.sync_attempts ?? 0) + 1;
  const stuck = attempts >= MAX_PUSH_ATTEMPTS;
  await patchRow(
    row.id,
    // Only the final attempt flips the state, so an ordinary blip stays in the
    // queue and retries instead of demanding attention.
    { sync_state: stuck ? "error" : "pending_push" },
    { sync_attempts: attempts, last_push_at: nowIso(), sync_error: message.slice(0, 1000) },
  );
  return { id: row.id, action, reason: message, ok: false, stuck, error: message };
}

export type PushAuthorization =
  | { ok: true; row: QueueRow; mailbox: PushMailbox }
  | { ok: false; noMailbox: boolean; reason: string };

/**
 * Ask the database whether this row may be pushed, and through which mailbox.
 *
 * `calendar_push_authorized_event` re-reads the row, insists its Outlook
 * identity was written by the server (`push_identity_verified`) and that the
 * person who last changed it (`push_actor_id`, stamped from their session)
 * may act as the mailbox — their own, a shared office mailbox they manage, or
 * any for owner/admin/dev. It answers with that fresh row and the mailbox, so
 * the payload we send is the one it authorised, not the queue's older copy.
 *
 * Anything other than a clean answer is a refusal: a missing function or a
 * network error must not turn into a push.
 */
export async function authorizeCalendarPush(queued: QueueRow): Promise<PushAuthorization> {
  const { data, error } = await supabaseAdmin.rpc("calendar_push_authorized_event", {
    _event_id: queued.id,
  });
  if (error) {
    // P0002 is the one refusal that is not a "no": a new event nobody has a
    // connected mailbox for. That used to stay a Recovery Hub entry, and still
    // does, rather than retrying into the error list.
    return {
      ok: false,
      noMailbox: error.code === "P0002",
      reason: `Calendar push refused: ${error.message}`,
    };
  }
  const answer = data as { row?: Partial<QueueRow>; mailbox?: Partial<PushMailbox> } | null;
  const mailbox = answer?.mailbox;
  if (!answer?.row || !mailbox?.id || !mailbox.upn) {
    return { ok: false, noMailbox: false, reason: "Calendar push refused: no mailbox was named." };
  }
  const row = { ...queued, ...answer.row } as QueueRow;
  const second = await resolveMailboxForEvent(row);
  if (second?.id !== mailbox.id) {
    return {
      ok: false,
      noMailbox: false,
      reason:
        "Calendar push refused: the database and the app disagree about which mailbox owns it.",
    };
  }
  return { ok: true, row, mailbox: { id: mailbox.id, upn: mailbox.upn } };
}

/** Push exactly one queued row. Never throws — the outcome is the report. */
export async function pushCalendarRow(queued: QueueRow): Promise<PushOutcome> {
  const settled = settlesWithoutOutlook(queued);
  if (settled) return succeed(queued, "skip", settled.reason);

  const auth = await authorizeCalendarPush(queued);
  if (!auth.ok) {
    if (auth.noMailbox && !queued.external_id) {
      return succeed(
        queued,
        "skip",
        "No connected mailbox — the event stays in Recovery Hub only.",
      );
    }
    // Reported, never dropped: the row stays queued with the database's reason
    // and lands in the admin screen's error list after the usual attempts.
    return fail(queued, "blocked", auth.reason);
  }
  const { row, mailbox } = auth;
  const decision = decideCalendarPush(row, { mailboxUpn: mailbox.upn });

  if (decision.action === "skip") {
    return succeed(row, "skip", decision.reason);
  }
  if (decision.action === "blocked") {
    return fail(row, "blocked", decision.reason);
  }

  const { loadOutlookEnv } = await import("@/lib/microsoft-delegated.server");
  await loadOutlookEnv();
  const graph = await import("@/lib/graph.server");
  const { resolveMailboxAuthById } = await import("@/lib/graph-auth.server");
  const resolved = await resolveMailboxAuthById(mailbox.id);
  if (!resolved.ok) {
    return {
      id: row.id,
      action: decision.action,
      reason: resolved.message,
      ok: false,
      waiting: true,
    };
  }
  // Whose Microsoft token writes to this mailbox (graph-auth.server.ts) —
  // separate from `authorization` above, which is whether the push may happen.
  const graphAuth = resolved.auth;

  try {
    if (decision.action === "create") {
      const input = buildEventCreate(row);
      if (!input)
        return fail(row, "create", "An Outlook invite needs both a start and an end time.");
      const created = await graph.createCalendarEvent(mailbox.upn, input, graphAuth);
      return succeed(row, "create", decision.reason, {
        provider: "outlook",
        external_id: created.id,
        mailbox_id: mailbox.id,
        organizer_email: mailbox.upn,
        web_link: created.webLink ?? null,
        sync_direction: "two_way",
        // The mailbox came from the database's own authorisation and Graph
        // made this id in it, so the new identity is the server's word.
        push_identity_verified: true,
      });
    }

    if (decision.action === "update") {
      await graph.updateCalendarEvent(
        mailbox.upn,
        row.external_id as string,
        buildEventPatch(row),
        graphAuth,
      );
      return succeed(row, "update", decision.reason, { mailbox_id: mailbox.id });
    }

    if (decision.action === "cancel") {
      await graph.cancelCalendarEvent(mailbox.upn, row.external_id as string, graphAuth);
      return succeed(row, "cancel", decision.reason, { meeting_held: false });
    }

    await graph.deleteCalendarEvent(mailbox.upn, row.external_id as string, graphAuth);
    return succeed(row, "delete", decision.reason, { meeting_held: false });
  } catch (e) {
    // The event is gone at their end. That is the state we were asking for on
    // a cancel, and on an update there is nothing left to patch — either way
    // it is settled, not stuck.
    if (e instanceof GraphError && e.status === 404) {
      return succeed(row, decision.action, "The event no longer exists in Outlook.", {
        sync_state: "clean",
      });
    }
    return fail(row, decision.action, (e as Error).message);
  }
}

/* ------------------------------------------------------------------ */
/* The queue                                                           */
/* ------------------------------------------------------------------ */

export type DrainResult = {
  configured: boolean;
  considered: number;
  pushed: number;
  skipped: number;
  failed: number;
  stuck: number;
  /** Left queued because the mailbox has no usable delegated token. */
  waiting: number;
  outcomes: PushOutcome[];
};

/**
 * Drain the pending queue. Called by the scheduled Graph job and, so the
 * common case is not a minute late, opportunistically right after a save.
 *
 * With Microsoft 365 not connected the rows are left exactly where they are:
 * a missing tenant credential is a configuration problem, not five failed
 * attempts per event, and marking them `error` would bury the real ones.
 */
export async function drainCalendarPushQueue(
  options: { limit?: number; ids?: string[] } = {},
): Promise<DrainResult> {
  // Admin-entered Outlook values first, or "configured" below would only see
  // deployment secrets (loadOutlookEnv).
  const { loadOutlookEnv } = await import("@/lib/microsoft-delegated.server");
  await loadOutlookEnv();
  const empty: DrainResult = {
    configured: graphConfigured(),
    considered: 0,
    pushed: 0,
    skipped: 0,
    failed: 0,
    stuck: 0,
    waiting: 0,
    outcomes: [],
  };
  if (!empty.configured) return empty;

  const limit = options.limit ?? 100;
  const rows = await selectQueue("pending_push", limit, options.ids);

  const now = Date.now();
  const due = rows.filter((r) => isRetryDue(r, now));

  const result: DrainResult = { ...empty, considered: due.length, outcomes: [] };
  for (const row of due) {
    const outcome = await pushCalendarRow(row);
    result.outcomes.push(outcome);
    if (outcome.waiting) {
      result.waiting += 1;
    } else if (!outcome.ok) {
      result.failed += 1;
      if (outcome.stuck) result.stuck += 1;
    } else if (outcome.action === "skip") {
      result.skipped += 1;
    } else {
      result.pushed += 1;
    }
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* What a human needs to see                                           */
/* ------------------------------------------------------------------ */

export type CalendarPushSummary = {
  pending: number;
  stuck: number;
  oldest_pending_at: string | null;
  /** A handful of stuck rows with the provider's own words, for the admin UI. */
  samples: {
    id: string;
    subject: string | null;
    starts_at: string | null;
    attempts: number;
    error: string | null;
  }[];
};

/** The queue's health, for the Microsoft 365 admin screen and the cron report. */
export async function calendarPushSummary(): Promise<CalendarPushSummary> {
  const count = async (state: string) => {
    const { count: n } = await supabaseAdmin
      .from("calendar_events")
      .select("id", { count: "exact", head: true })
      .eq("sync_state", state);
    return n ?? 0;
  };

  const [pending, stuck] = await Promise.all([count("pending_push"), count("error")]);
  const oldest = (await selectQueue("pending_push", 1))[0];
  const stuckRows = await selectQueue("error", 10);

  return {
    pending,
    stuck,
    oldest_pending_at: oldest?.updated_at ?? null,
    samples: stuckRows.map((r) => ({
      id: r.id,
      subject: r.subject ?? null,
      starts_at: r.starts_at ?? null,
      attempts: r.sync_attempts ?? 0,
      error: r.sync_error ?? null,
    })),
  };
}

/**
 * Put stuck rows back in the queue. A human has fixed whatever the message
 * said — a licence, a permission, a mailbox that came back — and wants them
 * tried again; without this the only way out of `error` is hand-editing rows.
 */
export async function retryStuckCalendarPushes(): Promise<number> {
  const rows = await selectQueue("error", 200);
  for (const row of rows) {
    await patchRow(row.id, { sync_state: "pending_push" }, { sync_attempts: 0, sync_error: null });
  }
  return rows.length;
}

export { attendeeEmails };
