/**
 * A rep's own to-do list.
 *
 * Mark: "Can we add a to do list (linked to jobs) which would be user
 * specific & potentially tied to tasks the in jobs where you can choose to
 * add that task to the to do list"
 *
 * "Tasks assigned to me" already exists — that is /tasks. This is the other
 * thing: a personal list the rep curates. It holds PINS (a job task from
 * anywhere, including one assigned to someone else that I want to keep an
 * eye on) and QUICK items (my own "call the adjuster back", optionally tied
 * to a job). Pinning never changes the task. Ticking a pin completes the real
 * task through the app's one `completeTask`, and the pin reads done from the
 * task's status; unpinning removes it from my list only.
 *
 * Table: `todo_items` (migration 20260918120000). It postdates the generated
 * Supabase types and may not be applied yet, so it is reached through an
 * untyped client and a missing table is "not set up yet", never an error on
 * the page — the same pattern as `planned-routes.ts`.
 *
 * Writes go through the offline queue (kind `todo`, writer in
 * `todo-writes.ts`): a rep in a basement can tick things off and the ticks
 * go up when service returns. What the list looks like — grouping by job,
 * the order, which items are done today — is pure and lives here so it can
 * be tested without a DOM.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { supabase } from "@/integrations/supabase/client";
import { taskDueAt } from "@/lib/account-timeline";
import { newId, writeOrQueue } from "@/lib/offline-queue";
import { applyTodoOp, todoOpLabel, type TodoOp } from "@/lib/todo-writes";

/* ------------------------------------------------------------------ types */

/** The job a row hangs off — a pin's from its task, a quick item's from itself. */
export type TodoJob = {
  id: string;
  job_number: string | null;
  address: string | null;
  job_name: string | null;
  loss_type: string | null;
  location_id: string | null;
  account_id: string | null;
};

/** The task behind a pin, as the embedded select returns it. */
export type TodoTask = {
  id: string;
  title: string;
  status: string;
  due_date: string | null;
  due_time: string | null;
  assignee: string | null;
  job_id: string | null;
  account_id: string | null;
  completed_at: string | null;
  job: TodoJob | null;
};

/** One `todo_items` row with its task and job embedded. */
export type TodoRow = {
  id: string;
  user_id: string;
  task_id: string | null;
  job_id: string | null;
  title: string | null;
  done_at: string | null;
  sort_order: number;
  created_at: string;
  task: TodoTask | null;
  job: TodoJob | null;
};

/** What the list renders. Everything the row needs, flattened. */
export type TodoItem = {
  id: string;
  kind: "pin" | "quick";
  taskId: string | null;
  title: string;
  job: TodoJob | null;
  /** When it is due, as an instant — a pin's from its task; a quick item has none. */
  dueAt: string | null;
  done: boolean;
  /** When it was ticked: the task's completed_at, or the quick item's done_at. */
  doneAt: string | null;
  /** The task's assignee when it is somebody else's task; null for mine or a quick item. */
  assignee: string | null;
  sortOrder: number;
  createdAt: string;
};

/* ---------------------------------------------------------- availability */

/** 42P01 / PGRST205 mean the migration is outstanding, not that the query was wrong. */
export function todoUnavailable(err: unknown): boolean {
  const e = err as { code?: string; message?: string; details?: string } | null;
  if (!e) return false;
  if (e.code === "42P01" || e.code === "PGRST205") return true;
  return /does not exist|could not find the table/i.test(`${e.message ?? ""} ${e.details ?? ""}`);
}

const db = () => supabase as unknown as SupabaseClient;

const JOB_COLUMNS = "id,job_number,address,job_name,loss_type,location_id,account_id";
const COLUMNS = `id,user_id,task_id,job_id,title,done_at,sort_order,created_at,task:tasks(id,title,status,due_date,due_time,assignee,job_id,account_id,completed_at,job:jobs(${JOB_COLUMNS})),job:jobs(${JOB_COLUMNS})`;

/**
 * The signed-in user's list. RLS already limits it to their own rows; the
 * `eq` is belt and braces so a cached query can never be another user's.
 * `available: false` is the migration not being applied yet.
 */
export async function fetchTodo(
  userId: string,
): Promise<{ available: boolean; items: TodoItem[] }> {
  const { data, error } = await db()
    .from("todo_items")
    .select(COLUMNS)
    .eq("user_id", userId)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) {
    if (todoUnavailable(error)) return { available: false, items: [] };
    throw error;
  }
  return { available: true, items: toItems((data ?? []) as unknown as TodoRow[], userId) };
}

