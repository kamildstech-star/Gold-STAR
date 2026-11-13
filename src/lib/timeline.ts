/**
 * Deal timeline + auto-capture client library.
 *
 * Two rules from the brief drive this file:
 *
 * 1. Activity is captured, not typed. Every timeline entry carries how it was
 *    captured — dialer, mailbox, calendar, SMS, voice note — and anything a
 *    person typed themselves is labelled self-reported.
 * 2. A cold email or text with no response is not a touchpoint. The database
 *    decides `counts_toward_cadence`; this file only reads it and explains it.
 */
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";

export type Touchpoint = Database["public"]["Tables"]["touchpoints"]["Row"];
export type AccountNote = Database["public"]["Tables"]["account_notes"]["Row"];
export type CapturedComm = Database["public"]["Tables"]["captured_communications"]["Row"];
export type NoteTrigger = Database["public"]["Enums"]["note_trigger"];
export type CaptureSource = Database["public"]["Enums"]["capture_source"];

export const CAPTURE_SOURCE_LABEL: Record<CaptureSource, string> = {
  dialer: "Dialer",
  mailbox: "Mailbox",
  calendar: "Calendar",
  sms: "SMS",
  voice_note: "Voice note",
  manual: "Self-reported",
  gift_engine: "Gift engine",
};

export const NOTE_TRIGGERS: string[] = [
  "none",
  "next_call",
  "next_meeting",
  "next_stage_change",
  "on_date",
];

export const NOTE_TRIGGER_LABEL: Record<string, string> = {
  none: "No trigger — plain note",
  next_call: "Surface on the next call",
  next_meeting: "Surface at the next meeting",
  next_stage_change: "Surface at the next stage change",
  on_date: "Surface on a specific date",
};

