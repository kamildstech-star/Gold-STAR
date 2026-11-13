/**
 * The account/deal timeline — one chronological feed of everything that ever
 * happened on a record.
 *
 * The rule from the brief drives the whole file: everything here except a note
 * arrives automatically. Emails come from the mailbox sync, calls from the
 * dialer, meetings from calendar state, tasks from the automation engine,
 * stage moves from the pipeline. A rep who never logged anything still opens a
 * complete history — which is exactly the argument for auto-capture.
 *
 * Each entry therefore carries *how it got here*: "(Web App)",
 * "(Automation rule: no activity 30 days)", "(Computed)". Knowing what moved a
 * record matters as much as knowing it moved.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { isReassignmentHistory } from "@/lib/reassign-book";
import { isMissingSchema } from "@/lib/schema-fallback";
import { CAPTURE_SOURCE_LABEL, type AccountNote } from "@/lib/timeline";

import { DATE_LOCALE, US_DATE } from "@/lib/date-format";
export type EntryKind =
  | "note"
  | "stage"
  | "task"
  | "email"
  | "call"
  | "sms"
  | "meeting"
  | "document"
  | "gift"
  | "job"
  | "photo"
  | "invoice";

export const ENTRY_KIND_LABEL: Record<EntryKind, string> = {
  note: "Notes",
  stage: "Stage changes",
  task: "Activities & tasks",
  email: "Emails",
  call: "Calls",
  sms: "Texts",
  meeting: "Meetings",
  document: "Documents",
  gift: "Gifts",
  job: "Jobs",
  photo: "Photos",
  invoice: "Invoices",
};

/**
 * The history tabs. Each is a view over the same feed, so a rep can jump
 * straight to "what did we email them" without reading a filter chip row.
 * `kinds: null` means everything.
 */
export const HISTORY_TABS: { id: string; label: string; kinds: EntryKind[] | null }[] = [
  { id: "all", label: "All", kinds: null },
  { id: "notes", label: "Notes", kinds: ["note"] },
  { id: "activities", label: "Activities", kinds: ["task", "meeting", "gift"] },
  { id: "calls", label: "Calls", kinds: ["call", "sms"] },
  { id: "emails", label: "Emails", kinds: ["email"] },
  { id: "files", label: "Files", kinds: ["photo"] },
  { id: "documents", label: "Documents", kinds: ["document"] },
  { id: "invoices", label: "Invoices", kinds: ["invoice"] },
  { id: "changelog", label: "Changelog", kinds: ["stage", "job"] },
];

export function historyTabCounts(entries: TimelineEntry[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of HISTORY_TABS) {
    out[t.id] = t.kinds ? entries.filter((e) => t.kinds!.includes(e.kind)).length : entries.length;
  }
  return out;
}

/** Clickable cross-links. This is what makes the feed navigable, not a log. */
export type EntityChip = {
  kind: "person" | "org" | "deal" | "job";
  id: string;
  label: string;
  to?: string;
};

export type EmailMeta = {
  from: string | null;
  to: string[];
  subject: string;
  preview: string | null;
  hasAttachment: boolean;
  isPrivate: boolean;
  /**
   * Set while the email sits in the undo window (or was cancelled in it, or
   * has not gone out — "Not sent yet — …" with Resend / Cancel), so
   * the feed can show "Sending in 4:32 — Edit · Cancel". Absent otherwise.
   */
  held?: {
    id: string;
    status: string;
    created_at?: string | null;
    release_at: string | null;
    sent_by: string | null;
    to_emails: string[];
    cc_emails: string[];
    subject: string;
    body_html: string;
    attachments: unknown;
  };
};

export type CallMeta = {
  direction: "inbound" | "outbound" | null;
  durationSeconds: number | null;
  outcome: string | null;
  recordingUrl: string | null;
};

/**
 * The task behind a task row — what the row's own actions read and write.
 * Mark: "tasks need to be smarter and needs to act as a task". `dueAt` is
 * the same instant `needs_you_today` computes (`due_date` at `due_time`, or
 * five o'clock), so the "Nd overdue" here and on the pipeline strip agree.
 */
