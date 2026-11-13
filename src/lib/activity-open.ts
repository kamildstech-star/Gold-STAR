import { supabase } from "@/integrations/supabase/client";
import { recordActivityGroup, type ActivityEntry } from "@/lib/activity";
import type { JobTab } from "@/lib/job-tab-order";
import { jobSearchFor, type JobPageSearch } from "@/lib/job-page-search";

/**
 * Where History's "Open record" goes for one entry.
 *
 * The feed (`record_activity`) files most of a job's events — a photo, a
 * work order, a note — under the JOB, so the old link was `/jobs/<that job>`:
 * the page the Timeline is already on. The job page kept its tab in local
 * state and took no search params, so the click landed on itself and nothing
 * moved. Tasks were filed as `task` and had no link at all; contacts, leads
 * and invoices linked to routes that do not exist.
 *
 * Now each entry resolves to the record itself: a photo opens in the
 * Pictures viewer, a work order in the AI reports panel, a document in the
 * document viewer, a task highlighted on the Tasks tab, the rest on their own
 * page or tab. A record that is gone says so ("deleted") instead of landing
 * nowhere.
 */
/** What a record that is gone says, wherever "Open record" finds it gone. */
export const RECORD_DELETED_MESSAGE = "That record was deleted";

export type ActivityTarget =
  | { kind: "job"; jobId: string; search: JobPageSearch }
  | { kind: "account"; id: string }
  | { kind: "estimate"; id: string }
  | { kind: "contact"; id: string }
  | { kind: "user"; id: string }
  | {
      kind: "page";
      to: "/pipeline" | "/tasks" | "/documents" | "/billing" | "/mail" | "/admin/automations";
    }
  | { kind: "deleted" };

/** The reads resolving needs, injectable so the mapping is tested without a database. */
export type RecordLookup = {
  /** A live (not deleted) album photo by its original's storage path. */
  photoIdByPath(path: string): Promise<string | null>;
  /** The job report a "Work order / report generated (vN, lang)" line is about. */
  reportId(
    jobId: string,
    q: { version: number | null; language: string | null; type: string | null },
  ): Promise<string | null>;
  /** The row's job, or null when the row is gone. `jobId` null = not on a job. */
  jobOf(
    table: "tasks" | "documents" | "invoices" | "email_messages",
    id: string,
  ): Promise<{ jobId: string | null } | null>;
  exists(table: "jobs" | "accounts" | "contacts" | "estimates", id: string): Promise<boolean>;
};

/** Whether an entry gets an "Open record" control at all. Pure, for rendering. */
export function activityHasTarget(e: ActivityEntry): boolean {
  if (!e.record_id) return false;
  return [
    "job",
    "task",
    "document",
    "estimate",
    "invoice",
    "email",
    "account",
    "contact",
    "lead",
    "user",
    "automation_rule",
  ].includes(e.record_type ?? "");
}

/** The tab of the job page an event on the job itself belongs to. */
export function jobTabForEvent(e: ActivityEntry): JobTab {
  const group = recordActivityGroup(e);
  const byGroup: Record<string, JobTab> = {
    photos: "pictures",
    documents: "documents",
    billing: "billing",
    money: "billing",
    time: "timecard",
    equipment: "equipment",
    tasks: "tasks",
    comms: "communications",
    status: "timeline",
  };
  return byGroup[group] ?? "general";
}

/** "Work order / report generated (v3, es)" → { version: 3, language: "es" }. */
export function reportVersionOf(e: ActivityEntry): {
  version: number | null;
  language: string | null;
} {
  const m = /\(v(\d+)(?:,\s*([a-z]{2}))?\)/i.exec(e.summary ?? "");
  const detailLang =
    typeof e.detail?.["language"] === "string" ? (e.detail["language"] as string) : null;
  return {
    version: m ? Number(m[1]) : null,
    language: detailLang ?? (m?.[2] ? m[2].toLowerCase() : null),
  };
}

