/**
 * The live part of a Timeline row: the small action row on the right, the
 * pickers that save on pick, the editor and the delete confirm.
 *
 * Mark, with a screenshot of the card: "this needs major work, it just doesnt
 * look good or act like its editable". And on a task row: "tasks need to be
 * smarter and needs to act as a task this is just a non actionable item
 * which needs to change".
 *
 * The rule for what each row offers is `entryPolicy` in
 * `src/lib/timeline-edit.ts`; nothing here decides permissions. What this
 * file decides is the shape: a task's Complete is always on show, because a
 * task that hides its tick behind a hover is still a dead row on a phone.
 * Everything else appears on hover or focus, the way the job notices and
 * the photo grid reveal theirs — and stays on show for a coarse pointer,
 * where there is no hover to reveal it.
 */
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUpRight,
  CalendarDays,
  Check,
  ExternalLink,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Reply,
  RotateCcw,
  StickyNote,
  Trash2,
  UserRound,
} from "lucide-react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { PersonPicker } from "@/components/person-picker";
import { TodoPinMenuItem } from "@/components/todo/todo-pin";
import { toastDbError } from "@/lib/db-errors";
import type { TimelineEntry } from "@/lib/account-timeline";
import { TASK_QUEUED_MESSAGE, completeTask } from "@/lib/task-complete";
import {
  deleteConfirmText,
  deleteEntry,
  fromLocalInput,
  saveEntryEdit,
  toLocalInput,
  type EditableField,
  type EntryEdit,
  type EntryPolicy,
} from "@/lib/timeline-edit";
import { cn } from "@/lib/utils";

/**
 * The app's own hover-reveal: `.row-actions` in `styles.css` is opacity 0
 * until its `.group` row is hovered or something in it has focus, and always
 * on where there is no hover to reveal it (`@media (hover: none)`). The jobs
 * list's quick actions use the same class. Applied to the whole cluster, so
 * a keyboard user tabbing into the row sees every button light up at once.
 */
export const REVEAL_ON_HOVER = "row-actions";

const ICON_BUTTON = "size-6 text-muted-foreground hover:text-foreground";

/**
 * The row's action cluster. `onChanged` is the timeline's refresh; the
 * optimistic patch for Complete runs before it so the row reads done at once.
 */
