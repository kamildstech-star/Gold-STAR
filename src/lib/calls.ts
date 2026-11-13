// Calls. Everything the app knows about a phone call lives in
// captured_communications (channel = 'call') — whether it came from CallRail,
// the in-app dialer, or a rep logging a conversation that genuinely happened
// off-system. Each call that connects also writes a touchpoint, so cadence and
// the account timeline stay honest without anyone typing twice.
//
// There is no dialer provider wired up yet. Rather than a dead "Call" button,
// the UI says so and still captures the call: the rep dials on their handset,
// the screen captures notes, duration and outcome live.

import { supabase } from "@/integrations/supabase/client";

import { DATE_LOCALE, US_DATE } from "@/lib/date-format";
export type CallRow = {
  id: string;
  provider: string;
  channel: string;
  direction: string;
  occurred_at: string;
  duration_seconds: number | null;
  from_address: string | null;
  to_address: string | null;
  outcome: string | null;
  recording_url: string | null;
  body_preview: string | null;
  account_id: string | null;
  contact_id: string | null;
  user_id: string | null;
  touchpoint_id: string | null;
  accounts?: { name: string | null } | null;
  contacts?: { full_name: string | null } | null;
};

export const CALL_OUTCOMES = [
  { value: "connected", label: "Connected — spoke with them" },
  { value: "voicemail", label: "Left voicemail" },
  { value: "no_answer", label: "No answer" },
  { value: "wrong_number", label: "Wrong number" },
  { value: "gatekeeper", label: "Blocked by gatekeeper" },
  { value: "callback", label: "Asked to call back" },
] as const;

export function outcomeLabel(v: string | null | undefined): string {
  return CALL_OUTCOMES.find((o) => o.value === v)?.label ?? v ?? "—";
}

export function fmtDurationShort(sec: number | null | undefined): string {
  const s = Math.max(0, Math.floor(Number(sec ?? 0)));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

/** Is this call good enough to count as contact? Outbound-with-no-answer isn't. */
export function connectedCall(outcome: string | null | undefined): boolean {
  return outcome === "connected";
}

export type CallFilters = {
  userIds?: string[];
  accountId?: string | null;
  from?: string;
  to?: string;
  outcome?: string | null;
  search?: string;
};

const SELECT =
  "id,provider,channel,direction,occurred_at,duration_seconds,from_address,to_address,outcome,recording_url,body_preview,account_id,contact_id,user_id,touchpoint_id,accounts(name),contacts(full_name)";

export async function listCalls(f: CallFilters): Promise<CallRow[]> {
  let q = supabase
    .from("captured_communications")
    .select(SELECT)
    .eq("channel", "call")
    .order("occurred_at", { ascending: false })
    .limit(400);
  if (f.userIds && f.userIds.length > 0) q = q.in("user_id", f.userIds);
  if (f.accountId) q = q.eq("account_id", f.accountId);
  if (f.from) q = q.gte("occurred_at", f.from);
  if (f.to) q = q.lte("occurred_at", f.to);
  if (f.outcome) q = q.eq("outcome", f.outcome);
  const { data, error } = await q;
  if (error) throw error;
  let rows = (data ?? []) as unknown as CallRow[];
  const term = (f.search ?? "").trim().toLowerCase();
  if (term) {
    rows = rows.filter((r) =>
      [r.accounts?.name, r.contacts?.full_name, r.to_address, r.from_address, r.body_preview]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(term)),
    );
  }
  return rows;
}

/* ---------------- the queue ---------------- */

export type QueueReason = "followup" | "aging_lead" | "cadence";

export type QueueItem = {
  key: string;
  reason: QueueReason;
  /** Why this is in front of the rep, in words. */
  why: string;
  accountId: string | null;
  accountName: string;
  contactId: string | null;
  contactName: string | null;
  phone: string | null;
  taskId?: string;
};

