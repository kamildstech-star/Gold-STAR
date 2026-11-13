/**
 * The day's work as sticky notes, on the dashboard's My to-do card.
 *
 * David, 22 Sep: "on the dashboard, every user should have their tasks on
 * their dashboard also... maybe like sticky notes type of thing... your tasks
 * for that day, or for each property should come up over there."
 *
 * Presentation and grouping only (todo-notes.ts). The notes are the to-do
 * list plus my own tasks due this week; a tick is the same tick the list and
 * /tasks use, and the pin is the same pin button — there is one task system.
 */
import * as React from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import { useAppContext } from "@/components/app-context";
import { TodoPinButton } from "@/components/todo/todo-pin";
import { Checkbox } from "@/components/ui/checkbox";
import { supabase } from "@/integrations/supabase/client";
import { toastDbError } from "@/lib/db-errors";
import { completeTask, TASK_QUEUED_MESSAGE } from "@/lib/task-complete";
import { jobLabel } from "@/lib/todo";
import {
  DEFAULT_TODO_VIEW,
  TODO_VIEW_SCOPE,
  groupNotes,
  mergeNotes,
  parseTodoView,
  type MyTask,
  type Note,
  type NoteGrouping,
  type TodoCardView,
} from "@/lib/todo-notes";
import { useTodoList, useTodoRefresh, useTodoWrites } from "@/lib/use-todo";
import { cn } from "@/lib/utils";

const localDay = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/** My open tasks due by the end of this week, and the ones ticked today. */
export function useMyWeekTasks() {
  const { userId } = useAppContext();
  return useQuery({
    // Under "tasks", so every tick anywhere (useTodoRefresh) refreshes it.
    queryKey: ["tasks", "dashboard-mine", userId],
    enabled: !!userId,
    queryFn: async (): Promise<MyTask[]> => {
      const now = new Date();
      const weekEnd = localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 6));
      const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
      const { data, error } = await supabase
        .from("tasks")
        .select(
          "id, title, status, due_date, due_time, completed_at, job:jobs(id, job_number, address, job_name, loss_type, location_id, account_id)",
        )
        .eq("assignee", userId!)
        .lte("due_date", weekEnd)
        .or(`status.in.(open,in_progress),completed_at.gte.${startOfToday}`)
        .order("due_date")
        .limit(100);
      if (error) throw error;
      return (data ?? []) as unknown as MyTask[];
    },
  });
}

/** List or notes, and how the notes group — per person, like the board densities. */
export function useTodoView(): [TodoCardView, (v: TodoCardView) => void] {
  const { userId } = useAppContext();
  const [view, setView] = React.useState<TodoCardView>(DEFAULT_TODO_VIEW);
  React.useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    void supabase
      .from("user_view_prefs")
      .select("view_mode")
      .eq("user_id", userId)
      .eq("scope", TODO_VIEW_SCOPE)
      .maybeSingle()
      .then(({ data }) => !cancelled && setView(parseTodoView(data?.view_mode)));
    return () => {
      cancelled = true;
    };
  }, [userId]);
  const set = React.useCallback(
    (v: TodoCardView) => {
      setView(v);
      if (!userId) return;
      // A preference that fails to save is still the view in front of them.
      void supabase
        .from("user_view_prefs")
        .upsert(
          {
            user_id: userId,
            scope: TODO_VIEW_SCOPE,
            view_mode: v,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "user_id,scope" },
        )
        .then(() => undefined);
    },
    [userId],
  );
  return [view, set];
}

/** Four pale note colours, in a fixed order by group — never by rank. */
const NOTE_TONES = ["var(--note-1)", "var(--note-2)", "var(--note-3)", "var(--note-4)"];

