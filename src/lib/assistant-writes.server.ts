/**
 * Assistant write layer.
 *
 * Rule: if the signed-in user can do it in the UI, the assistant can do it for
 * them — but only through the caller's own Supabase client, so RLS decides
 * whether each write is allowed. Nothing here uses the service role.
 *
 * Every write is first turned into a *step* of a plan. The plan is previewed in
 * the UI, and only executed after the user confirms. Each executed step writes
 * a "via Assistant" line to the record's timeline with the user as the actor,
 * and any failure is surfaced with the real database reason.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";
import type { AssistantScope } from "@/lib/assistant-scope.server";

type DB = SupabaseClient<Database>;
type WriteTable = keyof Database["public"]["Tables"];
type TagScope = Database["public"]["Enums"]["tag_scope"];

// Registry-driven writes intentionally have runtime-selected columns. Keep
// values unknown until PostgreSQL validates them, and keep table names tied to
// the generated schema. This adapter retains the caller's client and RLS.
type DynamicWriteSchema = {
  public: {
    Tables: {
      [Name in WriteTable]: {
        Row: Record<string, unknown>;
        Insert: Record<string, unknown>;
        Update: Record<string, unknown>;
        Relationships: [];
      };
    };
    Views: Record<never, never>;
    Functions: Record<never, never>;
  };
};
function writeTable(client: DB, table: WriteTable) {
  return (client as unknown as SupabaseClient<DynamicWriteSchema>).from(table);
}
function insertedRow(value: unknown): Record<string, unknown> & { id: string } {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("id" in value) ||
    typeof value.id !== "string"
  ) {
    throw new Error("The database did not return the created record id.");
  }
  return value as Record<string, unknown> & { id: string };
}

export type PlanOp = "create" | "update" | "archive" | "tag" | "draft_email";

export interface PlanStep {
  op: PlanOp;
  /** Registry key, e.g. "job", "account", "task". Absent for draft_email. */
  entity?: string;
  /** Target row for update/archive/tag. May be a "$1" reference to a prior step. */
  id?: string | null;
  fields?: Record<string, unknown>;
  /** Child rows (estimate lines, supply request lines). */
  children?: Array<Record<string, unknown>>;
  /** Tag names for op = "tag". */
  tags?: string[];
  summary: string;
  preview: Array<{ label: string; value: string }>;
}

/* ------------------------------------------------------------------ */
/* Entity registry                                                     */
/* ------------------------------------------------------------------ */

interface EntityDef {
  table: WriteTable;
  label: string;
  /** Columns the assistant may set on create. */
  insert: string[];
  /** Columns the assistant may change on update. */
  update: string[];
  /** Column that records who created the row. */
  createdBy?: string;
  /** Soft-archive column, when the entity supports archiving. */
  archiveColumn?: string;
  archivedByColumn?: string;
  /** Join table used for tagging. */
  tag?: { table: WriteTable; fk: string; scope: TagScope };
  /** Child rows written after the parent insert. */
  child?: { table: WriteTable; fk: string; columns: string[] };
  /** Where the record lives in the app. */
  path?: (id: string) => string;
  /** Timeline target: how to log "via Assistant" against the record. */
  timeline?:
    { kind: "account"; column: string } | { kind: "job"; column: string } | { kind: "none" };
}

const ACCOUNT_FIELDS = [
  "name",
  "account_type",
  "account_type_detail",
  "stage",
  "status",
  "phone",
  "email",
  "website",
  "address_line1",
  "city",
  "state",
  "postal_code",
  "assigned_rep",
  "location_id",
  "standing_note",
  "standing_note_kind",
  "notes",
  "what_they_do",
  "priority",
  "estimated_annual_value",
  "parent_account_id",
  "certificates_email",
  "annual_meeting_due_on",
  "reactivate_on",
  "no_service_reason_code",
  "no_service_reason_detail",
  "lost_reason",
  "pipeline_id",
  "stage_id",
];

const CONTACT_FIELDS = [
  "full_name",
  "title",
  "email",
  "phone",
  "office_phone",
  "office_extension",
  "account_id",
  "location_id",
  "is_primary",
  "is_decision_maker",
  "decision_role",
  "decision_role_detail",
  "preferred_contact_method",
  "best_time_to_reach",
  "relationship_notes",
  "gift_policy_notes",
  "linkedin_url",
];

