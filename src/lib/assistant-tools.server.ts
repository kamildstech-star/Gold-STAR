/**
 * Assistant tool layer — the only way the system-wide assistant touches data.
 *
 * Two hard rules, enforced here rather than in prompt text:
 *  1. Every read AND every write runs through the CALLER'S authenticated
 *     Supabase client. RLS is the boundary; the service role is never used.
 *     The money rule, location scope and chaser data rules therefore apply
 *     automatically — the assistant physically cannot see what the user can't.
 *  2. Writes are never executed by the model. Write tools return a *proposal*
 *     that the user confirms in the UI; `executeAction` performs it later.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";
import type { AssistantScope } from "@/lib/assistant-scope.server";
import { allowedPeople } from "@/lib/assistant-scope.server";
import { describeEntity, entityNames, type PlanStep } from "@/lib/assistant-writes.server";

type DB = SupabaseClient<Database>;

export function isToolArguments(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export type ToolResult = { ok: true; data: unknown } | { ok: false; error: string };

export type { PlanStep } from "@/lib/assistant-writes.server";

/** Allowed values for the choice fields the assistant most often sets. */
const OPTION_VALUES: Record<string, string[]> = {
  job_status: [
    "new",
    "scheduled",
    "in_progress",
    "drying",
    "complete",
    "invoiced",
    "paid",
    "cancelled",
  ],
  loss_type: ["water", "fire", "smoke", "mold", "biohazard", "storm", "cleaning", "sewer"],
  job_type: ["insurance", "cash", "reconstruction", "undetermined"],
  insurance_kind: ["homeowners", "renters", "commercial"],
  account_status: ["prospect", "onboarding", "active", "dormant", "lost"],
  account_type: ["property_management", "commercial", "residential", "other"],
  account_stage: [
    "new",
    "attempting_contact",
    "contacted",
    "appointment_set",
    "quoted",
    "won",
    "lost",
    "unqualified",
  ],
  task_status: ["open", "in_progress", "done", "cancelled"],
  task_priority: ["low", "normal", "high", "urgent"],
  touchpoint_type: [
    "call",
    "email",
    "meeting_in_person",
    "meeting_virtual",
    "gift",
    "seasonal_send",
    "other",
  ],
  contact_channel: ["call", "sms", "email", "door", "other"],
  job_assignment_role: [
    "crew_chief",
    "technician",
    "lead_technician",
    "account_rep",
    "project_manager",
    "estimator",
    "collector",
  ],
  estimate_status: ["draft", "sent", "approved", "declined"],
  invoice_status: ["draft", "sent", "partial", "paid", "disputed", "written_off"],
  time_entry_type: ["labour", "travel", "standby"],
};

/** Turn a field map into the label/value rows shown in the confirm card. */
function previewOf(
  fields: Record<string, unknown>,
  children?: unknown,
): Array<{ label: string; value: string }> {
  const rows = Object.entries(fields ?? {})
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .slice(0, 14)
    .map(([k, v]) => ({
      label: k.replaceAll("_", " ").replace(/\b\w/, (c) => c.toUpperCase()),
      value: typeof v === "object" ? JSON.stringify(v) : String(v),
    }));
  if (Array.isArray(children) && children.length)
    rows.push({ label: "Line items", value: `${children.length} line(s)` });
  return rows;
}

