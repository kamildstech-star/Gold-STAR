/**
 * The React side of the to-do list: one query for the signed-in user's list,
 * and the hooks every screen uses to read and change it.
 *
 * `useTodoPin(taskId)` is the ONE way a task row anywhere — the job page's
 * Tasks tab, the account Timeline, Needs-you-today, /tasks, the list itself
 * — asks "is this on my list?" and toggles it. Five sites with five private
 * copies of that is how one of them drifts, so the hook owns the read, the
 * optimistic patch and the write; a site only renders what it returns.
 *
 * Every write patches the cached list first and reconciles after, so a tick
 * in a dead zone reads as ticked at once (the queue holds the write) rather
 * than as a spinner that never ends. `queued` is surfaced so a caller can
 * say "held on this device" rather than "saved".
 */
import { useCallback, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useAppContext } from "@/components/app-context";
import { completeTask } from "@/lib/task-complete";
import {
  addQuickItem,
  fetchTodo,
  nextSortOrder,
  pinTask,
  promoteToTask,
  removeItem,
  saveOrder,
  setQuickDone,
  TODO_QUERY_KEYS,
  type TodoItem,
  type TodoJob,
} from "@/lib/todo";

export type TodoListData = { available: boolean; items: TodoItem[] };

/** What a task row can tell the list about the task it is pinning, for the optimistic row. */
export type TodoPinSnapshot = {
  title: string;
  dueAt?: string | null;
  job?: TodoJob | null;
  assignee?: string | null;
};

export const todoQueryKey = (userId: string | null) => ["todo", userId] as const;

const EMPTY: TodoListData = { available: false, items: [] };

/** The list, cached per user. `available` is false until the migration is applied. */
export function useTodoList() {
  const { userId, viewerUserId } = useAppContext();
  // Under View As the list read is the viewed person's (owner-only RLS means
  // the admin usually gets an empty list back — honest, unlike showing their
  // own). `userId` returned below stays the signed-in user: it is the author
  // of every write in this file.
  const query = useQuery({
    queryKey: todoQueryKey(viewerUserId),
    enabled: !!viewerUserId,
    queryFn: () => fetchTodo(viewerUserId as string),
    staleTime: 30_000,
  });
  return { ...query, data: query.data ?? EMPTY, userId };
}

/** Invalidate everything a to-do write can change. */
export function useTodoRefresh() {
  const qc = useQueryClient();
  return useCallback(() => {
    for (const key of TODO_QUERY_KEYS) void qc.invalidateQueries({ queryKey: [key] });
  }, [qc]);
}

function usePatchList() {
  const qc = useQueryClient();
  const { userId } = useAppContext();
  return useCallback(
    (fn: (items: TodoItem[]) => TodoItem[]) => {
      qc.setQueryData<TodoListData>(todoQueryKey(userId), (cur) =>
        cur ? { ...cur, items: fn(cur.items) } : cur,
      );
    },
    [qc, userId],
  );
}

/**
 * "Is this task on my list, and put it on / take it off." Returns nothing
 * useful until the list has loaded — `available` false hides the control —
 * so a row never shows a pin it cannot honour.
 */
