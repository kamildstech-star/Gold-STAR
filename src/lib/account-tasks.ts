import { useQuery, useQueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { accountSnapshotKey } from "@/components/account-snapshot";

/**
 * An account's tasks, and the activity types they are scheduled as.
 *
 * Melly (6 Nov): "the whole point of tasks are you should be able to go ...
 * it's a mini pop-up view, so you can add a note, log it, just finish it up
 * and then press complete, boom, then you have your next task." The account
 * page lists them (General shows the open ones, the Tasks tab all of them)
 * and the pop-up walks them in order, so both read the same rows from here.
 */

export type ActivityTypeRow = {
  id: string;
  key: string;
  label: string;
  is_default: boolean;
  metadata: { icon?: string } | null;
};

/** The managed "Activity type" list (Settings › Option lists): Call, Meeting, … */
export function useActivityTypes() {
  return useQuery({
    queryKey: ["option-list", "activity_type"],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("option_list_values")
        .select("id,key,label,sort_order,is_default,metadata,active,option_lists!inner(key)")
        .eq("option_lists.key", "activity_type")
        .eq("active", true)
        .order("sort_order");
      if (error) throw error;
      return (data ?? []) as unknown as ActivityTypeRow[];
    },
  });
}

/** Activity types that are a meeting with the client, for the Meetings tab. */
export const MEETING_ACTIVITY_KEYS = ["meeting", "site_visit"] as const;

export type AccountTask = {
  id: string;
  title: string;
  description: string | null;
  dueDate: string | null;
  dueTime: string | null;
  status: "open" | "in_progress" | "done" | "cancelled";
  priority: string;
  assignee: string | null;
  assigneeName: string | null;
  activityTypeId: string | null;
  activityKey: string | null;
  activityLabel: string | null;
  contactId: string | null;
  completedAt: string | null;
};

export const accountTasksKey = (accountId: string) => ["account-tasks", accountId] as const;

export function isOpenTask(t: Pick<AccountTask, "status">): boolean {
  return t.status === "open" || t.status === "in_progress";
}

/** Today in the office's own calendar, so "overdue" flips at midnight New York. */
export function officeToday(now: Date = new Date()): string {
  return now.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

export function isOverdue(t: Pick<AccountTask, "status" | "dueDate">, today = officeToday()) {
  return isOpenTask(t) && !!t.dueDate && t.dueDate < today;
}

/**
 * Open tasks first, soonest due first (undated last), then the done ones,
 * newest done first. One order for the list and for "next task".
 */
export function sortAccountTasks(rows: readonly AccountTask[]): AccountTask[] {
  const due = (t: AccountTask) => `${t.dueDate ?? "9999-12-31"}T${t.dueTime ?? "23:59"}`;
  return [...rows].sort((a, b) => {
    const ao = isOpenTask(a) ? 0 : 1;
    const bo = isOpenTask(b) ? 0 : 1;
    if (ao !== bo) return ao - bo;
    if (ao === 0) return due(a).localeCompare(due(b));
    return (b.completedAt ?? "").localeCompare(a.completedAt ?? "");
  });
}

/** The open task after `currentId`, in list order — or the first one if it was the last. */
export function nextOpenTask(
  rows: readonly AccountTask[],
  currentId: string,
  excludeIds: ReadonlySet<string> = new Set(),
): AccountTask | null {
  const open = sortAccountTasks(rows).filter(
    (t) => isOpenTask(t) && t.id !== currentId && !excludeIds.has(t.id),
  );
  return open[0] ?? null;
}

export async function fetchAccountTasks(accountId: string): Promise<AccountTask[]> {
  const { data, error } = await supabase
    .from("tasks")
    .select(
      "id,title,description,due_date,due_time,status,priority,assignee,activity_type_id,contact_id,completed_at",
    )
    .eq("account_id", accountId)
    .neq("status", "cancelled")
    .order("due_date", { ascending: true, nullsFirst: false })
    .limit(300);
  if (error) throw error;
  const rows = data ?? [];

  const people = [...new Set(rows.map((r) => r.assignee).filter(Boolean))] as string[];
  const types = [...new Set(rows.map((r) => r.activity_type_id).filter(Boolean))] as string[];
  const [peopleRes, typesRes] = await Promise.all([
    people.length
      ? supabase.from("profiles").select("user_id,full_name").in("user_id", people)
      : Promise.resolve({ data: [] as { user_id: string; full_name: string | null }[] }),
    types.length
      ? supabase.from("option_list_values").select("id,key,label").in("id", types)
      : Promise.resolve({ data: [] as { id: string; key: string; label: string }[] }),
  ]);
  const name = new Map((peopleRes.data ?? []).map((p) => [p.user_id, p.full_name ?? null]));
  const type = new Map((typesRes.data ?? []).map((t) => [t.id, t]));

  return sortAccountTasks(
    rows.map((r) => ({
      id: r.id,
      title: r.title,
      description: r.description,
      dueDate: r.due_date,
      dueTime: r.due_time,
      status: r.status as AccountTask["status"],
      priority: r.priority,
      assignee: r.assignee,
      assigneeName: r.assignee ? (name.get(r.assignee) ?? null) : null,
      activityTypeId: r.activity_type_id,
      activityKey: r.activity_type_id ? (type.get(r.activity_type_id)?.key ?? null) : null,
      activityLabel: r.activity_type_id ? (type.get(r.activity_type_id)?.label ?? null) : null,
      contactId: r.contact_id,
      completedAt: r.completed_at,
    })),
  );
}

export function useAccountTasks(accountId: string) {
  return useQuery({
    queryKey: accountTasksKey(accountId),
    queryFn: () => fetchAccountTasks(accountId),
  });
}

/**
 * Everything on the page that shows an account's activity, refreshed at once.
 *
 * Melly, 6 Nov: a saved note "should show in real time" — it did not until
 * the page was reloaded, because the record's save callback refreshed the
 * touchpoints and the header but never the timeline's own feed. Every write
 * on the account page now goes through this one list.
 */
export function useRefreshAccountActivity(accountId: string) {
  const qc = useQueryClient();
  return () => {
    for (const key of [
      accountTasksKey(accountId),
      ["account-timeline", accountId],
      ["account-timeline-read", accountId],
      ["account-notes", accountId],
      ["account-focus", accountId],
      ["account-next-task", accountId],
      ["touchpoints", accountId],
      ["contacts", accountId],
      ["account", accountId],
      ["account-proposals", accountId],
      accountSnapshotKey(accountId),
      ["accounts-cadence"],
      ["needs-you-today"],
      ["tasks"],
    ]) {
      void qc.invalidateQueries({ queryKey: key as readonly unknown[] });
    }
  };
}