const JOB_FIELDS = [
  "job_name",
  "customer_name",
  "customer_kind",
  "address",
  "address_line2",
  "locality",
  "region",
  "postal_code",
  "county",
  "community",
  "account_id",
  "primary_contact_id",
  "location_id",
  "status",
  "stage_id",
  "pipeline_id",
  "job_type",
  "job_type_detail",
  "loss_type",
  "loss_type_id",
  "loss_type_detail",
  "loss_date",
  "call_date",
  "call_time",
  "start_date",
  "completion_date",
  "scope",
  "loss_description",
  "initial_loss_description",
  "important_instructions",
  "insurance_kind",
  "insurance_kind_detail",
  "insurance_carrier",
  "insurance_carrier_account_id",
  "claim_number",
  "policy_number",
  "deductible",
  "adjuster_name",
  "adjuster_email",
  "adjuster_phone",
  "desk_adjuster_name",
  "desk_adjuster_email",
  "desk_adjuster_phone",
  "desk_adjuster_contact_id",
  "field_adjuster_name",
  "field_adjuster_email",
  "field_adjuster_phone",
  "field_adjuster_contact_id",
  "independent_reviewer_name",
  "independent_reviewer_firm",
  "independent_reviewer_email",
  "independent_reviewer_phone",
  "independent_reviewer_account_id",
  "independent_reviewer_contact_id",
  "public_adjuster_name",
  "public_adjuster_account_id",
  "public_adjuster_contact_id",
  "insurance_agency",
  "insurance_agent_name",
  "insurance_agent_email",
  "insurance_agent_phone",
  "referral_source_type",
  "referral_source_type_detail",
  "referred_by_account_id",
  "referred_by_contact_id",
  "referred_by_name",
  "reported_source_id",
  "reported_source_detail",
  "crew_chief",
  "payment_terms",
  "additional_work_pending",
];

