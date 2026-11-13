/**
 * The task pop-up: log it, complete it, next.
 *
 * Melly, 6 Nov: "you click on it and there's not really anything going on
 * here ... it's a mini pop-up view, so you can add a note, log it, just
 * finish it up and then press complete, boom, then you have your next task."
 * Clicking a task used to scroll the page to the composer at the top.
 *
 * The tick is the app's one `completeTask` (offline-safe, the same one the
 * Timeline and /tasks use). A note written here lands on the account's
 * timeline as a note, headed with the task it was about. Then the next open
 * task on the account, in the list's own order, takes its place; after the
 * last one the pop-up closes.
 */
import { useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import { CalendarClock, Check, ChevronRight, User } from "lucide-react";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { useWritesDisabled } from "@/components/app-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toastDbError } from "@/lib/db-errors";
import {
  isOpenTask,
  isOverdue,
  nextOpenTask,
  useAccountTasks,
  type AccountTask,
} from "@/lib/account-tasks";
import { TASK_QUEUED_MESSAGE, completeTask } from "@/lib/task-complete";
import { assertWritesEnabled } from "@/lib/write-guard";
import { cn } from "@/lib/utils";

export function dueText(t: Pick<AccountTask, "dueDate" | "dueTime">): string {
  if (!t.dueDate) return "No due date";
  const d = new Date(`${t.dueDate}T${t.dueTime ?? "12:00"}`);
  const day = format(d, "EEE d MMM");
  return t.dueTime ? `${day}, ${format(d, "h:mm a")}` : day;
}

export function AccountTaskDialog({
  accountId,
  taskId,
  userId,
  onOpenChange,
  onChanged,
}: {
  accountId: string;
  /** The task to open; null keeps the pop-up closed. */
  taskId: string | null;
  userId: string | null;
  onOpenChange: (open: boolean) => void;
  /** The page's one refresh, so the timeline, the lists and the header all move. */
  onChanged: () => void;
}) {
  const writes = useWritesDisabled();
  const tasksQ = useAccountTasks(accountId);
  const [currentId, setCurrentId] = useState<string | null>(taskId);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  /** Ticked in this sitting — skipped by "next" before the list has re-read. */
  const [doneHere, setDoneHere] = useState<Set<string>>(new Set());

  useEffect(() => {
    setCurrentId(taskId);
    setNote("");
    setDoneHere(new Set());
  }, [taskId]);

  const rows = useMemo(() => tasksQ.data ?? [], [tasksQ.data]);
  const task = rows.find((t) => t.id === currentId) ?? null;
  const next = currentId ? nextOpenTask(rows, currentId, doneHere) : null;
  const open = !!taskId;
  const alreadyDone = task ? !isOpenTask(task) || doneHere.has(task.id) : false;

  const goNext = () => {
    setNote("");
    if (next) setCurrentId(next.id);
    else onOpenChange(false);
  };

  const complete = async () => {
    if (!task) return;
    try {
      assertWritesEnabled(writes.disabled, writes.reason);
    } catch (e) {
      toastDbError(e, { action: "complete this task" });
      return;
    }
    setBusy(true);
    try {
      const body = note.trim();
      if (body) {
        const { error } = await supabase.from("account_notes").insert({
          account_id: accountId,
          contact_id: task.contactId,
          body: `${task.title}: ${body}`,
          trigger_type: "none",
          is_pinned: false,
          created_by: userId,
        });
        if (error) throw error;
      }
      const { queued } = await completeTask({ taskId: task.id, label: task.title });
      setDoneHere((s) => new Set(s).add(task.id));
      onChanged();
      if (queued) toast.info(TASK_QUEUED_MESSAGE);
      else toast.success(next ? "Task completed — here is the next one" : "Task completed");
      goNext();
    } catch (e) {
      toastDbError(e, { action: "complete this task" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" data-testid="account-task-dialog">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2 pr-6">
            <span className="min-w-0 break-words">{task?.title ?? "Task"}</span>
            {task?.activityLabel ? (
              <Badge variant="secondary" className="shrink-0">
                {task.activityLabel}
              </Badge>
            ) : null}
          </DialogTitle>
          <DialogDescription asChild>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
              {task ? (
                <>
                  <span
                    className={cn(
                      "inline-flex items-center gap-1",
                      isOverdue(task) && !alreadyDone && "font-medium text-destructive",
                    )}
                  >
                    <CalendarClock className="size-3.5" />
                    {isOverdue(task) && !alreadyDone ? "Overdue · " : ""}
                    {dueText(task)}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <User className="size-3.5" />
                    {task.assigneeName ?? (task.assignee ? "Assigned" : "Unassigned")}
                  </span>
                </>
              ) : tasksQ.isLoading ? (
                <span>Loading…</span>
              ) : (
                <span>This task is no longer on the account.</span>
              )}
            </div>
          </DialogDescription>
        </DialogHeader>

        {task?.description ? (
          <p className="whitespace-pre-wrap break-words rounded-md bg-muted/60 px-3 py-2 text-[13px]">
            {task.description}
          </p>
        ) : null}

        {alreadyDone ? (
          <p className="flex items-center gap-1.5 text-[13px] text-success">
            <Check className="size-4" /> Done
            {task?.completedAt ? ` · ${format(new Date(task.completedAt), "d MMM, h:mm a")}` : ""}
          </p>
        ) : (
          <div className="space-y-1.5">
            <Label htmlFor="task-note">What happened? (optional)</Label>
            <Textarea
              id="task-note"
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Spoke to Dana, sending the COI Friday"
              disabled={writes.disabled}
            />
            <p className="text-[11.5px] text-muted-foreground">
              Saved to the account's timeline when you complete the task.
            </p>
          </div>
        )}

        <DialogFooter className="flex-row items-center gap-2 sm:justify-between">
          <Button
            variant="ghost"
            size="sm"
            className="mr-auto text-muted-foreground"
            onClick={goNext}
            disabled={busy || (!next && alreadyDone)}
          >
            {next ? (
              <>
                Skip to next <ChevronRight className="ml-0.5 size-3.5" />
              </>
            ) : (
              "Close"
            )}
          </Button>
          {!alreadyDone && task ? (
            <Button
              size="sm"
              onClick={complete}
              disabled={busy || writes.disabled}
              title={writes.reason ?? undefined}
            >
              <Check className="mr-1 size-4" />
              {next ? "Complete & next" : "Complete"}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