export function useTodoPin(taskId: string | null | undefined, snapshot?: TodoPinSnapshot) {
  const { data, userId } = useTodoList();
  const patch = usePatchList();
  const refresh = useTodoRefresh();

  const item = useMemo(
    () =>
      taskId ? (data.items.find((i) => i.kind === "pin" && i.taskId === taskId) ?? null) : null,
    [data.items, taskId],
  );

  const mutation = useMutation({
    mutationFn: async () => {
      if (!userId || !taskId) throw new Error("Sign in to use your to-do list.");
      if (item) {
        patch((items) => items.filter((i) => i.id !== item.id));
        return { ...(await removeItem(item.id)), pinned: false };
      }
      const r = await pinTask({ userId, taskId });
      // What the row knows about the task stands in until the refetch — and
      // in a dead zone, until the queue drains, which is the case that
      // matters: the glyph must read pinned on the tap, not on the sync.
      const now = new Date().toISOString();
      patch((items) =>
        items.some((i) => i.id === r.id)
          ? items
          : [
              ...items,
              {
                id: r.id,
                kind: "pin",
                taskId,
                title: snapshot?.title ?? "Task",
                job: snapshot?.job ?? null,
                dueAt: snapshot?.dueAt ?? null,
                done: false,
                doneAt: null,
                assignee:
                  snapshot?.assignee && snapshot.assignee !== userId ? snapshot.assignee : null,
                sortOrder: nextSortOrder(items),
                createdAt: now,
              },
            ],
      );
      return { ...r, pinned: true };
    },
    onSettled: refresh,
  });

  return {
    available: data.available && !!taskId,
    pinned: !!item,
    /** The list row, when pinned — the list's own ⋯ menu removes by it. */
    item,
    toggle: mutation.mutateAsync,
    pending: mutation.isPending,
  };
}

/** The list's own writes: add, tick, remove, reorder, promote. */
export function useTodoWrites() {
  const { userId, data } = useTodoList();
  const patch = usePatchList();
  const refresh = useTodoRefresh();

  const add = useMutation({
    mutationFn: async (input: { title: string; job: TodoJob | null }) => {
      if (!userId) throw new Error("Sign in to use your to-do list.");
      const r = await addQuickItem({ userId, title: input.title, jobId: input.job?.id ?? null });
      const now = new Date().toISOString();
      patch((items) => [
        ...items,
        {
          id: r.id,
          kind: "quick",
          taskId: null,
          title: input.title.trim(),
          job: input.job,
          dueAt: null,
          done: false,
          doneAt: null,
          assignee: null,
          sortOrder: nextSortOrder(items),
          createdAt: now,
        },
      ]);
      return r;
    },
    onSettled: refresh,
  });

  /**
   * One tick for both kinds. A pin is the real task and goes through the
   * app's one `completeTask`; a quick item is its own `done_at`. Either way
   * the row reads done before the write lands.
   */
  const tick = useMutation({
    mutationFn: async ({ item, done }: { item: TodoItem; done: boolean }) => {
      const at = done ? new Date().toISOString() : null;
      patch((items) => items.map((i) => (i.id === item.id ? { ...i, done, doneAt: at } : i)));
      if (item.kind === "pin" && item.taskId) {
        return completeTask({ taskId: item.taskId, label: item.title, reopen: !done });
      }
      return setQuickDone(item.id, done);
    },
    onSettled: refresh,
  });

  const remove = useMutation({
    mutationFn: async (item: TodoItem) => {
      patch((items) => items.filter((i) => i.id !== item.id));
      return removeItem(item.id);
    },
    onSettled: refresh,
  });

  const reorder = useMutation({
    mutationFn: async (order: { id: string; sortOrder: number }[]) => {
      const by = new Map(order.map((o) => [o.id, o.sortOrder]));
      patch((items) => items.map((i) => (by.has(i.id) ? { ...i, sortOrder: by.get(i.id)! } : i)));
      return saveOrder(order);
    },
    onSettled: refresh,
  });

  const promote = useMutation({
    mutationFn: async ({ item, dueDate }: { item: TodoItem; dueDate: string | null }) => {
      const r = await promoteToTask({ id: item.id, dueDate });
      // The row becomes the pin for the task it just made. The task carries
      // the same title and job, so the line does not move or change.
      patch((items) =>
        items.map((i) =>
          i.id === item.id
            ? { ...i, kind: "pin", taskId: r.taskId, dueAt: dueDate ? `${dueDate}T17:00:00` : null }
            : i,
        ),
      );
      return r;
    },
    onSettled: refresh,
  });

  return {
    userId,
    items: data.items,
    available: data.available,
    add,
    tick,
    remove,
    reorder,
    promote,
  };
}