/** Tool schemas advertised to the model (OpenAI-style function tools). */
export const TOOL_SPECS = [
  {
    type: "function",
    function: {
      name: "search_records",
      description:
        "Full-text-ish search across accounts, contacts and jobs the signed-in user can see. Use before answering anything about a named company, person or job.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Name, address or job number fragment" },
          entity: {
            type: "string",
            enum: ["all", "accounts", "contacts", "jobs"],
            description: "Limit the search",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_account",
      description:
        "Full detail for one account: stage, owner, contacts, open tasks, recent touchpoints, compliance state.",
      parameters: {
        type: "object",
        properties: { account_id: { type: "string" } },
        required: ["account_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_job",
      description:
        "Full detail for one job: status, address, loss info, insurance, notes and (only if the user may see money) billing figures.",
      parameters: {
        type: "object",
        properties: { job_id: { type: "string" } },
        required: ["job_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_my_work",
      description:
        "The signed-in user's open tasks and upcoming calendar events. Use for 'what's on my plate', 'what's overdue'.",
      parameters: {
        type: "object",
        properties: {
          days: { type: "number", description: "Look-ahead window, default 7" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "pipeline_snapshot",
      description:
        "Counts of accounts by stage and jobs by status inside the user's visible scope. Use for 'how is the pipeline looking'.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "compliance_snapshot",
      description:
        "Vendor/company compliance requirements the user can see: expiring, expired and missing counts plus the worst offenders.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "person_activity",
      description:
        "Activity history for ONE person the caller manages: touchpoints, calls, jobs worked, timecards, goal progress. Refuses if the caller may not see that person.",
      parameters: {
        type: "object",
        properties: {
          user_id: { type: "string", description: "profiles.user_id" },
          days: { type: "number", description: "Window, default 30" },
        },
        required: ["user_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_people",
      description:
        "People the caller is allowed to ask about (their reports / location members). Use to resolve a name to a user_id before person_activity.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "list_writable_entities",
      description:
        "List every record type the assistant can create, edit, tag or archive. Call once before your first write in a conversation if you are unsure of the entity name.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "describe_entity",
      description:
        "Field list for one writable record type: which fields can be set on create, which can be edited, whether it supports tags/archive, and its line-item fields. Call this before proposing a write with unfamiliar fields.",
      parameters: {
        type: "object",
        properties: { entity: { type: "string" } },
        required: ["entity"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_options",
      description:
        "Allowed values for a choice field (job status, loss type, account stage, task priority, touchpoint type, crew role, estimate status, invoice status). Use before setting one.",
      parameters: {
        type: "object",
        properties: { field: { type: "string" } },
        required: ["field"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_create",
      description:
        'Add one CREATE step to the plan. entity is one of the writable entities (account, contact, job, task, touchpoint, contact_attempt, account_note, job_note, job_section_note, job_assignment, estimate, invoice, time_entry, equipment_placement, supply_request, document_send, email_message). Use children for line items (estimate lines, supply request lines). To link to a record created earlier in the same plan, set the field value to "$1" for the first step, "$2" for the second, and so on. Nothing is saved until the user confirms the whole plan.',
      parameters: {
        type: "object",
        properties: {
          entity: { type: "string" },
          fields: { type: "object", description: "Column → value map", additionalProperties: true },
          children: {
            type: "array",
            description: "Line items for estimates and supply requests",
            items: { type: "object", additionalProperties: true },
          },
          summary: { type: "string", description: "One short line describing this step" },
        },
        required: ["entity", "fields", "summary"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_update",
      description:
        "Add one UPDATE step to the plan: edit any editable field on an existing record — change a job's status or stage, move a deal, set an owner, complete a task (status=completed), set a due date, return equipment, update insurance or adjuster details. Nothing is saved until the user confirms.",
      parameters: {
        type: "object",
        properties: {
          entity: { type: "string" },
          id: { type: "string", description: 'Record id, or "$1" to reference an earlier step' },
          fields: { type: "object", additionalProperties: true },
          summary: { type: "string" },
        },
        required: ["entity", "id", "fields", "summary"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_tag",
      description:
        "Add a TAG step: apply one or more labels to an account, contact or job. Tags that do not exist yet are created.",
      parameters: {
        type: "object",
        properties: {
          entity: { type: "string", enum: ["account", "contact", "job"] },
          id: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          summary: { type: "string" },
        },
        required: ["entity", "id", "tags"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_archive",
      description:
        "Add an ARCHIVE step for an account or contact. Records are archived, never deleted.",
      parameters: {
        type: "object",
        properties: {
          entity: { type: "string", enum: ["account", "contact"] },
          id: { type: "string" },
          summary: { type: "string" },
        },
        required: ["entity", "id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_email_draft",
      description:
        "Draft an INTERNAL-only email for the user to review and send themselves. Never used to send anything to a client or referral source automatically.",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string" },
          subject: { type: "string" },
          body: { type: "string" },
        },
        required: ["subject", "body"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "navigate",
      description:
        "Offer the user a link to a page in the app. Use app paths like /jobs/<id>, /accounts/<id>, /pipeline, /chase, /compliance.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, label: { type: "string" } },
        required: ["path"],
      },
    },
  },
] as const;

const DENIED = "You do not have access to that record, so I can't tell you anything about it.";

function iso(daysFromNow: number) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString();
}

/**
 * Run a tool. `supabase` is the caller's client — every query below is
 * therefore RLS-filtered. Empty results are reported as "not visible",
 * never as "does not exist", so absence is not confirmable.
 */
export async function runTool(
  supabase: DB,
  scope: AssistantScope,
  name: string,
  args: Record<string, unknown>,
): Promise<{
  result: ToolResult;
  steps?: PlanStep[];
  navigate?: { path: string; label: string };
}> {
  switch (name) {
    case "search_records": {
      const q = String(args.query ?? "").trim();
      if (q.length < 2) return { result: { ok: false, error: "Query too short." } };
      const like = `%${q}%`;
      const entity = args.entity ?? "all";
      const out: Record<string, unknown> = {};
      if (entity === "all" || entity === "accounts") {
        const { data } = await supabase
          .from("accounts")
          .select("id, name, stage, status, account_type, city, state")
          .ilike("name", like)
          .is("archived_at", null)
          .limit(10);
        out.accounts = data ?? [];
      }
      if (entity === "all" || entity === "contacts") {
        const { data } = await supabase
          .from("contacts")
          .select("id, full_name, title, email, phone, account_id")
          .ilike("full_name", like)
          .is("archived_at", null)
          .limit(10);
        out.contacts = data ?? [];
      }
      if (entity === "all" || entity === "jobs") {
        const { data } = await supabase
          .from("jobs")
          .select("id, job_number, job_name, address, status, job_type, customer_name")
          .or(
            `job_number.ilike.${like},address.ilike.${like},customer_name.ilike.${like},job_name.ilike.${like}`,
          )
          .limit(10);
        out.jobs = data ?? [];
      }
      return { result: { ok: true, data: out } };
    }

    case "get_account": {
      const id = String(args.account_id ?? "");
      const { data: account } = await supabase
        .from("accounts")
        .select(
          "id, name, stage, status, account_type, phone, email, website, address_line1, city, state, assigned_rep, location_id, standing_note, annual_meeting_due_on, last_in_person_at",
        )
        .eq("id", id)
        .maybeSingle();
      if (!account) return { result: { ok: false, error: DENIED } };
      const [contacts, tasks, touches, notes] = await Promise.all([
        supabase
          .from("contacts")
          .select("id, full_name, title, email, phone, is_primary")
          .eq("account_id", id)
          .limit(25),
        supabase
          .from("tasks")
          .select("id, title, due_date, status, priority")
          .eq("account_id", id)
          .eq("status", "open")
          .limit(25),
        supabase
          .from("touchpoints")
          .select("id, type, occurred_at, notes, counts_toward_cadence")
          .eq("account_id", id)
          .order("occurred_at", { ascending: false })
          .limit(15),
        supabase
          .from("account_notes")
          .select("id, body, is_pinned, created_at")
          .eq("account_id", id)
          .order("created_at", { ascending: false })
          .limit(10),
      ]);
      return {
        result: {
          ok: true,
          data: {
            account,
            contacts: contacts.data ?? [],
            open_tasks: tasks.data ?? [],
            recent_touchpoints: touches.data ?? [],
            notes: notes.data ?? [],
          },
        },
      };
    }

    case "get_job": {
      const id = String(args.job_id ?? "");
      const money = scope.caps.financials;
      const cols = [
        "id, job_number, job_name, status, job_type, address, locality, region, postal_code",
        "loss_type, loss_date, scope, loss_description, customer_name, account_id, location_id",
        "insurance_carrier, claim_number, policy_number, desk_adjuster_name, field_adjuster_name",
        "start_date, completion_date, created_at",
        money ? "estimated_amount, approved_amount, billed_amount, collected_amount" : "",
      ]
        .filter(Boolean)
        .join(", ");
      const { data: job } = await supabase.from("jobs").select(cols).eq("id", id).maybeSingle();
      if (!job) return { result: { ok: false, error: DENIED } };
      const { data: notes } = await supabase
        .from("job_notes")
        .select("id, body, created_at")
        .eq("job_id", id)
        .order("created_at", { ascending: false })
        .limit(10);
      return {
        result: {
          ok: true,
          data: {
            job,
            notes: notes ?? [],
            ...(money
              ? {}
              : {
                  money_note:
                    "Financial figures are hidden for this user's role and were not retrieved.",
                }),
          },
        },
      };
    }

    case "list_my_work": {
      const days = Math.min(Math.max(Number(args.days ?? 7), 1), 90);
      const [tasks, events] = await Promise.all([
        supabase
          .from("tasks")
          .select("id, title, due_date, priority, status, account_id, job_id")
          .eq("assignee", scope.effectiveUserId)
          .eq("status", "open")
          .order("due_date", { ascending: true, nullsFirst: false })
          .limit(50),
        supabase
          .from("calendar_events")
          .select("id, subject, starts_at, ends_at, location_text")
          .gte("starts_at", new Date().toISOString())
          .lte("starts_at", iso(days))
          .order("starts_at")
          .limit(30),
      ]);
      const today = new Date().toISOString().slice(0, 10);
      const list = tasks.data ?? [];
      return {
        result: {
          ok: true,
          data: {
            open_tasks: list,
            overdue_count: list.filter((t) => t.due_date && t.due_date < today).length,
            due_today: list.filter((t) => t.due_date === today).length,
            upcoming_events: events.data ?? [],
          },
        },
      };
    }

    case "pipeline_snapshot": {
      const [accounts, jobs] = await Promise.all([
        supabase.from("accounts").select("stage, status").is("archived_at", null).limit(5000),
        supabase.from("jobs").select("status").limit(5000),
      ]);
      const tally = <K extends string>(rows: Array<Record<K, string | null>>, key: K) => {
        const m: Record<string, number> = {};
        for (const r of rows ?? []) m[r[key] ?? "unknown"] = (m[r[key] ?? "unknown"] ?? 0) + 1;
        return m;
      };
      return {
        result: {
          ok: true,
          data: {
            note: "Counts cover only records visible to this user.",
            accounts_by_stage: tally(accounts.data ?? [], "stage"),
            accounts_total: (accounts.data ?? []).length,
            jobs_by_status: tally(jobs.data ?? [], "status"),
            jobs_total: (jobs.data ?? []).length,
          },
        },
      };
    }

    case "compliance_snapshot": {
      const { data } = await supabase
        // Read the view, not the requirements table: status is derived in SQL
        // (one definition) rather than recomputed here, so the assistant quotes
        // the same numbers the Compliance page shows.
        .from("account_compliance_status")
        .select("requirement_id, account_id, requirement_type, status, expiry_date, days_to_expiry")
        .limit(2000);
      const rows = data ?? [];
      // status is the view's own verdict: satisfied | expiring_soon | expired |
      // missing. Trusting it keeps the assistant and the Compliance page from
      // quoting different counts for the same accounts.
      return {
        result: {
          ok: true,
          data: {
            total: rows.length,
            expired: rows.filter((r) => r.status === "expired").length,
            expiring_30d: rows.filter(
              (r) =>
                r.status === "expiring_soon" ||
                (typeof r.days_to_expiry === "number" &&
                  r.days_to_expiry >= 0 &&
                  r.days_to_expiry <= 30),
            ).length,
            missing: rows.filter((r) => r.status === "missing").length,
            sample: rows.slice(0, 20),
          },
        },
      };
    }

    case "list_people": {
      const allow = await allowedPeople(supabase, scope);
      let q = supabase
        .from("profiles")
        .select("user_id, full_name")
        .eq("is_active", true)
        .order("full_name");
      if (allow) q = q.in("user_id", [...allow]);
      const { data } = await q;
      return {
        result: {
          ok: true,
          data: {
            people_scope: scope.caps.peopleScope,
            people: (data ?? []).slice(0, 200),
          },
        },
      };
    }

    case "person_activity": {
      const targetId = String(args.user_id ?? "");
      const days = Math.min(Math.max(Number(args.days ?? 30), 1), 365);
      const allow = await allowedPeople(supabase, scope);
      if (allow && !allow.has(targetId)) {
        return {
          result: {
            ok: false,
            error:
              "Your role only lets you see your own activity, so I can't report on that person.",
          },
        };
      }
      const since = iso(-days);
      const [profile, touches, attempts, jobs, time, goals] = await Promise.all([
        supabase
          .from("profiles")
          .select("user_id, full_name")
          .eq("user_id", targetId)
          .maybeSingle(),
        supabase
          .from("touchpoints")
          .select("type, occurred_at, counts_toward_cadence")
          .eq("created_by", targetId)
          .gte("occurred_at", since)
          .limit(2000),
        supabase
          .from("contact_attempts")
          .select("channel, created_at")
          .eq("author_id", targetId)
          .gte("created_at", since)
          .limit(2000),
        supabase
          .from("jobs")
          .select("id, job_number, status, created_at")
          .eq("created_by", targetId)
          .gte("created_at", since)
          .limit(500),
        supabase
          .from("time_entries")
          .select("id, started_at, ended_at, status")
          .eq("user_id", targetId)
          .gte("started_at", since)
          .limit(500),
        supabase
          .from("goals")
          .select("id, metric, period_type, target_value, starts_on, ends_on")
          .eq("subject_user_id", targetId)
          .limit(50),
      ]);
      if (!profile.data) return { result: { ok: false, error: DENIED } };
      const byType = <K extends string>(rows: Array<Record<K, string | null>>, key: K) => {
        const m: Record<string, number> = {};
        for (const r of rows ?? []) m[r[key] ?? "other"] = (m[r[key] ?? "other"] ?? 0) + 1;
        return m;
      };
      const t = touches.data ?? [];
      const shifts = time.data ?? [];
      const hours = shifts.reduce((sum, s) => {
        if (!s.ended_at) return sum;
        return sum + (new Date(s.ended_at).getTime() - new Date(s.started_at).getTime()) / 3.6e6;
      }, 0);
      return {
        result: {
          ok: true,
          data: {
            person: profile.data,
            window_days: days,
            touchpoints_total: t.length,
            touchpoints_by_type: byType(t, "type"),
            touchpoints_counting_toward_cadence: t.filter((x) => x.counts_toward_cadence).length,
            contact_attempts: (attempts.data ?? []).length,
            contact_attempts_by_channel: byType(attempts.data ?? [], "channel"),
            jobs_created: (jobs.data ?? []).length,
            timecards: { shifts: shifts.length, hours_logged: Math.round(hours * 10) / 10 },
            goals: goals.data ?? [],
            note: "Only records this manager can already see are counted.",
          },
        },
      };
    }

    case "list_writable_entities":
      return { result: { ok: true, data: { entities: entityNames() } } };

    case "describe_entity": {
      const d = describeEntity(String(args.entity ?? ""));
      if (!d)
        return {
          result: {
            ok: false,
            error: `I can't write to "${args.entity}". Call list_writable_entities.`,
          },
        };
      return { result: { ok: true, data: d } };
    }

    case "list_options": {
      const field = String(args.field ?? "");
      const values = OPTION_VALUES[field];
      if (!values)
        return {
          result: {
            ok: false,
            error: `No option list for "${field}". Known: ${Object.keys(OPTION_VALUES).join(", ")}`,
          },
        };
      return { result: { ok: true, data: { field, values } } };
    }

    case "propose_create":
    case "propose_update":
    case "propose_tag":
    case "propose_archive": {
      if (!scope.caps.canWrite)
        return { result: { ok: false, error: "Writes are disabled while View As is active." } };
      const entity = String(args.entity ?? "");
      const def = describeEntity(entity);
      if (!def)
        return {
          result: {
            ok: false,
            error: `I can't write to "${entity}". Call list_writable_entities first.`,
          },
        };

      let step: PlanStep;
      if (name === "propose_create") {
        const fields = isToolArguments(args.fields) ? args.fields : {};
        const unknown = Object.keys(fields).filter((k) => !def.creatable_fields.includes(k));
        if (unknown.length === Object.keys(fields).length && unknown.length > 0)
          return {
            result: {
              ok: false,
              error: `None of those fields exist on a ${def.label}. Valid: ${def.creatable_fields.join(", ")}`,
            },
          };
        step = {
          op: "create",
          entity,
          fields,
          children: Array.isArray(args.children)
            ? args.children.filter(isToolArguments)
            : undefined,
          summary: String(args.summary ?? `Create ${def.label}`),
          preview: previewOf(fields, args.children),
        };
      } else if (name === "propose_update") {
        const fields = isToolArguments(args.fields) ? args.fields : {};
        const unknown = Object.keys(fields).filter((k) => !def.editable_fields.includes(k));
        if (unknown.length === Object.keys(fields).length && unknown.length > 0)
          return {
            result: {
              ok: false,
              error: `Those fields can't be edited on a ${def.label}. Editable: ${def.editable_fields.join(", ")}`,
            },
          };
        step = {
          op: "update",
          entity,
          id: String(args.id ?? ""),
          fields,
          summary: String(args.summary ?? `Update ${def.label}`),
          preview: previewOf(fields),
        };
      } else if (name === "propose_tag") {
        const tags = (Array.isArray(args.tags) ? args.tags : []).map(String).filter(Boolean);
        if (!tags.length) return { result: { ok: false, error: "No tag names given." } };
        step = {
          op: "tag",
          entity,
          id: String(args.id ?? ""),
          tags,
          summary: String(args.summary ?? `Tag ${def.label}`),
          preview: [{ label: "Tags", value: tags.join(", ") }],
        };
      } else {
        step = {
          op: "archive",
          entity,
          id: String(args.id ?? ""),
          summary: String(args.summary ?? `Archive ${def.label}`),
          preview: [{ label: "Action", value: `Archive this ${def.label}` }],
        };
      }

      return {
        result: {
          ok: true,
          data: {
            queued: true,
            step_number: "added to the plan; the user confirms before anything is saved",
            step,
          },
        },
        steps: [step],
      };
    }

    case "propose_email_draft": {
      const step: PlanStep = {
        op: "draft_email",
        summary: "Draft email (internal — you send it yourself)",
        preview: [
          ...(args.to ? [{ label: "To", value: String(args.to) }] : []),
          { label: "Subject", value: String(args.subject ?? "").slice(0, 300) },
          { label: "Body", value: String(args.body ?? "").slice(0, 8000) },
        ],
        fields: {
          to: args.to ?? null,
          subject: String(args.subject ?? "").slice(0, 300),
          body: String(args.body ?? "").slice(0, 8000),
        },
      };
      return { result: { ok: true, data: { queued: true } }, steps: [step] };
    }

    case "navigate": {
      const path = String(args.path ?? "/");
      // Intentionally reject control characters in a browser navigation URL.
      // eslint-disable-next-line no-control-regex
      if (!path.startsWith("/") || path.startsWith("//") || /[\\\u0000-\u0020]/.test(path))
        return { result: { ok: false, error: "Invalid path." } };
      return {
        result: { ok: true, data: { path } },
        navigate: { path, label: String(args.label ?? path) },
      };
    }

    default:
      return { result: { ok: false, error: `Unknown tool ${name}` } };
  }
}

/** Backwards-compatible export: plan execution lives in assistant-writes.server. */
export { executePlan } from "@/lib/assistant-writes.server";
