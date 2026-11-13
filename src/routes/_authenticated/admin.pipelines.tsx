import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, GripVertical, Plus, Trash2, Zap } from "lucide-react";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { toastDbError } from "@/lib/db-errors";
import { useAppContext } from "@/components/app-context";
import { EmptyLine, LoadError, WarningLine } from "@/components/ui-density";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { fetchPipelines, fetchStages, type Pipeline, type PipelineStage } from "@/lib/pipeline";
import { saveLeadSettings, useLeadSettings } from "@/lib/lead-settings";

import {
  ADVANCE_ACTIVITY_TYPES,
  ADVANCE_CONDITION_LABEL,
  ADVANCE_FIELDS,
  conditionsOfStage,
  describeCondition,
  saveStageAdvance,
  setPipelineAutoAdvance,
  COUNTABLE_KINDS,
  type AdvanceCondition,
  type AdvanceConditionKind,
  type AdvanceMatch,
} from "@/lib/stage-advance";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/admin/pipelines")({
  head: () => ({
    meta: [
      { title: "Pipelines · Admin · Recovery Hub" },
      {
        name: "description",
        content: "Configure sales pipeline stages: rename, reorder, color, probability and limits.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: PipelineAdmin,
});

/**
 * Lead approval gate. Off by default — leads are workable immediately and the
 * Sales Head gets an FYI notification. On restores the 7-day approval clock.
 */
function LeadApprovalSetting() {
  const app = useAppContext();
  const qc = useQueryClient();
  const { settings, isLoading } = useLeadSettings();

  const save = useMutation({
    mutationFn: (require_approval: boolean) =>
      saveLeadSettings({ ...settings, require_approval }, app.userId),
    onSuccess: (_d, require_approval) => {
      qc.invalidateQueries({ queryKey: ["leads", "settings"] });
      toast.success(
        require_approval
          ? "New leads now need Sales Head approval"
          : "New leads go straight into the pipeline",
      );
    },
    onError: (e) => toastDbError(e, { action: "save the lead approval setting" }),
  });

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-card)] border border-[var(--border)] bg-card p-4 shadow-[var(--shadow-card)]">
      <div className="min-w-0">
        <div className="text-[13px] font-semibold">Require Sales Head approval for new leads</div>
        <p className="mt-0.5 text-[12px] text-muted-foreground">
          {settings.require_approval
            ? "Rep-entered leads land as awaiting approval with a 7-day clock, then escalate."
            : "Rep-entered leads enter the pipeline immediately. The Sales Head is notified for information only."}
        </p>
      </div>
      <Switch
        checked={settings.require_approval}
        disabled={isLoading || save.isPending || app.writesDisabled}
        onCheckedChange={(v) => save.mutate(v)}
        aria-label="Require Sales Head approval for new leads"
      />
    </div>
  );
}

function slugify(name: string) {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "") || `stage_${Date.now().toString(36)}`
  );
}