export const ENTITIES: Record<string, EntityDef> = {
  account: {
    table: "accounts",
    label: "account",
    insert: ACCOUNT_FIELDS,
    update: ACCOUNT_FIELDS,
    createdBy: "created_by",
    archiveColumn: "archived_at",
    archivedByColumn: "archived_by",
    tag: { table: "account_tags", fk: "account_id", scope: "account" },
    path: (id) => `/accounts/${id}`,
    timeline: { kind: "account", column: "id" },
  },
  contact: {
    table: "contacts",
    label: "contact",
    insert: CONTACT_FIELDS,
    update: CONTACT_FIELDS,
    createdBy: "created_by",
    archiveColumn: "archived_at",
    archivedByColumn: "archived_by",
    tag: { table: "contact_tags", fk: "contact_id", scope: "contact" },
    path: () => `/contacts`,
    timeline: { kind: "account", column: "account_id" },
  },
  job: {
    table: "jobs",
    label: "job",
    insert: JOB_FIELDS,
    update: JOB_FIELDS,
    createdBy: "created_by",
    tag: { table: "job_tags", fk: "job_id", scope: "job" },
    path: (id) => `/jobs/${id}`,
    timeline: { kind: "job", column: "id" },
  },
  task: {
    table: "tasks",
    label: "task",
    insert: [
      "title",
      "description",
      "due_date",
      "due_time",
      "priority",
      "status",
      "assignee",
      "account_id",
      "contact_id",
      "job_id",
      "location_id",
    ],
    update: ["title", "description", "due_date", "due_time", "priority", "status", "assignee"],
    createdBy: "created_by",
    path: () => `/tasks`,
    timeline: { kind: "none" },
  },
  touchpoint: {
    table: "touchpoints",
    label: "touchpoint",
    insert: ["account_id", "contact_id", "type", "occurred_at", "notes", "duration_seconds"],
    update: ["notes", "occurred_at", "type"],
    createdBy: "created_by",
    path: () => `/accounts`,
    timeline: { kind: "none" },
  },
  contact_attempt: {
    table: "contact_attempts",
    label: "contact attempt",
    insert: [
      "account_id",
      "contact_id",
      "lead_id",
      "channel",
      "outcome",
      "occurred_at",
      "duration_seconds",
      "notes",
    ],
    update: ["outcome", "notes"],
    createdBy: "author_id",
    timeline: { kind: "account", column: "account_id" },
  },
  account_note: {
    table: "account_notes",
    label: "account note",
    insert: ["account_id", "body", "is_pinned"],
    update: ["body", "is_pinned"],
    createdBy: "created_by",
    timeline: { kind: "none" },
  },
  job_note: {
    table: "job_notes",
    label: "job note",
    insert: ["job_id", "body"],
    update: ["body"],
    createdBy: "author_id",
    timeline: { kind: "none" },
  },
  job_section_note: {
    table: "job_section_notes",
    label: "job section note",
    insert: ["job_id", "section_key", "body"],
    update: ["body"],
    createdBy: "author_id",
    timeline: { kind: "none" },
  },
  job_assignment: {
    table: "job_assignments",
    label: "crew assignment",
    insert: ["job_id", "user_id", "role", "start_date", "end_date"],
    update: ["role", "start_date", "end_date"],
    timeline: { kind: "job", column: "job_id" },
  },
  estimate: {
    table: "estimates",
    label: "estimate",
    insert: [
      "job_id",
      "location_id",
      "title",
      "status",
      "call_date",
      "estimate_date",
      "job_number",
      "customer_name",
      "account_id",
      "contact_id",
      "address",
      "locality",
      "region",
      "postal_code",
      "tax_rate",
      "notes",
    ],
    update: ["title", "status", "notes", "tax_rate", "estimate_date"],
    createdBy: "created_by",
    child: {
      table: "estimate_lines",
      fk: "estimate_id",
      columns: [
        "catalog_item_id",
        "position",
        "code",
        "name",
        "short_name",
        "description",
        "uom",
        "quantity",
        "unit_cost",
        "unit_price",
        "taxable",
        "is_discount",
        "note",
      ],
    },
    path: (id) => `/estimates/${id}`,
    timeline: { kind: "job", column: "job_id" },
  },
  invoice: {
    table: "invoices",
    label: "invoice",
    insert: [
      "job_id",
      "account_id",
      "location_id",
      "estimate_id",
      "invoice_number",
      "carrier",
      "claim_number",
      "adjuster_name",
      "adjuster_email",
      "issue_date",
      "due_date",
      "billed_amount",
      "approved_amount",
      "status",
      "notes",
    ],
    update: ["status", "due_date", "billed_amount", "approved_amount", "notes"],
    createdBy: "created_by",
    path: (id) => `/billing?invoice=${id}`,
    timeline: { kind: "job", column: "job_id" },
  },
  time_entry: {
    table: "time_entries",
    label: "time entry",
    // No location_id here - time_entries carries location through shift_id.
    insert: ["user_id", "job_id", "entry_type", "started_at", "ended_at", "notes", "status"],
    update: ["ended_at", "notes", "status"],
    path: () => `/time-clock`,
    timeline: { kind: "job", column: "job_id" },
  },
  equipment_placement: {
    table: "equipment_placements",
    label: "equipment placement",
    insert: ["equipment_id", "job_id", "room_id", "placed_at", "expected_retrieval_date", "notes"],
    update: [
      "retrieved_at",
      "retrieved_by",
      "return_condition",
      "expected_retrieval_date",
      "notes",
    ],
    createdBy: "placed_by",
    path: () => `/equipment`,
    timeline: { kind: "job", column: "job_id" },
  },
  supply_request: {
    table: "supply_requests",
    label: "supply request",
    insert: ["location_id", "job_id", "note", "needed_by", "status"],
    update: ["note", "needed_by", "status"],
    createdBy: "requester_id",
    child: {
      table: "supply_request_lines",
      fk: "request_id",
      columns: ["item_id", "other_label", "quantity", "unit"],
    },
    path: () => `/supplies`,
    timeline: { kind: "job", column: "job_id" },
  },
  document_send: {
    table: "document_send_packets",
    label: "document send",
    insert: [
      "job_id",
      "account_id",
      "location_id",
      "recipient_email",
      "recipient_name",
      "subject",
      "message",
      "required_fields",
      "expires_at",
    ],
    update: ["subject", "message", "recipient_email", "recipient_name"],
    createdBy: "created_by",
    path: () => `/documents`,
    timeline: { kind: "job", column: "job_id" },
  },
  email_message: {
    table: "email_messages",
    label: "email",
    insert: [
      "template_id",
      "template_key",
      "category",
      "to_emails",
      "cc_emails",
      "subject",
      "body_html",
      "account_id",
      "contact_id",
      "job_id",
      "invoice_id",
      "location_id",
      "status",
    ],
    update: ["subject", "body_html", "to_emails", "status"],
    createdBy: "sent_by",
    path: () => `/email`,
    timeline: { kind: "account", column: "account_id" },
  },
};

export function entityNames() {
  return Object.keys(ENTITIES);
}

