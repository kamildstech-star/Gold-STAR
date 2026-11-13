/**
 * The to-do list itself: quick add on top, one list grouped by job, done
 * items folded under "Done today". Rendered in full on /todo and in a
 * compact cut on the dashboard card.
 *
 * Mark: "Can we add a to do list (linked to jobs) which would be user
 * specific & potentially tied to tasks the in jobs where you can choose to
 * add that task to the to do list"
 *
 * Two kinds of row look the same on purpose. A pin is a real job task —
 * ticking it is `completeTask`, the app's one "mark done" — and a quick
 * item is the rep's own note. What tells them apart on the row is only what
 * the task brings with it: a due countdown, and the assignee's initials
 * when the task is somebody else's. Every write here goes through the
 * hooks in `use-todo.ts`, which patch the list first, so a tick in a
 * basement reads as ticked.
 *
 * Reordering is `@dnd-kit`, the same kit the dashboard and the pipeline
 * use, kept to within a job: dragging cannot move a note onto another job,
 * and a pin's job is its task's. The order is one `sort_order` sequence
 * across the list, written for the rows that changed.
 */
import * as React from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  DndContext,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Briefcase,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  GripVertical,
  ListChecks,
  MoreHorizontal,
  Plus,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { useWritesDisabled } from "@/components/app-context";
import { JobSearchField, type PickedJob } from "@/components/job-search-field";
import { TodoPinMenuItem } from "@/components/todo/todo-pin";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { toastDbError } from "@/lib/db-errors";
import { dueLabel, isOverdue } from "@/lib/needs-you-today";
import { TASK_QUEUED_MESSAGE } from "@/lib/task-complete";
import {
  TODO_QUEUED_MESSAGE,
  groupTodo,
  initials,
  moveWithinGroup,
  partitionTodo,
  resequence,
  type TodoGroup,
  type TodoItem,
  type TodoJob,
} from "@/lib/todo";
import { useTodoWrites } from "@/lib/use-todo";
import { cn } from "@/lib/utils";

/** How many open rows the dashboard card shows before "View all". */
export const COMPACT_ROWS = 6;

