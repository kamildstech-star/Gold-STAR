/**
 * Stalled-record escalation.
 *
 * The rule this module serves: a record is a problem when *nothing has moved
 * on it* — no status change, no payment, no touchpoint, no email — for a
 * configured number of days. A due date passing is not movement, and an old
 * invoice somebody chased yesterday is not stalled. The database owns that
 * calculation (`record_last_movement`) so the browser cannot disagree with it.
 */
import { supabase } from "@/integrations/supabase/client";
import { personLabel } from "@/lib/chat";
import type { Database } from "@/integrations/supabase/types";

export type EscalationRule = Database["public"]["Tables"]["escalation_rules"]["Row"];
export type EscalationEvent = Database["public"]["Tables"]["escalation_events"]["Row"];
export type EscalationRecordType = Database["public"]["Enums"]["escalation_record_type"];
export type EscalationTargetKind = Database["public"]["Enums"]["escalation_target_kind"];
export type EscalationState = Database["public"]["Enums"]["escalation_event_state"];

export const RECORD_TYPES: EscalationRecordType[] = [
  "estimate",
  "invoice",
  "job",
  "account",
  "lead",
  "compliance",
];

export const RECORD_TYPE_LABEL: Record<EscalationRecordType, string> = {
  estimate: "Estimate",
  invoice: "Invoice",
  job: "Job",
  account: "Account",
  lead: "Lead",
  compliance: "Compliance requirement",
};

/** The target is always an explicit choice. Nothing here is inferred silently. */
export const TARGET_KINDS: EscalationTargetKind[] = [
  "record_owner",
  "assignee",
  "location_manager",
  "collector",
  "named_user",
];

export const TARGET_KIND_LABEL: Record<EscalationTargetKind, string> = {
  record_owner: "The record's owner",
  assignee: "The record's assignee",
  location_manager: "Project manager",
  collector: "Collector on the job",
  named_user: "A named person",
};

/** Statuses worth watching, per record type. Empty selection means "any". */
export const WATCHABLE_STATUSES: Record<EscalationRecordType, string[]> = {
  invoice: ["draft", "sent", "partial", "disputed"],
  estimate: ["draft", "internal_review", "submitted"],
  job: ["new", "scheduled", "in_progress", "drying", "complete", "invoiced"],
  account: [
    "target",
    "researching",
    "attempting_contact",
    "meeting_booked",
    "meeting_held",
    "vendor_onboarding",
    "active",
    "nurture",
  ],
  lead: ["new", "attempting_contact", "contacted", "appointment_set", "quoted"],
  compliance: ["missing", "expiring_soon", "expired", "insufficient"],
};

export function recordHref(type: EscalationRecordType, id: string): string {
  switch (type) {
    case "job":
      return `/jobs/${id}`;
    case "account":
      return `/accounts/${id}`;
    case "lead":
      return "/pipeline";
    case "compliance":
      return "/compliance";
    case "invoice":
    case "estimate":
      return "/billing";
  }
}

/* ------------------------------------------------------------------ */
/* Rules                                                               */
/* ------------------------------------------------------------------ */

export async function listRules(locationIds?: string[] | null): Promise<EscalationRule[]> {
  let q = supabase.from("escalation_rules").select("*").order("record_type").order("stale_days");
  if (locationIds && locationIds.length > 0) q = q.in("location_id", locationIds);
  const { data, error } = await q;
  if (error) throw error;
  return data ?? [];
}

export type RuleDraft = {
  id?: string;
  location_id: string;
  name: string;
  record_type: EscalationRecordType;
  statuses: string[];
  stale_days: number;
  target_kind: EscalationTargetKind;
  target_user_id: string | null;
  step2_days: number | null;
  step2_target_kind: EscalationTargetKind | null;
  step2_target_user_id: string | null;
  step3_days: number | null;
  step3_target_kind: EscalationTargetKind | null;
  step3_target_user_id: string | null;
  active: boolean;
};

export async function saveRule(draft: RuleDraft, userId: string): Promise<EscalationRule> {
  const payload = { ...draft, created_by: userId };
  const { data, error } = draft.id
    ? await supabase.from("escalation_rules").update(payload).eq("id", draft.id).select().single()
    : await supabase.from("escalation_rules").insert(payload).select().single();
  if (error) throw error;
  return data;
}

export async function deleteRule(id: string): Promise<void> {
  const { error } = await supabase.from("escalation_rules").delete().eq("id", id);
  if (error) throw error;
}

/**
 * Default set for a new office: chase the money first, and always escalate to
 * the location manager on the second step.
 */