export function describeEntity(name: string) {
  const def = ENTITIES[name];
  if (!def) return null;
  return {
    entity: name,
    label: def.label,
    creatable_fields: def.insert,
    editable_fields: def.update,
    supports_tags: Boolean(def.tag),
    supports_archive: Boolean(def.archiveColumn),
    line_item_fields: def.child?.columns ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* Field filtering                                                     */
/* ------------------------------------------------------------------ */

export function filterFields(
  def: EntityDef,
  op: "create" | "update",
  fields: Record<string, unknown>,
): { clean: Record<string, unknown>; rejected: string[] } {
  const allowed = new Set(op === "create" ? def.insert : def.update);
  const clean: Record<string, unknown> = {};
  const rejected: string[] = [];
  for (const [k, v] of Object.entries(fields ?? {})) {
    if (allowed.has(k)) clean[k] = v;
    else rejected.push(k);
  }
  return { clean, rejected };
}

/* ------------------------------------------------------------------ */
/* Execution                                                           */
/* ------------------------------------------------------------------ */

const TAG = "via Assistant";

export interface StepResult {
  ok: boolean;
  summary: string;
  message: string;
  path?: string;
  id?: string;
}

function dbMessage(error: {
  message: string;
  details?: string | null;
  hint?: string | null;
  code?: string | null;
}) {
  const bits = [error.message, error.details ?? "", error.hint ?? ""].filter(Boolean);
  const text = bits.join(" — ");
  if (error.code === "42501" || /row-level security|permission denied/i.test(text)) {
    return `You don't have permission to do that (${text}).`;
  }
  if (error.code === "23502") return `A required field is missing: ${text}`;
  if (error.code === "23503")
    return `A linked record doesn't exist or isn't visible to you: ${text}`;
  if (error.code === "23514") return `That value isn't allowed: ${text}`;
  return text;
}

/** Resolve "$1"-style references to ids created by earlier steps. */
function resolveRefs<T>(value: T, created: string[]): T {
  if (typeof value === "string") {
    const m = /^\$(\d+)$/.exec(value);
    if (m) {
      const idx = Number(m[1]) - 1;
      const id = created[idx];
      if (!id) throw new Error(`Step ${m[1]} did not produce a record to link to.`);
      return id as unknown as T;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => resolveRefs(v, created)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>))
      out[k] = resolveRefs(v, created);
    return out as unknown as T;
  }
  return value;
}

async function logTimeline(
  supabase: DB,
  scope: AssistantScope,
  def: EntityDef,
  row: Record<string, unknown> | null,
  line: string,
) {
  const t = def.timeline;
  if (!t || t.kind === "none" || !row) return;
  const target = row[t.column];
  if (typeof target !== "string" || !target) return;
  const body = `${line} · ${TAG}`;
  if (t.kind === "account") {
    await supabase
      .from("account_notes")
      .insert({ account_id: target, body, created_by: scope.actorUserId });
  } else {
    await supabase.from("job_notes").insert({ job_id: target, body, author_id: scope.actorUserId });
  }
}

async function resolveTagIds(
  supabase: DB,
  scope: AssistantScope,
  scopeName: TagScope,
  names: string[],
): Promise<string[]> {
  const ids: string[] = [];
  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;
    const { data: existing } = await supabase
      .from("tags")
      .select("id")
      .contains("scopes", [scopeName])
      .ilike("name", name)
      .maybeSingle();
    if (existing?.id) {
      ids.push(existing.id);
      continue;
    }
    const { data: made, error } = await supabase
      .from("tags")
      .insert({ name, scopes: [scopeName], created_by: scope.actorUserId })
      .select("id")
      .single();
    if (error) throw new Error(dbMessage(error));
    ids.push(made.id);
  }
  return ids;
}

