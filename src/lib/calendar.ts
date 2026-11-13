import type { RecurrenceRule } from "@/lib/calendar-recurrence";
import {
  localRecurrenceAvailable,
  listLocalRecurringEvents,
  saveLocalRecurringEvent,
} from "@/lib/calendar-recurring-store";
// The calendar is one table, whatever put the event there. An Outlook meeting,
// an inspection someone booked in the app, a scheduled job, a tradeshow — all
// land in calendar_events, so the dashboard card, the record timelines and the
// full calendar are reading the same rows rather than three near-truths.
//
// Every row carries where it came from (`provider` + `external_id`) and which
// way it syncs (`sync_direction`, `sync_state`).
//
// `pending_push` is the outbound queue. Writing it here is only half the job:
// `calendar-push.server.ts` drains it into Microsoft Graph, and the scheduled
// Graph reconciliation retries whatever failed. Every writer below that changes
// something an attendee would notice marks the row and then *asks* for a push
// without waiting for it — the save is committed either way, because a
// Microsoft outage must never cost somebody their edit.

import { validateEventTimes } from "@/lib/calendar-validation";
import { supabase } from "@/integrations/supabase/client";
import { attendeeEmails, isPushWorthy, type CalendarPushRow } from "@/lib/calendar-push";

export type CalendarEventType =
  "meeting" | "inspection" | "job" | "task" | "tradeshow" | "shift" | "other";

/**
 * A record this event was derived from rather than stored as.
 *
 * Set only on events the calendar builds at read time from another table. They
 * have no `calendar_events` row, so nothing may try to move, cancel or delete
 * them — the record they came from is where they are edited.
 */
export type DerivedFrom = { kind: "tradeshow"; id: string };

export type CalendarEvent = {
  id: string;
  /** Present only on read-time events; see `DerivedFrom`. */
  derived?: DerivedFrom;
  recurrence?: RecurrenceRule | null;
  recurrence_master_id?: string | null;
  recurrence_index?: number | null;
  series_starts_at?: string;
  series_ends_at?: string;
  user_id: string | null;
  created_by: string | null;
  subject: string | null;
  body_preview: string | null;
  notes: string | null;
  location_text: string | null;
  starts_at: string | null;
  ends_at: string | null;
  is_all_day: boolean;
  is_cancelled: boolean;
  event_type: CalendarEventType;
  account_id: string | null;
  contact_id: string | null;
  job_id: string | null;
  location_id: string | null;
  provider: string | null;
  external_id: string | null;
  sync_direction: string;
  sync_state: string;
  web_link: string | null;
  meeting_held: boolean | null;
};

export const EVENT_TYPES: {
  value: CalendarEventType;
  label: string;
  /** CSS colour token — never a hardcoded hex in a component. */
  color: string;
}[] = [
  { value: "meeting", label: "Meeting", color: "var(--info)" },
  { value: "inspection", label: "Inspection", color: "var(--brand-gold)" },
  { value: "job", label: "Job scheduled", color: "var(--chart-1)" },
  { value: "task", label: "Task due", color: "var(--warning)" },
  { value: "tradeshow", label: "Tradeshow", color: "var(--chart-3)" },
  { value: "shift", label: "Shift", color: "var(--success)" },
  { value: "other", label: "Other", color: "var(--muted-foreground)" },
];

export function eventColor(type: string | null | undefined): string {
  return EVENT_TYPES.find((t) => t.value === type)?.color ?? "var(--muted-foreground)";
}

export function eventTypeLabel(type: string | null | undefined): string {
  return EVENT_TYPES.find((t) => t.value === type)?.label ?? "Other";
}

const SELECT =
  "id,user_id,created_by,subject,body_preview,notes,location_text,starts_at,ends_at,is_all_day,is_cancelled,event_type,account_id,contact_id,job_id,location_id,provider,external_id,sync_direction,sync_state,web_link,meeting_held";

export type CalendarFilters = {
  from: Date;
  to: Date;
  /** Empty = everyone the caller is allowed to see. */
  userIds?: string[];
  locationId?: string | null;
  types?: CalendarEventType[];
};

