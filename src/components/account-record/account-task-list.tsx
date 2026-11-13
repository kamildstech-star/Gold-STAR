/**
 * An account's tasks as a list of rows that open the task pop-up.
 *
 * General shows the open ones (a handful, with "See all"); the Tasks tab shows
 * every one, the done ones folded underneath. A row is one button: the whole
 * row opens the pop-up, which is where a task is logged and completed.
 */
import { useState } from "react";
import { CheckCircle2, ChevronDown, ChevronRight, Circle } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { EmptyLine, LoadError } from "@/components/ui-density";
import { dueText } from "@/components/account-record/account-task-dialog";
import { isOpenTask, isOverdue, useAccountTasks, type AccountTask } from "@/lib/account-tasks";
import { cn } from "@/lib/utils";

function TaskRow({ task, onOpen }: { task: AccountTask; onOpen: (id: string) => void }) {
  const open = isOpenTask(task);
  const overdue = isOverdue(task);
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(task.id)}
        data-task-row
        className="flex w-full min-w-0 items-start gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none"
      >
        {open ? (
          <Circle
            className={cn(
              "mt-0.5 size-4 shrink-0",
              overdue ? "text-destructive" : "text-muted-foreground",
            )}
          />
        ) : (
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
        )}
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              "block break-words text-[13.5px] font-medium leading-snug",
              !open && "text-muted-foreground line-through decoration-muted-foreground/60",
            )}
          >
            {task.title}
          </span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[12px] text-muted-foreground">
            <span className={cn(overdue && "font-medium text-destructive")}>
              {overdue ? "Overdue · " : ""}
              {dueText(task)}
            </span>
            {task.assigneeName ? (
              <>
                <span aria-hidden>·</span>
                <span>{task.assigneeName}</span>
              </>
            ) : null}
          </span>
        </span>
        {task.activityLabel ? (
          <Badge variant="secondary" className="shrink-0 text-[10.5px]">
            {task.activityLabel}
          </Badge>
        ) : null}
      </button>
    </li>
  );
}

export function AccountTaskList({
  accountId,
  onOpen,
  limit,
  showDone = false,
  filter,
  emptyText = "No open tasks on this account.",
  onSeeAll,
}: {
  accountId: string;
  onOpen: (taskId: string) => void;
  /** Show at most this many open tasks, with "See all" for the rest. */
  limit?: number;
  /** List the done tasks too, folded under the open ones. */
  showDone?: boolean;
  /** Narrow the list, e.g. to meetings. */
  filter?: (t: AccountTask) => boolean;
  emptyText?: string;
  onSeeAll?: () => void;
}) {
  const q = useAccountTasks(accountId);
  const [doneOpen, setDoneOpen] = useState(false);

  if (q.isError) {
    return <LoadError what="tasks" error={q.error as Error} onRetry={() => void q.refetch()} />;
  }
  if (q.isLoading) return <EmptyLine>Loading tasks…</EmptyLine>;

  const rows = (q.data ?? []).filter((t) => (filter ? filter(t) : true));
  const open = rows.filter(isOpenTask);
  const done = rows.filter((t) => !isOpenTask(t));
  const shown = limit != null ? open.slice(0, limit) : open;
  const more = open.length - shown.length;

  return (
    <div className="space-y-1">
      {shown.length === 0 ? (
        <EmptyLine>{emptyText}</EmptyLine>
      ) : (
        <ul className="-mx-2" data-testid="account-task-list">
          {shown.map((t) => (
            <TaskRow key={t.id} task={t} onOpen={onOpen} />
          ))}
        </ul>
      )}
      {more > 0 && onSeeAll ? (
        <button
          type="button"
          onClick={onSeeAll}
          className="text-[12.5px] font-medium text-primary hover:underline"
        >
          See all {open.length} open tasks
        </button>
      ) : null}
      {showDone && done.length > 0 ? (
        <div className="pt-2">
          <button
            type="button"
            onClick={() => setDoneOpen((v) => !v)}
            className="flex items-center gap-1 text-[12.5px] font-medium text-muted-foreground hover:text-foreground"
            aria-expanded={doneOpen}
          >
            {doneOpen ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <ChevronRight className="size-3.5" />
            )}
            Done ({done.length})
          </button>
          {doneOpen ? (
            <ul className="-mx-2 mt-1">
              {done.map((t) => (
                <TaskRow key={t.id} task={t} onOpen={onOpen} />
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
