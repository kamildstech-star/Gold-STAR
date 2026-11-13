/**
 * The job's own field changes on the Timeline, each with a Revert.
 *
 * Mark, on a job: "in timeline have a restore button for each item that gets
 * removed or changed". For the job itself the "changed" half is its fields —
 * status, address, customer, adjusters, dates.
 *
 * Nothing new records these: `job_field_changes` (a trigger on jobs since
 * August) already holds one row per column per save. This module groups the
 * rows of one save into one entry ("Mona changed Stage, Status"), reads what a
 * Revert would do (`job_field_change_state`) and asks for it
 * (`revert_job_field_change`, migration 20261006152000). Both run as the
 * caller, so the jobs policy decides who may revert — nothing here does.
 *
 * Until that migration is applied, the `reverts_id` column does not exist,
 * the read below fails as "not migrated", and the Timeline keeps showing the
 * plain "Field … changed" rows it shows today.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { supabase } from "@/integrations/supabase/client";
import type { ActivityEntry } from "@/lib/activity";
import { jobFieldLabel } from "@/lib/job-fields";

/**
 * The fields a Revert may write. Mirrors `job_revertable_fields()` in
 * 20261006152000_job_field_revert.sql; `job-field-revert.test.ts` fails if
 * the two drift. Money (deductible, estimated / approved / billed /
 * collected, agreed price, deposit, commission) and system columns are left
 * out on purpose — see the migration header.
 */
export const JOB_REVERTABLE_FIELDS: readonly string[] = [
  "account_id",
  "additional_work_pending",
  "address",
  "address_line2",
  "adjuster_email",
  "adjuster_name",
  "adjuster_phone",
  "bill_to_account_id",
  "bill_to_attention",
  "billing_location_id",
  "building_name",
  "call_date",
  "call_time",
  "cash_payer_name",
  "claim_number",
  "community",
  "completion_date",
  "county",
  "crew_chief",
  "customer_kind",
  "customer_name",
  "desk_adjuster_contact_id",
  "desk_adjuster_email",
  "desk_adjuster_name",
  "desk_adjuster_phone",
  "facility_name",
  "field_adjuster_contact_id",
  "field_adjuster_email",
  "field_adjuster_name",
  "field_adjuster_phone",
  "field_next_step",
  "hoa",
  "important_instructions",
  "independent_reviewer_account_id",
  "independent_reviewer_contact_id",
  "independent_reviewer_email",
  "independent_reviewer_firm",
  "independent_reviewer_name",
  "independent_reviewer_phone",
  "initial_loss_description",
  "insurance_agency",
  "insurance_agency_account_id",
  "insurance_agent_email",
  "insurance_agent_name",
  "insurance_agent_phone",
  "insurance_carrier",
  "insurance_carrier_account_id",
  "insurance_kind",
  "insurance_kind_detail",
  "job_name",
  "job_number",
  "job_type",
  "job_type_detail",
  "lat",
  "locality",
  "location_id",
  "lon",
  "loss_date",
  "loss_description",
  "loss_description_detail",
  "loss_type",
  "loss_type_detail",
  "loss_type_id",
  "office_next_step",
  "payment_terms",
  "policy_number",
  "postal_code",
  "primary_contact_id",
  "priority",
  "public_adjuster_account_id",
  "public_adjuster_contact_id",
  "public_adjuster_email",
  "public_adjuster_name",
  "public_adjuster_phone",
  "referral_source_type",
  "referral_source_type_detail",
  "referred_by_account_id",
  "referred_by_contact_id",
  "referred_by_name",
  "region",
  "rehabbed_after_1978",
  "reported_source_detail",
  "reported_source_id",
  "scope",
  "stage_id",
  "start_date",
  "status",
  "third_party_company",
  "water_category",
  "water_class",
];

const REVERTABLE = new Set(JOB_REVERTABLE_FIELDS);

export type FieldChangeRow = {
  id: string;
  field: string;
  old_value: string | null;
  new_value: string | null;
  changed_by: string | null;
  changed_at: string;
  reverts_id: string | null;
};

const COLUMNS = "id, field, old_value, new_value, changed_by, changed_at, reverts_id";

const db = () => supabase as unknown as SupabaseClient;

