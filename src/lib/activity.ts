import { supabase } from "@/integrations/supabase/client";

/**
 * Global activity history.
 *
 * This is a *view* over the trails the app already keeps — job field changes,
 * status and stage history, automation runs, assistant audit, document and
 * send logs, money events, role and credential changes, layout publishes,
 * exports, View As sessions. The only thing written fresh is `activity_log`,
 * and only for events nothing else records (sign-ins, demo seed/purge).
 *
 * The `global_activity` function raises unless the caller is admin/owner, so
 * the gate is the database, not this module.
 */

export type ActivityVia = "user" | "assistant" | "automation" | "system";

export type ActivityEntry = {
  occurred_at: string;
  module: string;
  event_type: string;
  actor_id: string | null;
  actor_name: string | null;
  via: string;
  summary: string;
  detail: Record<string, unknown> | null;
  record_type: string | null;
  record_id: string | null;
  record_label: string | null;
  location_id: string | null;
};

export type ActivityFilters = {
  from: string;
  to: string;
  modules?: string[];
  eventTypes?: string[];
  actor?: string | null;
  record?: string | null;
  location?: string | null;
  search?: string;
  limit?: number;
  offset?: number;
};

export const ACTIVITY_MODULES = [
  "jobs",
  "accounts",
  "pipeline",
  "billing",
  "documents",
  "automation",
  "assistant",
  "integrations",
  "chase",
  "auth",
  "admin",
] as const;

export const MODULE_LABEL: Record<string, string> = {
  jobs: "Jobs",
  accounts: "Accounts",
  pipeline: "Pipeline",
  billing: "Billing",
  documents: "Documents",
  automation: "Automation",
  assistant: "Assistant",
  integrations: "Integrations",
  chase: "Chase",
  auth: "Sign-in",
  admin: "Admin",
  system: "System",
};

export const VIA_LABEL: Record<string, string> = {
  user: "User",
  assistant: "via Assistant",
  automation: "via Automation",
  system: "System",
};

export async function fetchActivity(f: ActivityFilters): Promise<ActivityEntry[]> {
  const { data, error } = await supabase.rpc("global_activity", {
    _from: f.from,
    _to: f.to,
    _modules: f.modules?.length ? f.modules : undefined,
    _event_types: f.eventTypes?.length ? f.eventTypes : undefined,
    _actor: f.actor ?? undefined,
    _record: f.record ?? undefined,
    _location: f.location ?? undefined,
    _search: f.search?.trim() || undefined,
    _limit: f.limit ?? 300,
    _offset: f.offset ?? 0,
  });
  if (error) throw error;
  return (data ?? []) as ActivityEntry[];
}

/**
 * Records something no other trail covers. Never throws into the caller's
 * flow — a missing audit line must not break a sign-in or a seed run.
 */
export async function logActivity(entry: {
  module: string;
  event_type: string;
  summary: string;
  via?: ActivityVia;
  detail?: Record<string, unknown>;
  record_type?: string | null;
  record_id?: string | null;
  record_label?: string | null;
  location_id?: string | null;
}): Promise<void> {
  try {
    const { data: auth } = await supabase.auth.getUser();
    await supabase.from("activity_log").insert({
      actor_id: auth.user?.id ?? null,
      module: entry.module,
      event_type: entry.event_type,
      summary: entry.summary,
      via: entry.via ?? "user",
      detail: (entry.detail ?? {}) as never,
      record_type: entry.record_type ?? null,
      record_id: entry.record_id ?? null,
      record_label: entry.record_label ?? null,
      location_id: entry.location_id ?? null,
    });
  } catch {
    /* audit is best-effort on the client; the DB trails are authoritative */
  }
}

/** One sign-in row per browser session, not per token refresh or tab mount. */
export function logSignInOnce(userId: string) {
  if (typeof window === "undefined") return;
  const key = `rh:signin-logged:${userId}`;
  try {
    if (window.sessionStorage.getItem(key)) return;
    window.sessionStorage.setItem(key, "1");
  } catch {
    return;
  }
  void logActivity({
    module: "auth",
    event_type: "auth.signed_in",
    summary: "Signed in",
    detail: { user_agent: navigator.userAgent },
  });
}

/* "Open record" for an entry is src/lib/activity-open.ts. */