export async function listAccountNotes(accountId: string): Promise<AccountNote[]> {
  const { data, error } = await supabase
    .from("account_notes")
    .select("*")
    .eq("account_id", accountId)
    .order("is_pinned", { ascending: false })
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function listCapturedComms(accountId: string): Promise<CapturedComm[]> {
  const { data, error } = await supabase
    .from("captured_communications")
    .select("*")
    .eq("account_id", accountId)
    .order("occurred_at", { ascending: false })
    .limit(200);
  if (error) throw error;
  return data ?? [];
}

/**
 * Pull the notes waiting on a trigger and mark them fired. Called at the
 * moment the note is useful — when the call connects, when the meeting is
 * logged, when the stage moves — not from a background sweep.
 */
export async function fireNoteTriggers(
  accountId: string,
  trigger: Exclude<NoteTrigger, "none">,
): Promise<AccountNote[]> {
  const { data, error } = await supabase
    .from("account_notes")
    .select("*")
    .eq("account_id", accountId)
    .eq("trigger_type", trigger)
    .is("fired_at", null);
  if (error) throw error;
  const notes = data ?? [];
  if (notes.length > 0) {
    await supabase
      .from("account_notes")
      .update({ fired_at: new Date().toISOString() })
      .in(
        "id",
        notes.map((n) => n.id),
      );
  }
  return notes;
}

/** Date-triggered notes that are due and not yet acknowledged. */
export function dueDateNotes(notes: AccountNote[]): AccountNote[] {
  const today = new Date().toISOString().slice(0, 10);
  return notes.filter(
    (n) =>
      n.trigger_type === "on_date" && n.trigger_on && n.trigger_on <= today && !n.acknowledged_at,
  );
}

export async function acknowledgeNote(id: string, userId: string | null): Promise<void> {
  await supabase
    .from("account_notes")
    .update({ acknowledged_at: new Date().toISOString(), acknowledged_by: userId })
    .eq("id", id);
}

export type CadenceSummary = {
  /** Touches that actually satisfy cadence. */
  counted: number;
  /** Outbound attempts that landed nowhere. */
  attemptsNoReply: number;
  lastCounted: string | null;
  lastAttempt: string | null;
  lastInPerson: string | null;
  /** Plain-English line for the account header. */
  headline: string;
};

export function summariseCadence(touchpoints: Touchpoint[]): CadenceSummary {
  const counted = touchpoints.filter((t) => t.counts_toward_cadence);
  const noReply = touchpoints.filter((t) => !t.counts_toward_cadence);
  const lastInPerson =
    touchpoints.find((t) => t.type === "meeting_in_person" && t.counts_toward_cadence)
      ?.occurred_at ?? null;

  const headline =
    counted.length === 0 && noReply.length > 0
      ? `${noReply.length} attempt${noReply.length === 1 ? "" : "s"}, no reply — cadence not met`
      : counted.length === 0
        ? "No contact yet"
        : noReply.length > 0
          ? `${counted.length} that landed · ${noReply.length} attempt${noReply.length === 1 ? "" : "s"} with no reply`
          : `${counted.length} touch${counted.length === 1 ? "" : "es"} that landed`;

  return {
    counted: counted.length,
    attemptsNoReply: noReply.length,
    lastCounted: counted[0]?.occurred_at ?? null,
    lastAttempt: touchpoints[0]?.occurred_at ?? null,
    lastInPerson,
    headline,
  };
}

/** Why a specific entry did or did not count. Shown inline, never hidden. */
export function cadenceReason(t: Touchpoint): string {
  // What counts as a follow-up (20261110190000): proof on a hand-logged
  // touch, never an auto-reply, calls from two minutes.
  if (t.is_auto_reply) return "Automatic reply — not a response, does not count";
  if (t.counts_toward_cadence && t.is_self_reported && t.proof_kind !== "form") {
    return "Counts — logged by hand with proof, unverified";
  }
  if (!t.counts_toward_cadence && t.is_self_reported && !t.proof_kind && t.meeting_held !== false) {
    return "Attempt — logged by hand with nothing attached, does not count";
  }
  if (t.counts_toward_cadence) {
    if (t.direction === "inbound") return "Counts — they came to us";
    if (t.type === "call") return "Counts — connected call";
    if (t.type.startsWith("meeting")) return "Counts — meeting held";
    return "Counts — reply received";
  }
  if (t.type === "call") return "Unanswered or under two minutes — does not count toward cadence";
  if (t.type.startsWith("meeting")) return "Meeting not held — does not count";
  return "Sent, no reply — does not count toward cadence";
}

export type TimelineEntry = {
  id: string;
  kind: "touchpoint" | "note" | "comm";
  at: string;
  title: string;
  body: string | null;
  source: CaptureSource | null;
  counts: boolean | null;
  reason: string | null;
  durationSeconds: number | null;
  recordingUrl: string | null;
};

const TOUCH_TITLE: Record<string, string> = {
  call: "Call",
  email: "Email",
  sms: "Text message",
  meeting_in_person: "In-person meeting",
  meeting_virtual: "Virtual meeting",
  gift: "Gift",
  seasonal_send: "Seasonal send",
  other: "Contact",
};

export function buildTimeline(
  touchpoints: Touchpoint[],
  notes: AccountNote[],
  comms: CapturedComm[],
): TimelineEntry[] {
  const linkedTouchIds = new Set(comms.map((c) => c.touchpoint_id).filter(Boolean) as string[]);

  const entries: TimelineEntry[] = [
    ...touchpoints.map<TimelineEntry>((t) => ({
      id: `t:${t.id}`,
      kind: "touchpoint",
      at: t.occurred_at,
      title: TOUCH_TITLE[t.type] ?? t.type,
      body: t.notes,
      source: t.capture_source,
      counts: t.counts_toward_cadence,
      reason: cadenceReason(t),
      durationSeconds: t.duration_seconds,
      recordingUrl: null,
    })),
    // Captured comms that never became a touchpoint still belong on the timeline.
    ...comms
      .filter((c) => !c.touchpoint_id || !linkedTouchIds.has(c.touchpoint_id))
      .map<TimelineEntry>((c) => ({
        id: `c:${c.id}`,
        kind: "comm",
        at: c.occurred_at,
        title:
          c.channel === "call"
            ? `${c.direction === "inbound" ? "Inbound" : "Outbound"} call`
            : c.channel === "email"
              ? (c.subject ?? "Email")
              : "Text message",
        body: c.body_preview,
        source: c.channel === "call" ? "dialer" : c.channel === "email" ? "mailbox" : "sms",
        counts: null,
        reason: null,
        durationSeconds: c.duration_seconds,
        recordingUrl: c.recording_url,
      })),
    ...notes
      .filter((n) => !n.is_pinned)
      .map<TimelineEntry>((n) => ({
        id: `n:${n.id}`,
        kind: "note",
        at: n.created_at,
        title:
          n.trigger_type === "none"
            ? "Note"
            : `Note · ${(NOTE_TRIGGER_LABEL[n.trigger_type] ?? n.trigger_type).replace("Surface ", "")}`,
        body: n.body,
        source: null,
        counts: null,
        reason: null,
        durationSeconds: null,
        recordingUrl: null,
      })),
  ];

  return entries.sort((a, b) => (a.at < b.at ? 1 : -1));
}

export function fmtDuration(seconds: number | null | undefined): string | null {
  if (seconds == null) return null;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}
