import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DetailSelect } from "@/components/detail-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { fetchStages } from "@/lib/pipeline";
import { fetchNoServiceReasons, FARMING_LABEL } from "@/lib/sales-pipeline";
import { fireNoteTriggers } from "@/lib/timeline";
import { useWritesDisabled } from "@/components/app-context";
import { assertWritesEnabled } from "@/lib/write-guard";

/**
 * The stage path — a chevron bar across the top of a record.
 *
 * The active segment carries time-in-stage, and that number is the point of
 * the component: "149 days · Active Client" is the rot signal, visible before
 * anyone opens a report.
 *
 * Clicking a segment moves the record, with the reason prompts the pipeline
 * already demands — a lost stage needs a written reason, No Service Needed
 * needs a reason code. Farming stages are normally computed, so moving one by
 * hand says so out loud.
 */
export function StagePath({
  accountId,
  kind,
  pipelineId,
  currentStageId,
  changedAt,
  onMoved,
}: {
  accountId: string;
  kind: "prospecting" | "farming";
  pipelineId: string | null;
  currentStageId: string | null;
  changedAt: string | null;
  onMoved: () => void;
}) {
  const writes = useWritesDisabled();
  const [target, setTarget] = useState<{
    id: string;
    name: string;
    isLost: boolean;
    key: string;
  } | null>(null);

  const stagesQuery = useQuery({
    queryKey: ["stage-path", pipelineId],
    queryFn: () => fetchStages(pipelineId!),
    enabled: !!pipelineId,
  });

  const stages = (stagesQuery.data ?? []).filter((s) => s.is_active);
  const currentIndex = stages.findIndex((s) => s.id === currentStageId);
  const days = useMemo(() => {
    if (!changedAt) return null;
    return Math.max(0, Math.floor((Date.now() - new Date(changedAt).getTime()) / 86_400_000));
  }, [changedAt]);

  if (!pipelineId || stages.length === 0) return null;

  return (
    <div className="space-y-1" data-stage-rail>
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {kind === "farming" ? FARMING_LABEL : "Prospecting"}
      </div>
      <div className="flex w-full overflow-x-auto">
        {stages.map((s, i) => {
          const state = i < currentIndex ? "done" : i === currentIndex ? "current" : "todo";
          const color = (s.color as string | null) ?? "#1B5FA8";
          return (
            <button
              key={s.id}
              type="button"
              disabled={writes.disabled || state === "current"}
              onClick={() =>
                setTarget({
                  id: s.id,
                  name: s.name,
                  isLost: Boolean(s.is_lost),
                  key: (s.key as string) ?? "",
                })
              }
              title={
                state === "current"
                  ? `Current stage${days != null ? ` — ${days} days` : ""}`
                  : `Move to ${s.name}`
              }
              className="stage-chevron"
              data-state={state}
              data-color={color}
              // The Timeline's stage-change rows scroll to the stage they landed on.
              data-stage-id={s.id}
            >
              <span className="truncate text-[12px] font-semibold">{s.name}</span>
              {state === "current" && days != null && (
                <span className="stage-chevron-sub truncate text-[11px]">
                  {days} day{days === 1 ? "" : "s"} · {s.name}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <MoveDialog
        accountId={accountId}
        kind={kind}
        target={target}
        onClose={() => setTarget(null)}
        onMoved={onMoved}
      />
    </div>
  );
}

/**
 * The stage-move write, with the reason prompts the pipeline demands.
 * Exported so an alternative stage control (the prospect stepper) can drive
 * the same move rather than reimplementing the write.
 */
export function MoveDialog({
  accountId,
  kind,
  target,
  onClose,
  onMoved,
}: {
  accountId: string;
  kind: "prospecting" | "farming";
  target: { id: string; name: string; isLost: boolean; key: string } | null;
  onClose: () => void;
  onMoved: () => void;
}) {
  const writes = useWritesDisabled();
  const [lostReason, setLostReason] = useState("");
  const [reasonCode, setReasonCode] = useState("");
  const [reasonDetail, setReasonDetail] = useState("");
  const [reactivateOn, setReactivateOn] = useState("");
  const [saving, setSaving] = useState(false);
  const reasonsQuery = useQuery({
    queryKey: ["no-service-reasons"],
    queryFn: fetchNoServiceReasons,
    enabled: target?.key === "no_service_needed",
  });

  const needsReasonCode = target?.key === "no_service_needed";
  const needsLostReason = Boolean(target?.isLost);

  const move = async () => {
    if (!target) return;
    setSaving(true);
    try {
      assertWritesEnabled(writes.disabled, writes.reason);
      if (kind === "prospecting") {
        const patch = {
          stage_id: target.id,
          ...(needsLostReason ? { lost_reason: lostReason.trim() } : {}),
          ...(needsReasonCode
            ? {
                no_service_reason_code: reasonCode,
                no_service_reason_detail: reasonDetail.trim() || null,
              }
            : {}),
          ...(needsReasonCode && reactivateOn ? { reactivate_on: reactivateOn } : {}),
        };
        const { error } = await supabase.from("accounts").update(patch).eq("id", accountId);
        if (error) throw error;
      } else {
        const { data: before } = await supabase
          .from("accounts")
          .select("health_stage_id,stage")
          .eq("id", accountId)
          .maybeSingle();
        const { error } = await supabase
          .from("accounts")
          .update({ health_stage_id: target.id, health_changed_at: new Date().toISOString() })
          .eq("id", accountId);
        if (error) throw error;
        // Farming moves are normally computed, so record the manual override
        // explicitly — the timeline has to be able to say who overrode it.
        const { data: auth } = await supabase.auth.getUser();
        await supabase.from("account_stage_history").insert({
          account_id: accountId,
          from_stage_id: before?.health_stage_id ?? null,
          to_stage_id: target.id,
          from_stage: before?.stage ?? null,
          to_stage: target.key,
          reason: lostReason.trim() || "Active Clients stage set by hand",
          changed_by: auth.user?.id ?? null,
        });
      }
      // A stage move is one of the trigger points for a stashed note.
      const fired = await fireNoteTriggers(accountId, "next_stage_change");
      for (const n of fired) toast.info("Note for this moment", { description: n.body });
      toast.success(`Moved to ${target.name}`);
      onMoved();
      onClose();
      setLostReason("");
      setReasonCode("");
      setReactivateOn("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not move this record");
    } finally {
      setSaving(false);
    }
  };

  const blocked =
    (needsLostReason && lostReason.trim().length === 0) || (needsReasonCode && !reasonCode);

  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Move to {target?.name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          {kind === "farming" && (
            <p className="text-[12px] text-muted-foreground">
              {FARMING_LABEL} stages are normally computed from what did or didn't happen. Setting
              one by hand is recorded on the timeline as an override.
            </p>
          )}
          {needsReasonCode && (
            <>
              <div className="space-y-1.5">
                <DetailSelect
                  label="Reason code"
                  placeholder="Why is no service needed?"
                  options={(reasonsQuery.data ?? []).map((r) => ({
                    value: r.code,
                    label: r.label,
                  }))}
                  value={reasonCode}
                  onValueChange={setReasonCode}
                  detail={reasonDetail}
                  onDetailChange={setReasonDetail}
                  className="contents"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Come back to this on (optional)</Label>
                <Input
                  type="date"
                  className="h-11"
                  value={reactivateOn}
                  onChange={(e) => setReactivateOn(e.target.value)}
                />
              </div>
            </>
          )}
          {(needsLostReason || kind === "farming") && (
            <div className="space-y-1.5">
              <Label>{needsLostReason ? "Reason (required)" : "Note (optional)"}</Label>
              <Textarea
                rows={3}
                value={lostReason}
                onChange={(e) => setLostReason(e.target.value)}
                placeholder={needsLostReason ? "What happened?" : "Why are you setting this?"}
              />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={move}
            disabled={saving || blocked || writes.disabled}
            title={writes.reason ?? undefined}
          >
            {saving ? "Moving…" : "Move"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