export async function resolveActivityTarget(
  e: ActivityEntry,
  lookup: RecordLookup,
): Promise<ActivityTarget | null> {
  const id = e.record_id;
  if (!id || !activityHasTarget(e)) return null;
  const type = e.record_type;
  const event = e.event_type ?? "";

  if (type === "job") {
    // A deleted photo's line stays in the history; the photo itself is gone.
    if (event === "photo.deleted") return { kind: "deleted" };
    if (event.startsWith("photo.")) {
      const path = typeof e.detail?.["path"] === "string" ? (e.detail["path"] as string) : null;
      if (!path) return { kind: "job", jobId: id, search: jobSearchFor("pictures") };
      const photo = await lookup.photoIdByPath(path);
      return photo
        ? { kind: "job", jobId: id, search: jobSearchFor("pictures", { photo }) }
        : { kind: "deleted" };
    }
    if (event.startsWith("work_order.")) {
      const { version, language } = reportVersionOf(e);
      const kind = typeof e.detail?.["type"] === "string" ? (e.detail["type"] as string) : null;
      const report = await lookup.reportId(id, { version, language, type: kind });
      return report
        ? { kind: "job", jobId: id, search: jobSearchFor("documents", { report }) }
        : { kind: "deleted" };
    }
    if (!(await lookup.exists("jobs", id))) return { kind: "deleted" };
    return { kind: "job", jobId: id, search: jobSearchFor(jobTabForEvent(e)) };
  }

  if (type === "task") {
    const row = await lookup.jobOf("tasks", id);
    if (!row) return { kind: "deleted" };
    return row.jobId
      ? { kind: "job", jobId: row.jobId, search: jobSearchFor("tasks", { task: id }) }
      : { kind: "page", to: "/tasks" };
  }
  if (type === "document") {
    const row = await lookup.jobOf("documents", id);
    if (!row) return { kind: "deleted" };
    return row.jobId
      ? { kind: "job", jobId: row.jobId, search: jobSearchFor("documents", { doc: id }) }
      : { kind: "page", to: "/documents" };
  }
  if (type === "invoice") {
    const row = await lookup.jobOf("invoices", id);
    if (!row) return { kind: "deleted" };
    return row.jobId
      ? { kind: "job", jobId: row.jobId, search: jobSearchFor("billing") }
      : { kind: "page", to: "/billing" };
  }
  if (type === "email") {
    const row = await lookup.jobOf("email_messages", id);
    if (!row) return { kind: "deleted" };
    return row.jobId
      ? { kind: "job", jobId: row.jobId, search: jobSearchFor("communications") }
      : { kind: "page", to: "/mail" };
  }
  if (type === "estimate") {
    return (await lookup.exists("estimates", id)) ? { kind: "estimate", id } : { kind: "deleted" };
  }
  if (type === "account") {
    return (await lookup.exists("accounts", id)) ? { kind: "account", id } : { kind: "deleted" };
  }
  if (type === "contact") {
    return (await lookup.exists("contacts", id)) ? { kind: "contact", id } : { kind: "deleted" };
  }
  if (type === "lead") return { kind: "page", to: "/pipeline" };
  if (type === "user") return { kind: "user", id };
  if (type === "automation_rule") return { kind: "page", to: "/admin/automations" };
  return null;
}

/**
 * The real reads. Row-level security applies as everywhere: a row the viewer
 * cannot see reads the same as a row that is gone. A failed read throws, so
 * the caller can say it failed rather than claim the record was deleted.
 */
export const supabaseRecordLookup: RecordLookup = {
  async photoIdByPath(path) {
    const { data, error } = await supabase
      .from("photos")
      .select("id")
      .eq("storage_path_original", path)
      .is("deleted_at", null)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return data?.id ?? null;
  },
  async reportId(jobId, q) {
    let query = supabase.from("job_reports").select("id").eq("job_id", jobId);
    if (q.version != null) query = query.eq("version", q.version);
    if (q.language) query = query.eq("language", q.language);
    if (q.type) query = query.eq("report_type", q.type as never);
    const { data, error } = await query
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return data?.id ?? null;
  },
  async jobOf(table, id) {
    const { data, error } = await supabase.from(table).select("job_id").eq("id", id).maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return { jobId: (data as { job_id: string | null }).job_id ?? null };
  },
  async exists(table, id) {
    const { data, error } = await supabase.from(table).select("id").eq("id", id).maybeSingle();
    if (error) throw error;
    return data != null;
  },
};
