import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowLeft, Loader2 } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

import { actionErrorMessage } from "@/lib/db-errors";
import { fetchReasonTree, logOutcome, type ReasonNode, type OutcomeReason } from "@/lib/outcomes";
import { useOptionList } from "@/lib/option-lists";
import type { Incident } from "@/lib/incidents";

/**
 * Outcome capture: grids of large buttons, never dropdowns, never free text
 * first. The reason row decides whether the lead survives — this component
 * only collects, it does not judge.
 */
export function OutcomeSheet({
  open,
  onOpenChange,
  incident,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  incident: Incident;
  onSaved: () => void;
}) {
  const tree = useQuery({
    enabled: open,
    queryKey: ["chase", "reason-tree"],
    queryFn: fetchReasonTree,
  });
  const [reason, setReason] = useState<ReasonNode | null>(null);
  // Competitor and TPA sub-options come from the managed dropdown lists so a
  // Sales Head can edit them in Admin without touching the reason tree.
  const [note, setNote] = useState("");
  const [tryAgain, setTryAgain] = useState(false);
  const [busy, setBusy] = useState(false);
  const managed = useOptionList(reason?.option_list_key ?? "", {});

  useEffect(() => {
    if (!open) {
      setReason(null);
      setNote("");
      setTryAgain(false);
    }
  }, [open]);

  const managedOptions = reason?.option_list_key ? managed.options : [];
  const activeChildren = reason?.children ?? [];
  /** A reason has a second row only when it owns a list — nothing deeper. */
  const hasSubStep = (r: ReasonNode) => r.children.length > 0 || !!r.option_list_key;

  const save = async (r: ReasonNode, subReason: OutcomeReason | null, label: string | null) => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await logOutcome({
        incidentId: incident.id,
        reasonId: r.id,
        subReasonId: subReason?.id ?? null,
        subLabel: label,
        note,
        worthAnotherTry: tryAgain,
        revisitAfter: null,
      });

      // A win becomes a job. Everything else stays in the chase board.
      if (res.lifecycle === "won" && incident.location_id && !incident.job_id) {
        const { data: userRes } = await supabase.auth.getUser();
        const lossType = incident.incident_type === "other" ? "cleaning" : incident.incident_type;
        const { data: job, error: jobErr } = await supabase
          .from("jobs")
          .insert({
            location_id: incident.location_id,
            address: incident.address ?? "Unknown",
            locality: incident.locality,
            region: incident.region,
            postal_code: incident.postal_code,
            lat: incident.lat,
            lon: incident.lon,
            loss_type: lossType,
            loss_date: incident.reported_at.slice(0, 10),
            first_response_at: incident.arrived_at ?? new Date().toISOString(),
            fire_lead_id: incident.matched_fire_lead_id ?? null,
            scope: note || null,
            created_by: userRes.user?.id ?? null,
          } as never)
          .select("id")
          .single();
        if (jobErr) {
          toast.error(`Outcome saved, but the job wasn't created: ${jobErr.message}`);
        } else {
          await supabase.from("incidents").update({ job_id: job.id }).eq("id", incident.id);
          await supabase.from("incident_events").insert({
            incident_id: incident.id,
            event_type: "converted",
            actor_id: userRes.user?.id ?? null,
            payload: { job_id: job.id },
          });
        }
      }

      toast.success(
        res.kept_live
          ? "Logged — lead stays live and goes back on the board"
          : res.lifecycle === "won"
            ? "Signed — job created"
            : "Logged — lead closed",
      );
      onSaved();
    } catch (e) {
      const detail = actionErrorMessage(e, String(e));
      toast.error("Could not save outcome", { description: detail });
      console.error("log_incident_outcome failed", e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {reason && (
              <Button
                variant="ghost"
                size="icon"
                className="-ml-2 size-8"
                onClick={() => setReason(null)}
              >
                <ArrowLeft className="size-4" />
              </Button>
            )}
            {reason ? reason.label : "What happened?"}
          </DialogTitle>
        </DialogHeader>

        {tree.isLoading && (
          <div className="flex justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        )}

        {/* One tap. No confirmation — the tap is the answer. */}
        {!reason && (
          <div className="grid gap-2">
            {(tree.data ?? []).map((r) => (
              <Button
                key={r.id}
                variant="outline"
                disabled={busy}
                className={`h-16 w-full justify-start whitespace-normal px-4 text-left text-[15px] font-semibold leading-tight ${
                  r.wins_lead ? "border-emerald-600 text-emerald-700 dark:text-emerald-400" : ""
                } ${!r.kills_lead && !r.wins_lead ? "border-amber-500/70" : ""}`}
                onClick={() => {
                  if (hasSubStep(r)) setReason(r);
                  else void save(r, null, null);
                }}
              >
                <span className="min-w-0">
                  {r.label}
                  <span className="mt-0.5 block text-[11px] font-normal text-muted-foreground">
                    {r.wins_lead
                      ? "Job created"
                      : r.kills_lead
                        ? "Lead closes for everyone"
                        : "Stays live for the next chaser"}
                  </span>
                </span>
              </Button>
            ))}
          </div>
        )}

        {/* Second row — who signed it. Nothing deeper than this. */}
        {reason && (
          <div className="grid gap-2">
            {activeChildren.map((c) => (
              <Button
                key={c.id}
                variant="outline"
                disabled={busy}
                className="h-14 w-full justify-start whitespace-normal px-4 text-left text-[15px] font-semibold leading-tight"
                onClick={() => void save(reason, c, null)}
              >
                {c.label}
              </Button>
            ))}
            {managedOptions.map((o) => (
              <Button
                key={o.id}
                variant="outline"
                disabled={busy}
                className="h-14 w-full justify-start whitespace-normal px-4 text-left text-[15px] font-semibold leading-tight"
                onClick={() => void save(reason, null, o.label)}
              >
                {o.label}
              </Button>
            ))}
          </div>
        )}

        {/* Optional on every branch — submit works empty. */}
        <div className="space-y-3">
          {reason?.allows_another_try && (
            <div className="flex items-center justify-between rounded-sm border px-3 py-2">
              <Label htmlFor="try-again" className="text-[13px] font-medium">
                Worth another try
              </Label>
              <Switch id="try-again" checked={tryAgain} onCheckedChange={setTryAgain} />
            </div>
          )}
          <Textarea
            placeholder="Note (optional) — e.g. lights off, no cars, try after 9"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
          />
          {busy && (
            <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Saving…
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
