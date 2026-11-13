import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";

import { DATE_LOCALE, US_DATE } from "@/lib/date-format";
export type Task = Database["public"]["Tables"]["tasks"]["Row"];
export type TaskStatus = Database["public"]["Enums"]["task_status"];
export type TaskPriority = Database["public"]["Enums"]["task_priority"];

export const TASK_STATUSES: TaskStatus[] = ["open", "in_progress", "done", "cancelled"];
export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  done: "Done",
  cancelled: "Canceled",
};

export const TASK_PRIORITIES: TaskPriority[] = ["low", "normal", "high", "urgent"];
export const TASK_PRIORITY_LABEL: Record<TaskPriority, string> = {
  low: "Low",
  normal: "Normal",
  high: "High",
  urgent: "Urgent",
};

export type TaskBucket = "today" | "overdue" | "week" | "all";

export const TASK_BUCKET_LABEL: Record<TaskBucket, string> = {
  today: "Today",
  overdue: "Overdue",
  week: "This week",
  all: "All",
};

function isoDate(d: Date) {
  return d.toISOString().slice(0, 10);
}

export function todayIso() {
  return isoDate(new Date());
}

export function endOfWeekIso() {
  const d = new Date();
  d.setDate(d.getDate() + (7 - d.getDay()));
  return isoDate(d);
}

export function bucketOf(task: Task): Exclude<TaskBucket, "all"> | "later" | "someday" {
  if (!task.due_date) return "someday";
  const today = todayIso();
  if (task.due_date < today) return "overdue";
  if (task.due_date === today) return "today";
  if (task.due_date <= endOfWeekIso()) return "week";
  return "later";
}

export function isOpen(task: Task) {
  return task.status === "open" || task.status === "in_progress";
}

export function dueLabel(task: Task) {
  if (!task.due_date) return "No due date";
  const time = task.due_time ? ` ${task.due_time.slice(0, 5)}` : "";
  const today = todayIso();
  if (task.due_date === today) return `Today${time}`;
  return `${new Date(`${task.due_date}T00:00:00`).toLocaleDateString(DATE_LOCALE, US_DATE)}${time}`;
}

/** Add days to today and return a date string, for "follow up in N weeks". */
export function dueInDays(days: number) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return isoDate(d);
}

/**
 * Cadence keys are deterministic so the generator is idempotent — a quarterly
 * touch that is already overdue must not create a new task every night.
 */
export function cadenceKey(kind: "quarterly" | "annual", accountId: string, periodStamp: string) {
  return `${kind}:${accountId}:${periodStamp}`;
}

/* ------------------------------------------------------------------ */
/*  Creating a task                                                    */
/* ------------------------------------------------------------------ */

/** What a task hangs off. `locationId` is the one that decides who can see it. */
export type TaskLink = {
  entityType?: string | null;
  entityId?: string | null;
  accountId?: string | null;
  contactId?: string | null;
  jobId?: string | null;
  locationId?: string | null;
};

/**
 * Which office a task belongs to, given what the caller supplied and what the
 * creator's profile says.
 *
 * This exists because of the RLS policy, which is easy to read past:
 *
 *   tasks visible in scope:
 *     assignee = auth.uid()
 *     OR created_by = auth.uid()
 *     OR (location_id IS NOT NULL AND can_view_location(auth.uid(), location_id))
 *
 * A task with a NULL `location_id` is therefore visible to exactly two people
 * — the assignee and whoever created it — and to NO manager, regional or
 * owner, however senior. It is not deleted and not filtered by any query in
 * the app; it simply cannot be selected by anyone else, which from a manager's
 * chair is indistinguishable from the task having vanished.
 *
 * Pure so the precedence is testable without a database: an explicit office
 * always wins, then the creator's primary office, then any office they belong
 * to. `null` only survives when the creator belongs to nothing at all.
 */
export function pickTaskLocationId(input: {
  explicit?: string | null;
  primaryLocationId?: string | null;
  membershipLocationIds?: readonly string[];
}): string | null {
  return (
    input.explicit ??
    input.primaryLocationId ??
    (input.membershipLocationIds ?? []).find((id): id is string => !!id) ??
    null
  );
}

/**
 * The creator's own office, read once when a caller could not name one.
 *
 * Every in-app path already passes a `locationId` — but several pass one that
 * can legitimately be null (an account with no office, a director board with
 * no office in scope), and `?? null` in the insert turned that into a task
 * nobody senior could see. This is the backstop, at the single choke point
 * rather than in five call sites.
 */
export async function resolveTaskLocationId(
  explicit: string | null | undefined,
  createdBy: string,
): Promise<string | null> {
  if (explicit) return explicit;

  const { data: profile } = await supabase
    .from("profiles")
    .select("primary_location_id")
    .eq("user_id", createdBy)
    .maybeSingle();

  const { data: memberships } = await supabase
    .from("location_members")
    .select("location_id")
    .eq("user_id", createdBy)
    .order("created_at", { ascending: true })
    .limit(1);

  return pickTaskLocationId({
    explicit: null,
    primaryLocationId: profile?.primary_location_id ?? null,
    membershipLocationIds: (memberships ?? []).map((m) => m.location_id),
  });
}

/**
 * Insert a task. Shared by the dialog, the touchpoint follow-up control and
 * both director boards, so the `location_id` guarantee is made once here.
 *
 * A creator who belongs to no office at all still gets their task — refusing
 * to record work because of a profile gap would be the worse failure — but it
 * is reported, because that row is one only they and the assignee can see.
 */
export async function createTask(input: {
  title: string;
  description?: string | null;
  assignee: string | null;
  dueDate: string | null;
  dueTime?: string | null;
  priority?: TaskPriority;
  source?: string;
  cadenceKey?: string | null;
  createdBy: string;
  activityTypeId?: string | null;
  link?: TaskLink;
}) {
  const locationId = await resolveTaskLocationId(input.link?.locationId, input.createdBy);
  if (!locationId) {
    console.warn(
      "[tasks] creating a task with no location_id — only its assignee and creator will be able to see it",
      { createdBy: input.createdBy, title: input.title },
    );
  }

  return supabase
    .from("tasks")
    .insert({
      title: input.title,
      description: input.description ?? null,
      assignee: input.assignee,
      due_date: input.dueDate,
      due_time: input.dueTime ?? null,
      priority: input.priority ?? "normal",
      source: input.source ?? "manual",
      cadence_key: input.cadenceKey ?? null,
      created_by: input.createdBy,
      activity_type_id: input.activityTypeId ?? null,
      entity_type: input.link?.entityType ?? null,
      entity_id: input.link?.entityId ?? null,
      account_id: input.link?.accountId ?? null,
      contact_id: input.link?.contactId ?? null,
      job_id: input.link?.jobId ?? null,
      location_id: locationId,
    })
    .select("id")
    .single();
}
