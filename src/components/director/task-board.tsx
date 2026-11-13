import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DndContext,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { toast } from "sonner";
import { AlertTriangle, Plus } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { useAppContext, useWritesDisabled } from "@/components/app-context";
import { useDefaultLocationId } from "@/components/location-picker";
import { createTask } from "@/components/task-dialog";
import { EmptyLine, LoadError } from "@/components/ui-density";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { toastDbError } from "@/lib/db-errors";
import {
  dueLabel,
  todayIso,
  TASK_PRIORITIES,
  TASK_PRIORITY_LABEL,
  TASK_STATUS_LABEL,
  type Task,
  type TaskPriority,
  type TaskStatus,
} from "@/lib/tasks";

/**
 * Every open task across the team on one board. Group by rep to see who is
 * carrying what and drag a card to reassign, or group by status to move work
 * along. Overdue is flagged on the card and counted per column, because that
 * is the only number a manager acts on here.
 */

type Person = { user_id: string; full_name: string | null };

const UNASSIGNED = "unassigned";
const BOARD_STATUSES: TaskStatus[] = ["open", "in_progress", "done"];

async function fetchBoardTasks(): Promise<Task[]> {
  const { data, error } = await supabase
    .from("tasks")
    .select("*")
    .in("status", ["open", "in_progress"])
    .order("due_date", { ascending: true, nullsFirst: false })
    .limit(500);
  if (error) throw error;
  return (data ?? []) as Task[];
}

function isOverdue(t: Task) {
  return !!t.due_date && t.due_date < todayIso() && t.status !== "done";
}