/** 42703 / PGRST204: the reverts_id column is not there — the migration is outstanding. */
export function fieldRevertUnavailable(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  if (!e) return false;
  if (e.code === "42703" || e.code === "PGRST204" || e.code === "PGRST202") return true;
  return /reverts_id|could not find the function/i.test(e.message ?? "");
}

export type FieldChangeData = {
  available: boolean;
  rows: FieldChangeRow[];
  /** user_id → name, for who changed it and for crew_chief values. */
  people: Record<string, string>;
  /** pipeline stage id → name, for stage_id values. */
  stages: Record<string, string>;
};

export async function fetchJobFieldChanges(jobId: string): Promise<FieldChangeData> {
  const { data, error } = await db()
    .from("job_field_changes")
    .select(COLUMNS)
    .eq("job_id", jobId)
    .order("changed_at", { ascending: false })
    .limit(600);
  if (error) {
    if (fieldRevertUnavailable(error))
      return { available: false, rows: [], people: {}, stages: {} };
    throw error;
  }
  const rows = (data ?? []) as unknown as FieldChangeRow[];

  const personIds = new Set<string>();
  const stageIds = new Set<string>();
  for (const r of rows) {
    if (r.changed_by) personIds.add(r.changed_by);
    if (r.field === "crew_chief") {
      for (const v of [r.old_value, r.new_value]) if (v) personIds.add(v);
    }
    if (r.field === "stage_id") {
      for (const v of [r.old_value, r.new_value]) if (v) stageIds.add(v);
    }
  }
  const people: Record<string, string> = {};
  const stages: Record<string, string> = {};
  if (personIds.size) {
    const { data: ps } = await supabase
      .from("profiles")
      .select("user_id, full_name")
      .in("user_id", [...personIds]);
    for (const p of ps ?? []) if (p.full_name) people[p.user_id] = p.full_name;
  }
  if (stageIds.size) {
    const { data: ss } = await supabase
      .from("pipeline_stages")
      .select("id, name")
      .in("id", [...stageIds]);
    for (const s of ss ?? []) stages[s.id] = s.name;
  }
  return { available: true, rows, people, stages };
}

export type FieldStateField = {
  field: string;
  before: string | null;
  after: string | null;
  now: string | null;
  moved: boolean;
  revertable: boolean;
  reverted: boolean;
};

export type FieldState = {
  id: string;
  status: "ready" | "already_reverted" | "conflict" | "nothing_revertable" | "gone" | "reverted";
  fields?: FieldStateField[];
  may_edit?: boolean;
};

export async function fetchFieldChangeState(changeId: string): Promise<FieldState> {
  const { data, error } = await db().rpc("job_field_change_state", { _change_id: changeId });
  if (error) throw error;
  return data as FieldState;
}

export async function revertFieldChange(changeId: string): Promise<FieldState> {
  const { data, error } = await db().rpc("revert_job_field_change", { _change_id: changeId });
  if (error) throw error;
  return data as FieldState;
}

/* ------------------------------------------------------------------ *
 * Pure
 * ------------------------------------------------------------------ */

/** One save: every row with the same instant (now() is fixed per transaction). */
export type FieldEdit = {
  /** Any row of the save; the database expands it back to the whole save. */
  id: string;
  at: string;
  actorId: string | null;
  changes: { field: string; before: string | null; after: string | null }[];
  /** This save was itself a revert of another. */
  isRevert: boolean;
  /** Every revertable field in this save has been reverted since. */
  revertedBy: { actorId: string | null; at: string } | null;
  /** Something in it may be reverted (not only money / system fields). */
  revertable: boolean;
};

/** Derived columns the stage trigger sets; never shown as their own line. */
const DERIVED = new Set(["pipeline_id", "stage_entered_at"]);

