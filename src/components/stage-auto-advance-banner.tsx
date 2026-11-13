/**
 * Shows the last automatic stage move on an account with a one-click undo.
 * The engine is invisible otherwise, so the rep must always be able to see
 * "the system moved this, and why" — and put it back.
 */

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Undo2, Zap } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { toastDbError } from "@/lib/db-errors";
import { fetchLatestAutoAdvance, undoAutoAdvance } from "@/lib/stage-advance";

export function StageAutoAdvanceBanner({ accountId }: { accountId: string }) {
  const qc = useQueryClient();
  const [dismissed, setDismissed] = React.useState(false);

  const advance = useQuery({
    queryKey: ["stage-auto-advance", accountId],
    queryFn: () => fetchLatestAutoAdvance(accountId),
  });

  const undo = useMutation({
    mutationFn: async (id: string) => {
      const ok = await undoAutoAdvance(id);
      if (!ok) throw new Error("This move was already undone.");
    },
    onSuccess: () => {
      toast.success("Stage put back");
      qc.invalidateQueries({ queryKey: ["stage-auto-advance", accountId] });
      qc.invalidateQueries({ queryKey: ["account", accountId] });
      qc.invalidateQueries({ queryKey: ["account-timeline", accountId] });
      qc.invalidateQueries({ queryKey: ["pipeline-cards"] });
    },
    onError: (e) => toastDbError(e, { action: "undo the automatic move" }),
  });

  const row = advance.data;
  if (!row || dismissed) return null;

  const fired = new Date(row.fired_at);
  const hoursAgo = (Date.now() - fired.getTime()) / 36e5;
  if (hoursAgo > 24 * 14) return null;

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-primary/30 bg-primary/5 px-2.5 py-1.5 text-[12px]">
      <Zap className="size-3.5 text-primary" />
      <span className="font-medium">{row.note ?? "Advanced automatically"}</span>
      <span className="text-muted-foreground">
        {fired.toLocaleString("en-US", {
          day: "numeric",
          month: "short",
          hour: "numeric",
          minute: "2-digit",
        })}
      </span>
      <div className="ml-auto flex items-center gap-1">
        <Button
          size="sm"
          variant="outline"
          className="h-6 px-2 text-[11px]"
          disabled={undo.isPending}
          onClick={() => undo.mutate(row.id)}
        >
          <Undo2 className="mr-1 size-3" /> Undo
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-[11px]"
          onClick={() => setDismissed(true)}
        >
          Dismiss
        </Button>
      </div>
    </div>
  );
}