export function EntryActions({
  entry,
  policy,
  accountId,
  locationId,
  disabled,
  disabledReason,
  onChanged,
  onReply,
}: {
  entry: TimelineEntry;
  policy: EntryPolicy;
  accountId: string;
  locationId: string | null;
  /** Writes are off (View As, approval pending) — every control disables with the reason. */
  disabled: boolean;
  disabledReason: string | null;
  onChanged: () => void;
  onReply?: () => void;
}) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  /**
   * Complete — the same `completeTask` the Needs-you-today card and /tasks
   * call. The timeline's own cached copy of the row is patched first so the
   * tick lands without waiting on the refetch; the invalidations that follow
   * are what refresh the pipeline strip and the account's task count.
   */
  const complete = useMutation({
    mutationFn: (reopen: boolean) =>
      completeTask({ taskId: entry.task!.id, label: entry.title, reopen }),
    onSuccess: ({ queued, status, completedAt }) => {
      qc.setQueryData(
        ["account-timeline", accountId],
        (
          prev:
            | { entries: TimelineEntry[]; pinned: unknown; due: unknown; locationId?: unknown }
            | undefined,
        ) =>
          prev
            ? {
                ...prev,
                entries: prev.entries.map((e) =>
                  e.id === entry.id && e.task
                    ? {
                        ...e,
                        done: status === "done",
                        overdue: status === "done" ? false : e.overdue,
                        at: completedAt ?? e.at,
                        task: { ...e.task, status, completedAt },
                      }
                    : e,
                ),
              }
            : prev,
      );
      if (queued) toast.info(TASK_QUEUED_MESSAGE);
      else toast.success(status === "done" ? "Task completed" : "Task reopened");
      onChanged();
    },
    onError: (e) => toastDbError(e, { action: "complete this task" }),
  });

  const save = useMutation({
    mutationFn: (edit: EntryEdit) => saveEntryEdit(entry, edit),
    onSuccess: () => {
      toast.success("Saved");
      setEditing(false);
      onChanged();
    },
    onError: (e) => toastDbError(e, { action: "save this change" }),
  });

  const remove = useMutation({
    mutationFn: () => deleteEntry(entry),
    onSuccess: () => {
      toast.success("Deleted");
      setConfirmingDelete(false);
      onChanged();
    },
    onError: (e) => toastDbError(e, { action: "delete this entry" }),
  });

  const busy = complete.isPending || save.isPending || remove.isPending;
  const off = disabled || busy || policy.pending;
  const title = disabled
    ? (disabledReason ?? undefined)
    : policy.pending
      ? policy.reason!
      : undefined;
  const has = (f: EditableField) => policy.fields.includes(f);

  const isTask = entry.kind === "task" && !!entry.task;
  const isNote = entry.kind === "note" && !!entry.note;

  return (
    <>
      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        {/* A task's tick is the reason the row exists. Never hidden. */}
        {isTask && policy.canComplete && (
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 text-[11px]"
            disabled={off}
            title={title}
            onClick={() => complete.mutate(false)}
          >
            <Check className="mr-1 size-3" /> Complete
          </Button>
        )}

        <span className={cn("flex items-center gap-0.5", REVEAL_ON_HOVER)}>
          {isTask && has("due") && (
            <ReschedulePopover
              value={entry.task!.dueDate}
              disabled={off}
              title={title}
              onPick={(due) => save.mutate({ due })}
            />
          )}
          {isTask && has("assignee") && (
            <ReassignPopover
              value={entry.task!.assignee}
              locationId={locationId}
              disabled={off}
              title={title}
              onPick={(assignee) => save.mutate({ assignee })}
            />
          )}

          {isNote && has("pin") && (
            <Button
              size="icon"
              variant="ghost"
              className={ICON_BUTTON}
              disabled={off}
              title={title ?? (entry.note!.is_pinned ? "Unpin" : "Pin to the top")}
              aria-label={entry.note!.is_pinned ? "Unpin note" : "Pin note to the top"}
              onClick={() => save.mutate({ pin: !entry.note!.is_pinned })}
            >
              {entry.note!.is_pinned ? <PinOff className="size-3" /> : <Pin className="size-3" />}
            </Button>
          )}

          {policy.fields.length > 0 && (
            <Button
              size="icon"
              variant="ghost"
              className={ICON_BUTTON}
              disabled={off}
              title={
                title ?? (entry.comm ? (entry.comm.note ? "Edit your note" : "Add a note") : "Edit")
              }
              aria-label={
                entry.comm
                  ? `${entry.comm.note ? "Edit your note on" : "Add a note to"} this ${entry.kind}`
                  : `Edit ${entry.kind}`
              }
              onClick={() => setEditing(true)}
            >
              {entry.comm ? <StickyNote className="size-3" /> : <Pencil className="size-3" />}
            </Button>
          )}

          {entry.kind === "email" && onReply && (
            <Button
              size="icon"
              variant="ghost"
              className={ICON_BUTTON}
              disabled={disabled}
              title={disabledReason ?? "Reply"}
              aria-label="Reply to this email"
              onClick={onReply}
            >
              <Reply className="size-3" />
            </Button>
          )}

          {entry.kind === "stage" && (
            <Button
              size="icon"
              variant="ghost"
              className={ICON_BUTTON}
              title="Show this stage on the rail"
              aria-label="Show this stage on the rail"
              onClick={() => showStageOnRail(entry.stage?.toStageId ?? null)}
            >
              <ArrowUpRight className="size-3" />
            </Button>
          )}

          {entry.kind === "document" && (
            <Button size="icon" variant="ghost" className={ICON_BUTTON} asChild>
              <Link to="/documents" title="Open documents" aria-label="Open documents">
                <ExternalLink className="size-3" />
              </Link>
            </Button>
          )}

          {(isTask || policy.canDelete) && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  className={ICON_BUTTON}
                  aria-label="More actions"
                  title="More"
                >
                  <MoreHorizontal className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[10rem]">
                {isTask && (
                  <DropdownMenuItem asChild>
                    <Link to="/tasks">
                      <ExternalLink className="mr-2 size-3.5" /> Open in Tasks
                    </Link>
                  </DropdownMenuItem>
                )}
                {isTask && (
                  <TodoPinMenuItem
                    taskId={entry.task!.id}
                    snapshot={{
                      title: entry.title,
                      assignee: entry.task!.assignee,
                      dueAt: entry.task!.dueAt,
                    }}
                    disabled={disabled}
                  />
                )}
                {isTask && policy.canReopen && (
                  <DropdownMenuItem disabled={off} onSelect={() => complete.mutate(true)}>
                    <RotateCcw className="mr-2 size-3.5" /> Reopen
                  </DropdownMenuItem>
                )}
                {policy.canDelete && (
                  <DropdownMenuItem
                    disabled={off}
                    className="text-destructive focus:text-destructive"
                    onSelect={() => setConfirmingDelete(true)}
                  >
                    <Trash2 className="mr-2 size-3.5" /> Delete
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </span>
      </div>

      {editing && (
        <EntryEditDialog
          entry={entry}
          policy={policy}
          locationId={locationId}
          saving={save.isPending}
          onSave={(edit) => save.mutate(edit)}
          onClose={() => setEditing(false)}
        />
      )}

      {/* Destructive, so it asks. */}
      <AlertDialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{deleteConfirmText(entry).title}</AlertDialogTitle>
            <AlertDialogDescription>{deleteConfirmText(entry).body}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              disabled={remove.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault();
                remove.mutate();
              }}
            >
              {remove.isPending ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** Change the due date — a date control, saved the moment a day is picked. */
function ReschedulePopover({
  value,
  disabled,
  title,
  onPick,
}: {
  value: string | null;
  disabled: boolean;
  title?: string;
  onPick: (due: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          className={ICON_BUTTON}
          disabled={disabled}
          title={title ?? "Reschedule"}
          aria-label="Reschedule task"
        >
          <CalendarDays className="size-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-auto space-y-2 p-2">
        <Label className="text-[11px] text-muted-foreground">Due</Label>
        <Input
          type="date"
          autoFocus
          defaultValue={value ?? ""}
          className="h-8 w-[160px] text-[12px]"
          onChange={(e) => {
            if (!e.target.value) return;
            onPick(e.target.value);
            setOpen(false);
          }}
        />
        {value && (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 w-full text-[11px]"
            onClick={() => {
              onPick(null);
              setOpen(false);
            }}
          >
            Clear the date
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** Hand the task to someone else — the app's person picker, saved on pick. */
function ReassignPopover({
  value,
  locationId,
  disabled,
  title,
  onPick,
}: {
  value: string | null;
  locationId: string | null;
  disabled: boolean;
  title?: string;
  onPick: (assignee: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          className={ICON_BUTTON}
          disabled={disabled}
          title={title ?? "Reassign"}
          aria-label="Reassign task"
        >
          <UserRound className="size-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[260px] space-y-2 p-2">
        <Label className="text-[11px] text-muted-foreground">Assigned to</Label>
        <PersonPicker
          value={value}
          locationId={locationId}
          className="h-9 text-[13px]"
          onChange={(id) => {
            if (id === value) return;
            onPick(id);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

/**
 * The editor. Its fields are exactly the policy's `fields`, and it names the
 * fields it is not offering when the record is the system's.
 */
export function EntryEditDialog({
  entry,
  policy,
  locationId,
  saving,
  onSave,
  onClose,
}: {
  entry: TimelineEntry;
  policy: EntryPolicy;
  locationId: string | null;
  saving: boolean;
  onSave: (edit: EntryEdit) => void;
  onClose: () => void;
}) {
  const has = (f: EditableField) => policy.fields.includes(f);
  const initialBody =
    entry.kind === "note"
      ? (entry.note?.body ?? "")
      : entry.kind === "task"
        ? (entry.task?.description ?? "")
        : entry.comm
          ? (entry.comm.note ?? "")
          : (entry.touch?.notes ?? "");
  const [title, setTitle] = useState(entry.title);
  const [body, setBody] = useState(initialBody);
  const [when, setWhen] = useState(entry.touch ? toLocalInput(entry.touch.occurredAt) : "");
  const [due, setDue] = useState(entry.task?.dueDate ?? "");
  const [assignee, setAssignee] = useState<string | null>(entry.task?.assignee ?? null);

  const heading = entry.comm
    ? `Note on this ${entry.kind === "sms" ? "text" : entry.kind}`
    : entry.kind === "note"
      ? "Edit note"
      : entry.kind === "task"
        ? "Edit task"
        : `Edit ${entry.kind === "meeting" ? "meeting" : "activity"}`;
  const bodyLabel = entry.kind === "note" || entry.comm ? "Note" : "Notes";
  const bodyRequired = entry.kind === "note";

  const submit = () => {
    const edit: EntryEdit = {};
    if (has("title")) edit.title = title;
    if (has("body")) edit.body = body;
    if (has("when")) {
      const iso = fromLocalInput(when);
      if (iso) edit.when = iso;
    }
    if (has("due")) edit.due = due || null;
    if (has("assignee")) edit.assignee = assignee;
    onSave(edit);
  };

  const invalid = (has("title") && !title.trim()) || (bodyRequired && !body.trim());

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{heading}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          {has("title") && (
            <div className="space-y-1.5">
              <Label>Title</Label>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} className="h-9" />
            </div>
          )}
          {has("body") && (
            <div className="space-y-1.5">
              <Label>{bodyLabel}</Label>
              <Textarea
                rows={4}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder={entry.comm ? "What came of it, what to remember" : undefined}
              />
            </div>
          )}
          {has("when") && (
            <div className="space-y-1.5">
              <Label>When</Label>
              <Input
                type="datetime-local"
                value={when}
                onChange={(e) => setWhen(e.target.value)}
                className="h-9"
              />
            </div>
          )}
          {(has("due") || has("assignee")) && (
            <div className="grid gap-3 sm:grid-cols-2">
              {has("due") && (
                <div className="space-y-1.5">
                  <Label>Due</Label>
                  <Input
                    type="date"
                    value={due}
                    onChange={(e) => setDue(e.target.value)}
                    className="h-9"
                  />
                </div>
              )}
              {has("assignee") && (
                <div className="space-y-1.5">
                  <Label>Assigned to</Label>
                  <PersonPicker
                    value={assignee}
                    locationId={locationId}
                    className="h-9 text-[13px]"
                    onChange={setAssignee}
                  />
                </div>
              )}
            </div>
          )}
          {policy.locked && (
            <p className="text-[11px] leading-snug text-muted-foreground">
              <span className="font-medium">Locked:</span> {policy.locked.fields.join(", ")}.{" "}
              {policy.locked.reason}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving || invalid}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A stage-change row is history and stays so; what it can do is point at the
 * stage on the rail above. Both rails mark their stages `data-stage-id`;
 * with no id, or a stage the rail no longer has, the rail itself is the
 * target.
 */
export function showStageOnRail(stageId: string | null) {
  if (typeof document === "undefined") return;
  const el =
    (stageId && document.querySelector<HTMLElement>(`[data-stage-id="${stageId}"]`)) ||
    document.querySelector<HTMLElement>("[data-stage-rail]");
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.add("ring-2", "ring-primary", "rounded-lg");
  window.setTimeout(() => el.classList.remove("ring-2", "ring-primary", "rounded-lg"), 1600);
}
