import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CheckCircle2, Circle } from "lucide-react";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { NewTaskDialog } from "@/components/task-dialog";
import { DryingClockCard } from "@/components/drying-clock-card";
import { TodoPinButton } from "@/components/todo/todo-pin";
import { useAppContext, useWritesDisabled } from "@/components/app-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toastDbError } from "@/lib/db-errors";
import { fmtDate } from "@/lib/jobs";
import { taskDueAt } from "@/lib/account-timeline";
import { TASK_QUEUED_MESSAGE, completeTask } from "@/lib/task-complete";
import type { TaskStatus } from "@/lib/tasks";
import type { RecordFocus } from "@/lib/job-page-search";
import { cn } from "@/lib/utils";
import {
  BUILT_IN_TASK_CATALOG,
  automaticScopeTypeFor,
  automaticTaskGroupLabel,
  loadTaskCatalog,
  sortTasksByChecklist,
  syncAutomaticJobTasksForJob,
} from "@/lib/automatic-job-tasks";

interface TaskRow {
  id: string;
  title: string;
  status: string;
  priority: string;
  due_date: string | null;
  assignee: string | null;
  source: string;
  cadence_key: string | null;
}

/** Tasks raised against this job, newest deadline first. */
export function JobTasksTab({
  jobId,
  locationId,
  accountId,
  jobTypeKey,
  additionalWorkPending,
  onJobChanged,
  focusTask = null,
}: {
  jobId: string;
  locationId: string;
  accountId?: string | null;
  /** Service category key (the database's legacy loss_type compatibility value). */
  jobTypeKey?: string | null;
  additionalWorkPending?: boolean;
  onJobChanged?: () => void;
  /** A task to highlight and scroll to — History's "Open record". */
  focusTask?: RecordFocus | null;
}) {
  const app = useAppContext();
  const qc = useQueryClient();
  const writes = useWritesDisabled();
  const key = ["job-tasks", jobId];
  const scopeType = automaticScopeTypeFor(jobTypeKey);
  const [automaticError, setAutomaticError] = useState<unknown>(null);
  const [syncing, setSyncing] = useState(false);

  const q = useQuery({
    queryKey: key,
    queryFn: async (): Promise<TaskRow[]> => {
      const { data, error } = await supabase
        .from("tasks")
        .select("id, title, status, priority, due_date, assignee, source, cadence_key")
        .eq("job_id", jobId)
        .order("due_date", { nullsFirst: false });
      if (error) throw error;
      return (data ?? []) as TaskRow[];
    },
  });

  // The order David set in Settings › Job checklists. Only the order rides on
  // it, so a slow or failed read just leaves Mark's compiled order.
  const catalog = useQuery({
    queryKey: ["job-task-catalog"],
    queryFn: () => loadTaskCatalog(),
    staleTime: 5 * 60_000,
  });

  // Also reconciles older jobs the first time their Tasks tab is opened and
  // catches equipment placed while offline. Strict Mode may run this twice;
  // cadence keys make that intentionally harmless.
  useEffect(() => {
    if (!app.userId || writes.disabled) return;
    let current = true;
    setSyncing(true);
    setAutomaticError(null);
    syncAutomaticJobTasksForJob(jobId, app.userId)
      .then(() => {
        if (current) void qc.invalidateQueries({ queryKey: key });
      })
      .catch((error) => {
        if (current) setAutomaticError(error);
      })
      .finally(() => {
        if (current) setSyncing(false);
      });
    return () => {
      current = false;
    };
    // key is reconstructed each render; its scalar inputs are the dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, jobTypeKey, additionalWorkPending, app.userId, writes.disabled, qc]);

  const addRemediation = useMutation({
    mutationFn: async () => {
      if (!app.userId) throw new Error("Not signed in");
      const { data, error } = await supabase
        .from("jobs")
        .update({ additional_work_pending: true })
        .eq("id", jobId)
        .select("id");
      if (error) throw error;
      if (!data?.length) throw new Error("This job could not be updated.");
      await syncAutomaticJobTasksForJob(jobId, app.userId);
    },
    onSuccess: () => {
      toast.success("Water remediation tasks added");
      void qc.invalidateQueries({ queryKey: key });
      onJobChanged?.();
    },
    onError: (error) => toastDbError(error, { action: "Adding remediation tasks" }),
  });

  /**
   * Ticking a task here is the app's one `completeTask`, the same write
   * Needs-you-today, /tasks, the Timeline and the to-do list make. This tab
   * predated that module and kept its own `status = done` update, so a tick
   * in a dead zone failed here while the identical tick on /tasks held on the
   * device and went up later. Going through the queue is what fixes that.
   */
  const toggle = useMutation({
    mutationFn: ({ id, title, next }: { id: string; title: string; next: TaskStatus }) =>
      completeTask({ taskId: id, label: title, reopen: next === "open" }),
    onMutate: async ({ id, next }) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<TaskRow[]>(key);
      qc.setQueryData<TaskRow[]>(key, (rows) =>
        (rows ?? []).map((r) => (r.id === id ? { ...r, status: next } : r)),
      );
      return { prev };
    },
    onError: (e, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
      toastDbError(e, { action: "update this task" });
    },
    onSuccess: ({ queued, status }) => {
      if (queued) toast.info(TASK_QUEUED_MESSAGE);
      else toast.success(status === "done" ? "Task completed" : "Task reopened");
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: key });
      // The task list and the side rail count the same rows.
      void qc.invalidateQueries({ queryKey: ["tasks"] });
    },
  });

  const rows = sortTasksByChecklist(q.data ?? [], catalog.data ?? BUILT_IN_TASK_CATALOG);

  /*
   * History's "Open record" on a task: the row is highlighted and scrolled
   * into view once the list has it. Once per request, so the list refetching
   * does not yank the page back to it.
   */
  const rowRefs = useRef(new Map<string, HTMLDivElement | null>());
  const scrolledFor = useRef<number | null>(null);
  const focusedId = focusTask?.id ?? null;
  const focusLoaded = focusedId != null && rows.some((r) => r.id === focusedId);
  useEffect(() => {
    if (!focusTask || !focusLoaded || scrolledFor.current === focusTask.at) return;
    scrolledFor.current = focusTask.at;
    rowRefs.current.get(focusTask.id)?.scrollIntoView?.({ block: "center", behavior: "smooth" });
  }, [focusTask, focusLoaded]);
  const open = rows.filter((r) => r.status === "open" || r.status === "in_progress");
  const done = rows.filter((r) => r.status !== "open" && r.status !== "in_progress");

  return (
    <div className="space-y-3">
      {scopeType === "water" && (
        <div className="space-y-3 rounded-md border bg-muted/30 p-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="text-sm font-medium">If additional work needed</p>
              <p className="text-xs text-muted-foreground">
                {additionalWorkPending
                  ? "The Water · Remediation checklist is on this job."
                  : "Adds the Water · Remediation checklist: the extraction steps again, then the remediation work."}
              </p>
            </div>
            {/* Gone once pressed, and the flag it sets is what seeds the
                checklist — so a second tap, or a field ticket saying the
                same thing, has nothing left to add. */}
            {!additionalWorkPending && (
              <Button
                size="sm"
                variant="outline"
                className="shrink-0"
                disabled={writes.disabled || addRemediation.isPending}
                title={writes.reason ?? undefined}
                onClick={() => addRemediation.mutate()}
              >
                Add remediation tasks
              </Button>
            )}
          </div>
          {/* Mark's "Reset 3 days of drying time (new button linked to scanning
              and alerts)" — the same card as the Drying and Work ticket tabs,
              so there is one reset and it moves everything. */}
          <DryingClockCard jobId={jobId} bare className="rounded-sm border bg-background p-3" />
        </div>
      )}

      {automaticError ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          Automatic scope tasks could not be synchronized. Your existing tasks were not removed.
          <Button
            size="sm"
            variant="outline"
            className="ml-2"
            disabled={syncing || writes.disabled || !app.userId}
            onClick={() => {
              if (!app.userId) return;
              setSyncing(true);
              syncAutomaticJobTasksForJob(jobId, app.userId)
                .then(() => {
                  setAutomaticError(null);
                  void qc.invalidateQueries({ queryKey: key });
                })
                .catch(setAutomaticError)
                .finally(() => setSyncing(false));
            }}
          >
            Retry
          </Button>
        </div>
      ) : null}

      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          {open.length} open{syncing ? " · syncing automatic scope…" : ""}
        </p>
        <NewTaskDialog
          link={{ entityType: "job", entityId: jobId, jobId, locationId, accountId }}
        />
      </div>
      <div className="rounded-md border">
        {q.isError ? (
          <div className="p-3 text-sm text-destructive">
            Tasks could not be loaded. This is a load failure, not an empty list.
          </div>
        ) : (
          rows.length === 0 &&
          !q.isLoading && (
            /* Honest about the one case that is not a bug: a task made from
               the Tasks page or an account is not on any job, so it is never
               listed here. Say so, rather than let "none" read as "lost". */
            <div className="space-y-1 p-3 text-sm text-muted-foreground">
              <p>No tasks on this job yet.</p>
              <p className="text-xs">
                Tasks added from the Tasks page or from an account are not linked to a job and show
                there instead. Add one here with New task to put it on this job.
              </p>
            </div>
          )
        )}
        {[...open, ...done].map((t) => {
          const isDone = t.status === "done";
          const isCancelled = t.status === "cancelled";
          const groupLabel = automaticTaskGroupLabel(t.source, catalog.data);
          return (
            <div
              key={t.id}
              ref={(el) => {
                rowRefs.current.set(t.id, el);
              }}
              data-task-id={t.id}
              data-focused={focusedId === t.id || undefined}
              aria-current={focusedId === t.id ? "true" : undefined}
              className={cn(
                "flex flex-wrap items-center gap-2 border-b px-3 py-2 last:border-b-0",
                focusedId === t.id && "bg-primary/10 ring-2 ring-inset ring-primary",
              )}
            >
              {/* The circle always looked like a checkbox; now it is one. */}
              <button
                type="button"
                disabled={writes.disabled || toggle.isPending}
                title={writes.reason ?? (isDone || isCancelled ? "Reopen task" : "Mark complete")}
                aria-label={
                  isDone || isCancelled ? `Reopen ${t.title}` : `Mark ${t.title} complete`
                }
                aria-pressed={isDone}
                onClick={() =>
                  toggle.mutate({
                    id: t.id,
                    title: t.title,
                    next: isDone || isCancelled ? "open" : "done",
                  })
                }
                className="shrink-0 rounded-full p-0.5 hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isDone ? (
                  <CheckCircle2 className="size-4 text-success" />
                ) : (
                  <Circle className="size-4 text-muted-foreground" />
                )}
              </button>
              <span
                className={`min-w-40 flex-1 text-[13px] ${isDone || isCancelled ? "text-muted-foreground line-through" : ""}`}
              >
                {t.title}
              </span>
              {groupLabel && <Badge variant="secondary">{groupLabel}</Badge>}
              {isCancelled && <Badge variant="outline">retired</Badge>}
              {t.priority !== "normal" && <Badge variant="outline">{t.priority}</Badge>}
              <span className="text-xs text-muted-foreground">
                {t.due_date ? fmtDate(t.due_date) : "—"}
              </span>
              {/* "choose to add that task to the to do list" — the one shared toggle. */}
              <TodoPinButton
                taskId={t.id}
                snapshot={{
                  title: t.title,
                  assignee: t.assignee,
                  dueAt: taskDueAt(t.due_date, null),
                }}
                disabled={writes.disabled}
              />
            </div>
          );
        })}
      </div>
      <Link to="/tasks" search={{} as never} className="text-xs text-primary underline">
        Open task list
      </Link>
    </div>
  );
}