function PipelineAdmin() {
  const app = useAppContext();
  const qc = useQueryClient();
  const [entity, setEntity] = React.useState<"account" | "job">("account");
  const [advanceStage, setAdvanceStage] = React.useState<PipelineStage | null>(null);
  const [selected, setSelected] = React.useState<string | null>(null);
  const recordTable = entity === "job" ? ("jobs" as const) : ("accounts" as const);
  const recordNoun = entity === "job" ? "job" : "account";
  const [newPipelineOpen, setNewPipelineOpen] = React.useState(false);
  const [deactivate, setDeactivate] = React.useState<{
    stage: PipelineStage;
    count: number;
  } | null>(null);
  const [moveTarget, setMoveTarget] = React.useState<string>("");
  const [dragIndex, setDragIndex] = React.useState<number | null>(null);

  const pipelinesQuery = useQuery({
    queryKey: ["pipelines", entity],
    queryFn: () => fetchPipelines(entity),
  });

  const pipelines = pipelinesQuery.data ?? [];
  const pipelineId = selected ?? pipelines[0]?.id ?? null;
  const pipeline = pipelines.find((p) => p.id === pipelineId) ?? null;

  const stagesQuery = useQuery({
    queryKey: ["pipeline-stages", pipelineId],
    enabled: !!pipelineId,
    queryFn: () => fetchStages(pipelineId!),
  });
  const stages = stagesQuery.data ?? [];

  const countsQuery = useQuery({
    queryKey: ["pipeline-stage-counts", recordTable, pipelineId, stages.map((s) => s.id).join(",")],
    enabled: stages.length > 0,
    queryFn: async () => {
      const entries = await Promise.all(
        stages.map(async (s) => {
          const { count } = await supabase
            .from(recordTable)
            .select("id", { count: "exact", head: true })
            .eq("stage_id", s.id);
          return [s.id, count ?? 0] as const;
        }),
      );
      return Object.fromEntries(entries) as Record<string, number>;
    },
  });
  const counts = countsQuery.data ?? {};

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["pipeline-stages"] });
    qc.invalidateQueries({ queryKey: ["pipeline-stage-counts"] });
    qc.invalidateQueries({ queryKey: ["pipelines"] });
    qc.invalidateQueries({ queryKey: ["pipeline-cards"] });
  };

  const patchStage = useMutation({
    mutationFn: async (args: { id: string; patch: Partial<PipelineStage> }) => {
      const { error } = await supabase
        .from("pipeline_stages")
        .update(args.patch as never)
        .eq("id", args.id);
      if (error) throw error;
    },
    onSuccess: invalidate,
    onError: (e) => toastDbError(e, { action: "update the stage" }),
  });

  const togglePipelineAuto = useMutation({
    mutationFn: async (on: boolean) => {
      if (!pipelineId) return;
      await setPipelineAutoAdvance(pipelineId, on);
    },
    onSuccess: () => {
      toast.success("Saved");
      invalidate();
    },
    onError: (e) => toastDbError(e, { action: "change automatic progression" }),
  });

  const addStage = useMutation({
    mutationFn: async () => {
      if (!pipelineId) return;
      const name = "New stage";
      const { error } = await supabase.from("pipeline_stages").insert({
        pipeline_id: pipelineId,
        key: slugify(`${name}_${Date.now().toString(36)}`),
        name,
        sort_order: (stages.at(-1)?.sort_order ?? 0) + 10,
        color: "var(--muted-foreground)",
        probability: 0,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Stage added");
      invalidate();
    },
    onError: (e) => toastDbError(e, { action: "add the stage" }),
  });

  const deleteStage = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("pipeline_stages").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Stage removed");
      invalidate();
    },
    onError: (e) => toastDbError(e, { action: "remove the stage" }),
  });

  const reorder = useMutation({
    mutationFn: async (ordered: PipelineStage[]) => {
      for (let i = 0; i < ordered.length; i++) {
        const s = ordered[i]!;
        const next = (i + 1) * 10;
        if (s.sort_order === next) continue;
        const { error } = await supabase
          .from("pipeline_stages")
          .update({ sort_order: next })
          .eq("id", s.id);
        if (error) throw error;
      }
    },
    onSuccess: invalidate,
    onError: (e) => toastDbError(e, { action: "reorder the stages" }),
  });

  const moveAndDeactivate = useMutation({
    mutationFn: async (args: { from: string; to: string | null }) => {
      if (args.to) {
        const { error } = await supabase
          .from(recordTable)
          .update({ stage_id: args.to })
          .eq("stage_id", args.from);
        if (error) throw error;
      }
      const { error } = await supabase
        .from("pipeline_stages")
        .update({ is_active: false })
        .eq("id", args.from);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Stage deactivated");
      setDeactivate(null);
      setMoveTarget("");
      invalidate();
    },
    onError: (e) => toastDbError(e, { action: "deactivate the stage" }),
  });

  const applyOrder = (from: number, to: number) => {
    const next = [...stages];
    const [item] = next.splice(from, 1);
    if (!item) return;
    next.splice(to, 0, item);
    reorder.mutate(next);
  };

  // Whether the role may edit this pipeline at all: without it the stages
  // read as text. View As preview (writesDisabled) keeps the controls, off.
  const canEdit = (p: Pipeline | null) =>
    !!p &&
    (app.roles.includes("owner") ||
      app.roles.includes("admin") ||
      app.roles.includes("dev") ||
      (p.location_id != null &&
        app.memberships.some(
          (m) => m.location_id === p.location_id && m.role === "location_manager",
        )));

  const editable = canEdit(pipeline);
  const locked = app.writesDisabled;

  return (
    <div className="flex flex-col gap-2 p-3 md:p-4">
      {app.writesDisabled && <WarningLine>{app.writesDisabledReason}</WarningLine>}

      <LeadApprovalSetting />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Label className="text-xs">For</Label>
          <Select
            value={entity}
            onValueChange={(v) => {
              setEntity(v as "account" | "job");
              setSelected(null);
            }}
          >
            <SelectTrigger className="h-8 w-[140px] text-[13px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="account">Accounts</SelectItem>
              <SelectItem value="job">Jobs</SelectItem>
            </SelectContent>
          </Select>
          <Label className="text-xs">Pipeline</Label>
          <Select value={pipelineId ?? ""} onValueChange={setSelected}>
            <SelectTrigger className="h-8 w-[280px] text-[13px]">
              <SelectValue placeholder="Select a pipeline" />
            </SelectTrigger>
            <SelectContent>
              {pipelines.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name} ·{" "}
                  {p.location_id
                    ? (app.allLocations.find((l) => l.id === p.location_id)?.code ?? "office")
                    : "Global"}
                  {p.is_default ? " · default" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setNewPipelineOpen(true)}
            disabled={app.writesDisabled}
          >
            <Plus className="mr-1 size-3.5" /> New pipeline
          </Button>
          {editable && (
            <Button size="sm" onClick={() => addStage.mutate()} disabled={locked}>
              <Plus className="mr-1 size-3.5" /> Add stage
            </Button>
          )}
        </div>
      </div>

      {pipeline && (
        <div className="flex flex-wrap items-center gap-2 border bg-muted/30 px-2 py-1.5">
          <Zap className="size-3.5 text-muted-foreground" />
          <Label className="text-[12px]">Automatic stage progression</Label>
          {editable ? (
            <Switch
              checked={pipeline.auto_advance_enabled !== false}
              disabled={locked}
              onCheckedChange={(v) => togglePipelineAuto.mutate(v)}
            />
          ) : (
            <span className="text-[12px] font-medium">
              {pipeline.auto_advance_enabled !== false ? "On" : "Off"}
            </span>
          )}
          <span className="text-[11px] text-muted-foreground">
            Master switch for this pipeline — off, no stage rule fires.
          </span>
        </div>
      )}

      {pipelinesQuery.error && <LoadError what="pipelines" error={pipelinesQuery.error} />}
      {stagesQuery.error && <LoadError what="stages" error={stagesQuery.error} />}

      {stages.length === 0 && !stagesQuery.isLoading ? (
        <EmptyLine>
          {editable
            ? "This pipeline has no stages yet. Add the first one."
            : "This pipeline has no stages yet."}
        </EmptyLine>
      ) : (
        <div className="overflow-x-auto md:max-h-[75svh] md:overflow-auto border">
          <table className="w-full text-[13px]">
            <thead className="bg-muted text-[11px] uppercase tracking-wide text-muted-foreground">
              <tr className="[&>th]:px-2 [&>th]:py-1.5 [&>th]:text-left">
                {editable && <th className="w-8" />}
                <th>Stage</th>
                <th className="w-[86px]">Color</th>
                <th className="w-[92px] text-right">Probability</th>
                <th className="w-[86px] text-right">WIP limit</th>
                <th className="w-[64px] text-center">Won</th>
                <th className="w-[64px] text-center">Lost</th>
                <th className="w-[80px] text-right">{entity === "job" ? "Jobs" : "Accounts"}</th>
                <th className="w-[110px] text-center">Auto-advance</th>
                <th className="w-[72px] text-center">Active</th>
                {editable && <th className="w-[112px]" />}
              </tr>
            </thead>
            <tbody>
              {stages.map((s, i) => (
                <tr
                  key={s.id}
                  draggable={editable && !locked}
                  onDragStart={() => setDragIndex(i)}
                  onDragOver={(e) => editable && !locked && e.preventDefault()}
                  onDrop={() => {
                    if (dragIndex != null && dragIndex !== i) applyOrder(dragIndex, i);
                    setDragIndex(null);
                  }}
                  className={cn(
                    "border-t [&>td]:px-2 [&>td]:py-1",
                    !s.is_active && "opacity-60",
                    dragIndex === i && "bg-accent/40",
                  )}
                >
                  {editable && (
                    <td className="text-muted-foreground">
                      <div className="flex flex-col items-center">
                        <GripVertical className={cn("size-3.5", !locked && "cursor-grab")} />
                      </div>
                    </td>
                  )}
                  {!editable ? (
                    <>
                      <td className="py-1.5 font-medium">{s.name}</td>
                      <td>
                        <span
                          className="block h-4 w-8 rounded-sm border"
                          style={{ backgroundColor: s.color }}
                          aria-label={`Color ${s.color}`}
                        />
                      </td>
                      <td className="text-right tabular-nums">{Number(s.probability)}%</td>
                      <td className="text-right tabular-nums">{s.wip_limit ?? "None"}</td>
                      <td className="text-center">{s.is_won ? "Yes" : ""}</td>
                      <td className="text-center">{s.is_lost ? "Yes" : ""}</td>
                      <td className="text-right tabular-nums">{counts[s.id] ?? 0}</td>
                      <td className="text-center text-[12px]">
                        {s.auto_advance
                          ? `${conditionsOfStage(s.advance_conditions).length} rule(s)`
                          : "Off"}
                      </td>
                      <td className="text-center text-[12px]">{s.is_active ? "Yes" : "No"}</td>
                    </>
                  ) : (
                    <>
                      <td>
                        <Input
                          className="h-7 text-[13px]"
                          defaultValue={s.name}
                          disabled={locked}
                          onBlur={(e) => {
                            const v = e.target.value.trim();
                            if (v && v !== s.name)
                              patchStage.mutate({ id: s.id, patch: { name: v } });
                          }}
                        />
                      </td>
                      <td>
                        <input
                          type="color"
                          className="h-7 w-full border bg-background"
                          defaultValue={s.color}
                          disabled={locked}
                          onBlur={(e) =>
                            e.target.value !== s.color &&
                            patchStage.mutate({ id: s.id, patch: { color: e.target.value } })
                          }
                        />
                      </td>
                      <td>
                        <Input
                          className="h-7 text-right text-[13px] tabular-nums"
                          inputMode="numeric"
                          defaultValue={Number(s.probability)}
                          disabled={locked}
                          onBlur={(e) => {
                            const v = Math.max(0, Math.min(100, Number(e.target.value) || 0));
                            if (v !== Number(s.probability))
                              patchStage.mutate({ id: s.id, patch: { probability: v } });
                          }}
                        />
                      </td>
                      <td>
                        <Input
                          className="h-7 text-right text-[13px] tabular-nums"
                          inputMode="numeric"
                          defaultValue={s.wip_limit ?? ""}
                          disabled={locked}
                          onBlur={(e) => {
                            const raw = e.target.value.trim();
                            const v = raw === "" ? null : Math.max(1, Number(raw) || 1);
                            if (v !== s.wip_limit)
                              patchStage.mutate({ id: s.id, patch: { wip_limit: v } });
                          }}
                        />
                      </td>
                      <td className="text-center">
                        <input
                          type="checkbox"
                          checked={s.is_won}
                          disabled={locked}
                          onChange={(e) =>
                            patchStage.mutate({
                              id: s.id,
                              patch: { is_won: e.target.checked, is_lost: false },
                            })
                          }
                        />
                      </td>
                      <td className="text-center">
                        <input
                          type="checkbox"
                          checked={s.is_lost}
                          disabled={locked}
                          onChange={(e) =>
                            patchStage.mutate({
                              id: s.id,
                              patch: { is_lost: e.target.checked, is_won: false },
                            })
                          }
                        />
                      </td>
                      <td className="text-right tabular-nums">{counts[s.id] ?? 0}</td>
                      <td className="text-center">
                        <Button
                          size="sm"
                          variant={s.auto_advance ? "default" : "outline"}
                          className="h-6 px-2 text-[11px]"
                          disabled={locked}
                          onClick={() => setAdvanceStage(s)}
                        >
                          <Zap className="mr-1 size-3" />
                          {s.auto_advance
                            ? `${conditionsOfStage(s.advance_conditions).length} rule(s)`
                            : "Off"}
                        </Button>
                      </td>
                      <td className="text-center">
                        <Switch
                          checked={s.is_active}
                          disabled={locked}
                          onCheckedChange={(v) => {
                            if (!v && (counts[s.id] ?? 0) > 0) {
                              setMoveTarget("");
                              setDeactivate({ stage: s, count: counts[s.id] ?? 0 });
                              return;
                            }
                            patchStage.mutate({ id: s.id, patch: { is_active: v } });
                          }}
                        />
                      </td>
                      <td>
                        <div className="flex items-center justify-end gap-0.5">
                          <Button
                            size="icon"
                            variant="ghost"
                            className="size-6"
                            disabled={locked || i === 0}
                            onClick={() => applyOrder(i, i - 1)}
                            aria-label="Move up"
                          >
                            <ArrowUp className="size-3.5" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="size-6"
                            disabled={locked || i === stages.length - 1}
                            onClick={() => applyOrder(i, i + 1)}
                            aria-label="Move down"
                          >
                            <ArrowDown className="size-3.5" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="size-6 text-destructive"
                            disabled={locked || (counts[s.id] ?? 0) > 0}
                            title={
                              (counts[s.id] ?? 0) > 0
                                ? "Accounts sit in this stage — deactivate it instead, or move them first"
                                : "Remove stage"
                            }
                            onClick={() => deleteStage.mutate(s.id)}
                            aria-label="Remove stage"
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                        </div>
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-[12px] text-muted-foreground">
        Probability drives the weighted forecast on the pipeline board. A stage holding {recordNoun}
        s cannot be deleted — deactivate it and move its {recordNoun}s somewhere else. Job stages
        are the single source of truth for job status: rename, reorder, add or retire them here.
      </p>

      {advanceStage && (
        <AdvanceDialog
          stage={advanceStage}
          stages={stages}
          onClose={() => setAdvanceStage(null)}
          onSaved={() => {
            setAdvanceStage(null);
            qc.invalidateQueries({ queryKey: ["pipeline-stages"] });
          }}
        />
      )}

      <NewPipelineDialog
        entity={entity}
        open={newPipelineOpen}
        onOpenChange={setNewPipelineOpen}
        onCreated={(id) => {
          setSelected(id);
          invalidate();
        }}
      />

      {/* Deactivating a stage that holds records ------------------------- */}
      <Dialog open={!!deactivate} onOpenChange={(v) => !v && setDeactivate(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>
              Move {recordNoun}s out of {deactivate?.stage.name}?
            </DialogTitle>
            <DialogDescription>
              {deactivate?.count} {recordNoun}
              {deactivate?.count === 1 ? "" : "s"} sit here. Choose where they go — they cannot be
              left without a stage.
            </DialogDescription>
          </DialogHeader>
          <Select value={moveTarget} onValueChange={setMoveTarget}>
            <SelectTrigger>
              <SelectValue placeholder="Move them to…" />
            </SelectTrigger>
            <SelectContent>
              {stages
                .filter((s) => s.id !== deactivate?.stage.id && s.is_active && !s.is_lost)
                .map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
          <DialogFooter>
            <Button size="sm" variant="outline" onClick={() => setDeactivate(null)}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={!moveTarget || moveAndDeactivate.isPending}
              onClick={() =>
                deactivate &&
                moveAndDeactivate.mutate({ from: deactivate.stage.id, to: moveTarget })
              }
            >
              Move and deactivate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function NewPipelineDialog({
  entity,
  open,
  onOpenChange,
  onCreated,
}: {
  entity: "account" | "job";
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: (id: string) => void;
}) {
  const app = useAppContext();
  const [name, setName] = React.useState("");
  const [locationId, setLocationId] = React.useState("__global");
  const [isDefault, setIsDefault] = React.useState(true);

  React.useEffect(() => {
    if (open) {
      setName("");
      setLocationId("__global");
      setIsDefault(true);
    }
  }, [open]);

  const create = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase
        .from("pipelines")
        .insert({
          name: name.trim(),
          entity_type: entity,
          location_id: locationId === "__global" ? null : locationId,
          is_default: isDefault,
          created_by: app.userId,
        })
        .select("id")
        .single();
      if (error) throw error;

      // A new pipeline with no stages is useless — start from the agreed lifecycle.
      const seed = (
        entity === "job"
          ? ([
              ["new", "New", 10, "var(--muted-foreground)", 0, false, false],
              ["scheduled", "Scheduled", 20, "#2563EB", 20, false, false],
              ["in_progress", "In progress", 30, "#1B5FA8", 40, false, false],
              ["drying", "Drying", 40, "#0EA5E9", 55, false, false],
              ["complete", "Complete", 50, "#059669", 75, false, false],
              ["invoiced", "Invoiced", 60, "#B8A030", 90, false, false],
              ["paid", "Paid", 70, "#047857", 100, true, false],
              ["cancelled", "Canceled", 80, "#E31B23", 0, false, true],
            ] as const)
          : ([
              ["target", "Target", 10, "var(--muted-foreground)", 5, false, false],
              ["researching", "Researching", 20, "#0F766E", 10, false, false],
              ["attempting_contact", "Attempting contact", 30, "#1B5FA8", 20, false, false],
              ["meeting_booked", "Meeting booked", 40, "#2563EB", 35, false, false],
              ["meeting_held", "Meeting held", 50, "#7C3AED", 50, false, false],
              ["vendor_onboarding", "Vendor onboarding", 60, "#C8951C", 70, false, false],
              ["active", "Active", 70, "var(--success)", 100, true, false],
              ["nurture", "Nurture", 80, "#0891B2", 25, false, false],
              ["dormant", "Dormant", 90, "#78716C", 0, false, false],
              ["lost", "Lost", 100, "var(--destructive)", 0, false, true],
            ] as const)
      ) as readonly (readonly [string, string, number, string, number, boolean, boolean])[];
      const { error: stageErr } = await supabase.from("pipeline_stages").insert(
        seed.map(([key, sname, sort, color, prob, won, lost]) => ({
          pipeline_id: data.id,
          key,
          name: sname,
          sort_order: sort,
          color,
          probability: prob,
          is_won: won,
          is_lost: lost,
        })),
      );
      if (stageErr) throw stageErr;
      return data.id as string;
    },
    onSuccess: (id) => {
      toast.success("Pipeline created");
      onCreated(id);
      onOpenChange(false);
    },
    onError: (e) => toastDbError(e, { action: "create the pipeline" }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>New pipeline</DialogTitle>
          <DialogDescription>
            Offices can run their own stages. A global pipeline applies wherever there is no local
            one.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2.5">
          <div>
            <Label className="text-xs">Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </div>
          <div>
            <Label className="text-xs">Scope</Label>
            <Select value={locationId} onValueChange={setLocationId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__global">Global (all offices)</SelectItem>
                {app.allLocations.map((l) => (
                  <SelectItem key={l.id} value={l.id}>
                    {l.code} — {l.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <label className="flex items-center gap-2 text-[13px]">
            <input
              type="checkbox"
              checked={isDefault}
              onChange={(e) => setIsDefault(e.target.checked)}
            />
            Make this the default for its scope
          </label>
        </div>
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={name.trim().length < 2 || create.isPending}
            onClick={() => create.mutate()}
          >
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AdvanceDialog({
  stage,
  stages,
  onClose,
  onSaved,
}: {
  stage: PipelineStage;
  stages: PipelineStage[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const idx = stages.findIndex((s) => s.id === stage.id);
  const [on, setOn] = React.useState(!!stage.auto_advance);
  const [target, setTarget] = React.useState<string>(
    stage.advance_to_stage_id ?? stages[idx + 1]?.id ?? "",
  );
  const [conds, setConds] = React.useState<AdvanceCondition[]>(
    conditionsOfStage(stage.advance_conditions),
  );
  const [match, setMatch] = React.useState<AdvanceMatch>(
    stage.advance_match === "any" ? "any" : "all",
  );
  const [minCount, setMinCount] = React.useState<number>(Math.max(1, stage.advance_min_count ?? 1));

  const save = useMutation({
    mutationFn: () =>
      saveStageAdvance(stage.id, {
        auto_advance: on,
        advance_to_stage_id: target || null,
        advance_conditions: conds,
        advance_match: match,
        advance_min_count: minCount,
      }),
    onSuccess: () => {
      toast.success("Progression saved");
      onSaved();
    },
    onError: (e) => toastDbError(e, { action: "save progression" }),
  });

  const setCond = (i: number, patch: Partial<AdvanceCondition>) =>
    setConds((c) => c.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Auto-advance · {stage.name}</DialogTitle>
          <DialogDescription>
            When the conditions below are met the record moves itself, the timeline records which
            rule caused it and the owner gets a notification with a one-click undo. Forward only —
            never backwards, and never past a stage that needs a human decision.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Switch checked={on} onCheckedChange={setOn} />
            <Label className="text-[13px]">Advance automatically</Label>
          </div>

          <div>
            <Label className="text-[11px]">Move to</Label>
            <Select value={target} onValueChange={setTarget}>
              <SelectTrigger className="h-8 text-[13px]">
                <SelectValue placeholder="Next stage" />
              </SelectTrigger>
              <SelectContent>
                {stages
                  .filter((s) => s.id !== stage.id)
                  .map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center gap-2">
            <Label className="text-[11px]">Require</Label>
            <Select value={match} onValueChange={(v) => setMatch(v as AdvanceMatch)}>
              <SelectTrigger className="h-7 w-[190px] text-[12px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All conditions (AND)</SelectItem>
                <SelectItem value="any">Any of them (OR)</SelectItem>
              </SelectContent>
            </Select>
            {match === "any" && (
              <>
                <Label className="text-[11px]">at least</Label>
                <Input
                  className="h-7 w-[60px] text-right text-[12px] tabular-nums"
                  inputMode="numeric"
                  value={minCount}
                  onChange={(e) => setMinCount(Math.max(1, Number(e.target.value) || 1))}
                />
              </>
            )}
          </div>

          <div className="space-y-1.5">
            <Label className="text-[11px]">Conditions</Label>
            {conds.length === 0 && (
              <p className="text-[12px] text-muted-foreground">
                No conditions — nothing will advance until you add one.
              </p>
            )}
            {conds.map((c, i) => (
              <div key={i} className="flex flex-wrap items-center gap-1.5 border p-1.5">
                <Select
                  value={c.kind}
                  onValueChange={(v) => setCond(i, { kind: v as AdvanceConditionKind })}
                >
                  <SelectTrigger className="h-7 w-[170px] text-[12px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(ADVANCE_CONDITION_LABEL).map(([k, label]) => (
                      <SelectItem key={k} value={k}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                {c.kind === "activity_logged" && (
                  <>
                    <Select
                      value={c.activity_type ?? "any"}
                      onValueChange={(v) => setCond(i, { activity_type: v })}
                    >
                      <SelectTrigger className="h-7 w-[150px] text-[12px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ADVANCE_ACTIVITY_TYPES.map((a) => (
                          <SelectItem key={a.key} value={a.key}>
                            {a.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Input
                      className="h-7 w-[64px] text-right text-[12px] tabular-nums"
                      inputMode="numeric"
                      value={c.min_count ?? 1}
                      onChange={(e) =>
                        setCond(i, { min_count: Math.max(1, Number(e.target.value) || 1) })
                      }
                    />
                  </>
                )}

                {c.kind !== "activity_logged" && COUNTABLE_KINDS.includes(c.kind) && (
                  <Input
                    className="h-7 w-[64px] text-right text-[12px] tabular-nums"
                    inputMode="numeric"
                    title="How many are needed"
                    value={c.min_count ?? 1}
                    onChange={(e) =>
                      setCond(i, { min_count: Math.max(1, Number(e.target.value) || 1) })
                    }
                  />
                )}

                {c.kind === "days_in_stage" && (
                  <Input
                    className="h-7 w-[74px] text-right text-[12px] tabular-nums"
                    inputMode="numeric"
                    title="Days in stage"
                    value={c.days ?? 7}
                    onChange={(e) => setCond(i, { days: Math.max(1, Number(e.target.value) || 1) })}
                  />
                )}

                {c.kind === "field_populated" && (
                  <Select
                    value={c.field ?? ADVANCE_FIELDS[0].key}
                    onValueChange={(v) => setCond(i, { field: v })}
                  >
                    <SelectTrigger className="h-7 w-[190px] text-[12px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ADVANCE_FIELDS.map((f) => (
                        <SelectItem key={f.key} value={f.key}>
                          {f.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}

                <span className="ml-auto text-[11px] text-muted-foreground">
                  {describeCondition(c)}
                </span>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-6 text-destructive"
                  onClick={() => setConds((x) => x.filter((_, j) => j !== i))}
                  aria-label="Remove condition"
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            ))}
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-[12px]"
              onClick={() => setConds((c) => [...c, { kind: "call_logged", min_count: 1 }])}
            >
              <Plus className="mr-1 size-3" /> Add condition
            </Button>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
