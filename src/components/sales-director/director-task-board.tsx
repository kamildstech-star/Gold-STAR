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
import { Plus } from "lucide-react";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { useAppContext, useWritesDisabled } from "@/components/app-context";
import { useDefaultLocationId } from "@/components/location-picker";
import { createTask } from "@/components/task-dialog";
import { EmptyLine, LoadError } from "@/components/ui-density";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { toastDbError } from "@/lib/db-errors";
import { dueLabel, todayIso, type Task, type TaskStatus } from "@/lib/tasks";
import { initialsOf } from "@/lib/sales-director";

/** To Do / In Progress / Done, drag between columns, add per column. */

const COLUMNS: { status: TaskStatus; label: string }[] = [
  { status: "open", label: "To Do" },
  { status: "in_progress", label: "In Progress" },
  { status: "done", label: "Done" },
];

export type BoardPerson = { user_id: string; full_name: string };

async function fetchTasks(): Promise<Task[]> {
  const { data, error } = await supabase
    .from("tasks")
    .select("*")
    .in("status", ["open", "in_progress", "done"])
    .order("due_date", { ascending: true, nullsFirst: false })
    .limit(300);
  if (error) throw error;
  return (data ?? []) as Task[];
}

function Card({ task, name }: { task: Task; name: string }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: task.id,
  });
  const overdue = !!task.due_date && task.due_date < todayIso() && task.status !== "done";
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      style={
        transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` } : undefined
      }
      className={cn(
        "cursor-grab rounded-lg border border-border bg-card p-3 shadow-[0_1px_2px_rgba(16,36,61,0.04)]",
        isDragging && "opacity-60",
      )}
    >
      <div className="flex items-start gap-2">
        <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-muted text-[11px] font-semibold">
          {name === "Unassigned" ? "—" : initialsOf(name)}
        </span>
        <div className="min-w-0">
          <p className="truncate text-[13px] font-medium">{task.title}</p>
          <p className="mt-0.5 text-[12px] text-muted-foreground">{name}</p>
          <p className={cn("text-[12px]", overdue ? "text-destructive" : "text-muted-foreground")}>
            {dueLabel(task)}
          </p>
        </div>
      </div>
    </div>
  );
}

function Column({
  status,
  label,
  tasks,
  nameFor,
  onAdd,
}: {
  status: TaskStatus;
  label: string;
  tasks: Task[];
  nameFor: (id: string | null) => string;
  onAdd: (status: TaskStatus) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "rounded-xl border border-border bg-muted/40 p-3",
        isOver && "ring-2 ring-primary/40",
      )}
    >
      <div className="flex items-center justify-between">
        <h4 className="text-[13px] font-semibold">
          {label}{" "}
          <span className="ml-1 rounded-full bg-card px-2 py-0.5 text-[11px] text-muted-foreground">
            {tasks.length}
          </span>
        </h4>
      </div>
      <div className="mt-3 space-y-2">
        {tasks.length === 0 ? (
          <EmptyLine>Nothing here.</EmptyLine>
        ) : (
          tasks.slice(0, 12).map((t) => <Card key={t.id} task={t} name={nameFor(t.assignee)} />)
        )}
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="mt-2 w-full justify-start text-[13px] text-muted-foreground"
        onClick={() => onAdd(status)}
      >
        <Plus className="size-3.5" /> Add task
      </Button>
    </div>
  );
}

export function DirectorTaskBoard({
  people,
  openSignal,
}: {
  people: BoardPerson[];
  /** Increment to open the create dialog from the page header button. */
  openSignal?: number;
}) {
  const qc = useQueryClient();
  const app = useAppContext();
  const { disabled: writesDisabled } = useWritesDisabled();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const q = useQuery({ queryKey: ["sd-tasks"], queryFn: fetchTasks });

  const [dialog, setDialog] = React.useState<{ status: TaskStatus } | null>(null);
  const [title, setTitle] = React.useState("");
  const [assignee, setAssignee] = React.useState<string>("");
  const [due, setDue] = React.useState(todayIso());
  const locationId = useDefaultLocationId();

  React.useEffect(() => {
    if (openSignal) setDialog({ status: "open" });
  }, [openSignal]);

  const nameFor = React.useCallback(
    (id: string | null) => people.find((p) => p.user_id === id)?.full_name ?? "Unassigned",
    [people],
  );

  const move = useMutation({
    mutationFn: async (v: { id: string; status: TaskStatus }) => {
      const { error } = await supabase
        .from("tasks")
        .update({
          status: v.status,
          completed_at: v.status === "done" ? new Date().toISOString() : null,
        })
        .eq("id", v.id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sd-tasks"] }),
    onError: (e) => toastDbError(e, { action: "move task" }),
  });

  const create = useMutation({
    mutationFn: async () => {
      const createdBy = app.userId;
      if (!createdBy) throw new Error("Sign in again before assigning a task.");
      // Through createTask, not a bare insert: it stamps location_id, which is
      // what the tasks RLS policy scopes on. Without it the row is visible only
      // to its assignee and its author, so this board never shows it again.
      const { data, error } = await createTask({
        title: title.trim(),
        assignee: assignee || null,
        dueDate: due || null,
        createdBy,
        link: { locationId },
      });
      if (error) throw error;
      // createTask always opens a task; a card dropped into another column
      // still has to land there.
      const status = dialog?.status ?? "open";
      if (data && status !== "open") {
        const { error: moveError } = await supabase
          .from("tasks")
          .update({
            status,
            completed_at: status === "done" ? new Date().toISOString() : null,
          })
          .eq("id", data.id);
        if (moveError) throw moveError;
      }
    },
    onSuccess: () => {
      toast.success("Task assigned");
      setTitle("");
      setAssignee("");
      setDialog(null);
      qc.invalidateQueries({ queryKey: ["sd-tasks"] });
    },
    onError: (e) => toastDbError(e, { action: "create task" }),
  });

  if (q.error) return <LoadError what="tasks" error={q.error} />;

  const tasks = q.data ?? [];

  function onDragEnd(e: DragEndEvent) {
    const status = e.over?.id as TaskStatus | undefined;
    const id = e.active.id as string;
    if (!status) return;
    const task = tasks.find((t) => t.id === id);
    if (!task || task.status === status) return;
    if (writesDisabled) return;
    move.mutate({ id, status });
  }

  return (
    <>
      <DndContext sensors={sensors} onDragEnd={onDragEnd}>
        <div className="grid gap-3 md:grid-cols-3">
          {COLUMNS.map((c) => (
            <Column
              key={c.status}
              status={c.status}
              label={c.label}
              tasks={tasks.filter((t) => t.status === c.status)}
              nameFor={nameFor}
              onAdd={(s) => setDialog({ status: s })}
            />
          ))}
        </div>
      </DndContext>

      <Dialog open={!!dialog} onOpenChange={(o) => setDialog(o ? dialog : null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Assign task</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label htmlFor="sd-task-title">Task</Label>
              <Input
                id="sd-task-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Follow up with Northside Property"
              />
            </div>
            <div>
              <Label>Assign to</Label>
              <Select value={assignee} onValueChange={setAssignee}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose a rep" />
                </SelectTrigger>
                <SelectContent>
                  {people.map((p) => (
                    <SelectItem key={p.user_id} value={p.user_id}>
                      {p.full_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="sd-task-due">Due</Label>
              <Input
                id="sd-task-due"
                type="date"
                value={due}
                onChange={(e) => setDue(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              disabled={!title.trim() || writesDisabled || create.isPending}
              onClick={() => create.mutate()}
            >
              Assign
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