async function runStep(
  supabase: DB,
  scope: AssistantScope,
  step: PlanStep,
  created: string[],
): Promise<StepResult> {
  if (step.op === "draft_email") {
    return {
      ok: true,
      summary: step.summary,
      message: "Draft ready for you to review and send yourself.",
    };
  }

  const def = step.entity ? ENTITIES[step.entity] : undefined;
  if (!def) throw new Error(`I can't write to “${step.entity}”.`);

  const fields = resolveRefs(step.fields ?? {}, created);
  const targetId = step.id ? resolveRefs(step.id, created) : null;

  if (step.op === "create") {
    const { clean, rejected } = filterFields(def, "create", fields);
    if (def.createdBy) clean[def.createdBy] = scope.actorUserId;
    if (def.table === "time_entries" && !clean.user_id) clean.user_id = scope.actorUserId;
    if (def.table === "tasks" && !clean.assignee) clean.assignee = scope.effectiveUserId;
    if (def.table === "tasks") clean.source = "assistant";
    const { data, error } = await writeTable(supabase, def.table)
      .insert(clean)
      .select("*")
      .single();
    if (error) throw new Error(dbMessage(error));
    const row = insertedRow(data);
    created.push(row.id);

    if (def.child && step.children?.length) {
      const rows = (resolveRefs(step.children, created) as Array<Record<string, unknown>>).map(
        (c, i) => {
          const allowed = new Set(def.child!.columns);
          const out: Record<string, unknown> = { [def.child!.fk]: row.id };
          for (const [k, v] of Object.entries(c)) if (allowed.has(k)) out[k] = v;
          if (def.child!.columns.includes("position") && out.position == null) out.position = i + 1;
          return out;
        },
      );
      const { error: childErr } = await writeTable(supabase, def.child.table).insert(rows);
      if (childErr) throw new Error(`Line items failed: ${dbMessage(childErr)}`);
    }

    await logTimeline(supabase, scope, def, row, `${capitalise(def.label)} created by assistant`);
    return {
      ok: true,
      summary: step.summary,
      id: row.id,
      path: def.path?.(row.id),
      message: `${capitalise(def.label)} created${rejected.length ? ` (ignored unknown fields: ${rejected.join(", ")})` : ""}.`,
    };
  }

  if (!targetId) throw new Error(`I need the record id to ${step.op} that ${def.label}.`);

  if (step.op === "archive") {
    if (!def.archiveColumn) throw new Error(`A ${def.label} can't be archived.`);
    const patch: Record<string, unknown> = { [def.archiveColumn]: new Date().toISOString() };
    if (def.archivedByColumn) patch[def.archivedByColumn] = scope.actorUserId;
    const { data, error } = await writeTable(supabase, def.table)
      .update(patch)
      .eq("id", targetId)
      .select("*")
      .maybeSingle();
    if (error) throw new Error(dbMessage(error));
    if (!data) throw new Error(`That ${def.label} isn't visible to you, so it wasn't archived.`);
    await logTimeline(supabase, scope, def, data, `${capitalise(def.label)} archived`);
    return { ok: true, summary: step.summary, message: `${capitalise(def.label)} archived.` };
  }

  if (step.op === "tag") {
    if (!def.tag) throw new Error(`A ${def.label} can't be tagged.`);
    const ids = await resolveTagIds(supabase, scope, def.tag.scope, step.tags ?? []);
    if (!ids.length) throw new Error("No tag names were given.");
    const rows: Array<Record<string, unknown>> = ids.map((tag_id) => ({
      [def.tag!.fk]: targetId,
      tag_id,
      created_by: scope.actorUserId,
    }));
    const { error } = await writeTable(supabase, def.tag.table).upsert(rows);
    if (error) throw new Error(dbMessage(error));
    return {
      ok: true,
      summary: step.summary,
      path: def.path?.(String(targetId)),
      message: `Tagged: ${(step.tags ?? []).join(", ")}.`,
    };
  }

  // update
  const { clean, rejected } = filterFields(def, "update", fields);
  if (!Object.keys(clean).length)
    throw new Error(
      `None of those fields can be changed on a ${def.label}${rejected.length ? ` (${rejected.join(", ")})` : ""}.`,
    );
  if (def.table === "tasks" && clean.status === "completed")
    clean.completed_at = new Date().toISOString();
  const { data, error } = await writeTable(supabase, def.table)
    .update(clean)
    .eq("id", targetId)
    .select("*")
    .maybeSingle();
  if (error) throw new Error(dbMessage(error));
  if (!data) throw new Error(`That ${def.label} isn't visible to you, so nothing was changed.`);
  const changed = Object.keys(clean).join(", ");
  await logTimeline(supabase, scope, def, data, `${capitalise(def.label)} updated (${changed})`);
  return {
    ok: true,
    summary: step.summary,
    path: def.path?.(String(targetId)),
    message: `${capitalise(def.label)} updated: ${changed}${rejected.length ? ` (ignored: ${rejected.join(", ")})` : ""}.`,
  };
}

function capitalise(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Execute a confirmed plan step by step. Stops at the first failure and
 * reports the real reason; steps already applied are reported as done.
 */
export async function executePlan(
  supabase: DB,
  scope: AssistantScope,
  steps: PlanStep[],
): Promise<{ results: StepResult[]; ok: boolean; path?: string }> {
  if (!scope.caps.canWrite) throw new Error("Writes are disabled while View As is active.");
  const created: string[] = [];
  const results: StepResult[] = [];
  for (const step of steps) {
    try {
      const res = await runStep(supabase, scope, step, created);
      results.push(res);
    } catch (err) {
      results.push({
        ok: false,
        summary: step.summary,
        message: (err as Error).message,
      });
      break;
    }
  }
  const firstPath = results.find((r) => r.ok && r.path)?.path;
  return { results, ok: results.every((r) => r.ok), path: firstPath };
}