export function groupFieldChanges(rows: FieldChangeRow[]): FieldEdit[] {
  const byAt = new Map<string, FieldChangeRow[]>();
  for (const r of rows) {
    const key = String(new Date(r.changed_at).getTime());
    const list = byAt.get(key) ?? [];
    list.push(r);
    byAt.set(key, list);
  }
  const revertOf = new Map<string, FieldChangeRow>();
  for (const r of rows) if (r.reverts_id) revertOf.set(r.reverts_id, r);

  const edits: FieldEdit[] = [];
  for (const group of byAt.values()) {
    const first = group[0]!;
    const revertableRows = group.filter((r) => REVERTABLE.has(r.field));
    const reverts = revertableRows.map((r) => revertOf.get(r.id));
    const allReverted = revertableRows.length > 0 && reverts.every(Boolean);
    const hasStage = group.some((r) => r.field === "stage_id");
    edits.push({
      id: first.id,
      at: first.changed_at,
      actorId: first.changed_by,
      changes: group
        .filter((r) => !DERIVED.has(r.field) && !(hasStage && r.field === "status"))
        .map((r) => ({ field: r.field, before: r.old_value, after: r.new_value }))
        .sort((a, b) => a.field.localeCompare(b.field)),
      isRevert: group.some((r) => r.reverts_id),
      revertedBy: allReverted
        ? { actorId: reverts[0]!.changed_by, at: reverts[0]!.changed_at }
        : null,
      revertable: revertableRows.length > 0,
    });
  }
  return edits.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A logged value as a person reads it. */
export function fieldValueLabel(
  field: string,
  value: string | null,
  names: { people: Record<string, string>; stages: Record<string, string> },
): string {
  if (value === null || value === "") return "—";
  if (field === "stage_id") return names.stages[value] ?? "another stage";
  if (field === "crew_chief") return names.people[value] ?? "someone";
  if (field === "status") return value.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
  if (value === "true") return "Yes";
  if (value === "false") return "No";
  // Other links (account, contact, office…) are ids; the name lives in a
  // table this reader may not be allowed to see from here.
  if (UUID.test(value)) return "a linked record";
  return value;
}

export function fieldLabel(field: string): string {
  if (field === "stage_id") return "Stage";
  if (field === "status") return "Status";
  return jobFieldLabel(field);
}

/** "Mona changed Stage", "Mona changed Address, City and 2 more". */
export function fieldEditHeadline(edit: FieldEdit, actor: string | null): string {
  const labels = edit.changes.map((c) => fieldLabel(c.field));
  const shown =
    labels.length > 3
      ? `${labels.slice(0, 2).join(", ")} and ${labels.length - 2} more`
      : labels.join(", ");
  return `${actor ?? "Someone"} ${edit.isRevert ? "reverted" : "changed"} ${shown || "the job"}`;
}

export function fieldStateMessage(s: Pick<FieldState, "status" | "may_edit">): string | null {
  switch (s.status) {
    case "ready":
      return s.may_edit === false
        ? "You don't edit this job, so the database will refuse the revert."
        : null;
    case "already_reverted":
    case "reverted":
      return "Every field already has its old value again — nothing to revert.";
    case "conflict":
      return "Changed again since — reverting would overwrite the newer edit, so it's off. Edit the job by hand instead.";
    case "nothing_revertable":
      return "Nothing in this change can be reverted here. Money and system fields are left out on purpose.";
    case "gone":
      return "That job no longer exists.";
    default:
      return null;
  }
}

export type FieldTimelineItem = { kind: "field"; at: string; edit: FieldEdit };

/**
 * Swap the feed's plain field rows for the grouped, revertable ones. Every
 * "Field … changed" row goes (the edits carry all of them), and a "Status
 * a → b" row goes when an edit saved at the same instant carries it, since
 * that is the same save told twice.
 */
export function withFieldEdits<T extends { kind: string; at: string }>(
  items: T[],
  edits: FieldEdit[],
): (T | FieldTimelineItem)[] {
  const instants = new Set(edits.map((e) => new Date(e.at).getTime()));
  const kept = items.filter((it) => {
    const entry = (it as unknown as { entry?: ActivityEntry }).entry;
    if (it.kind !== "activity" || !entry) return true;
    if (entry.event_type === "job.field_changed") return false;
    if (entry.event_type === "job.status_changed") {
      return !instants.has(new Date(entry.occurred_at).getTime());
    }
    return true;
  });
  const merged: (T | FieldTimelineItem)[] = [
    ...kept,
    ...edits.map((edit) => ({ kind: "field" as const, at: edit.at, edit })),
  ];
  return merged.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}
