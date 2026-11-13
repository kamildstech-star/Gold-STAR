/**
 * The popup for moving a record to No Service Needed.
 *
 * Mark: "Once moved here, a pop-up comes up. Why don't they need our service
 * with a text box. & Should we try again in 6 Months, 12 Months? And if yes at
 * that 6/12 month mark it will move back into Active Outreach with a task to
 * reach out to them."
 *
 * The whole machinery behind that already existed and nothing had ever called
 * it: `pipeline_mark_no_service` writes the reason and turns the months into a
 * return date, and `pipeline_no_service_return_sweep` brings the record back to
 * Active Outreach with a "Reach out again" task. The sweep runs every ten
 * minutes as part of the stage advance sweep. This is the missing screen.
 *
 * "No, don't try again" is a real answer and the default is not chosen for
 * anybody: a record parked here by accident with a silent 6-month timer is
 * worse than one somebody has to think about for a second.
 */
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { toastDbError } from "@/lib/db-errors";
import { markNoService } from "@/lib/pipeline-rules";

import { DATE_LOCALE, US_DATE } from "@/lib/date-format";
export type NoServiceTarget = { id: string; name: string };

/** Radix Select will not take an empty string, so "not chosen" needs a token. */
const NO_CODE = "__none";

/** The three answers to "try again?", as the popup asks them. */
export const RETRY_CHOICES = [
  { value: "0", label: "No — do not try again", months: null as number | null },
  { value: "6", label: "Yes, in 6 months", months: 6 },
  { value: "12", label: "Yes, in 12 months", months: 12 },
];

export function retryMonthsFor(value: string): number | null {
  return RETRY_CHOICES.find((c) => c.value === value)?.months ?? null;
}

/** "in 6 months" as a date, for saying out loud what will happen. */
export function retryDateLabel(months: number | null): string | null {
  if (!months) return null;
  const d = new Date();
  d.setMonth(d.getMonth() + months);
  return d.toLocaleDateString(DATE_LOCALE, US_DATE);
}

export function NoServiceDialog({
  target,
  onOpenChange,
  onDone,
}: {
  target: NoServiceTarget | null;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState("");
  const [code, setCode] = useState(NO_CODE);
  const [retry, setRetry] = useState("");
  const [busy, setBusy] = useState(false);

  // A fresh answer per record. Carrying the last one over is how a reason ends
  // up on the wrong company.
  useEffect(() => {
    if (target) {
      setReason("");
      setCode(NO_CODE);
      setRetry("");
    }
  }, [target]);

  const reasonsQ = useQuery({
    queryKey: ["no-service-reasons"],
    enabled: !!target,
    staleTime: 10 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("no_service_reasons")
        .select("code,label")
        .order("sort_order");
      if (error) throw error;
      return (data ?? []) as { code: string; label: string }[];
    },
  });

  const months = retryMonthsFor(retry);
  const when = retryDateLabel(months);

  const save = async () => {
    if (!target) return;
    setBusy(true);
    try {
      await markNoService(target.id, {
        reason: reason.trim() || null,
        reasonCode: code === NO_CODE ? null : code,
        retryMonths: months,
      });
      toast.success(
        when
          ? `${target.name} moved to No Service Needed — back in Active Outreach on ${when}`
          : `${target.name} moved to No Service Needed`,
      );
      onOpenChange(false);
      onDone();
    } catch (e) {
      toastDbError(e, { action: "move this to No Service Needed" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={!!target} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>No service needed — {target?.name}</DialogTitle>
          <DialogDescription>
            Why they do not need us, and whether it is worth asking again.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-1.5">
            <Label htmlFor="ns-code">Reason</Label>
            <Select value={code} onValueChange={setCode}>
              <SelectTrigger id="ns-code">
                <SelectValue placeholder="Pick one, or just write it below" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_CODE}>Not chosen</SelectItem>
                {(reasonsQ.data ?? []).map((r) => (
                  <SelectItem key={r.code} value={r.code}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="ns-reason">In their words</Label>
            <Textarea
              id="ns-reason"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="They use their insurer's panel and cannot pick their own vendor."
            />
            <p className="text-[11px] text-muted-foreground">
              Whoever picks this up in six months reads this first.
            </p>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="ns-retry">Try again?</Label>
            <Select value={retry} onValueChange={setRetry}>
              <SelectTrigger id="ns-retry">
                <SelectValue placeholder="Choose" />
              </SelectTrigger>
              <SelectContent>
                {RETRY_CHOICES.map((c) => (
                  <SelectItem key={c.value} value={c.value}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {/* Say what will happen, in a date, before it is agreed to. */}
            <p className="text-[11px] text-muted-foreground">
              {when
                ? `Returns to Active Outreach on ${when}, with a task to reach out.`
                : "It stays in No Service Needed until somebody moves it."}
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={busy || !retry}>
            {busy ? "Moving…" : "Move to No Service Needed"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