/**
 * Rows to items. A pin whose task the embed did not return — the task was
 * deleted (the cascade will catch up) or is no longer visible to this user
 * under the tasks policy — is dropped rather than shown as a blank line.
 */
export function toItems(rows: TodoRow[], userId: string): TodoItem[] {
  const out: TodoItem[] = [];
  for (const r of rows) {
    if (r.task_id) {
      const t = r.task;
      if (!t) continue;
      const done = t.status === "done" || t.status === "cancelled";
      out.push({
        id: r.id,
        kind: "pin",
        taskId: t.id,
        title: t.title,
        job: t.job ?? null,
        dueAt: taskDueAt(t.due_date, t.due_time),
        done,
        doneAt: done ? (t.completed_at ?? r.created_at) : null,
        assignee: t.assignee && t.assignee !== userId ? t.assignee : null,
        sortOrder: r.sort_order,
        createdAt: r.created_at,
      });
    } else {
      out.push({
        id: r.id,
        kind: "quick",
        taskId: null,
        title: r.title ?? "",
        job: r.job ?? null,
        dueAt: null,
        done: !!r.done_at,
        doneAt: r.done_at,
        assignee: null,
        sortOrder: r.sort_order,
        createdAt: r.created_at,
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ pure */

/** "24 Lodz Drive — Mold": the address (or what stands in for it) and the loss type. */
export function jobLabel(job: TodoJob | null): string {
  if (!job) return "No job";
  const where = job.address || job.job_name || job.job_number || "Job";
  const loss = job.loss_type ? job.loss_type.replace(/[_-]+/g, " ") : "";
  const cased = loss ? loss.charAt(0).toUpperCase() + loss.slice(1) : "";
  return cased ? `${where} — ${cased}` : where;
}

/** "DO" from "Dana Ortiz"; "M" from "melly"; "?" from nothing. */
export function initials(name: string | null | undefined): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.charAt(0).toUpperCase();
  return (parts[0]!.charAt(0) + parts[parts.length - 1]!.charAt(0)).toUpperCase();
}

function sameLocalDay(iso: string, now: Date): boolean {
  const d = new Date(iso);
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

/**
 * Open items, the ones ticked today, and the ones ticked before that. Done
 * items drop to "Done today" rather than vanishing — a rep wants to see the
 * day's ticks — but yesterday's are not the day's work and stay out of view.
 * A pin's done state is the task's, so a task somebody else completed shows
 * up here the same as one I ticked.
 */
export function partitionTodo(
  items: TodoItem[],
  now: Date = new Date(),
): { open: TodoItem[]; doneToday: TodoItem[]; doneEarlier: TodoItem[] } {
  const open: TodoItem[] = [];
  const doneToday: TodoItem[] = [];
  const doneEarlier: TodoItem[] = [];
  for (const it of items) {
    if (!it.done) open.push(it);
    else if (it.doneAt && sameLocalDay(it.doneAt, now)) doneToday.push(it);
    else doneEarlier.push(it);
  }
  return { open, doneToday, doneEarlier };
}

export type TodoGroup = {
  /** The job id, or "" for the no-job group. */
  key: string;
  job: TodoJob | null;
  label: string;
  items: TodoItem[];
};

/**
 * Grouped by job, each group in the rep's own order (sort_order, then
 * creation), groups ordered by their first item so dragging a job's first
 * row up moves the job up. "No job" is always last: it is the pile of loose
 * notes, and it belongs under the work.
 */
export function groupTodo(items: TodoItem[]): TodoGroup[] {
  const sorted = sortTodo(items);
  const groups = new Map<string, TodoGroup>();
  for (const it of sorted) {
    const key = it.job?.id ?? "";
    let g = groups.get(key);
    if (!g) {
      g = { key, job: it.job, label: jobLabel(it.job), items: [] };
      groups.set(key, g);
    }
    g.items.push(it);
  }
  const out = [...groups.values()];
  const noJob = out.findIndex((g) => g.key === "");
  if (noJob >= 0 && noJob !== out.length - 1) out.push(...out.splice(noJob, 1));
  return out;
}

export function sortTodo(items: TodoItem[]): TodoItem[] {
  return [...items].sort(
    (a, b) => a.sortOrder - b.sortOrder || (a.createdAt < b.createdAt ? -1 : 1),
  );
}

/**
 * One drag: `activeId` dropped onto `overId` inside the same group. Returns
 * the whole open list in its new order, flattened group by group, so the
 * sort_order that gets written is one sequence across the list and the
 * groups keep their relative order. Null when the drop changes nothing or
 * crosses groups — a quick item cannot change job by being dragged, and a
 * pin's job is its task's.
 */
export function moveWithinGroup(
  groups: TodoGroup[],
  activeId: string,
  overId: string,
): TodoItem[] | null {
  if (activeId === overId) return null;
  const gi = groups.findIndex((g) => g.items.some((i) => i.id === activeId));
  if (gi < 0) return null;
  const g = groups[gi]!;
  const from = g.items.findIndex((i) => i.id === activeId);
  const to = g.items.findIndex((i) => i.id === overId);
  if (to < 0) return null;
  const moved = [...g.items];
  const [row] = moved.splice(from, 1);
  moved.splice(to, 0, row!);
  return groups.flatMap((grp, i) => (i === gi ? moved : grp.items));
}

/**
 * The sort_order writes a new order needs: position in the list, and only
 * for the rows whose number changed. A list of forty where one row moved
 * one place is two updates, not forty.
 */
export function resequence(ordered: TodoItem[]): { id: string; sortOrder: number }[] {
  const out: { id: string; sortOrder: number }[] = [];
  ordered.forEach((it, i) => {
    if (it.sortOrder !== i) out.push({ id: it.id, sortOrder: i });
  });
  return out;
}

/** The sort_order a new item takes: after everything already there. */
export function nextSortOrder(items: TodoItem[]): number {
  return items.reduce((m, it) => Math.max(m, it.sortOrder + 1), 0);
}

/** "My to-do · 3 left" on the dashboard card. */
export function todoSummary(items: TodoItem[]): string {
  const left = partitionTodo(items).open.length;
  return left === 0 ? "All clear" : `${left} left`;
}

/* ---------------------------------------------------------------- writes */

export type TodoWriteResult = { queued: boolean };

/**
 * Every write is one queue item. `id` on the queue item is the todo row's id
 * where the op creates a row, so the immediate attempt and a later drain
 * address the same row — that is what makes a lost response harmless.
 */
async function queueTodoOp(op: TodoOp, queueId?: string): Promise<TodoWriteResult> {
  return writeOrQueue({
    kind: "todo",
    id: queueId ?? newId(),
    payload: op as unknown as Record<string, unknown>,
    label: todoOpLabel(op),
    write: () => applyTodoOp(op, db()),
  });
}

/** A quick item. Returns the row id it was given, so the list can show it at once. */
export async function addQuickItem(input: {
  userId: string;
  title: string;
  jobId: string | null;
}): Promise<TodoWriteResult & { id: string }> {
  const id = newId();
  const title = input.title.trim();
  const r = await queueTodoOp(
    { op: "add", id, userId: input.userId, title, jobId: input.jobId },
    id,
  );
  return { ...r, id };
}

/** Pin a task. Idempotent on (user, task). */
export async function pinTask(input: {
  userId: string;
  taskId: string;
}): Promise<TodoWriteResult & { id: string }> {
  const id = newId();
  const r = await queueTodoOp({ op: "pin", id, userId: input.userId, taskId: input.taskId }, id);
  return { ...r, id };
}

/** Remove a row from my list — an unpin, or a quick item gone for good. */
export async function removeItem(id: string): Promise<TodoWriteResult> {
  return queueTodoOp({ op: "remove", id });
}

/** Tick or untick a quick item. A pin is ticked through `completeTask`, never here. */
export async function setQuickDone(id: string, done: boolean): Promise<TodoWriteResult> {
  return queueTodoOp({ op: "done", id, doneAt: done ? new Date().toISOString() : null });
}

export async function saveOrder(
  order: { id: string; sortOrder: number }[],
): Promise<TodoWriteResult> {
  if (order.length === 0) return { queued: false };
  return queueTodoOp({ op: "reorder", order });
}

/**
 * "Make this a task". The task id is chosen here, before the call, so the
 * database can tell a replay from a second promotion — see
 * `promote_todo_item` in the migration, which does the two writes in one
 * transaction. Returns the id the task will have.
 */
export async function promoteToTask(input: {
  id: string;
  dueDate: string | null;
}): Promise<TodoWriteResult & { taskId: string }> {
  const taskId = newId();
  const r = await queueTodoOp({ op: "promote", id: input.id, taskId, dueDate: input.dueDate });
  return { ...r, taskId };
}

/** What the toast says when a write is holding on the device. */
export const TODO_QUEUED_MESSAGE = "Held on this device — it syncs when you have signal.";

/**
 * Query keys a to-do write touches. The list itself, and — because a pin's
 * done state is the task's and a promotion creates a task — everything the
 * app draws tasks from, the same set `completeTask`'s callers refresh.
 */
export const TODO_QUERY_KEYS = [
  "todo",
  "tasks",
  "job-tasks",
  "needs-you-today",
  "account-timeline",
  "account-focus",
  "account-next-task",
] as const;