export function defaultRulesFor(locationId: string): Omit<RuleDraft, "id">[] {
  return [
    {
      location_id: locationId,
      name: "Invoice gone quiet",
      record_type: "invoice",
      statuses: ["sent", "partial", "disputed"],
      stale_days: 14,
      target_kind: "record_owner",
      target_user_id: null,
      step2_days: 21,
      step2_target_kind: "location_manager",
      step2_target_user_id: null,
      step3_days: 35,
      step3_target_kind: "collector",
      step3_target_user_id: null,
      active: true,
    },
    {
      location_id: locationId,
      name: "Estimate gone quiet",
      record_type: "estimate",
      statuses: ["submitted", "internal_review"],
      stale_days: 10,
      target_kind: "record_owner",
      target_user_id: null,
      step2_days: 18,
      step2_target_kind: "location_manager",
      step2_target_user_id: null,
      step3_days: null,
      step3_target_kind: null,
      step3_target_user_id: null,
      active: true,
    },
    {
      location_id: locationId,
      name: "Job standing still",
      record_type: "job",
      statuses: ["in_progress", "drying", "complete"],
      stale_days: 7,
      target_kind: "record_owner",
      target_user_id: null,
      step2_days: 14,
      step2_target_kind: "location_manager",
      step2_target_user_id: null,
      step3_days: null,
      step3_target_kind: null,
      step3_target_user_id: null,
      active: true,
    },
  ];
}

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */

export type StalledRow = EscalationEvent & {
  ownerName: string | null;
  notifiedName: string | null;
  ruleName: string | null;
};

export async function listStalled(input: {
  locationIds?: string[] | null;
  state?: EscalationState;
  recordType?: EscalationRecordType | null;
}): Promise<StalledRow[]> {
  let q = supabase
    .from("escalation_events")
    .select("*, escalation_rules(name)")
    .eq("state", input.state ?? "open")
    .order("days_stale", { ascending: false })
    .limit(500);
  if (input.locationIds && input.locationIds.length > 0) q = q.in("location_id", input.locationIds);
  if (input.recordType) q = q.eq("record_type", input.recordType);
  const { data, error } = await q;
  if (error) throw error;
  const rows = (data ?? []) as (EscalationEvent & { escalation_rules: { name: string } | null })[];

  const ids = [
    ...new Set(
      rows.flatMap((r) => [r.owner_user_id, r.notified_user_id].filter((v): v is string => !!v)),
    ),
  ];
  const names = new Map<string, string>();
  if (ids.length > 0) {
    const { data: profiles, error: profErr } = await supabase
      .from("profiles")
      .select("user_id, full_name")
      .in("user_id", ids);
    if (profErr) throw profErr;
    for (const p of profiles ?? []) names.set(p.user_id, personLabel(p));
  }

  return rows.map((r) => ({
    ...r,
    ruleName: r.escalation_rules?.name ?? null,
    ownerName: r.owner_user_id ? (names.get(r.owner_user_id) ?? null) : null,
    notifiedName: r.notified_user_id ? (names.get(r.notified_user_id) ?? null) : null,
  }));
}

export async function closeEscalation(
  id: string,
  userId: string,
  state: "resolved" | "dismissed",
  note: string | null,
): Promise<void> {
  const { error } = await supabase
    .from("escalation_events")
    .update({
      state,
      resolved_at: new Date().toISOString(),
      resolved_by: userId,
      resolution_note: note,
    })
    .eq("id", id);
  if (error) throw error;
}

/** Runs the sweep on demand. Idempotent — an existing step is never re-raised. */
export async function runScanNow(): Promise<{ raised: number; resolved: number }> {
  const { data, error } = await supabase.rpc("run_escalation_scan");
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return { raised: row?.raised ?? 0, resolved: row?.resolved ?? 0 };
}

export function groupStalled(rows: StalledRow[]) {
  const byType = new Map<EscalationRecordType, Map<string, StalledRow[]>>();
  for (const r of rows) {
    const owner = r.ownerName ?? "Unassigned";
    const inner = byType.get(r.record_type) ?? new Map<string, StalledRow[]>();
    const list = inner.get(owner) ?? [];
    list.push(r);
    inner.set(owner, list);
    byType.set(r.record_type, inner);
  }
  return [...byType.entries()].map(([type, owners]) => ({
    type,
    owners: [...owners.entries()].map(([owner, items]) => ({ owner, items })),
    count: [...owners.values()].reduce((n, l) => n + l.length, 0),
  }));
}