export type TaskMeta = {
  id: string;
  status: string;
  dueDate: string | null;
  dueTime: string | null;
  dueAt: string | null;
  assignee: string | null;
  assigneeName: string | null;
  createdBy: string | null;
  description: string | null;
  completedAt: string | null;
};

/** A touchpoint logged by hand (a meeting, an off-system call, a gift). */
export type TouchMeta = {
  id: string;
  createdBy: string | null;
  occurredAt: string;
  notes: string | null;
  /**
   * What the follow-up rule needs to say about this touch (20261110190000):
   * whether it was logged by hand, whether it counted, and what proof is on
   * it — see `proofState` in src/lib/touchpoint-proof.ts.
   */
  createdAt: string;
  selfReported: boolean;
  counts: boolean;
  proofKind: string | null;
  proofPath: string | null;
  meetingHeld: boolean | null;
  isAutoReply: boolean;
};

/**
 * A captured communication — the dialer's call, the mailbox's email, the
 * gateway's text. The record is the system's; what a rep may add is a note,
 * and that note lives on the touchpoint the capture wrote alongside it.
 */
export type CommMeta = {
  id: string;
  userId: string | null;
  touchpointId: string | null;
  touchCreatedBy: string | null;
  note: string | null;
  /** An out-of-office or other machine reply: recorded, never a response. */
  isAutoReply: boolean;
};

export type TimelineEntry = {
  id: string;
  kind: EntryKind;
  at: string;
  title: string;
  /** Muted second line: who, where, how long. */
  subtitle: string | null;
  body: string | null;
  /** "Web App", "Automation rule: …", "Dialer" — always shown in parentheses. */
  source: string | null;
  /** Green check on completed activities. */
  done?: boolean;
  /** True while a task is past due — drives the attention bar on the rail. */
  overdue?: boolean;
  chips: EntityChip[];
  email?: EmailMeta;
  call?: CallMeta;
  /** Notes written against an activity render underneath it, in yellow. */
  childNotes?: { id: string; body: string; author: string | null; at: string }[];
  note?: AccountNote;
  task?: TaskMeta;
  touch?: TouchMeta;
  comm?: CommMeta;
  /**
   * The stage a stage-change row landed on, so the row can point at the rail
   * and be drawn in that stage's colour (`stageTone`, by key). The key is
   * null on a rep change, which moved nobody.
   */
  stage?: { toStageId: string | null; toStageKey?: string | null };
};

export type TimelineData = {
  entries: TimelineEntry[];
  pinned: AccountNote[];
  /** Date-triggered notes that came due and were never acknowledged. */
  due: AccountNote[];
  /** The account's office — what decides whether the viewer manages its rows. */
  locationId: string | null;
};

/**
 * When a task is due, as an instant: `due_date` at `due_time`, or at five —
 * the same rule `needs_you_today` uses for its countdown.
 */