export async function listEvents(f: CalendarFilters): Promise<CalendarEvent[]> {
  const recurringEnabled = await localRecurrenceAvailable();
  let q = supabase
    .from("calendar_events")
    .select(SELECT)
    .gte("starts_at", f.from.toISOString())
    .lt("starts_at", f.to.toISOString())
    .order("starts_at")
    .limit(1000);
  if (recurringEnabled) q = q.is("recurrence", null).is("recurrence_master_id", null);
  if (f.userIds && f.userIds.length > 0) q = q.in("user_id", f.userIds);
  if (f.locationId) q = q.eq("location_id", f.locationId);
  if (f.types && f.types.length > 0 && f.types.length < EVENT_TYPES.length) {
    q = q.in("event_type", f.types);
  }
  const { data, error } = await q;
  if (error) throw error;
  const recurring = recurringEnabled ? await listLocalRecurringEvents(f) : [];
  const tradeshows = await listTradeshowEvents(f);
  return [...((data ?? []) as unknown as CalendarEvent[]), ...recurring, ...tradeshows]
    .filter((e) => !!e.starts_at)
    .sort((a, b) => Date.parse(a.starts_at!) - Date.parse(b.starts_at!));
}

/** The id a derived tradeshow event carries, so it is never mistaken for a row. */
export function tradeshowEventId(tradeshowId: string): string {
  return `tradeshow:${tradeshowId}`;
}

/**
 * Scheduled tradeshows, as calendar events.
 *
 * The calendar has offered a "Tradeshow" filter chip since the event-type
 * vocabulary was written, but nothing ever put a tradeshow on it: shows live in
 * their own table and `saveTradeshow` writes only there. So September 2026
 * rendered an empty grid while the Tradeshows page listed IICRC Restoration
 * across the 9th to the 12th of that very month (QA, 2026-09-16).
 *
 * Derived at read time rather than copied into `calendar_events` on save. That
 * is how local recurring events already reach this list, and it keeps one
 * source of truth: renaming or re-dating a show on its own page is immediately
 * what the calendar shows, with no second row to drift, no backfill for shows
 * already in the table, and no outbound Outlook push for something nobody
 * invited anyone to.
 */
async function listTradeshowEvents(f: CalendarFilters): Promise<CalendarEvent[]> {
  // The chip filter is "show me only these types" — if tradeshows are not among
  // them there is nothing to fetch.
  if (f.types && f.types.length > 0 && f.types.length < EVENT_TYPES.length) {
    if (!f.types.includes("tradeshow")) return [];
  }

  // A show is a span of days. It belongs on any grid the span touches, so the
  // overlap test is "starts before the window ends, ends after it begins" —
  // not the `starts_at` range the stored events use, which would drop a show
  // that began last month and is still running.
  const fromDay = f.from.toISOString().slice(0, 10);
  const toDay = f.to.toISOString().slice(0, 10);

  let q = supabase
    .from("tradeshows")
    .select("id,name,city,state,starts_on,ends_on,location_id,notes")
    .is("archived_at", null)
    .not("starts_on", "is", null)
    .lte("starts_on", toDay)
    .limit(200);
  if (f.locationId) q = q.eq("location_id", f.locationId);

  const { data, error } = await q;
  // A calendar that cannot read shows is still a calendar. This is decoration
  // on top of the stored events and must never take the grid down with it.
  if (error) return [];

  const rows = (data ?? []) as {
    id: string;
    name: string | null;
    city: string | null;
    state: string | null;
    starts_on: string | null;
    ends_on: string | null;
    location_id: string | null;
    notes: string | null;
  }[];

  return rows.filter((r) => (r.ends_on ?? r.starts_on ?? "") >= fromDay).map(tradeshowToEvent);
}

