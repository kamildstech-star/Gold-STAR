import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAppContext, useWritesDisabled } from "@/components/app-context";
import { NewTaskDialog } from "@/components/task-dialog";
import { TodoPinButton } from "@/components/todo/todo-pin";
import { EmptyLine, LoadError, PageHeader } from "@/components/ui-density";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  TASK_BUCKET_LABEL,
  TASK_PRIORITY_LABEL,
  TASK_STATUS_LABEL,
  bucketOf,
  dueLabel,
  endOfWeekIso,
  isOpen,
  todayIso,
  type Task,
  type TaskBucket,
} from "@/lib/tasks";
import { isPrivileged } from "@/lib/roles";
import { toastDbError } from "@/lib/db-errors";
import { EmptyScopeGuard } from "@/components/empty-scope-guard";
import { cn } from "@/lib/utils";

import { AutomationOrigin } from "@/components/automation-origin";
import { TASK_QUEUED_MESSAGE, completeTask } from "@/lib/task-complete";
import { taskDueAt } from "@/lib/account-timeline";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/tasks/")({
  head: () => ({
    meta: [
      { title: "Tasks · Recovery Hub" },
      {
        name: "description",
        content: "Follow-ups, cadence tasks and reminders assigned to you, grouped by due date.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: TasksPage,
});

const BUCKETS: TaskBucket[] = ["today", "overdue", "week", "all"];

function TasksPage() {
  // "Mine" is the viewed person's under View As (viewerUserId); nothing here writes with it.
  const { viewerUserId, roles } = useAppContext();
  const { disabled: writesDisabled } = useWritesDisabled();
  const qc = useQueryClient();
  const [bucket, setBucket] = useState<TaskBucket>("today");
  const [scope, setScope] = useState<"mine" | "team">("mine");

  const canSeeTeam =
    isPrivileged(roles) ||
    roles.some((r) => ["regional", "location_manager", "sales_manager"].includes(r));

  const query = useQuery({
    queryKey: ["tasks", scope, viewerUserId],
    queryFn: async () => {
      let q = supabase.from("tasks").select("*").order("due_date", { ascending: true });
      if (scope === "mine" && viewerUserId) q = q.eq("assignee", viewerUserId);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as Task[];
    },
  });

  /** What the team view holds, so an empty "my tasks" can say so rather than look broken. */
  const teamCountQuery = useQuery({
    queryKey: ["tasks-team-count"],
    enabled: canSeeTeam && scope === "mine",
    queryFn: async () => {
      const { count, error } = await supabase
        .from("tasks")
        .select("id", { count: "exact", head: true });
      if (error) throw error;
      return count ?? 0;
    },
  });

  const toggle = useMutation({
    mutationKey: ["tasks", "toggle"],
    mutationFn: async (task: Task) => {
      /*
       * In a dead zone the tick holds on the device and goes up when service
       * returns — the sync indicator in the header shows the state. It goes
       * through the same path whether the network is off or merely broken:
       * "the request failed" and "there is no network" are the same thing to
       * someone in a basement, and only one of them used to be survivable.
       *
       * The write itself is `completeTask`, shared with the Needs-you-today
       * card and the account Timeline, so ticking a task is one code path.
       */
      const { queued } = await completeTask({
        taskId: task.id,
        label: task.title,
        reopen: task.status === "done",
      });
      if (queued) toast.info(TASK_QUEUED_MESSAGE);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tasks"] }),
    onError: (error) => toastDbError(error, { action: "update task" }),
  });

  const tasks = query.data ?? [];

  const filtered = useMemo(() => {
    const today = todayIso();
    const week = endOfWeekIso();
    return tasks.filter((t) => {
      if (bucket === "all") return true;
      if (!isOpen(t)) return false;
      if (!t.due_date) return false;
      if (bucket === "today") return t.due_date === today;
      if (bucket === "overdue") return t.due_date < today;
      return t.due_date >= today && t.due_date <= week;
    });
  }, [tasks, bucket]);

  const counts = useMemo(() => {
    const today = todayIso();
    const week = endOfWeekIso();
    const open = tasks.filter(isOpen);
    return {
      today: open.filter((t) => t.due_date === today).length,
      overdue: open.filter((t) => t.due_date && t.due_date < today).length,
      week: open.filter((t) => t.due_date && t.due_date >= today && t.due_date <= week).length,
      all: tasks.length,
    } as Record<TaskBucket, number>;
  }, [tasks]);

  const byAssignee = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of tasks.filter(isOpen)) {
      const key = t.assignee ?? "unassigned";
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }, [tasks]);

  return (
    <div className="space-y-3 p-3 md:p-4">
      <PageHeader title="Tasks" count={`${filtered.length} of ${tasks.length}`}>
        {canSeeTeam && (
          <div className="flex rounded-md border">
            <button
              type="button"
              onClick={() => setScope("mine")}
              className={cn(
                "min-h-11 px-3 text-[12px] sm:min-h-0 sm:px-2 sm:py-1",
                scope === "mine" && "bg-accent font-medium",
              )}
            >
              My tasks
            </button>
            <button
              type="button"
              onClick={() => setScope("team")}
              className={cn(
                "min-h-11 border-l px-3 text-[12px] sm:min-h-0 sm:px-2 sm:py-1",
                scope === "team" && "bg-accent font-medium",
              )}
            >
              By rep
            </button>
          </div>
        )}
        <NewTaskDialog />
      </PageHeader>

      <EmptyScopeGuard
        scopedCount={tasks.length}
        unscopedCount={teamCountQuery.data ?? 0}
        noun="tasks"
        scopedLabel="assigned to you"
        unscopedLabel="across the team"
        switchLabel="View the team's tasks"
        onSwitch={() => setScope("team")}
      />

      <div className="flex flex-wrap gap-1.5">
        {BUCKETS.map((b) => (
          <Button
            key={b}
            variant={bucket === b ? "default" : "outline"}
            size="sm"
            className="h-11 sm:h-7"
            onClick={() => setBucket(b)}
          >
            {TASK_BUCKET_LABEL[b]}
            <span className="ml-1.5 font-mono text-[11px] tabular-nums opacity-80">
              {counts[b]}
            </span>
          </Button>
        ))}
      </div>

      {query.isError ? (
        <LoadError what="tasks" error={query.error} onRetry={() => query.refetch()} />
      ) : query.isLoading ? (
        <EmptyLine>Loading…</EmptyLine>
      ) : filtered.length === 0 ? (
        <EmptyLine>
          No tasks here. Tasks appear when you create one, when you set a follow-up while logging a
          touchpoint, or when an account crosses its quarterly touch or annual meeting threshold.
        </EmptyLine>
      ) : (
        <div className="border">
          {/* Phone: a card per task, with the completion checkbox as a real
              44px target. The six-column table has no room at 390px. */}
          <ul className="divide-y md:hidden">
            {filtered.map((t) => (
              <li
                key={t.id}
                className={cn(
                  "flex items-start gap-1 px-2 py-2",
                  bucketOf(t) === "overdue" && isOpen(t) && "bg-destructive/5",
                )}
              >
                <label className="flex size-11 shrink-0 items-center justify-center">
                  <Checkbox
                    checked={t.status === "done"}
                    disabled={writesDisabled || toggle.isPending}
                    onCheckedChange={() => toggle.mutate(t)}
                    aria-label={`Mark "${t.title}" complete`}
                  />
                </label>
                <div className="min-w-0 flex-1 py-1.5">
                  <div
                    className={cn(
                      "break-words text-[14px] font-medium",
                      t.status === "done" && "text-muted-foreground line-through",
                    )}
                  >
                    {t.title}
                  </div>
                  {t.description && (
                    <div className="text-[12px] text-muted-foreground">{t.description}</div>
                  )}
                  <div className="mt-0.5 text-[12px] text-muted-foreground">
                    <span className="font-mono tabular-nums">{dueLabel(t)}</span>
                    {" · "}
                    {TASK_PRIORITY_LABEL[t.priority]}
                    {" · "}
                    {TASK_STATUS_LABEL[t.status]}
                    {t.source ? ` · ${t.source}` : ""}
                  </div>
                  <AutomationOrigin ruleId={t.automation_rule_id} reason={t.automation_reason} />
                </div>
                <TodoPinButton
                  taskId={t.id}
                  snapshot={{
                    title: t.title,
                    assignee: t.assignee,
                    dueAt: taskDueAt(t.due_date, t.due_time),
                  }}
                  disabled={writesDisabled}
                  className="mt-2.5"
                />
              </li>
            ))}
          </ul>

          <div className="hidden overflow-x-auto md:max-h-[75svh] md:overflow-auto md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8" />
                  <TableHead>Task</TableHead>
                  <TableHead className="w-32">Due</TableHead>
                  <TableHead className="w-24">Priority</TableHead>
                  <TableHead className="w-28">Status</TableHead>
                  <TableHead className="w-24">Source</TableHead>
                  <TableHead className="w-8" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((t) => (
                  <TableRow
                    key={t.id}
                    className={cn(bucketOf(t) === "overdue" && isOpen(t) && "bg-destructive/5")}
                  >
                    <TableCell>
                      <Checkbox
                        checked={t.status === "done"}
                        disabled={writesDisabled || toggle.isPending}
                        onCheckedChange={() => toggle.mutate(t)}
                        aria-label="Toggle complete"
                      />
                    </TableCell>
                    <TableCell>
                      <div
                        className={cn(
                          "font-medium",
                          t.status === "done" && "line-through text-muted-foreground",
                        )}
                      >
                        {t.title}
                      </div>
                      {t.description && (
                        <div className="text-[12px] text-muted-foreground">{t.description}</div>
                      )}
                      <AutomationOrigin
                        ruleId={t.automation_rule_id}
                        reason={t.automation_reason}
                      />
                    </TableCell>
                    <TableCell className="font-mono text-[12px] tabular-nums">
                      {dueLabel(t)}
                    </TableCell>
                    <TableCell>{TASK_PRIORITY_LABEL[t.priority]}</TableCell>
                    <TableCell>{TASK_STATUS_LABEL[t.status]}</TableCell>
                    <TableCell className="text-[12px] text-muted-foreground">{t.source}</TableCell>
                    <TableCell>
                      <TodoPinButton
                        taskId={t.id}
                        snapshot={{
                          title: t.title,
                          assignee: t.assignee,
                          dueAt: taskDueAt(t.due_date, t.due_time),
                        }}
                        disabled={writesDisabled}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      {scope === "team" && byAssignee.length > 0 && (
        <div className="border">
          <div className="border-b px-3 py-1.5 text-[12px] font-medium uppercase tracking-wide text-muted-foreground">
            Open tasks by rep
          </div>
          {byAssignee.map(([assignee, count]) => (
            <div
              key={assignee}
              className="flex justify-between border-b px-3 py-1.5 text-[13px] last:border-b-0"
            >
              <span className="truncate">
                {assignee === "unassigned" ? "Unassigned" : assignee}
              </span>
              <span className="font-mono tabular-nums">{count}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
