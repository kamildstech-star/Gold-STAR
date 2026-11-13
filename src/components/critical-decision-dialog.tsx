/**
 * The day-30 decision.
 *
 * Melly: "On day thirty the manager must pick one of four things, and the
 * system will not let them skip it or let it sit. Extend the cure window, but
 * they have to write down why ... Reassign it to a different rep ... Demote
 * it to Dormant ... Close it out as No Service Needed. The advice is to
 * reassign before you ever demote."
 *
 * One call does the work — `client_critical_decide` in the database — and it
 * is what refuses a non-manager, an extension with no reason, or a reassign to
 * a rep over the 20% cap. This dialog only asks the questions.
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { toastDbError } from "@/lib/db-errors";
import {
  CRITICAL_DECISION_META,
  CRITICAL_QUERY_KEY,
  decideCritical,
  type CriticalDecision,
  type CriticalListEntry,
} from "@/lib/critical-clients";
import { cn } from "@/lib/utils";

const ORDER: CriticalDecision[] = ["extend", "reassign", "dormant", "no_service"];

export function CriticalDecisionDialog({
  entry,
  onOpenChange,
  onDone,
}: {
  entry: CriticalListEntry | null;
  onOpenChange: (open: boolean) => void;
  onDone?: () => void;
}) {
  const qc = useQueryClient();
  const [decision, setDecision] = useState<CriticalDecision>("extend");
  const [note, setNote] = useState("");
  const [reassignTo, setReassignTo] = useState<string>("");
  const [retry, setRetry] = useState<string>("none");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (entry) {
      setDecision("extend");
      setNote("");
      setReassignTo("");
      setRetry("none");
    }
  }, [entry]);

  const repsQ = useQuery({
    queryKey: ["business-reps"],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_business_reps");
      if (error) throw error;
      return data ?? [];
    },
    enabled: !!entry,
    staleTime: 5 * 60_000,
  });
  const reps = useMemo(
    () => (repsQ.data ?? []).filter((r) => r.user_id !== entry?.episode.assigned_rep),
    [repsQ.data, entry?.episode.assigned_rep],
  );

  const meta = CRITICAL_DECISION_META[decision];
  const noteMissing = meta.noteRequired && !note.trim();
  const repMissing = decision === "reassign" && !reassignTo;

  const save = async () => {
    if (!entry || noteMissing || repMissing) return;
    setBusy(true);
    try {
      await decideCritical({
        episodeId: entry.episode.id,
        decision,
        note: note.trim() || null,
        reassignTo: decision === "reassign" ? reassignTo : null,
        retryMonths: decision === "no_service" && retry !== "none" ? Number(retry) : null,
      });
      toast.success(`${entry.accountName}: ${meta.label.toLowerCase()}`);
      void qc.invalidateQueries({ queryKey: CRITICAL_QUERY_KEY });
      void qc.invalidateQueries({ queryKey: ["active-clients"] });
      onOpenChange(false);
      onDone?.();
    } catch (e) {
      toastDbError(e, { action: "record the decision" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={!!entry} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Day-30 decision · {entry?.accountName}</DialogTitle>
          <DialogDescription>
            {entry
              ? `${entry.episode.track === "relationship" ? "Relationship" : "Compliance"}: ${entry.episode.reason}. ` +
                (entry.window.decisionDue
                  ? `${-entry.window.daysLeft} day${-entry.window.daysLeft === 1 ? "" : "s"} past the deadline.`
                  : `Day ${entry.window.dayOf} of 30.`)
              : null}{" "}
            Reassign before you demote: a different rep wins back a surprising number of accounts.
          </DialogDescription>
        </DialogHeader>

        <RadioGroup
          value={decision}
          onValueChange={(v) => setDecision(v as CriticalDecision)}
          className="gap-2"
        >
          {ORDER.map((key) => {
            const m = CRITICAL_DECISION_META[key];
            const on = key === decision;
            return (
              <label
                key={key}
                htmlFor={`decision-${key}`}
                className={cn(
                  "flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors",
                  on ? "border-primary bg-primary/5" : "hover:bg-muted/50",
                )}
              >
                <RadioGroupItem id={`decision-${key}`} value={key} className="mt-0.5" />
                <span className="min-w-0">
                  <span className="block text-[13px] font-semibold">{m.label}</span>
                  <span className="block text-[12px] text-muted-foreground">{m.description}</span>
                </span>
              </label>
            );
          })}
        </RadioGroup>

        {decision === "reassign" ? (
          <div className="space-y-1.5">
            <Label htmlFor="decision-rep">New rep</Label>
            <Select value={reassignTo} onValueChange={setReassignTo}>
              <SelectTrigger id="decision-rep" className="h-10">
                <SelectValue placeholder={repsQ.isLoading ? "Loading reps…" : "Pick a rep"} />
              </SelectTrigger>
              <SelectContent>
                {reps.map((r) => (
                  <SelectItem key={r.user_id} value={r.user_id}>
                    {r.full_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">
              A rep over the 20% Critical cap is refused. The original rep keeps every dollar from
              jobs already signed.
            </p>
          </div>
        ) : null}

        {decision === "no_service" ? (
          <div className="space-y-1.5">
            <Label htmlFor="decision-retry">Try again</Label>
            <Select value={retry} onValueChange={setRetry}>
              <SelectTrigger id="decision-retry" className="h-10">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Never</SelectItem>
                <SelectItem value="6">In 6 months</SelectItem>
                <SelectItem value="12">In 12 months</SelectItem>
              </SelectContent>
            </Select>
          </div>
        ) : null}

        <div className="space-y-1.5">
          <Label htmlFor="decision-note">
            {meta.noteRequired ? "Why (required)" : "Note (optional)"}
          </Label>
          <Textarea
            id="decision-note"
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={
              decision === "extend"
                ? "The contact is on leave until January…"
                : "Anything worth remembering"
            }
          />
        </div>

        <DialogFooter>
          <Button size="sm" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button size="sm" onClick={save} disabled={busy || noteMissing || repMissing}>
            {meta.label}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