export function taskDueAt(dueDate: string | null, dueTime: string | null): string | null {
  if (!dueDate) return null;
  const time = dueTime ? dueTime.slice(0, 8) : "17:00:00";
  const d = new Date(`${dueDate}T${time.length === 5 ? `${time}:00` : time}`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/* ------------------------------------------------------------------ format */

const DAY = 86_400_000;

export function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const days = Math.floor(Math.abs(diff) / DAY);
  const ago = diff >= 0;
  const phrase = (n: number, unit: string) =>
    `${n} ${unit}${n === 1 ? "" : "s"} ${ago ? "ago" : "from now"}`;
  if (days < 1) return ago ? "today" : "today";
  if (days < 30) return phrase(days, "day");
  if (days < 365) return phrase(Math.round(days / 30), "month");
  return phrase(Math.round(days / 365), "year");
}

/** "December 3, 2025 (8 months ago)" — Pipedrive's own date treatment. */
export function longDate(iso: string): string {
  return new Date(iso).toLocaleDateString(DATE_LOCALE, US_DATE);
}

export function shortStamp(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

/* ------------------------------------------------------------------- fetch */

export type ProposalTimelineRow = {
  id: string;
  title: string;
  document_id: string | null;
  created_at: string;
  created_by: string | null;
  sent_at: string | null;
  sent_by: string | null;
  signed_at: string | null;
  declined_at: string | null;
  declined_reason: string | null;
  expired_at: string | null;
};

/**
 * The feed lines one proposal makes — one per thing that happened to it, each
 * on the day it happened, filed with the documents. Status and dates only: the
 * money rule keeps the amount on the proposal itself, not on the feed.
 */
export function proposalEntries(
  p: ProposalTimelineRow,
  people: Map<string, string>,
  orgChip: EntityChip,
): TimelineEntry[] {
  const line = (what: string, at: string, extra: Partial<TimelineEntry> = {}): TimelineEntry => ({
    id: `proposal-${what}:${p.id}`,
    kind: "document",
    at,
    title: `Proposal ${what} — ${p.title}`,
    subtitle: null,
    body: null,
    source: "Web App",
    chips: [orgChip],
    ...extra,
  });
  const out = [line("created", p.created_at, { subtitle: name(people, p.created_by) })];
  if (p.sent_at) {
    out.push(
      line("sent", p.sent_at, {
        subtitle: name(people, p.sent_by),
        body: p.document_id ? "Sent for e-signature" : null,
      }),
    );
  }
  if (p.signed_at) {
    out.push(
      line("signed", p.signed_at, {
        source: p.document_id ? "E-signature" : "Web App",
        done: true,
      }),
    );
  }
  if (p.declined_at) out.push(line("declined", p.declined_at, { body: p.declined_reason }));
  if (p.expired_at) out.push(line("expired", p.expired_at));
  return out;
}

function name(map: Map<string, string>, id: unknown): string | null {
  return typeof id === "string" ? (map.get(id) ?? null) : null;
}

/**
 * One read for the whole feed. Anything the viewer may not see is filtered out
 * by RLS on the way through — the timeline never widens access.
 */
export async function fetchAccountTimeline(
  accountId: string,
  /**
   * Defaults to the browser client. The timeline read passes the caller's
   * server-side authenticated client instead, so a server function gets
   * exactly the feed that user would have seen in the card — never wider.
   */
  db: SupabaseClient<Database> = supabase,
): Promise<TimelineData> {
  const [
    accountRes,
    notesRes,
    touchRes,
    commsRes,
    stageRes,
    tasksRes,
    emailRes,
    docsRes,
    giftRes,
    jobsRes,
    projectsRes,
    contactsRes,
    peopleRes,
    stagesRes,
    invoicesRes,
    proposalsRes,
  ] = await Promise.all([
    db.from("accounts").select("id,name,location_id").eq("id", accountId).maybeSingle(),
    db
      .from("account_notes")
      .select("*")
      .eq("account_id", accountId)
      .order("created_at", { ascending: false }),
    db
      .from("touchpoints")
      .select("*")
      .eq("account_id", accountId)
      .order("occurred_at", { ascending: false })
      .limit(400),
    db
      .from("captured_communications")
      .select("*")
      .eq("account_id", accountId)
      .order("occurred_at", { ascending: false })
      .limit(400),
    db
      .from("account_stage_history")
      .select("id,from_stage,to_stage,from_stage_id,to_stage_id,reason,changed_by,changed_at")
      .eq("account_id", accountId)
      .order("changed_at", { ascending: false })
      .limit(300),
    db
      .from("tasks")
      // "*" rather than a list: completion_note (11 Nov) arrives by migration,
      // and naming a column the database does not have yet would fail the
      // whole timeline instead of just leaving the note out.
      .select("*")
      .eq("account_id", accountId)
      .order("created_at", { ascending: false })
      .limit(300),
    readAccountEmails(db, accountId),
    db
      .from("documents")
      .select("id,name,doc_type,status,sent_at,signed_at,created_at,created_by,job_id,contact_id")
      .eq("account_id", accountId)
      .order("created_at", { ascending: false })
      .limit(200),
    db
      .from("gift_sends")
      .select("id,sent_at,delivery_status,notes,contact_id,created_by,created_at")
      .eq("account_id", accountId)
      .limit(200),
    db
      .from("jobs")
      .select("id,job_number,address,loss_type,status,created_at")
      .eq("account_id", accountId)
      .order("created_at", { ascending: false })
      .limit(200),
    db.from("projects").select("id,name").eq("account_id", accountId).limit(100),
    db.from("contacts").select("id,full_name").eq("account_id", accountId),
    db.from("profiles").select("user_id,full_name"),
    db.from("pipeline_stages").select("id,name"),
    // No amounts: the money rule keeps figures off a rep's screen until
    // commission is issued, so the feed carries status and dates only.
    db
      .from("invoices")
      .select("id,invoice_number,status,issue_date,due_date,sent_at,created_at,job_id")
      .eq("account_id", accountId)
      .order("created_at", { ascending: false })
      .limit(200),
    // Proposals (migration 20261012200000). Read untyped until types.ts is
    // regenerated; before the migration is applied the read errors and the
    // feed simply has none. Like invoices, no amounts — status and dates only.
    (db as unknown as SupabaseClient)
      .from("account_proposals")
      .select(
        "id,title,status,document_id,created_at,created_by,sent_at,sent_by,signed_at,declined_at,declined_reason,expired_at",
      )
      .eq("account_id", accountId)
      .order("created_at", { ascending: false })
      .limit(200),
  ]);

  const accountName = accountRes.data?.name ?? "This account";
  const people = new Map<string, string>(
    (peopleRes.data ?? []).map((p) => [p.user_id as string, (p.full_name as string) ?? "Someone"]),
  );
  const contacts = new Map<string, string>(
    (contactsRes.data ?? []).map((c) => [c.id as string, (c.full_name as string) ?? "Contact"]),
  );
  const stageNames = new Map<string, string>(
    (stagesRes.data ?? []).map((s) => [s.id as string, s.name as string]),
  );
  const jobNumbers = new Map<string, string>(
    (jobsRes.data ?? []).map((j) => [j.id as string, (j.job_number as string) ?? "Job"]),
  );

  const orgChip: EntityChip = {
    kind: "org",
    id: accountId,
    label: accountName,
    to: `/accounts/${accountId}`,
  };
  const personChip = (id: unknown): EntityChip[] =>
    typeof id === "string" && contacts.has(id)
      ? [{ kind: "person", id, label: contacts.get(id)!, to: `/contacts?focus=${id}` }]
      : [];
  const jobChip = (id: unknown): EntityChip[] =>
    typeof id === "string" && jobNumbers.has(id)
      ? [{ kind: "job", id, label: jobNumbers.get(id)!, to: `/jobs/${id}` }]
      : [];

  const notes = (notesRes.data ?? []) as AccountNote[];
  const entries: TimelineEntry[] = [];

  /* ---- notes: the most visually distinct thing in the feed ---- */
  for (const n of notes) {
    if (n.is_pinned) continue;
    entries.push({
      id: `note:${n.id}`,
      kind: "note",
      at: n.created_at,
      title: "Note",
      subtitle: name(people, n.created_by),
      body: n.body,
      source: n.trigger_type === "none" ? null : "Triggered note",
      chips: [orgChip, ...personChip(n.contact_id)],
      note: n,
    });
  }

  /* ---- stage changes: one compact line, with what moved it ---- */
  for (const s of stageRes.data ?? []) {
    const from = s.from_stage_id ? (stageNames.get(s.from_stage_id) ?? s.from_stage) : null;
    const to = s.to_stage_id ? (stageNames.get(s.to_stage_id) ?? s.to_stage) : s.to_stage;
    const reason = (s.reason as string | null) ?? null;
    const automation = reason?.startsWith("Automation rule:") ? reason : null;
    // A rep change is written to the same history by the Reassign page; the
    // stage did not move, so the line says what did.
    const reassigned = isReassignmentHistory(reason);
    entries.push({
      id: `stage:${s.id}`,
      kind: "stage",
      at: s.changed_at,
      title: reassigned ? "Rep changed" : from ? `Stage: ${from} → ${to}` : `Stage set to ${to}`,
      subtitle: name(people, s.changed_by),
      body: automation ? null : reason,
      source: automation ?? (s.changed_by ? "Web App" : "Computed"),
      chips: [orgChip],
      stage: {
        toStageId: (s.to_stage_id as string | null) ?? null,
        // `to_stage` is the stage KEY as stored on the account (the
        // misspelled "goasted" included), which is what the colour map keys on.
        toStageKey: reassigned ? null : ((s.to_stage as string | null) ?? null),
      },
    });
  }

  // The touchpoint a capture wrote alongside itself, by id: it carries the
  // rep's note on a call or email the system logged.
  const touchById = new Map((touchRes.data ?? []).map((t) => [t.id as string, t]));

  /* ---- captured comms: calls, emails and texts, straight off the wire ---- */
  for (const c of commsRes.data ?? []) {
    const channel = c.channel as string;
    const kind: EntryKind = channel === "call" ? "call" : channel === "email" ? "email" : "sms";
    const isIn = c.direction === "inbound";
    const linkedTouch = c.touchpoint_id ? touchById.get(c.touchpoint_id as string) : undefined;
    entries.push({
      id: `comm:${c.id}`,
      kind,
      at: c.occurred_at as string,
      title:
        kind === "call"
          ? `${isIn ? "Inbound" : "Outbound"} call`
          : kind === "email"
            ? ((c.subject as string) ?? "Email")
            : `${isIn ? "Inbound" : "Outbound"} text`,
      subtitle: name(people, c.user_id),
      body: kind === "call" ? null : ((c.body_preview as string) ?? null),
      source: kind === "call" ? "Dialer" : kind === "email" ? "Mailbox sync" : "SMS gateway",
      chips: [orgChip, ...personChip(c.contact_id)],
      comm: {
        id: c.id as string,
        userId: (c.user_id as string | null) ?? null,
        touchpointId: (c.touchpoint_id as string | null) ?? null,
        touchCreatedBy: (linkedTouch?.created_by as string | null) ?? null,
        note: (linkedTouch?.notes as string | null) ?? null,
        isAutoReply: c.is_auto_reply === true || linkedTouch?.is_auto_reply === true,
      },
      childNotes: linkedTouch?.notes
        ? [
            {
              id: linkedTouch.id as string,
              body: linkedTouch.notes as string,
              author: name(people, linkedTouch.created_by),
              at: linkedTouch.occurred_at as string,
            },
          ]
        : undefined,
      ...(kind === "call"
        ? {
            call: {
              direction: (c.direction as CallMeta["direction"]) ?? null,
              durationSeconds: (c.duration_seconds as number) ?? null,
              outcome: (c.outcome as string) ?? null,
              recordingUrl: (c.recording_url as string) ?? null,
            },
          }
        : {}),
      ...(kind === "email"
        ? {
            email: {
              from: (c.from_address as string) ?? null,
              to: [c.to_address as string].filter(Boolean) as string[],
              subject: (c.subject as string) ?? "Email",
              preview: (c.body_preview as string) ?? null,
              hasAttachment: false,
              isPrivate: false,
            },
          }
        : {}),
    });
  }

  /* ---- touchpoints that no captured comm covers (meetings, gifts, off-system) ---- */
  const commTouchIds = new Set(
    (commsRes.data ?? []).map((c) => c.touchpoint_id).filter(Boolean) as string[],
  );
  for (const t of touchRes.data ?? []) {
    if (commTouchIds.has(t.id as string)) continue;
    const type = t.type as string;
    const kind: EntryKind = type.startsWith("meeting")
      ? "meeting"
      : type === "gift" || type === "seasonal_send"
        ? "gift"
        : type === "call"
          ? "call"
          : type === "email"
            ? "email"
            : // The enum value is `text`; "sms" is the capture source, not a type.
              type === "text"
              ? "sms"
              : "note";
    const captureSource = t.capture_source as keyof typeof CAPTURE_SOURCE_LABEL | null;
    entries.push({
      id: `touch:${t.id}`,
      kind,
      at: t.occurred_at as string,
      title:
        kind === "meeting"
          ? type === "meeting_in_person"
            ? "In-person meeting"
            : "Virtual meeting"
          : kind === "gift"
            ? "Gift sent"
            : kind === "call"
              ? "Call"
              : kind === "email"
                ? "Email"
                : kind === "sms"
                  ? "Text message"
                  : "Contact",
      subtitle: name(people, t.created_by),
      body: (t.notes as string) ?? null,
      source: captureSource ? CAPTURE_SOURCE_LABEL[captureSource] : "Web App",
      done: kind === "meeting" ? Boolean(t.meeting_held ?? true) : undefined,
      chips: [orgChip, ...personChip(t.contact_id)],
      touch: {
        id: t.id as string,
        createdBy: (t.created_by as string | null) ?? null,
        occurredAt: t.occurred_at as string,
        notes: (t.notes as string | null) ?? null,
        createdAt: (t.created_at as string) ?? (t.occurred_at as string),
        selfReported: t.is_self_reported === true,
        counts: t.counts_toward_cadence === true,
        proofKind: (t.proof_kind as string | null) ?? null,
        proofPath: (t.proof_path as string | null) ?? null,
        meetingHeld: (t.meeting_held as boolean | null) ?? null,
        isAutoReply: t.is_auto_reply === true,
      },
      ...(kind === "call"
        ? {
            call: {
              direction: (t.direction as CallMeta["direction"]) ?? null,
              durationSeconds: (t.duration_seconds as number) ?? null,
              outcome: null,
              recordingUrl: null,
            },
          }
        : {}),
    });
  }

  /* ---- activities and tasks ---- */
  const today = new Date().toISOString().slice(0, 10);
  for (const t of tasksRes.data ?? []) {
    const done = t.status === "done";
    const due = t.due_date as string | null;
    const assigneeName = name(people, t.assignee);
    entries.push({
      id: `task:${t.id}`,
      kind: "task",
      at: (t.completed_at as string) ?? (t.created_at as string),
      title: t.title as string,
      subtitle: [assigneeName ?? "Unassigned", due ? `due ${longDate(`${due}T12:00:00`)}` : null]
        .filter(Boolean)
        .join(" · "),
      body:
        [
          (t.description as string | null) ?? null,
          done && (t as { completion_note?: string | null }).completion_note
            ? `How it was completed: ${(t as { completion_note?: string | null }).completion_note}`
            : null,
        ]
          .filter(Boolean)
          .join("\n\n") || null,
      source: t.automation_reason
        ? `Automation rule: ${t.automation_reason}`
        : t.source === "automation"
          ? "Automation rule"
          : "Web App",
      done,
      overdue: !done && !!due && due < today,
      chips: [orgChip, ...personChip(t.contact_id), ...jobChip(t.job_id)],
      task: {
        id: t.id as string,
        status: t.status as string,
        dueDate: due,
        dueTime: (t.due_time as string | null) ?? null,
        dueAt: taskDueAt(due, (t.due_time as string | null) ?? null),
        assignee: (t.assignee as string | null) ?? null,
        assigneeName,
        createdBy: (t.created_by as string | null) ?? null,
        description: (t.description as string | null) ?? null,
        completedAt: (t.completed_at as string | null) ?? null,
      },
    });
  }

  /* ---- emails sent from the app ---- */
  for (const e of emailRes.data ?? []) {
    const at = (e.sent_at ?? e.queued_at ?? e.created_at) as string;
    const to = ((e.to_emails as string[]) ?? []).concat((e.cc_emails as string[]) ?? []);
    const preview = ((e.body_html as string) ?? "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    entries.push({
      id: `email:${e.id}`,
      kind: "email",
      at,
      title: (e.subject as string) ?? "Email",
      subtitle: name(people, e.sent_by),
      body: null,
      source: "Mailbox sync",
      chips: [orgChip, ...personChip(e.contact_id), ...jobChip(e.job_id)],
      email: {
        from: name(people, e.sent_by),
        to,
        subject: (e.subject as string) ?? "Email",
        preview: preview || null,
        hasAttachment: Boolean(e.attachment_url) || parseAttachmentCount(e.attachments) > 0,
        isPrivate: false,
        // Not-yet-sent states ride along too: a 'queued' or 'failed' email
        // must say "Not sent yet", not sit in the feed looking delivered.
        ...(e.status === "held" ||
        e.status === "cancelled" ||
        ((e.status === "queued" || e.status === "failed") && !e.sent_at)
          ? {
              held: {
                id: e.id as string,
                status: e.status as string,
                created_at: (e.created_at as string | null) ?? null,
                release_at: (e.release_at as string | null) ?? null,
                sent_by: (e.sent_by as string | null) ?? null,
                to_emails: (e.to_emails as string[]) ?? [],
                cc_emails: (e.cc_emails as string[]) ?? [],
                subject: (e.subject as string) ?? "",
                body_html: (e.body_html as string) ?? "",
                attachments: e.attachments ?? [],
              },
            }
          : {}),
      },
    });
  }

  /* ---- proposals: written, sent, signed, declined, expired ---- */
  const proposals = (proposalsRes.data ?? []) as ProposalTimelineRow[];
  // A proposal's signing document would otherwise say "sent" and "signed" a
  // second time, one line under the proposal saying the same thing.
  const proposalDocs = new Set(proposals.map((p) => p.document_id).filter(Boolean));
  for (const p of proposals) entries.push(...proposalEntries(p, people, orgChip));

  /* ---- documents sent and signed ---- */
  for (const d of docsRes.data ?? []) {
    if (proposalDocs.has(d.id as string)) continue;
    if (d.sent_at) {
      entries.push({
        id: `doc-sent:${d.id}`,
        kind: "document",
        at: d.sent_at as string,
        title: `Document sent — ${d.name as string}`,
        subtitle: name(people, d.created_by),
        body: null,
        source: "Web App",
        chips: [orgChip, ...personChip(d.contact_id), ...jobChip(d.job_id)],
      });
    }
    if (d.signed_at) {
      entries.push({
        id: `doc-signed:${d.id}`,
        kind: "document",
        at: d.signed_at as string,
        title: `Document signed — ${d.name as string}`,
        subtitle: null,
        body: null,
        source: "E-signature",
        done: true,
        chips: [orgChip, ...personChip(d.contact_id), ...jobChip(d.job_id)],
      });
    }
  }

  /* ---- gift sends ---- */
  for (const g of giftRes.data ?? []) {
    entries.push({
      id: `gift:${g.id}`,
      kind: "gift",
      at: (g.sent_at ?? g.created_at) as string,
      title: "Gift sent",
      subtitle: [name(people, g.created_by), g.delivery_status as string]
        .filter(Boolean)
        .join(" · "),
      body: (g.notes as string) ?? null,
      source: "Gift engine",
      chips: [orgChip, ...personChip(g.contact_id)],
    });
  }

  /* ---- jobs created off this relationship ---- */
  for (const j of jobsRes.data ?? []) {
    entries.push({
      id: `job:${j.id}`,
      kind: "job",
      at: j.created_at as string,
      title: `Job created — ${j.job_number as string}`,
      subtitle: [j.address as string, j.loss_type as string].filter(Boolean).join(" · "),
      body: null,
      source: "Web App",
      chips: [
        orgChip,
        { kind: "job", id: j.id as string, label: j.job_number as string, to: `/jobs/${j.id}` },
      ],
    });
  }

  /* ---- invoices: status and dates only, never an amount ---- */
  for (const inv of invoicesRes.data ?? []) {
    const at = (inv.sent_at ?? inv.created_at) as string;
    const due = inv.due_date as string | null;
    entries.push({
      id: `invoice:${inv.id}`,
      kind: "invoice",
      at,
      title: `Invoice ${inv.invoice_number as string}`,
      subtitle: [(inv.status as string) ?? null, due ? `due ${longDate(`${due}T12:00:00`)}` : null]
        .filter(Boolean)
        .join(" · "),
      body: null,
      source: "Billing",
      done: inv.status === "paid",
      chips: [orgChip, ...jobChip(inv.job_id)],
    });
  }

  /* ---- photos, grouped per project per day ---- */
  const projectIds = (projectsRes.data ?? []).map((p) => p.id as string);
  if (projectIds.length > 0) {
    const { data: photos } = await db
      .from("photos")
      .select("id,project_id,captured_at,created_at")
      .in("project_id", projectIds)
      .is("deleted_at", null)
      .limit(1000);
    const projectName = new Map(
      (projectsRes.data ?? []).map((p) => [p.id as string, p.name as string]),
    );
    const groups = new Map<string, { at: string; count: number; project: string; id: string }>();
    for (const p of photos ?? []) {
      const at = (p.captured_at ?? p.created_at) as string;
      const key = `${p.project_id}:${dayKey(at)}`;
      const g = groups.get(key);
      if (g) {
        g.count += 1;
        if (at > g.at) g.at = at;
      } else {
        groups.set(key, {
          at,
          count: 1,
          project: projectName.get(p.project_id as string) ?? "Project",
          id: p.project_id as string,
        });
      }
    }
    for (const [key, g] of groups) {
      entries.push({
        id: `photo:${key}`,
        kind: "photo",
        at: g.at,
        title: `${g.count} photo${g.count === 1 ? "" : "s"} uploaded`,
        subtitle: g.project,
        body: null,
        source: "Field capture",
        chips: [orgChip, { kind: "deal", id: g.id, label: g.project, to: `/projects/${g.id}` }],
      });
    }
  }

  entries.sort((a, b) => (a.at < b.at ? 1 : -1));

  const dueToday = new Date().toISOString().slice(0, 10);
  return {
    entries,
    locationId: (accountRes.data?.location_id as string | null) ?? null,
    pinned: notes.filter((n) => n.is_pinned),
    due: notes.filter(
      (n) =>
        n.trigger_type === "on_date" &&
        n.trigger_on != null &&
        n.trigger_on <= dueToday &&
        !n.acknowledged_at,
    ),
  };
}

/** Filter + search + jump-to-date, applied in one pass. */
export function filterEntries(
  entries: TimelineEntry[],
  opts: { kinds: EntryKind[]; q: string; onOrBefore: string | null },
): TimelineEntry[] {
  const q = opts.q.trim().toLowerCase();
  return entries.filter((e) => {
    if (opts.kinds.length > 0 && !opts.kinds.includes(e.kind)) return false;
    if (opts.onOrBefore && dayKey(e.at) > opts.onOrBefore) return false;
    if (!q) return true;
    return [e.title, e.subtitle, e.body, e.source, e.email?.preview, ...e.chips.map((c) => c.label)]
      .filter(Boolean)
      .some((v) => (v as string).toLowerCase().includes(q));
  });
}

const EMAIL_COLUMNS =
  "id,subject,body_html,to_emails,cc_emails,status,sent_at,queued_at,created_at,sent_by,contact_id,job_id,attachment_url";

type AccountEmailRow = Record<string, unknown> & {
  release_at?: string | null;
  attachments?: unknown;
};

/**
 * The account's email, with the undo-window columns when the database has
 * them (20260928122000). Before that, the same read without them — one
 * unshipped column must not blank the whole timeline.
 */
async function readAccountEmails(db: SupabaseClient<Database>, accountId: string) {
  const read = (cols: string) =>
    db
      .from("email_messages")
      .select(cols)
      .eq("account_id", accountId)
      .order("created_at", { ascending: false })
      .limit(200);
  const withHold = await read(`${EMAIL_COLUMNS},release_at,attachments`);
  if (withHold.error && isMissingSchema(withHold.error)) {
    const plain = await read(EMAIL_COLUMNS);
    return { ...plain, data: (plain.data ?? null) as AccountEmailRow[] | null };
  }
  return { ...withHold, data: (withHold.data ?? null) as AccountEmailRow[] | null };
}

function parseAttachmentCount(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}
