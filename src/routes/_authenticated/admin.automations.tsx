import { InvoiceFollowupRulesAdmin } from "@/components/invoice-followup-rules-admin";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Play, Plus, Trash2 } from "lucide-react";

import { useAppContext } from "@/components/app-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toastDbError } from "@/lib/db-errors";
import { supabase } from "@/integrations/supabase/client";
import { JobRecipientPicker, JobStagePicker } from "@/components/automation-job-rule";
import {
  ACTIONS,
  ACTION_LABEL,
  JOB_ACTIONS,
  isJobTrigger,
  DATE_FIELDS,
  TRIGGERS,
  TRIGGER_HINT,
  TRIGGER_LABEL,
  actionsOf,
  deleteRule,
  describeRule,
  listRules,
  listRecentEvents,
  listRuns,
  ruleStats,
  listStageWindows,
  saveStageWindow,
  setRuleActive,
  upsertRule,
  type AutomationRule,
  type RuleAction,
  type TriggerType,
} from "@/lib/automation";
import { runAutomations } from "@/lib/automation.functions";

import { DATE_LOCALE, US_DATE } from "@/lib/date-format";
export const Route = createFileRoute("/_authenticated/admin/automations")({
  head: () => ({
    meta: [
      { title: "Task automation — Recovery Hub" },
      {
        name: "description",
        content:
          "Configure rotting-deal rules, reminders and escalations without a developer. Internal actions only.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AutomationsPage,
});

function AutomationsPage() {
  const app = useAppContext();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Partial<AutomationRule> | null>(null);

  const rulesQ = useQuery({
    queryKey: ["automation-rules", app.currentLocationId],
    queryFn: () => listRules(app.currentLocationId),
  });
  const runsQ = useQuery({ queryKey: ["automation-runs"], queryFn: () => listRuns(30) });
  const statsQ = useQuery({ queryKey: ["automation-rule-stats"], queryFn: () => ruleStats() });
  const eventsQ = useQuery({
    queryKey: ["automation-events-feed"],
    queryFn: () => listRecentEvents(60),
  });
  const stats = statsQ.data ?? {};
  const ruleName = (id: string | null) =>
    (rulesQ.data ?? []).find((r) => r.id === id)?.name ?? "Deleted rule";

  const run = useMutation({
    mutationFn: (ruleId?: string) => runAutomations({ data: { ruleId: ruleId ?? null } }),
    onSuccess: (r) => {
      toast.success(
        `${r.actions} action${r.actions === 1 ? "" : "s"} taken across ${r.rules} rule${r.rules === 1 ? "" : "s"}`,
      );
      void qc.invalidateQueries({ queryKey: ["automation-runs"] });
      void qc.invalidateQueries({ queryKey: ["automation-rule-stats"] });
      void qc.invalidateQueries({ queryKey: ["automation-events-feed"] });
      void qc.invalidateQueries({ queryKey: ["tasks"] });
    },
    onError: (e) => toastDbError(e, { action: "Run automations" }),
  });

  const toggle = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) => setRuleActive(id, active),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["automation-rules"] }),
    onError: (e) => toastDbError(e, { action: "Toggle rule" }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteRule(id),
    onSuccess: () => {
      toast.success("Rule deleted");
      void qc.invalidateQueries({ queryKey: ["automation-rules"] });
    },
    onError: (e) => toastDbError(e, { action: "Delete rule" }),
  });

  const rules = rulesQ.data ?? [];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-2xl text-xs text-muted-foreground">
          Rules run against your deals, tasks and jobs and only ever act internally — a task, a
          reminder, a flag, a notification, an escalation, or an email to staff. Automation never
          sends anything to a client, including pre-written templates. Every task a rule creates
          carries the rule name and the reason it fired.
        </p>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={run.isPending || app.writesDisabled}
            onClick={() => run.mutate(undefined)}
          >
            <Play className="mr-1.5 size-3.5" /> Run all now
          </Button>
          {/*
            David, 22 Sep: "it looks like it's more on the sales end for
            tracking sale items... I can't create my rules that I want to
            create." The job rules get their own front door.
          */}
          <Button
            size="sm"
            variant="outline"
            onClick={() => setEditing({ trigger_type: "job_stage_age" as never, name: "" })}
          >
            <Plus className="mr-1.5 size-3.5" /> New job rule
          </Button>
          <Button size="sm" onClick={() => setEditing({ trigger_type: "stage_rot", name: "" })}>
            <Plus className="mr-1.5 size-3.5" /> New sales rule
          </Button>
        </div>
      </div>

      <Tabs defaultValue="rules">
        <TabsList>
          <TabsTrigger value="rules">Rules</TabsTrigger>
          <TabsTrigger value="windows">Rot windows</TabsTrigger>
          <TabsTrigger value="history">Run history</TabsTrigger>
          <TabsTrigger value="invoice-followups">Invoice follow-ups</TabsTrigger>
        </TabsList>

        <TabsContent value="rules" className="space-y-2 pt-2">
          {rulesQ.isLoading ? (
            <p className="text-xs text-muted-foreground">Loading rules…</p>
          ) : rules.length === 0 ? (
            <Card>
              <CardContent className="py-6 text-center text-xs text-muted-foreground">
                No rules yet. The usual first one: a deal that rots in its stage creates a follow-up
                task for the owner, then escalates to the Sales Head at the second threshold.
              </CardContent>
            </Card>
          ) : (
            rules.map((r) => (
              <Card key={r.id}>
                <CardContent className="flex flex-wrap items-start gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{r.name}</span>
                      <Badge variant="outline" className="text-[10px]">
                        {TRIGGER_LABEL[r.trigger_type]}
                      </Badge>
                      {!r.is_active && (
                        <Badge variant="secondary" className="text-[10px]">
                          Paused
                        </Badge>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">{describeRule(r)}</p>
                    {r.description ? (
                      <p className="mt-0.5 text-[11px] text-muted-foreground">{r.description}</p>
                    ) : null}
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                      <span>
                        Last run:{" "}
                        {stats[r.id]?.lastRunAt
                          ? new Date(stats[r.id]!.lastRunAt!).toLocaleString("en-US")
                          : "never"}
                      </span>
                      <span>
                        Fired {stats[r.id]?.fireCount ?? 0}×
                        {stats[r.id]?.lastFiredAt
                          ? ` (last ${new Date(stats[r.id]!.lastFiredAt!).toLocaleDateString(DATE_LOCALE, US_DATE)})`
                          : ""}
                      </span>
                      <span>{stats[r.id]?.runCount ?? 0} evaluations</span>
                      {stats[r.id]?.lastError ? (
                        <span className="text-destructive">Error: {stats[r.id]!.lastError}</span>
                      ) : null}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={r.is_active}
                      disabled={app.writesDisabled}
                      onCheckedChange={(v) => toggle.mutate({ id: r.id, active: v })}
                    />
                    <Button size="sm" variant="outline" onClick={() => setEditing(r)}>
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={run.isPending || app.writesDisabled}
                      onClick={() => run.mutate(r.id)}
                    >
                      <Play className="size-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={app.writesDisabled}
                      onClick={() => remove.mutate(r.id)}
                    >
                      <Trash2 className="size-3.5 text-destructive" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))
          )}
        </TabsContent>

        <TabsContent value="windows" className="pt-2">
          <StageWindows />
        </TabsContent>

        {/* Client item 18 (21 Oct): reminders on unpaid, sent invoices. */}
        <TabsContent value="invoice-followups" className="pt-2">
          <InvoiceFollowupRulesAdmin />
        </TabsContent>

        <TabsContent value="history" className="space-y-3 pt-2">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">What automation actually did</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 pt-0">
              {(eventsQ.data ?? []).length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Nothing has fired yet. Rules are evaluated every 15 minutes and immediately when a
                  relevant record changes.
                </p>
              ) : (
                (eventsQ.data ?? []).map((e) => (
                  <div key={e.id} className="border-b pb-2 last:border-0 last:pb-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline" className="text-[10px]">
                        {ACTION_LABEL[e.action_kind]}
                      </Badge>
                      <span className="text-xs font-medium">{e.record_label ?? e.record_type}</span>
                      <span className="text-[11px] text-muted-foreground">
                        {ruleName(e.rule_id)} · {new Date(e.created_at).toLocaleString("en-US")}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">{e.reason}</p>
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Started</TableHead>
                    <TableHead>Rule</TableHead>
                    <TableHead className="text-right">Evaluated</TableHead>
                    <TableHead className="text-right">Matched</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                    <TableHead>Outcome</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(runsQ.data ?? []).map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="text-xs">
                        {new Date(r.started_at).toLocaleString("en-US")}
                      </TableCell>
                      <TableCell className="text-xs">{ruleName(r.rule_id)}</TableCell>
                      <TableCell className="text-right text-xs tabular-nums">
                        {r.evaluated_count}
                      </TableCell>
                      <TableCell className="text-right text-xs tabular-nums">
                        {r.matched_count}
                      </TableCell>
                      <TableCell className="text-right text-xs tabular-nums">
                        {r.action_count}
                      </TableCell>
                      <TableCell className="text-xs">
                        {r.error ? (
                          <span className="text-destructive">{r.error}</span>
                        ) : r.finished_at ? (
                          "OK"
                        ) : (
                          "Running…"
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                  {(runsQ.data ?? []).length === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={6}
                        className="py-6 text-center text-xs text-muted-foreground"
                      >
                        No runs yet.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {editing ? (
        <RuleEditor
          rule={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void qc.invalidateQueries({ queryKey: ["automation-rules"] });
          }}
        />
      ) : null}
    </div>
  );
}

function RuleEditor({
  rule,
  onClose,
  onSaved,
}: {
  rule: Partial<AutomationRule>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const app = useAppContext();
  const [name, setName] = useState(rule.name ?? "");
  const [description, setDescription] = useState(rule.description ?? "");
  const [trigger, setTrigger] = useState<TriggerType>(
    (rule.trigger_type as TriggerType | undefined) ?? "stage_rot",
  );
  const jobRule = isJobTrigger(trigger);
  const cfg = (rule.trigger_config ?? {}) as { days?: number; date_field?: string };
  const [days, setDays] = useState(String(cfg.days ?? (jobRule ? 7 : 14)));
  const [stageIds, setStageIds] = useState<string[]>(
    ((rule.conditions ?? {}) as { stage_ids?: string[] }).stage_ids ?? [],
  );
  const [dateField, setDateField] = useState(cfg.date_field ?? DATE_FIELDS[0].key);
  const [actions, setActions] = useState<RuleAction[]>(
    rule.id
      ? actionsOf(rule as AutomationRule)
      : isJobTrigger(rule.trigger_type as TriggerType)
        ? [
            {
              kind: "create_task",
              title: "",
              assignee_mode: "office_manager",
              due_in_days: 0,
              priority: "normal",
            },
          ]
        : [
            {
              kind: "create_task",
              title: "Follow up — deal has stalled",
              assignee_mode: "account_owner",
              due_in_days: 1,
              priority: "high",
            },
            { kind: "escalate" },
          ],
  );

  const save = useMutation({
    mutationFn: async () => {
      if (!name.trim()) throw new Error("Give the rule a name.");
      if (jobRule && stageIds.length === 0) throw new Error("Pick at least one job stage.");
      if (jobRule && actions.some((a) => a.assignee_mode === "specific" && !a.assignee_user_id)) {
        throw new Error("Choose the person for each action set to a specific person.");
      }
      await upsertRule({
        ...(rule.id ? { id: rule.id } : {}),
        name: name.trim(),
        description: description.trim() || null,
        trigger_type: trigger as never,
        location_id: rule.location_id ?? app.currentLocationId,
        // Merged, not replaced: a key this editor does not show (offset_days)
        // used to be wiped on every save.
        trigger_config: {
          ...((rule.trigger_config ?? {}) as object),
          days: Number(days) || 0,
          ...(jobRule ? {} : { date_field: dateField }),
        } as never,
        conditions: {
          ...((rule.conditions ?? {}) as object),
          ...(jobRule ? { stage_ids: stageIds } : {}),
        } as never,
        actions: actions as never,
        created_by: rule.created_by ?? app.userId,
      });
    },
    onSuccess: () => {
      toast.success("Rule saved");
      onSaved();
    },
    onError: (e) => toastDbError(e, { action: "Save rule" }),
  });

  const updateAction = (i: number, patch: Partial<RuleAction>) =>
    setActions((a) => a.map((x, idx) => (idx === i ? { ...x, ...patch } : x)));

  return (
    <Card className="border-[var(--brand-gold)]">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">{rule.id ? "Edit rule" : "New rule"}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-2 sm:grid-cols-2">
          <div>
            <Label className="text-xs">Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Rotting deal follow-up"
            />
          </div>
          <div>
            <Label className="text-xs">Trigger</Label>
            <Select value={trigger} onValueChange={(v) => setTrigger(v as TriggerType)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TRIGGERS.filter((t) => isJobTrigger(t) === jobRule).map((t) => (
                  <SelectItem key={t} value={t}>
                    {TRIGGER_LABEL[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground">{TRIGGER_HINT[trigger]}</p>

        <div className="flex flex-wrap items-end gap-2">
          {trigger !== "date_reached" ? (
            <div>
              <Label className="text-xs">
                {jobRule
                  ? "Days in the stage before it fires"
                  : trigger === "stage_rot"
                    ? "Fallback days (used when a stage has no window)"
                    : trigger === "no_activity"
                      ? "Days (0 = follow the Client health at-risk threshold)"
                      : "Days"}
              </Label>
              <Input
                className="w-[220px]"
                inputMode="numeric"
                value={days}
                onChange={(e) => setDays(e.target.value)}
              />
            </div>
          ) : (
            <div>
              <Label className="text-xs">Date field</Label>
              <Select value={dateField} onValueChange={setDateField}>
                <SelectTrigger className="w-[280px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DATE_FIELDS.map((f) => (
                    <SelectItem key={f.key} value={f.key}>
                      {f.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>

        {jobRule ? (
          <JobStagePicker
            locationId={rule.location_id ?? app.currentLocationId}
            value={stageIds}
            onChange={setStageIds}
          />
        ) : null}

        <div>
          <Label className="text-xs">Notes for the team</Label>
          <Textarea
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Why this rule exists — reps see this on the task."
          />
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-xs">Actions (internal only)</Label>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                setActions((a) => [
                  ...a,
                  jobRule
                    ? { kind: "send_email", assignee_mode: "office_manager" }
                    : { kind: "notify" },
                ])
              }
            >
              <Plus className="mr-1 size-3" /> Add action
            </Button>
          </div>
          {actions.map((a, i) => (
            <div key={i} className="flex flex-wrap items-end gap-2 rounded-md border p-2">
              <Select
                value={a.kind}
                onValueChange={(v) => updateAction(i, { kind: v as RuleAction["kind"] })}
              >
                <SelectTrigger className="w-[220px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(jobRule ? JOB_ACTIONS : ACTIONS.filter((k) => k !== "send_email")).map((k) => (
                    <SelectItem key={k} value={k}>
                      {ACTION_LABEL[k]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {(a.kind === "create_task" || a.kind === "assign_task") && (
                <>
                  <Input
                    className="w-[240px]"
                    placeholder="Task title"
                    value={a.title ?? ""}
                    onChange={(e) => updateAction(i, { title: e.target.value })}
                  />
                  {jobRule ? null : (
                    <Select
                      value={a.assignee_mode ?? "account_owner"}
                      onValueChange={(v) =>
                        updateAction(i, { assignee_mode: v as RuleAction["assignee_mode"] })
                      }
                    >
                      <SelectTrigger className="w-[170px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="account_owner">Assign to owner</SelectItem>
                        <SelectItem value="sales_head">Assign to Sales Head</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                  <Input
                    className="w-[110px]"
                    inputMode="numeric"
                    placeholder="Due in days"
                    value={a.due_in_days ?? 1}
                    onChange={(e) => updateAction(i, { due_in_days: Number(e.target.value) || 0 })}
                  />
                </>
              )}
              {jobRule &&
                (a.kind === "create_task" || a.kind === "send_email" || a.kind === "notify") && (
                  <JobRecipientPicker action={a} onChange={(patch) => updateAction(i, patch)} />
                )}
              {a.kind === "notify" && (
                <Input
                  className="flex-1"
                  placeholder="Message"
                  value={a.message ?? ""}
                  onChange={(e) => updateAction(i, { message: e.target.value })}
                />
              )}
              {a.kind === "apply_flag" && (
                <Input
                  className="w-[180px]"
                  placeholder="Priority flag: high or critical"
                  value={a.flag ?? ""}
                  onChange={(e) => updateAction(i, { flag: e.target.value })}
                />
              )}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setActions((x) => x.filter((_, idx) => idx !== i))}
              >
                <Trash2 className="size-3.5 text-destructive" />
              </Button>
            </div>
          ))}
        </div>

        <div className="flex justify-end gap-2">
          <Button size="sm" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={save.isPending || app.writesDisabled}
            onClick={() => save.mutate()}
          >
            Save rule
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function StageWindows() {
  const app = useAppContext();
  const qc = useQueryClient();
  const stagesQ = useQuery({
    queryKey: ["pipeline-stages-all"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("pipeline_stages")
        .select("id, name, pipeline_id, sort_order, pipelines(name)")
        .eq("is_active", true)
        .order("sort_order");
      if (error) throw error;
      return data ?? [];
    },
  });
  const windowsQ = useQuery({ queryKey: ["stage-windows"], queryFn: listStageWindows });
  const byStage = new Map((windowsQ.data ?? []).map((w) => [w.stage_id, w]));

  const save = useMutation({
    mutationFn: (input: {
      pipeline_id: string;
      stage_id: string;
      rot_days: number;
      escalate_days: number | null;
      id?: string;
    }) => saveStageWindow(input),
    onSuccess: () => {
      toast.success("Rot window saved");
      void qc.invalidateQueries({ queryKey: ["stage-windows"] });
    },
    onError: (e) => toastDbError(e, { action: "Save rot window" }),
  });

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Rot window per stage</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <p className="px-4 pb-2 text-[11px] text-muted-foreground">
          Active Outreach should rot far faster than Conversation Established — one global timer is
          useless. The escalate column is the second threshold, where the Sales Head gets pulled in.
        </p>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Stage</TableHead>
              <TableHead className="w-[140px]">Rot after (days)</TableHead>
              <TableHead className="w-[160px]">Escalate after (days)</TableHead>
              <TableHead className="w-[90px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {(stagesQ.data ?? []).map((s) => {
              const w = byStage.get(s.id);
              return (
                <StageWindowRow
                  key={s.id}
                  stage={
                    s as {
                      id: string;
                      name: string;
                      pipeline_id: string;
                      pipelines: { name: string } | null;
                    }
                  }
                  rotDays={w?.rot_days ?? 14}
                  escalateDays={w?.escalate_days ?? null}
                  disabled={app.writesDisabled || save.isPending}
                  onSave={(rot, esc) =>
                    save.mutate({
                      ...(w ? { id: w.id } : {}),
                      pipeline_id: s.pipeline_id,
                      stage_id: s.id,
                      rot_days: rot,
                      escalate_days: esc,
                    })
                  }
                />
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function StageWindowRow({
  stage,
  rotDays,
  escalateDays,
  disabled,
  onSave,
}: {
  stage: { id: string; name: string; pipeline_id: string; pipelines: { name: string } | null };
  rotDays: number;
  escalateDays: number | null;
  disabled: boolean;
  onSave: (rot: number, esc: number | null) => void;
}) {
  const [rot, setRot] = useState(String(rotDays));
  const [esc, setEsc] = useState(escalateDays == null ? "" : String(escalateDays));
  return (
    <TableRow>
      <TableCell className="text-xs">
        <span className="font-medium">{stage.name}</span>
        <span className="ml-1.5 text-muted-foreground">{stage.pipelines?.name}</span>
      </TableCell>
      <TableCell>
        <Input
          className="h-7"
          inputMode="numeric"
          value={rot}
          onChange={(e) => setRot(e.target.value)}
        />
      </TableCell>
      <TableCell>
        <Input
          className="h-7"
          inputMode="numeric"
          value={esc}
          onChange={(e) => setEsc(e.target.value)}
        />
      </TableCell>
      <TableCell>
        <Button
          size="sm"
          variant="outline"
          className="h-7"
          disabled={disabled}
          onClick={() => onSave(Number(rot) || 0, esc.trim() === "" ? null : Number(esc))}
        >
          Save
        </Button>
      </TableCell>
    </TableRow>
  );
}