function TaskCard({ task, personName }: { task: Task; personName?: string | undefined }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: task.id,
  });
  const overdue = isOverdue(task);
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      style={
        transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` } : undefined
      }
      className={cn(
        "cursor-grab rounded-md border bg-card p-2 shadow-sm active:cursor-grabbing",
        isDragging && "opacity-60",
        overdue && "border-destructive/50",
      )}
    >
      <div className="text-[13px] font-semibold leading-snug">{task.title}</div>
      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className={cn(overdue && "font-semibold text-destructive")}>
          {overdue && <AlertTriangle className="mr-0.5 inline size-3" />}
          {dueLabel(task)}
        </span>
        {personName && <span className="truncate">· {personName}</span>}
        {task.priority !== "normal" && (
          <Badge variant={task.priority === "urgent" ? "destructive" : "outline"}>
            {TASK_PRIORITY_LABEL[task.priority]}
          </Badge>
        )}
      </div>
    </div>
  );
}

function Column({
  id,
  title,
  tasks,
  nameFor,
  showOwner,
}: {
  id: string;
  title: string;
  tasks: Task[];
  nameFor: (userId: string | null) => string | undefined;
  showOwner: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  const overdue = tasks.filter(isOverdue).length;
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex w-[240px] shrink-0 flex-col gap-1.5 rounded-md border bg-muted/30 p-2",
        isOver && "ring-2 ring-primary",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-[12px] font-bold">{title}</span>
        <span className="flex items-center gap-1">
          {overdue > 0 && (
            <Badge variant="destructive" className="h-4 px-1 text-[10px] tabular-nums">
              {overdue} late
            </Badge>
          )}
          <span className="text-[11px] tabular-nums text-muted-foreground">{tasks.length}</span>
        </span>
      </div>
      {tasks.length ? (
        tasks.map((t) => (
          <TaskCard key={t.id} task={t} personName={showOwner ? nameFor(t.assignee) : undefined} />
        ))
      ) : (
        <p className="py-3 text-center text-[11px] text-muted-foreground">Nothing open</p>
      )}
    </div>
  );
}

export function TaskBoard({ people }: { people: Person[] }) {
  const qc = useQueryClient();
  const app = useAppContext();
  const { disabled: writesDisabled } = useWritesDisabled();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const [groupBy, setGroupBy] = React.useState<"rep" | "status">("rep");
  const [overdueOnly, setOverdueOnly] = React.useState(false);

  const q = useQuery({ queryKey: ["director-tasks"], queryFn: fetchBoardTasks });

  const nameFor = React.useCallback(
    (userId: string | null) =>
      userId ? (people.find((p) => p.user_id === userId)?.full_name ?? "Other") : "Unassigned",
    [people],
  );

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["director-tasks"] });
    qc.invalidateQueries({ queryKey: ["tasks"] });
  };

  const update = useMutation({
    mutationFn: async (v: { id: string; patch: Partial<Task> }) => {
      const { error } = await supabase.from("tasks").update(v.patch).eq("id", v.id);
      if (error) throw error;
    },
    onSuccess: (_d, v) => {
      toast.success("assignee" in v.patch ? "Task reassigned" : "Task updated");
      invalidate();
    },
    onError: (e) => toastDbError(e, { action: "update task" }),
  });

  const tasks = React.useMemo(() => {
    const rows = q.data ?? [];
    return overdueOnly ? rows.filter(isOverdue) : rows;
  }, [q.data, overdueOnly]);

  const columns = React.useMemo(() => {
    if (groupBy === "status") {
      return BOARD_STATUSES.map((s) => ({
        id: s,
        title: TASK_STATUS_LABEL[s],
        tasks: tasks.filter((t) => t.status === s),
      }));
    }
    const known = new Set(people.map((p) => p.user_id));
    return [
      { id: UNASSIGNED, title: "Unassigned", tasks: tasks.filter((t) => !t.assignee) },
      ...people.map((p) => ({
        id: p.user_id,
        title: p.full_name ?? "Unnamed",
        tasks: tasks.filter((t) => t.assignee === p.user_id),
      })),
      {
        id: "other",
        title: "Other",
        tasks: tasks.filter((t) => t.assignee && !known.has(t.assignee)),
      },
    ].filter((c) => c.id !== "other" || c.tasks.length > 0);
  }, [groupBy, tasks, people]);

  function onDragEnd(e: DragEndEvent) {
    const target = e.over?.id ? String(e.over.id) : null;
    if (!target || target === "other") return;
    const taskId = String(e.active.id);
    const current = (q.data ?? []).find((t) => t.id === taskId);
    if (!current) return;
    if (writesDisabled) {
      toast.error("Read-only while previewing another role");
      return;
    }
    if (groupBy === "status") {
      const next = target as TaskStatus;
      if (current.status === next) return;
      update.mutate({
        id: taskId,
        patch: {
          status: next,
          completed_at: next === "done" ? new Date().toISOString() : null,
        } as Partial<Task>,
      });
      return;
    }
    const next = target === UNASSIGNED ? null : target;
    if (current.assignee === next) return;
    update.mutate({ id: taskId, patch: { assignee: next } as Partial<Task> });
  }

  if (q.isError) return <LoadError what="tasks" error={q.error} onRetry={() => void q.refetch()} />;

  const totalOverdue = (q.data ?? []).filter(isOverdue).length;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Tabs value={groupBy} onValueChange={(v) => setGroupBy(v as "rep" | "status")}>
          <TabsList>
            <TabsTrigger value="rep" className="text-[12px]">
              By rep
            </TabsTrigger>
            <TabsTrigger value="status" className="text-[12px]">
              By status
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <Button
          type="button"
          size="sm"
          variant={overdueOnly ? "default" : "outline"}
          className="h-8"
          onClick={() => setOverdueOnly((v) => !v)}
        >
          <AlertTriangle className="size-3.5" />
          Overdue {totalOverdue > 0 ? `(${totalOverdue})` : ""}
        </Button>
        <div className="ml-auto">
          <NewTaskDialog
            people={people}
            createdBy={app.userId}
            disabled={writesDisabled}
            onCreated={invalidate}
          />
        </div>
      </div>

      {q.isLoading ? (
        <EmptyLine>Loading tasks…</EmptyLine>
      ) : (
        <DndContext sensors={sensors} onDragEnd={onDragEnd}>
          <div className="flex gap-2 overflow-x-auto pb-2">
            {columns.map((c) => (
              <Column
                key={c.id}
                id={c.id}
                title={c.title}
                tasks={c.tasks}
                nameFor={nameFor}
                showOwner={groupBy === "status"}
              />
            ))}
          </div>
        </DndContext>
      )}
      <p className="text-[11px] text-muted-foreground">
        Drag a card between columns to {groupBy === "rep" ? "reassign it" : "move its status"}.
      </p>
    </div>
  );
}

function NewTaskDialog({
  people,
  createdBy,
  disabled,
  onCreated,
}: {
  people: Person[];
  createdBy: string | null;
  disabled: boolean;
  onCreated: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [title, setTitle] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [assignee, setAssignee] = React.useState<string>(UNASSIGNED);
  const [dueDate, setDueDate] = React.useState(todayIso());
  const [priority, setPriority] = React.useState<TaskPriority>("normal");
  const locationId = useDefaultLocationId();

  const create = useMutation({
    mutationFn: async () => {
      if (!createdBy) throw new Error("Sign in again before assigning a task.");
      // Through createTask, not a bare insert: it stamps location_id, which is
      // what the tasks RLS policy scopes on. Without it the row is visible only
      // to its assignee and its author, so this board never shows it again.
      const { error } = await createTask({
        title: title.trim(),
        description: description.trim() || null,
        assignee: assignee === UNASSIGNED ? null : assignee,
        dueDate: dueDate || null,
        priority,
        createdBy,
        link: { locationId },
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Task assigned");
      setOpen(false);
      setTitle("");
      setDescription("");
      onCreated();
    },
    onError: (e) => toastDbError(e, { action: "create task" }),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" size="sm" className="h-8" disabled={disabled}>
          <Plus className="size-3.5" />
          Assign task
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>Assign a task</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="text-xs">Task</Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Call the adjuster back"
            />
          </div>
          <div>
            <Label className="text-xs">Detail (optional)</Label>
            <Textarea
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label className="text-xs">Assign to</Label>
              <Select value={assignee} onValueChange={setAssignee}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
                  {people.map((p) => (
                    <SelectItem key={p.user_id} value={p.user_id}>
                      {p.full_name ?? "Unnamed"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Due</Label>
              <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </div>
          </div>
          <div>
            <Label className="text-xs">Priority</Label>
            <Select value={priority} onValueChange={(v) => setPriority(v as TaskPriority)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TASK_PRIORITIES.map((p) => (
                  <SelectItem key={p} value={p}>
                    {TASK_PRIORITY_LABEL[p]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!title.trim() || create.isPending || disabled}
            onClick={() => create.mutate()}
          >
            Assign
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
