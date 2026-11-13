import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { PackageCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { NumberInput } from "@/components/ui/number-input";
import { toastDbError } from "@/lib/db-errors";
import { recordDelivery } from "@/lib/supply-inventory";
import {
  deliveryLines,
  deliveryProgress,
  planDelivery,
  pendingNotice,
} from "@/lib/supply-delivery";
import { notifyPartialDelivery, setStatus, type SupplyRequestFull } from "@/lib/supplies";

/**
 * Recording exactly what turned up.
 *
 * David, 17 Sep: "we should have a place where we can put in exactly what was
 * delivered — meaning if I ordered five rolls and they only delivered four
 * rolls, it's still gonna show as one is pending... and then potentially they
 * should let me know somehow that there's still something pending."
 *
 * So this is a line-by-line count, not a single button. Each box starts at what
 * the line is OWED — its outstanding remainder — because the common case is a
 * complete delivery and the manager should be able to press straight through.
 *
 * The order becomes Delivered only when every line is full. Four of five leaves
 * it at Pending delivery with the remainder on the row, which is the falsehood
 * David was objecting to: an order that is not finished must not read finished.
 */
export function SupplyDeliveryDialog({
  request,
  requesterName,
  actorId,
  open,
  onOpenChange,
}: {
  request: SupplyRequestFull;
  /** Shown in the title: no delivery should leave the viewer asking "for whom?". */
  requesterName: string;
  actorId: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const qc = useQueryClient();
  const lines = useMemo(() => deliveryLines(request), [request]);

  /** lineId -> the new running total the office is typing. */
  const [typed, setTyped] = useState<Record<string, number | null>>(() =>
    Object.fromEntries(lines.map((l) => [l.lineId, l.ordered])),
  );

  const entries = useMemo(() => planDelivery(lines, typed), [lines, typed]);
  const after = useMemo(
    () =>
      deliveryProgress(
        entries.map((e) => ({
          ...e.line,
          delivered: e.delivered,
          outstanding: Math.max(0, e.line.ordered - e.delivered),
        })),
      ),
    [entries],
  );

  const submit = useMutation({
    mutationFn: async () => {
      await recordDelivery({
        request,
        entries: entries.map((e) => ({
          lineId: e.line.lineId,
          itemId: e.line.itemId,
          delivered: e.delivered,
          delta: e.delta,
        })),
        userId: actorId,
      });

      /*
       * The status moves only on a complete delivery. A short one stays at
       * Pending delivery and the requester is told what is still coming —
       * "potentially they should let me know somehow that there's still
       * something pending".
       */
      if (after.complete) {
        await setStatus({ request, status: "delivered", deciderId: actorId });
      } else {
        const notice = pendingNotice(after);
        if (notice) {
          await notifyPartialDelivery({ request, summary: notice, actorId });
        }
      }
      return after;
    },
    onSuccess: (progress) => {
      toast.success(progress.complete ? "Delivery complete" : "Part delivery recorded", {
        description: progress.summary,
      });
      qc.invalidateQueries({ queryKey: ["supply-requests"] });
      qc.invalidateQueries({ queryKey: ["supply-stock"] });
      onOpenChange(false);
    },
    onError: (e) => toastDbError(e, { action: "record this delivery" }),
  });

  const nothingChanged = entries.every((e) => e.delta === 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90svh] w-[calc(100vw-1.5rem)] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PackageCheck className="size-4" /> What arrived?
          </DialogTitle>
          {/* Who it is for, on the delivery itself. */}
          <DialogDescription>
            Ordered by {requesterName}. Type what actually turned up — anything short stays pending
            and {requesterName.split(" ")[0]} is told what is still coming.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          {lines.map((l) => (
            <div
              key={l.lineId}
              className="grid grid-cols-[minmax(0,1fr)_6rem] items-center gap-3 border-b py-2 last:border-0"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{l.label}</p>
                <p className="text-xs text-muted-foreground">
                  Ordered {l.ordered}
                  {l.unit ? ` ${l.unit}` : ""}
                  {l.delivered > 0 ? ` · ${l.delivered} already in` : ""}
                </p>
              </div>
              <NumberInput
                decimals={0}
                aria-label={`${l.label} delivered`}
                value={typed[l.lineId] ?? 0}
                onValueChange={(n) => setTyped((p) => ({ ...p, [l.lineId]: n }))}
              />
            </div>
          ))}
        </div>

        <p className={after.complete ? "text-xs text-success" : "text-xs text-warning"}>
          {after.summary}
        </p>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={submit.isPending || nothingChanged} onClick={() => submit.mutate()}>
            {after.complete ? "Mark delivered" : "Record what arrived"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
