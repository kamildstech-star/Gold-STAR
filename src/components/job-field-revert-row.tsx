/**
 * One save of the job's own fields on the Timeline, with its Revert.
 *
 * Mark, on a job: "in timeline have a restore button for each item that gets
 * removed or changed". This is the job itself being changed: "Mona changed
 * Stage: New → In progress".
 *
 * Same shape as the record Restore (`record-history-restore.tsx`): the button
 * is always on show — a phone has no hover — and the confirm first asks the
 * database what the revert would do, field by field (goes back to / this
 * change made it / now), so a field somebody has edited since is shown in red
 * and the button stays off instead of overwriting it. The revert runs as the
 * caller; the jobs policy has the last word.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, GitBranch, RotateCcw } from "lucide-react";
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
  fetchFieldChangeState,
  fieldEditHeadline,
  fieldLabel,
  fieldStateMessage,
  fieldValueLabel,
  revertFieldChange,
  type FieldEdit,
} from "@/lib/job-field-revert";
import { restoreErrorMessage } from "@/lib/record-history";

type Names = { people: Record<string, string>; stages: Record<string, string> };

const when = (iso: string) => new Date(iso).toLocaleString("en-US");

export function JobFieldEditRow({ edit, names }: { edit: FieldEdit; names: Names }) {
  const [open, setOpen] = useState(false);
  const actor = edit.actorId ? (names.people[edit.actorId] ?? null) : null;
  const canOffer = edit.revertable && !edit.revertedBy;

  return (
    <div className="flex items-start gap-2 border-b px-3 py-2 last:border-b-0">
      <GitBranch className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="text-[13px]">{fieldEditHeadline(edit, actor)}</div>
        {edit.changes.map((c) => (
          <div
            key={c.field}
            className="mt-0.5 flex flex-wrap items-center gap-1 text-xs text-muted-foreground"
          >
            <span className="font-medium">{fieldLabel(c.field)}:</span>
            <span className="line-through">{fieldValueLabel(c.field, c.before, names)}</span>
            <ArrowRight className="size-3" />
            <span className="break-words text-foreground">
              {fieldValueLabel(c.field, c.after, names)}
            </span>
          </div>
        ))}
        {edit.revertedBy && (
          <div className="mt-0.5 text-xs text-success">
            Reverted by{" "}
            {(edit.revertedBy.actorId && names.people[edit.revertedBy.actorId]) || "someone"} ·{" "}
            {when(edit.revertedBy.at)}
          </div>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>{when(edit.at)}</span>
          {canOffer && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setOpen(true)}
              aria-label={`Revert ${edit.changes.map((c) => fieldLabel(c.field)).join(", ")}`}
            >
              <RotateCcw />
              Revert
            </Button>
          )}
        </div>
      </div>
      {open && <RevertDialog edit={edit} names={names} open={open} onOpenChange={setOpen} />}
    </div>
  );
}

function RevertDialog({
  edit,
  names,
  open,
  onOpenChange,
}: {
  edit: FieldEdit;
  names: Names;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const qc = useQueryClient();
  const state = useQuery({
    queryKey: ["job-field-change-state", edit.id],
    queryFn: () => fetchFieldChangeState(edit.id),
    staleTime: 0,
    gcTime: 0,
  });

  const revert = useMutation({
    mutationFn: () => revertFieldChange(edit.id),
    onSuccess: (r) => {
      toast.success(
        r.status === "reverted" ? "Reverted" : (fieldStateMessage(r) ?? "Nothing to do"),
      );
      onOpenChange(false);
      // The job header, its fields, the board and the Timeline all read the
      // job; refresh every cached read rather than guess the keys.
      void qc.invalidateQueries();
    },
    onError: (err) => {
      console.error("[revert_job_field_change]", err);
      toast.error(restoreErrorMessage(err));
      void state.refetch();
    },
  });

  const s = state.data;
  const reason = s ? fieldStateMessage(s) : null;
  // The may_edit hint informs the message; it does not gate the button —
  // the database decides, and a stale hint must not block a manager.
  const ready = s?.status === "ready";
  const rows = (s?.fields ?? []).filter((f) => f.field !== "pipeline_id");

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-h-[85svh] overflow-y-auto">
        <AlertDialogHeader>
          <AlertDialogTitle>Revert this change?</AlertDialogTitle>
          <AlertDialogDescription>
            Puts these job fields back the way they were before this change.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {state.isLoading && <div className="text-sm text-muted-foreground">Checking…</div>}
        {state.error && (
          <div className="text-sm text-destructive">{restoreErrorMessage(state.error)}</div>
        )}
        {rows.length > 0 && (
          <div className="overflow-x-auto md:max-h-[75svh] md:overflow-auto">
            <table className="w-full text-left text-[13px]">
              <thead className="text-xs text-muted-foreground">
                <tr>
                  <th className="py-1 pr-2 font-medium">Field</th>
                  <th className="py-1 pr-2 font-medium">Goes back to</th>
                  <th className="py-1 pr-2 font-medium">This change made it</th>
                  <th className="py-1 font-medium">Now</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((f) => (
                  <tr key={f.field} className="border-t align-top">
                    <td className="py-1 pr-2 font-medium">{fieldLabel(f.field)}</td>
                    <td className="py-1 pr-2">
                      {f.revertable ? fieldValueLabel(f.field, f.before, names) : "—"}
                    </td>
                    <td className="py-1 pr-2 text-muted-foreground">
                      {fieldValueLabel(f.field, f.after, names)}
                    </td>
                    <td className={f.moved ? "py-1 font-medium text-destructive" : "py-1"}>
                      {fieldValueLabel(f.field, f.now, names)}
                      {f.moved && <span className="block text-xs">edited again since</span>}
                      {!f.revertable && (
                        <span className="block text-xs text-muted-foreground">not reverted</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {reason && (
          <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
            {reason}
          </div>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={!ready || revert.isPending}
            onClick={(e) => {
              e.preventDefault();
              revert.mutate();
            }}
          >
            {revert.isPending ? "Reverting…" : "Revert"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