export function TodoNotes({ grouping }: { grouping: NoteGrouping }) {
  const { data: todo } = useTodoList();
  const tasksQ = useMyWeekTasks();
  const { tick } = useTodoWrites();
  const refresh = useTodoRefresh();
  const now = React.useMemo(() => new Date(), []);

  const notes = React.useMemo(
    () => mergeNotes(todo.available ? todo.items : [], tasksQ.data ?? [], now),
    [todo, tasksQ.data, now],
  );
  const groups = groupNotes(notes, grouping, now);

  /* The one tick: a list note through the list's own write (a pin is
     completeTask inside it), an assigned task straight through completeTask. */
  const tickTask = useMutation({
    mutationFn: (n: Note) => completeTask({ taskId: n.taskId!, label: n.title, reopen: n.done }),
    onSuccess: (r) => {
      if (r.queued) toast.message(TASK_QUEUED_MESSAGE);
    },
    onError: (e) => toastDbError(e, { action: "update the task" }),
    onSettled: refresh,
  });

  const onTick = (n: Note) => {
    if (n.todo) tick.mutate({ item: n.todo, done: !n.done });
    else if (n.taskId) tickTask.mutate(n);
  };

  if (tasksQ.isError) {
    return <p className="text-[13px] text-destructive">Your tasks could not be loaded.</p>;
  }
  if (groups.length === 0) {
    return (
      <p className="text-[13px] text-muted-foreground">
        {grouping === "today"
          ? "Nothing due today. Tasks you are given, and anything you pin or jot down, land here."
          : "Nothing this week. Tasks you are given, and anything you pin or jot down, land here."}
      </p>
    );
  }

  return (
    <div className="@container space-y-3">
      {groups.map((g, gi) => (
        <section key={g.key} aria-label={g.label}>
          <h3
            className={cn(
              "mb-1.5 text-[11px] font-semibold uppercase tracking-wide",
              g.overdue ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {g.label} · {g.notes.length}
          </h3>
          <ul className="grid grid-cols-1 gap-2 @[22rem]:grid-cols-2 @[40rem]:grid-cols-3">
            {g.notes.map((n, i) => (
              <StickyNote
                key={n.key}
                note={n}
                tone={NOTE_TONES[gi % NOTE_TONES.length]!}
                tilt={i % 2 === 0 ? "-rotate-[0.6deg]" : "rotate-[0.6deg]"}
                overdue={!!g.overdue}
                showJob={grouping !== "job"}
                onTick={() => onTick(n)}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function dueText(dueAt: string | null, overdue: boolean): string | null {
  if (!dueAt) return null;
  const d = new Date(dueAt);
  const when = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  return overdue ? `Overdue · was due ${when}` : `Due ${when}`;
}

function StickyNote({
  note,
  tone,
  tilt,
  overdue,
  showJob,
  onTick,
}: {
  note: Note;
  tone: string;
  tilt: string;
  overdue: boolean;
  showJob: boolean;
  onTick: () => void;
}) {
  const due = dueText(note.dueAt, overdue && !note.done);
  return (
    <li
      data-sticky-note
      className={cn(
        "relative flex min-h-24 flex-col gap-1.5 rounded-sm p-3 text-foreground shadow-sm ring-1 ring-black/5 motion-safe:transition-transform motion-safe:hover:rotate-0",
        tilt,
        note.done && "opacity-60",
      )}
      style={{ background: tone }}
    >
      <label className="flex items-start gap-2">
        <Checkbox
          checked={note.done}
          onCheckedChange={onTick}
          className="mt-0.5 size-5 border-foreground/40 bg-background/60"
          aria-label={note.done ? `Mark "${note.title}" not done` : `Mark "${note.title}" done`}
        />
        <span
          className={cn(
            "min-w-0 flex-1 text-[13px] font-medium leading-snug",
            note.done && "line-through",
          )}
        >
          {note.title || "Untitled"}
        </span>
      </label>
      <div className="mt-auto space-y-0.5 pl-7 text-[11px] text-foreground/70">
        {showJob && note.job ? (
          <Link
            to="/jobs/$id"
            params={{ id: note.job.id }}
            className="block truncate underline-offset-2 hover:underline"
          >
            {jobLabel(note.job)}
          </Link>
        ) : null}
        {/* Overdue is said in words, not only in the heading's colour. */}
        {due ? (
          <p className={overdue && !note.done ? "font-semibold text-destructive" : ""}>{due}</p>
        ) : null}
      </div>
      {note.unpinnedTask && note.taskId ? (
        <TodoPinButton taskId={note.taskId} className="absolute right-1 top-1" />
      ) : null}
    </li>
  );
}