export function TodoList({ compact = false }: { compact?: boolean }) {
  const { items, available, add, tick, remove, reorder, promote, userId } = useTodoWrites();
  const writes = useWritesDisabled();
  const off = writes.disabled || !userId;

  const { open, doneToday } = React.useMemo(() => partitionTodo(items), [items]);
  const groups = React.useMemo(() => groupTodo(open), [open]);
  const doneGroups = React.useMemo(() => groupTodo(doneToday), [doneToday]);
  const [showDone, setShowDone] = React.useState(false);

  /* Names for the tasks that are somebody else's — one lookup for the list. */
  const others = React.useMemo(
    () => [...new Set(items.map((i) => i.assignee).filter((a): a is string => !!a))].sort(),
    [items],
  );
  const names = useQuery({
    queryKey: ["todo-assignees", others],
    enabled: others.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("user_id,full_name")
        .in("user_id", others);
      if (error) throw error;
      return new Map((data ?? []).map((p) => [p.user_id, p.full_name as string | null]));
    },
  });
  const nameOf = (id: string) => names.data?.get(id) ?? null;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
  );

  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over) return;
    const next = moveWithinGroup(groups, String(e.active.id), String(e.over.id));
    if (!next) return;
    const writesNeeded = resequence(next);
    if (writesNeeded.length === 0) return;
    reorder.mutate(writesNeeded, {
      onSuccess: ({ queued }) => {
        if (queued) toast.info(TODO_QUEUED_MESSAGE);
      },
      onError: (err) => toastDbError(err, { action: "reorder your to-do list" }),
    });
  };

  const onTick = (item: TodoItem, done: boolean) =>
    tick.mutate(
      { item, done },
      {
        onSuccess: ({ queued }) => {
          if (queued) toast.info(item.kind === "pin" ? TASK_QUEUED_MESSAGE : TODO_QUEUED_MESSAGE);
        },
        onError: (err) => toastDbError(err, { action: "update this to-do" }),
      },
    );

  const onRemove = (item: TodoItem) =>
    remove.mutate(item, {
      onSuccess: ({ queued }) => {
        if (queued) toast.info(TODO_QUEUED_MESSAGE);
      },
      onError: (err) => toastDbError(err, { action: "remove this to-do" }),
    });

  const onPromote = (item: TodoItem) =>
    promote.mutate(
      { item, dueDate: null },
      {
        onSuccess: ({ queued }) => {
          if (queued) toast.info(TODO_QUEUED_MESSAGE);
          else toast.success("It's a task now — assigned to you, on the job.");
        },
        onError: (err) => toastDbError(err, { action: "make this a task" }),
      },
    );

  if (!available) return null;

  const rowProps = { off, compact, nameOf, onTick, onRemove, onPromote };

  const onAdd = (title: string, job: TodoJob | null) =>
    add.mutate(
      { title, job },
      {
        onSuccess: ({ queued }) => {
          if (queued) toast.info(TODO_QUEUED_MESSAGE);
        },
        onError: (err) => toastDbError(err, { action: "add to your to-do list" }),
      },
    );

  /* The compact cut: the first few open rows, still grouped, then "View all". */
  if (compact) {
    let budget = COMPACT_ROWS;
    const shown: TodoGroup[] = [];
    for (const g of groups) {
      if (budget <= 0) break;
      const take = g.items.slice(0, budget);
      budget -= take.length;
      shown.push({ ...g, items: take });
    }
    const hidden = open.length - shown.reduce((n, g) => n + g.items.length, 0);
    return (
      <div className="space-y-2" data-todo-compact>
        {/*
          The same one-line add as the full page, on the card itself.
          
          Moshe asked for the list "under everyones dashboard", and adding to
          it is the thing a user does most — a free-standing "order labels"
          should be one tap and one line, not a trip to another page. The card
          used to offer only a link to /todo, which on a phone is a navigation
          away from the dashboard to type four words.
          
          It is the same QuickAdd component and the same handler, so the job
          picker and the offline queueing behave identically in both places.
        */}
        <QuickAdd disabled={off} reason={writes.reason} onAdd={onAdd} />
        {open.length === 0 ? (
          <div className="text-[13px] text-muted-foreground">
            Nothing on your list yet — type one above, or bookmark a task on any job.
          </div>
        ) : (
          shown.map((g) => <Group key={g.key} group={g} {...rowProps} />)
        )}
        {hidden > 0 && (
          <Link
            to="/todo"
            className="inline-flex items-center gap-0.5 text-[12px] font-medium text-primary"
          >
            {hidden} more
            <ChevronRight className="size-3.5" />
          </Link>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <QuickAdd disabled={off} reason={writes.reason} onAdd={onAdd} />

      {open.length === 0 ? (
        <div className="rounded-md border px-3 py-6 text-center text-[13px] text-muted-foreground">
          <ListChecks className="mx-auto mb-1.5 size-5" />
          Nothing on your list. Type one above, or bookmark a task on any job.
        </div>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <div className="space-y-3">
            {groups.map((g) => (
              <SortableContext
                key={g.key}
                items={g.items.map((i) => i.id)}
                strategy={verticalListSortingStrategy}
              >
                <Group group={g} {...rowProps} draggable />
              </SortableContext>
            ))}
          </div>
        </DndContext>
      )}

      {doneToday.length > 0 && (
        <div className="rounded-md border">
          <button
            type="button"
            className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-[12px] font-medium text-muted-foreground"
            aria-expanded={showDone}
            onClick={() => setShowDone((v) => !v)}
          >
            {showDone ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <ChevronRight className="size-3.5" />
            )}
            Done today
            <span className="font-mono tabular-nums">{doneToday.length}</span>
          </button>
          {showDone && (
            <div className="space-y-2 border-t px-1 pb-1 pt-2">
              {doneGroups.map((g) => (
                <Group key={g.key} group={g} {...rowProps} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ quick add */

function QuickAdd({
  disabled,
  reason,
  onAdd,
}: {
  disabled: boolean;
  reason: string | null;
  onAdd: (title: string, job: TodoJob | null) => void;
}) {
  const [title, setTitle] = React.useState("");
  const [pickJob, setPickJob] = React.useState(false);
  const [job, setJob] = React.useState<PickedJob | null>(null);

  const submit = () => {
    const t = title.trim();
    if (!t) return;
    onAdd(t, job ? toTodoJob(job) : null);
    setTitle("");
  };

  return (
    <div className="space-y-2 rounded-md border bg-card p-2">
      <div className="flex items-center gap-2">
        <Plus className="size-4 shrink-0 text-muted-foreground" />
        <Input
          value={title}
          disabled={disabled}
          title={reason ?? undefined}
          placeholder="Add a to-do — Enter to save"
          aria-label="New to-do"
          className="h-9"
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
        />
        <Button
          type="button"
          size="sm"
          variant={job ? "secondary" : "ghost"}
          className="h-9 shrink-0 px-2 text-[12px]"
          disabled={disabled}
          aria-pressed={pickJob || !!job}
          onClick={() => setPickJob((v) => !v)}
          title="Tie this to a job"
        >
          <Briefcase className="size-3.5 sm:mr-1" />
          <span className="hidden sm:inline">{job ? job.job_number : "Job"}</span>
        </Button>
        <Button
          type="button"
          size="sm"
          className="h-9 shrink-0"
          disabled={disabled || !title.trim()}
          onClick={submit}
        >
          Add
        </Button>
      </div>
      {(pickJob || job) && (
        <JobSearchField
          value={job}
          onChange={(j) => {
            setJob(j);
            if (!j) setPickJob(false);
          }}
          label={null}
          disabled={disabled}
          emptyHint="No open jobs match."
        />
      )}
    </div>
  );
}

function toTodoJob(j: PickedJob): TodoJob {
  return {
    id: j.id,
    job_number: j.job_number,
    address: j.address,
    job_name: j.job_name,
    loss_type: null,
    location_id: j.location_id,
    account_id: j.account_id,
  };
}

/* ---------------------------------------------------------------- groups */

type RowProps = {
  off: boolean;
  compact: boolean;
  nameOf: (id: string) => string | null;
  onTick: (item: TodoItem, done: boolean) => void;
  onRemove: (item: TodoItem) => void;
  onPromote: (item: TodoItem) => void;
};

function Group({ group, draggable, ...row }: RowProps & { group: TodoGroup; draggable?: boolean }) {
  return (
    <section data-todo-group={group.key || "none"}>
      <h3
        className={cn(
          "mb-1 flex items-center gap-1.5 text-[12px] font-medium text-muted-foreground",
          row.compact && "text-[11px]",
        )}
      >
        {group.job ? (
          <Link
            to="/jobs/$id"
            params={{ id: group.job.id }}
            className="inline-flex min-w-0 items-center gap-1 hover:text-foreground hover:underline"
          >
            <Briefcase className="size-3 shrink-0" />
            <span className="truncate">{group.label}</span>
          </Link>
        ) : (
          <span>{group.label}</span>
        )}
      </h3>
      <ul
        className={cn(
          "divide-y rounded-md border bg-card",
          row.compact && "border-0 bg-transparent",
        )}
      >
        {group.items.map((it) => (
          <Row key={it.id} item={it} draggable={!!draggable} {...row} />
        ))}
      </ul>
    </section>
  );
}

function Row({
  item,
  draggable,
  off,
  compact,
  nameOf,
  onTick,
  onRemove,
  onPromote,
}: RowProps & {
  item: TodoItem;
  draggable: boolean;
}) {
  const sortable = useSortable({ id: item.id, disabled: !draggable || off });
  const overdue = !item.done && isOverdue(item.dueAt);
  const who = item.assignee ? nameOf(item.assignee) : null;

  return (
    <li
      ref={sortable.setNodeRef}
      style={{
        transform: CSS.Transform.toString(sortable.transform),
        transition: sortable.transition,
      }}
      className={cn(
        "flex items-center gap-1.5 px-1.5",
        compact ? "py-1" : "py-1.5",
        sortable.isDragging && "relative z-10 bg-accent shadow-sm",
      )}
      data-todo-item={item.kind}
      data-todo-done={item.done ? "true" : "false"}
    >
      {draggable && (
        <button
          type="button"
          className="touch-none cursor-grab rounded p-0.5 text-muted-foreground/60 hover:text-foreground active:cursor-grabbing disabled:cursor-default"
          aria-label={`Drag to reorder ${item.title}`}
          disabled={off}
          {...sortable.attributes}
          {...sortable.listeners}
        >
          <GripVertical className="size-3.5" />
        </button>
      )}
      <label
        className={cn("flex shrink-0 items-center justify-center", compact ? "size-7" : "size-9")}
      >
        <Checkbox
          checked={item.done}
          disabled={off}
          onCheckedChange={(v) => onTick(item, v === true)}
          aria-label={item.done ? `Reopen "${item.title}"` : `Mark "${item.title}" done`}
        />
      </label>
      <div className="min-w-0 flex-1">
        <div
          className={cn("truncate text-[13px]", item.done && "text-muted-foreground line-through")}
        >
          {item.title}
        </div>
        {!compact && item.kind === "pin" && (
          <div className="text-[11px] text-muted-foreground">Job task</div>
        )}
      </div>
      {item.dueAt && !item.done && (
        <span
          className={cn(
            "shrink-0 text-[11px] tabular-nums",
            overdue ? "font-medium text-destructive" : "text-muted-foreground",
          )}
          data-todo-due
        >
          {dueLabel(item.dueAt)}
        </span>
      )}
      {item.assignee && (
        <span
          className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold uppercase text-muted-foreground"
          title={who ? `${who}'s task` : "Somebody else's task"}
          aria-label={who ? `${who}'s task` : "Somebody else's task"}
          data-todo-assignee
        >
          {initials(who)}
        </span>
      )}
      {!compact && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              className="size-7 shrink-0 text-muted-foreground"
              aria-label={`More for ${item.title}`}
            >
              <MoreHorizontal className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[11rem]">
            {item.kind === "pin" && (
              <DropdownMenuItem asChild>
                <Link to="/tasks">
                  <ExternalLink className="mr-2 size-3.5" /> Open task
                </Link>
              </DropdownMenuItem>
            )}
            {item.job && (
              <DropdownMenuItem asChild>
                <Link to="/jobs/$id" params={{ id: item.job.id }}>
                  <Briefcase className="mr-2 size-3.5" /> Open job
                </Link>
              </DropdownMenuItem>
            )}
            {item.kind === "quick" && !item.done && (
              <DropdownMenuItem disabled={off} onSelect={() => onPromote(item)}>
                <ListChecks className="mr-2 size-3.5" /> Make this a task
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            {item.kind === "pin" ? (
              /* A pin comes off through the same hook that put it on. */
              <TodoPinMenuItem taskId={item.taskId} disabled={off} />
            ) : (
              <DropdownMenuItem
                disabled={off}
                className="text-destructive focus:text-destructive"
                onSelect={() => onRemove(item)}
              >
                <Trash2 className="mr-2 size-3.5" /> Remove from my list
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </li>
  );
}
