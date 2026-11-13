/**
 * A delete, an edit or a restore on the job Timeline, with its Restore.
 *
 * Mark, on a job: "in timeline have a restore button for each item that gets
 * removed or changed".
 *
 * The button is always on show, not revealed on hover like the account
 * Timeline's actions: a Restore that only appears under a mouse does not
 * exist on the phone the crew deleted the note from. It opens a confirm that
 * first asks the database what would happen (`record_history_preview`) and
 * shows that — the note's text, the contact's name, the estimate's number and
 * line count, or for an edit each field as it was, as the change left it,
 * and as it is now — so nobody restores blind. When the answer is not
 * "ready" (edited again since, already back, not yours to restore) the
 * dialog says why and the button stays off. The database checks it all
 * again on Restore; the dialog only saves a wasted tap.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Pencil, RotateCcw, Trash2 } from "lucide-react";
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
  childrenLabel,
  columnLabel,
  displayValue,
  fetchHistoryPreview,
  historyHeadline,
  restoreErrorMessage,
  restoreHistory,
  restoreVerb,
  statusMessage,
  type HistoryItem,
  type HistoryPreview,
} from "@/lib/record-history";

const when = (iso: string) => new Date(iso).toLocaleString("en-US");

export function HistoryTimelineRow({ entry }: { entry: HistoryItem }) {
  const [open, setOpen] = useState(false);
  const Icon = entry.op === "delete" ? Trash2 : entry.op === "update" ? Pencil : RotateCcw;
  const changes = Object.entries(entry.changes ?? {});
  const canOffer = entry.op !== "restore" && !entry.restoredBy;

  return (
    <div className="flex items-start gap-2 border-b px-3 py-2 last:border-b-0">
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="whitespace-pre-wrap break-words text-[13px]">
          {historyHeadline(entry, entry.actor_name)}
        </div>
        {changes.map(([column, c]) => (
          <div
            key={column}
            className="mt-0.5 flex flex-wrap items-center gap-1 text-xs text-muted-foreground"
          >
            <span className="font-medium">{columnLabel(column)}:</span>
            <span className="line-through">{displayValue(c.before)}</span>
            <ArrowRight className="size-3" />
            <span className="text-foreground">{displayValue(c.after)}</span>
          </div>
        ))}
        {entry.restoredBy && (
          <div className="mt-0.5 text-xs text-success">
            {entry.op === "update" ? "Reverted" : "Restored"} by{" "}
            {entry.restoredBy.actor_name ?? "someone"} · {when(entry.restoredBy.occurred_at)}
          </div>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>{when(entry.occurred_at)}</span>
          {canOffer && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setOpen(true)}
              aria-label={`${restoreVerb(entry.op)} ${entry.summary}`}
            >
              <RotateCcw />
              {restoreVerb(entry.op)}
            </Button>
          )}
        </div>
      </div>
      {open && <RestoreDialog entry={entry} open={open} onOpenChange={setOpen} />}
    </div>
  );
}

function RestoreDialog({
  entry,
  open,
  onOpenChange,
}: {
  entry: HistoryItem;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const qc = useQueryClient();
  const verb = restoreVerb(entry.op);
  const preview = useQuery({
    queryKey: ["record-history-preview", entry.id],
    queryFn: () => fetchHistoryPreview(entry.id),
    // What the dialog shows has to be what Restore would do now, not a
    // minute ago: always ask again.
    staleTime: 0,
    gcTime: 0,
  });

  const restore = useMutation({
    mutationFn: () => restoreHistory(entry.id),
    onSuccess: (r) => {
      toast.success(
        r.status === "restored"
          ? `${verb === "Revert" ? "Reverted" : "Restored"} ${entry.summary}`
          : (statusMessage(r) ?? "Nothing to do"),
      );
      onOpenChange(false);
      // The restored row can belong to any panel on the job — notes,
      // contacts, tasks, estimates — so every cached read is refreshed
      // rather than guessing which keys it touched.
      void qc.invalidateQueries();
    },
    onError: (err) => {
      console.error("[restore_record_history]", err);
      toast.error(restoreErrorMessage(err));
      void preview.refetch();
    },
  });

  const p = preview.data;
  const reason = p ? statusMessage(p) : null;
  const ready = p?.status === "ready";

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-h-[85svh] overflow-y-auto">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {verb} {entry.summary}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {entry.op === "update"
              ? "Puts these fields back the way they were before this change."
              : "Puts it back on the job exactly as it was when it was deleted."}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {preview.isLoading && <div className="text-sm text-muted-foreground">Checking…</div>}
        {preview.error && (
          <div className="text-sm text-destructive">{restoreErrorMessage(preview.error)}</div>
        )}
        {p && <PreviewBody preview={p} />}
        {reason && (
          <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
            {reason}
          </div>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={!ready || restore.isPending}
            onClick={(e) => {
              // Keep the dialog up until the database answers; a refusal
              // re-reads the preview so the reason shows in place.
              e.preventDefault();
              restore.mutate();
            }}
          >
            {restore.isPending ? `${verb === "Revert" ? "Reverting" : "Restoring"}…` : verb}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** What comes back: the deleted item's own fields, or each edited field's three values. */
function PreviewBody({ preview }: { preview: HistoryPreview }) {
  if (preview.op === "update" && preview.fields?.length) {
    return (
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
            {preview.fields.map((f) => (
              <tr key={f.column} className="border-t align-top">
                <td className="py-1 pr-2 font-medium">{columnLabel(f.column)}</td>
                <td className="py-1 pr-2">{displayValue(f.before)}</td>
                <td className="py-1 pr-2 text-muted-foreground">{displayValue(f.after)}</td>
                <td className={f.moved ? "py-1 font-medium text-destructive" : "py-1"}>
                  {displayValue(f.now)}
                  {f.moved && <span className="block text-xs">edited again since</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  const detail = Object.entries(preview.detail ?? {}).filter(
    ([, v]) => v !== null && v !== undefined && v !== "",
  );
  const comesBack = childrenLabel(preview.children);
  if (!detail.length && !comesBack) return null;
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
      {detail.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted-foreground">{columnLabel(k)}</dt>
          <dd className="whitespace-pre-wrap break-words">{displayValue(v)}</dd>
        </div>
      ))}
      {comesBack && (
        <div className="contents">
          <dt className="text-muted-foreground">Comes back with</dt>
          <dd>{comesBack}</dd>
        </div>
      )}
    </dl>
  );
}
