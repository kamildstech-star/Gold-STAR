import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAppContext, useWritesDisabled } from "@/components/app-context";
import { useDefaultLocationId } from "@/components/location-picker";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  TASK_PRIORITIES,
  TASK_PRIORITY_LABEL,
  createTask,
  dueInDays,
  type TaskLink,
  type TaskPriority,
} from "@/lib/tasks";
import { toastDbError } from "@/lib/db-errors";

/*
 * `TaskLink` and `createTask` moved to src/lib/tasks.ts so the `location_id`
 * guarantee sits in one testable place instead of in a component module. They
 * are re-exported here because four other call sites import them from this
 * path and nothing about their contract changed.
 */
export type { TaskLink };
export { createTask };

export function NewTaskDialog({
  link,
  defaultTitle,
  trigger,
  onCreated,
}: {
  link?: TaskLink;
  defaultTitle?: string;
  trigger?: React.ReactNode;
  onCreated?: () => void;
}) {
  const { userId } = useAppContext();
  const defaultLocationId = useDefaultLocationId();
  const { disabled: writesDisabled, reason } = useWritesDisabled();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(defaultTitle ?? "");
  const [description, setDescription] = useState("");
  const [dueDate, setDueDate] = useState(dueInDays(1));
  const [dueTime, setDueTime] = useState("");
  const [priority, setPriority] = useState<TaskPriority>("normal");
  const [assignee, setAssignee] = useState("me");

  const peopleQuery = useQuery({
    queryKey: ["task-assignees"],
    enabled: open,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("user_id, full_name")
        .eq("is_active", true)
        .order("full_name");
      if (error) throw error;
      return data ?? [];
    },
  });

  const mutation = useMutation({
    mutationKey: ["tasks", "create"],
    mutationFn: async () => {
      if (!userId) throw new Error("Not signed in");
      const { error } = await createTask({
        title: title.trim(),
        description: description.trim() || null,
        assignee: assignee === "me" ? userId : assignee,
        dueDate: dueDate || null,
        dueTime: dueTime || null,
        priority,
        createdBy: userId,
        link: {
          ...link,
          locationId: link?.locationId ?? defaultLocationId ?? null,
        },
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Task created");
      qc.invalidateQueries({ queryKey: ["tasks"] });
      /*
       * The job's own lists are cached under their own keys, which ["tasks"]
       * does not reach. A task made from a job's Tasks tab was saved and then
       * not shown — David, 22 Sep: "When you go to certain jobs, tasks aren't
       * populating. This I did manually today." — until the tab was reopened.
       */
      if (link?.jobId) {
        qc.invalidateQueries({ queryKey: ["job-tasks", link.jobId] });
        qc.invalidateQueries({ queryKey: ["job-rail-tasks", link.jobId] });
      }
      setOpen(false);
      setTitle(defaultTitle ?? "");
      setDescription("");
      onCreated?.();
    },
    onError: (error) => toastDbError(error, { action: "create task" }),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button size="sm" disabled={writesDisabled} title={reason ?? undefined}>
            New task
          </Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New task</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Title</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Description</Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label>Due date</Label>
              <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Time</Label>
              <Input type="time" value={dueTime} onChange={(e) => setDueTime(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Priority</Label>
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
          <div className="space-y-1.5">
            <Label>Assignee</Label>
            <Select value={assignee} onValueChange={setAssignee}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="me">Me</SelectItem>
                {(peopleQuery.data ?? [])
                  .filter((p) => p.user_id !== userId)
                  .map((p) => (
                    <SelectItem key={p.user_id} value={p.user_id}>
                      {p.full_name ?? p.user_id}
                    </SelectItem>
                  ))}
                {/* Users are never created inline — inviting one carries
                    roles, offices and access. Say who to ask instead. */}
                <div className="border-t px-2 py-1.5 text-[11px] text-muted-foreground">
                  Someone missing? Ask an admin to invite them.
                </div>
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending || writesDisabled || title.trim().length === 0}
          >
            {mutation.isPending ? "Saving…" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