export const QUEUE_REASON_LABEL: Record<QueueReason, string> = {
  followup: "Follow-up due",
  aging_lead: "Aging lead",
  cadence: "Cadence due",
};

/**
 * One list to work top to bottom: today's follow-up calls, leads going cold,
 * and accounts past their quarterly touch. Ordered by that priority, deduped
 * on the account so nobody gets rung twice in a row.
 */
export async function buildQueue(userId: string): Promise<QueueItem[]> {
  const today = new Date();
  const todayIso = today.toISOString().slice(0, 10);
  const quarterAgo = new Date(today.getTime() - 90 * 86_400_000).toISOString();
  const twoWeeksAgo = new Date(today.getTime() - 14 * 86_400_000).toISOString();

  const [tasksRes, accountsRes] = await Promise.all([
    supabase
      .from("tasks")
      .select("id,title,due_date,account_id,contact_id,status")
      .eq("assignee", userId)
      .neq("status", "done")
      .lte("due_date", todayIso)
      .order("due_date")
      .limit(100),
    supabase
      .from("accounts")
      .select("id,name,phone,stage,status,created_at,assigned_rep")
      .eq("assigned_rep", userId)
      .is("archived_at", null)
      .limit(300),
  ]);
  if (tasksRes.error) throw tasksRes.error;
  if (accountsRes.error) throw accountsRes.error;

  const accounts = accountsRes.data ?? [];
  const accountIds = accounts.map((a) => a.id);

  // Last time anyone actually reached each account.
  const lastTouch = new Map<string, string>();
  if (accountIds.length > 0) {
    const { data: tps } = await supabase
      .from("touchpoints")
      .select("account_id,occurred_at")
      .in("account_id", accountIds)
      .gte("occurred_at", quarterAgo)
      .order("occurred_at", { ascending: false })
      .limit(1000);
    for (const t of tps ?? []) {
      if (t.account_id && !lastTouch.has(t.account_id)) {
        lastTouch.set(t.account_id, t.occurred_at as string);
      }
    }
  }

  // Primary contact + number per account, so the queue can dial without a detour.
  const contactByAccount = new Map<string, { id: string; name: string; phone: string | null }>();
  if (accountIds.length > 0) {
    const { data: cs } = await supabase
      .from("contacts")
      .select("id,account_id,full_name,phone,office_phone,is_primary")
      .in("account_id", accountIds)
      .is("archived_at", null)
      .order("is_primary", { ascending: false })
      .limit(1000);
    for (const c of cs ?? []) {
      if (!c.account_id || contactByAccount.has(c.account_id)) continue;
      contactByAccount.set(c.account_id, {
        id: c.id,
        name: c.full_name ?? "Contact",
        phone: c.phone ?? c.office_phone ?? null,
      });
    }
  }

  const byId = new Map(accounts.map((a) => [a.id, a]));
  const out: QueueItem[] = [];
  const seen = new Set<string>();

  const push = (item: QueueItem) => {
    const dedupe = item.accountId ?? item.key;
    if (seen.has(dedupe)) return;
    seen.add(dedupe);
    out.push(item);
  };

  for (const t of tasksRes.data ?? []) {
    const acct = t.account_id ? byId.get(t.account_id) : null;
    const contact = t.account_id ? contactByAccount.get(t.account_id) : null;
    push({
      key: `task:${t.id}`,
      reason: "followup",
      why: `${t.title}${t.due_date && t.due_date < todayIso ? " · overdue" : " · due today"}`,
      accountId: t.account_id,
      accountName: acct?.name ?? "No account",
      contactId: t.contact_id ?? contact?.id ?? null,
      contactName: contact?.name ?? null,
      phone: contact?.phone ?? acct?.phone ?? null,
      taskId: t.id,
    });
  }

  for (const a of accounts) {
    const isLead = ["lead", "new_lead", "ready", "active_outreach"].includes(String(a.stage ?? ""));
    const touched = lastTouch.get(a.id) ?? null;
    const contact = contactByAccount.get(a.id) ?? null;
    if (isLead && (!touched || touched < twoWeeksAgo)) {
      push({
        key: `lead:${a.id}`,
        reason: "aging_lead",
        why: touched
          ? `No contact since ${new Date(touched).toLocaleDateString(DATE_LOCALE, US_DATE)}`
          : "Never contacted",
        accountId: a.id,
        accountName: a.name ?? "Account",
        contactId: contact?.id ?? null,
        contactName: contact?.name ?? null,
        phone: contact?.phone ?? a.phone ?? null,
      });
    } else if (!touched) {
      push({
        key: `cadence:${a.id}`,
        reason: "cadence",
        why: "No touch in the last quarter",
        accountId: a.id,
        accountName: a.name ?? "Account",
        contactId: contact?.id ?? null,
        contactName: contact?.name ?? null,
        phone: contact?.phone ?? a.phone ?? null,
      });
    }
  }

  const order: QueueReason[] = ["followup", "aging_lead", "cadence"];
  return out.sort((a, b) => order.indexOf(a.reason) - order.indexOf(b.reason));
}

