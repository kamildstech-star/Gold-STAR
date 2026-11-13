import { supabase } from "@/integrations/supabase/client";
import {
  expandRecurringEvent,
  validateRecurrence,
  type RecurrenceRule,
} from "@/lib/calendar-recurrence";
import type { CalendarEvent, CalendarFilters, EventDraft } from "@/lib/calendar";
import { validateEventTimes } from "@/lib/calendar-validation";

export const RECURRENCE_COLUMNS = "recurrence,recurrence_master_id,recurrence_index";
const COLUMNS =
  "id,user_id,created_by,subject,body_preview,notes,location_text,starts_at,ends_at,is_all_day,is_cancelled,event_type,account_id,contact_id,job_id,location_id,provider,external_id,sync_direction,sync_state,web_link,meeting_held," +
  RECURRENCE_COLUMNS;

let capability: { expires: number; value: Promise<boolean> } | undefined;
export function localRecurrenceAvailable(): Promise<boolean> {
  if (capability && capability.expires > Date.now()) return capability.value;
  const value = (async () => {
    const { data, error } = await supabase.rpc("calendar_local_recurrence_available" as never);
    return !error && data === true;
  })().catch(() => false);
  capability = { expires: Date.now() + 60_000, value };
  return value;
}

export async function listLocalRecurringEvents(
  f: CalendarFilters,
  record?: { key: "account_id" | "job_id" | "contact_id"; id: string },
): Promise<CalendarEvent[]> {
  // Masters outside the visible range still matter: an exception may have
  // moved an occurrence into this window. Never filter masters by starts_at.
  let query = supabase
    .from("calendar_events")
    .select(COLUMNS)
    .not("recurrence", "is", null)
    .eq("is_cancelled", false)
    .limit(1001);
  if (f.userIds?.length) query = query.in("user_id", f.userIds);
  if (f.locationId) query = query.eq("location_id", f.locationId);
  if (f.types?.length) query = query.in("event_type", f.types);
  if (record) query = query.eq(record.key, record.id);
  const { data, error } = await query;
  if (error) throw error;
  const masters = (data ?? []) as unknown as CalendarEvent[];
  if (masters.length > 1000)
    throw new Error("Too many recurring series. Narrow the person or office filter.");
  const exceptions: CalendarEvent[] = [];
  for (let batch = 0; batch < masters.length; batch += 100) {
    const ids = masters.slice(batch, batch + 100).map((m) => m.id);
    for (let offset = 0; ; offset += 1000) {
      const { data: rows, error: readError } = await supabase
        .from("calendar_events")
        .select(COLUMNS)
        .in("recurrence_master_id", ids)
        .order("id")
        .range(offset, offset + 999);
      if (readError) throw readError;
      const page = (rows ?? []) as unknown as CalendarEvent[];
      exceptions.push(...page);
      if (page.length < 1000) break;
    }
  }
  const result: CalendarEvent[] = [];
  for (const master of masters)
    result.push(...expandRecurringEvent(master, exceptions, f.from, f.to));
  return result;
}

export type LocalRecurringDraft = EventDraft & {
  recurrence: RecurrenceRule;
  masterId?: string;
  occurrenceIndex?: number;
  isCancelled?: boolean;
};

export async function saveLocalRecurringEvent(
  draft: LocalRecurringDraft,
  createdBy: string | null,
): Promise<string> {
  const timeError = validateEventTimes(draft.starts_at, draft.ends_at);
  if (timeError) throw new Error(timeError);
  const occurrence = draft.occurrenceIndex != null;
  if (!occurrence) {
    const ruleError = validateRecurrence(draft.recurrence, draft.starts_at);
    if (ruleError) throw new Error(ruleError);
  }
  if (draft.attendees?.length)
    throw new Error("Recurring events stay in Goldstar and cannot include Outlook attendees.");
  if (occurrence && !draft.masterId) throw new Error("Choose a recurring series.");
  const row = {
    subject: draft.subject,
    event_type: draft.event_type,
    starts_at: draft.starts_at,
    ends_at: draft.ends_at,
    is_all_day: draft.is_all_day ?? false,
    is_cancelled: draft.isCancelled ?? false,
    location_text: draft.location_text ?? null,
    notes: draft.notes ?? null,
    account_id: draft.account_id ?? null,
    contact_id: draft.contact_id ?? null,
    job_id: draft.job_id ?? null,
    location_id: draft.location_id ?? null,
    user_id: draft.user_id,
    provider: null,
    external_id: null,
    attendees: [],
    sync_direction: "local",
    sync_state: "clean",
    recurrence: occurrence ? null : draft.recurrence,
    recurrence_master_id: occurrence ? draft.masterId : null,
    recurrence_index: occurrence ? draft.occurrenceIndex : null,
  };
  if (occurrence) {
    const { data, error } = await supabase
      .from("calendar_events")
      .upsert({ ...row, created_by: createdBy } as never, {
        onConflict: "recurrence_master_id,recurrence_index",
      })
      .select("id")
      .single();
    if (error) throw error;
    return data.id;
  }
  const id = draft.masterId ?? draft.id;
  const query = id
    ? supabase
        .from("calendar_events")
        .update(row as never)
        .eq("id", id)
        .is("provider", null)
        .eq("sync_direction", "local")
    : supabase.from("calendar_events").insert({ ...row, created_by: createdBy } as never);
  const { data, error } = await query.select("id").single();
  if (error) throw error;
  return data.id;
}