/** One tradeshow row as the calendar's own shape. Pure, so it is testable. */
export function tradeshowToEvent(r: {
  id: string;
  name: string | null;
  city: string | null;
  state: string | null;
  starts_on: string | null;
  ends_on: string | null;
  location_id: string | null;
  notes: string | null;
}): CalendarEvent {
  const start = r.starts_on ?? r.ends_on!;
  // `ends_on` is the last day the show runs, and an all-day span is read as
  // half-open, so the event ends at the start of the following day. A one-day
  // show with no `ends_on` still occupies its one day.
  const lastDay = r.ends_on && r.ends_on >= start ? r.ends_on : start;
  const end = new Date(`${lastDay}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  return {
    id: tradeshowEventId(r.id),
    derived: { kind: "tradeshow", id: r.id },
    user_id: null,
    created_by: null,
    subject: r.name?.trim() || "Tradeshow",
    body_preview: null,
    notes: r.notes,
    location_text: [r.city, r.state].filter(Boolean).join(", ") || null,
    starts_at: `${start}T00:00:00.000Z`,
    ends_at: end.toISOString(),
    is_all_day: true,
    is_cancelled: false,
    event_type: "tradeshow",
    account_id: null,
    contact_id: null,
    job_id: null,
    location_id: r.location_id,
    provider: null,
    external_id: null,
    sync_direction: "none",
    sync_state: "local",
    web_link: null,
    meeting_held: null,
  };
}

/** Events attached to one record — the account/job/contact timeline feed. */
export async function listEventsForRecord(
  key: "account_id" | "job_id" | "contact_id",
  id: string,
): Promise<CalendarEvent[]> {
  const recurringEnabled = await localRecurrenceAvailable();
  let query = supabase
    .from("calendar_events")
    .select(SELECT)
    .eq(key, id)
    .order("starts_at", { ascending: false })
    .limit(100);
  if (recurringEnabled) query = query.is("recurrence", null).is("recurrence_master_id", null);
  const { data, error } = await query;
  if (error) throw error;
  const now = new Date();
  const from = new Date(now);
  from.setFullYear(from.getFullYear() - 1);
  const to = new Date(now);
  to.setFullYear(to.getFullYear() + 1);
  const recurring = recurringEnabled
    ? await listLocalRecurringEvents({ from, to }, { key, id })
    : [];
  return [...((data ?? []) as unknown as CalendarEvent[]), ...recurring]
    .sort((a, b) => Date.parse(b.starts_at!) - Date.parse(a.starts_at!))
    .slice(0, 100);
}

/**
 * Attendees for one event, fetched only when the edit dialog opens — the list
 * views never need them and the column is jsonb, so keeping it out of the
 * 1000-row range query is worth one extra round trip on edit.
 */
export async function listEventAttendees(id: string): Promise<string[]> {
  const { data, error } = await supabase
    .from("calendar_events")
    .select("attendees")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("This event is no longer accessible.");
  return attendeeEmails(data.attendees);
}

export type EventDraft = {
  id?: string;
  subject: string;
  event_type: CalendarEventType;
  starts_at: string;
  ends_at: string;
  is_all_day?: boolean;
  location_text?: string | null;
  notes?: string | null;
  account_id?: string | null;
  contact_id?: string | null;
  job_id?: string | null;
  location_id?: string | null;
  /** Email addresses. `undefined` leaves whatever is already on the row. */
  attendees?: string[];
  user_id: string;
};

const PUSH_COLUMNS =
  "id,provider,external_id,subject,body_preview,notes,location_text,starts_at,ends_at,is_all_day,is_cancelled,is_demo,attendees,organizer_email,sync_direction";

/** The row as it stands, so we can tell a real change from a re-save. */
async function currentPushRow(id: string): Promise<CalendarPushRow | null> {
  const { data, error } = await supabase
    .from("calendar_events")
    .select(PUSH_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (error || !data) return null;
  return data as unknown as CalendarPushRow;
}

/**
 * Ask the server to drain this row now instead of waiting for the scheduled
 * Graph job. Deliberately not awaited and deliberately silent: the local write
 * has already succeeded, and a Microsoft failure is the queue's problem, not
 * something to throw back at somebody who just clicked Save.
 */
function requestPush(id: string): void {
  void (async () => {
    try {
      const { pushCalendarEvent } = await import("@/lib/graph.functions");
      await pushCalendarEvent({ data: { id } });
    } catch {
      /* The scheduled drain retries it; a stuck row surfaces in admin. */
    }
  })();
}

/** Stored the same shape `ingestEvents` writes, so both writers agree. */
function attendeeRows(emails: string[]) {
  const unique = new Set(emails.map((e) => e.trim().toLowerCase()).filter((e) => e.includes("@")));
  return [...unique].map((email) => ({ email, name: null, response: null }));
}

export async function saveEvent(draft: EventDraft, createdBy: string | null) {
  const timeError = validateEventTimes(draft.starts_at, draft.ends_at);
  if (timeError) throw new Error(timeError);
  const row = {
    subject: draft.subject,
    event_type: draft.event_type,
    starts_at: draft.starts_at,
    ends_at: draft.ends_at,
    is_all_day: draft.is_all_day ?? false,
    location_text: draft.location_text ?? null,
    notes: draft.notes ?? null,
    account_id: draft.account_id ?? null,
    contact_id: draft.contact_id ?? null,
    job_id: draft.job_id ?? null,
    location_id: draft.location_id ?? null,
    user_id: draft.user_id,
    ...(draft.attendees ? { attendees: attendeeRows(draft.attendees) } : {}),
  };

  if (draft.id) {
    const before = await currentPushRow(draft.id);
    const after = { ...(before ?? {}), ...row, id: draft.id } as CalendarPushRow;
    // Re-tagging a meeting to another account is filing, not news. Only the
    // fields an attendee would notice earn a fresh invite — otherwise people
    // learn to ignore update notices and miss the one that moved the time.
    const worthPushing = isPushWorthy(before, after);

    const { error } = await supabase
      .from("calendar_events")
      .update({ ...row, ...(worthPushing ? { sync_state: "pending_push" } : {}) })
      .eq("id", draft.id);
    if (error) throw error;
    if (worthPushing) requestPush(draft.id);
    return draft.id;
  }

  const { data, error } = await supabase
    .from("calendar_events")
    .insert({
      ...row,
      created_by: createdBy,
      // Said out loud because the column defaulted to 'outlook', and the
      // calendar identity guard refuses any provider on a CRM insert — so
      // every new event failed with "Provider identities are server
      // managed". A local event has no provider until the push gives it one.
      provider: null,
      sync_direction: "outbound",
      sync_state: "pending_push",
      attendees: draft.attendees ? attendeeRows(draft.attendees) : [],
    })
    .select("id")
    .single();
  if (error) throw error;
  requestPush(data.id as string);
  return data.id as string;
}

/** Drag to reschedule — keeps the duration, moves the start. */
export async function moveEvent(ev: CalendarEvent, newStart: Date): Promise<void> {
  const started = ev.starts_at ? new Date(ev.starts_at) : newStart;
  const ended = ev.ends_at ? new Date(ev.ends_at) : null;
  const durationMs = ended ? Math.max(0, ended.getTime() - started.getTime()) : 60 * 60_000;
  if (ev.recurrence && ev.recurrence_master_id && ev.recurrence_index != null) {
    if (!ev.user_id) throw new Error("The series has no owner.");
    await saveLocalRecurringEvent(
      {
        ...ev,
        subject: ev.subject ?? "Event",
        user_id: ev.user_id,
        starts_at: newStart.toISOString(),
        ends_at: new Date(newStart.getTime() + durationMs).toISOString(),
        recurrence: ev.recurrence,
        masterId: ev.recurrence_master_id,
        occurrenceIndex: ev.recurrence_index,
      },
      ev.created_by,
    );
    return;
  }
  const { error } = await supabase
    .from("calendar_events")
    .update({
      starts_at: newStart.toISOString(),
      ends_at: new Date(newStart.getTime() + durationMs).toISOString(),
      sync_state: "pending_push",
    })
    .eq("id", ev.id);
  if (error) throw error;
  requestPush(ev.id);
}

export async function cancelEvent(id: string): Promise<void> {
  const { error } = await supabase
    .from("calendar_events")
    .update({ is_cancelled: true, sync_state: "pending_push" })
    .eq("id", id);
  if (error) throw error;
  requestPush(id);
}

/**
 * Removing an event that reached Outlook cannot be a plain DELETE — the row is
 * the only record of the external id, and dropping it strands the invite in
 * every attendee's mailbox with nothing left to cancel it. So an event with an
 * Outlook copy is cancelled and queued; only a purely local one is deleted.
 * Cancelled events are already filtered out of every view.
 */
export async function deleteEvent(id: string): Promise<void> {
  const existing = await currentPushRow(id);
  if (existing?.sync_direction === "local" && !existing.external_id) {
    const { error } = await supabase
      .from("calendar_events")
      .update({ is_cancelled: true, sync_state: "clean" })
      .eq("id", id);
    if (error) throw error;
    return;
  }
  if (existing?.external_id) {
    await cancelEvent(id);
    return;
  }
  const { error } = await supabase.from("calendar_events").delete().eq("id", id);
  if (error) throw error;
}

/* ---------- date helpers, all local-time ---------- */

export function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

export function startOfWeek(d: Date): Date {
  const x = startOfDay(d);
  x.setDate(x.getDate() - x.getDay());
  return x;
}

export function startOfMonthGrid(d: Date): Date {
  const first = new Date(d.getFullYear(), d.getMonth(), 1);
  return startOfWeek(first);
}

export function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function timeLabel(iso: string | null, allDay?: boolean | null): string {
  if (allDay) return "All day";
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

export function toLocalInput(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