/* ---------------- logging ---------------- */

export type LogCallInput = {
  userId: string;
  accountId: string | null;
  contactId: string | null;
  jobId?: string | null;
  phone: string | null;
  direction: "inbound" | "outbound";
  outcome: string;
  durationSeconds: number;
  notes: string;
  /** True when the rep dialled on their own handset rather than in-app. */
  selfReported: boolean;
  recordingConsentState?: string | null;
};

/**
 * Writes the call once, in both places that matter: a touchpoint (so cadence,
 * timelines and reporting see it) and the communications log (so the Calls page
 * and any future provider recording line up on the same row).
 */
export async function logCall(input: LogCallInput): Promise<void> {
  const body = [`Outcome: ${outcomeLabel(input.outcome)}`, input.notes.trim()]
    .filter(Boolean)
    .join("\n");

  let touchpointId: string | null = null;
  if (input.accountId) {
    const { data, error } = await supabase
      .from("touchpoints")
      .insert({
        account_id: input.accountId,
        contact_id: input.contactId,
        type: "call",
        notes: body,
        created_by: input.userId,
        capture_source: input.selfReported ? "manual" : "dialer",
        direction: input.direction,
        duration_seconds: connectedCall(input.outcome) ? input.durationSeconds : 0,
        is_self_reported: input.selfReported,
        // An outbound call nobody picked up is not a touch.
        counts_toward_cadence: connectedCall(input.outcome),
      })
      .select("id")
      .single();
    if (error) throw error;
    touchpointId = data.id;
  }

  const { error: ccError } = await supabase.from("captured_communications").insert({
    provider: input.selfReported ? "self_reported" : "in_app_dialer",
    external_id: crypto.randomUUID(),
    channel: "call",
    direction: input.direction,
    occurred_at: new Date().toISOString(),
    duration_seconds: input.durationSeconds,
    to_address: input.direction === "outbound" ? input.phone : null,
    from_address: input.direction === "inbound" ? input.phone : null,
    outcome: input.outcome,
    body_preview: input.notes.trim() || null,
    account_id: input.accountId,
    contact_id: input.contactId,
    user_id: input.userId,
    touchpoint_id: touchpointId,
    recording_consent_state: input.recordingConsentState ?? null,
  });
  if (ccError) throw ccError;
}

/**
 * Is a dialer provider connected for this org? Until one is, the call screen
 * captures the call but does not claim to place it.
 */
export async function dialerConnected(): Promise<boolean> {
  const { data, error } = await supabase
    .from("integration_connections")
    .select("id,status,provider")
    .eq("provider", "callrail")
    .eq("status", "connected")
    .limit(1);
  if (error) return false;
  return (data ?? []).length > 0;
}