/** before -> after pair when the entry carries one. */
export function changePair(detail: Record<string, unknown> | null) {
  if (!detail) return null;
  const has = "before" in detail || "after" in detail;
  if (!has) return null;
  const fmt = (v: unknown) =>
    v === null || v === undefined || v === "" ? "—" : typeof v === "string" ? v : JSON.stringify(v);
  return { before: fmt(detail["before"]), after: fmt(detail["after"]) };
}

export function activityCsv(rows: ActivityEntry[]): string {
  const head = [
    "timestamp",
    "module",
    "event",
    "via",
    "user",
    "summary",
    "record_type",
    "record_id",
    "record",
    "detail",
  ];
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = rows.map((r) =>
    [
      r.occurred_at,
      r.module,
      r.event_type,
      r.via,
      r.actor_name ?? r.actor_id ?? "",
      r.summary,
      r.record_type ?? "",
      r.record_id ?? "",
      r.record_label ?? "",
      JSON.stringify(r.detail ?? {}),
    ]
      .map(esc)
      .join(","),
  );
  return [head.join(","), ...lines].join("\n");
}

/* ------------------------------------------------------------------ *
 * Per-record history
 *
 * Same trails as the global feed, scoped to one record and gated by the
 * caller's own view permission (can_view_job / _contact / _location).
 * ------------------------------------------------------------------ */

export type RecordActivityType = "job" | "account" | "contact" | "estimate" | "invoice";

export async function fetchRecordActivity(
  type: RecordActivityType,
  id: string,
  opts: { search?: string; limit?: number; offset?: number } = {},
): Promise<ActivityEntry[]> {
  const { data, error } = await supabase.rpc("record_activity", {
    _record_type: type,
    _record_id: id,
    _search: opts.search?.trim() || undefined,
    _limit: opts.limit ?? 400,
    _offset: opts.offset ?? 0,
  });
  if (error) throw error;
  return (data ?? []) as ActivityEntry[];
}

export const RECORD_ACTIVITY_GROUPS = [
  { key: "fields", label: "Field edits" },
  { key: "status", label: "Status & stage" },
  { key: "notes", label: "Notes & notices" },
  { key: "crew", label: "Crew" },
  { key: "photos", label: "Photos" },
  { key: "documents", label: "Documents & signatures" },
  { key: "billing", label: "Estimates & invoices" },
  { key: "money", label: "Payments" },
  { key: "time", label: "Time entries" },
  { key: "equipment", label: "Equipment" },
  { key: "supplies", label: "Supplies" },
  { key: "tasks", label: "Tasks" },
  { key: "comms", label: "Email" },
  { key: "calls", label: "Calls & touchpoints" },
  { key: "automation", label: "Automation & Assistant" },
  // The job's own delete/edit history (record_history), the rows that carry
  // a Restore. Not an activity_log bucket: recordActivityGroup never returns it.
  { key: "history", label: "Deleted & changed" },
  { key: "other", label: "Other" },
] as const;

/** Buckets an entry for the activity-type filter. */
export function recordActivityGroup(e: ActivityEntry): string {
  const t = e.event_type;
  if (e.via === "automation" || e.via === "assistant" || t.startsWith("automation."))
    return "automation";
  if (t.includes("field_changed")) return "fields";
  if (t.includes("status_changed") || t.includes("stage")) return "status";
  if (t.startsWith("note.") || t.includes("notice")) return "notes";
  if (t.startsWith("crew.")) return "crew";
  if (t.startsWith("photo.")) return "photos";
  if (t.startsWith("document.") || t.includes("work_order") || t.startsWith("translation."))
    return "documents";
  if (t.startsWith("estimate.") || t.startsWith("invoice.") || t.startsWith("revision."))
    return "billing";
  if (t.startsWith("payment.") || t.startsWith("money.")) return "money";
  if (t.startsWith("time_entry.")) return "time";
  if (t.startsWith("equipment.")) return "equipment";
  if (t.startsWith("supply_request.")) return "supplies";
  if (t.startsWith("task.")) return "tasks";
  if (t.startsWith("email.")) return "comms";
  if (t.startsWith("call.") || t.startsWith("touchpoint.")) return "calls";
  if (t.startsWith("questionnaire.")) return "other";
  return "other";
}
