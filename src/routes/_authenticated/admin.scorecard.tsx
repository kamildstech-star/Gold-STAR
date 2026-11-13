import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Plus, RotateCcw, Trophy, X } from "lucide-react";
import { toast } from "sonner";

import { ActionPicker, UNIT_HINT } from "@/components/action-picker";
import type { ActionDef } from "@/lib/action-catalogue";
import { useAppContext } from "@/components/app-context";
import { toastDbError } from "@/lib/db-errors";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { fetchWeights, type RoleGroup, type Weight } from "@/lib/scorecard";
import {
  applySavePlan,
  clearOfficeMinActivity,
  draftFromAction,
  effectiveRows,
  fetchScorecardSettings,
  minActivityAt,
  officeOverrides,
  planSave,
  previewPoints,
  resetOfficeToCompany,
  rowProblems,
  saveMinActivity,
  weightTotal,
  type DraftRow,
  type Scope,
  type ScorecardSetting,
} from "@/lib/scorecard-admin";

export const Route = createFileRoute("/_authenticated/admin/scorecard")({
  head: () => ({
    meta: [
      { title: "Scorecard and points · Admin · Recovery Hub" },
      {
        name: "description",
        content:
          "Which actions earn leaderboard points, how much each is worth and what the target is — company-wide or per office.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: ScorecardAdmin,
});

const COMPANY = "__company__";
// Stable while the query is loading: `?? []` would be a new array every render,
// and GroupEditor re-seeds its draft whenever the stored rows change identity.
const NO_WEIGHTS: Weight[] = [];
const GROUPS: { id: RoleGroup; label: string; blurb: string }[] = [
  {
    id: "sales",
    label: "Sales",
    blurb: "Sales reps, cold callers, outside reps and the Sales Head — the leaderboard.",
  },
  {
    id: "chase",
    label: "Chase",
    blurb: "Fire chasers and field staff — their own performance screen, not the leaderboard.",
  },
];

/**
 * Mark: "this needs to have an admin menu to change and add, also the admin
 * menu needs to have the ability to add components and targets weights etc
 * for anything they want that needs to tie to an action, so have a list of
 * actions they can choose from, it should get every action available i the
 * crm with a serach function thats smart".
 *
 * Points = Σ weight × (actual ÷ target) × 25, over the rows on this screen.
 * Access is decided in src/lib/page-access.ts (owner, admin, Sales Head) and
 * again by the table's write policy; this component is the renderer.
 */
function ScorecardAdmin() {
  const app = useAppContext();
  const qc = useQueryClient();
  const [scopeKey, setScopeKey] = React.useState<string>(COMPANY);
  const scope: Scope = React.useMemo(
    () => ({ locationId: scopeKey === COMPANY ? null : scopeKey }),
    [scopeKey],
  );

  const weightsQ = useQuery({ queryKey: ["scorecard-weights-admin"], queryFn: fetchWeights });
  const settingsQ = useQuery({
    queryKey: ["scorecard-settings-admin"],
    queryFn: fetchScorecardSettings,
  });
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["scorecard-weights-admin"] });
    qc.invalidateQueries({ queryKey: ["scorecard-settings-admin"] });
    // The boards read the same rows under their own keys.
    qc.invalidateQueries({ queryKey: ["lb-weights"] });
    qc.invalidateQueries({ queryKey: ["lb-action-counts"] });
  };

  const officeName =
    scope.locationId == null
      ? "Company"
      : (app.visibleLocations.find((l) => l.id === scope.locationId)?.name ?? "This office");

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="rounded-[var(--radius-card)] border border-[var(--border)] bg-card p-4 shadow-[var(--shadow-card)]">
        <div className="flex flex-wrap items-start gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
            <Trophy className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-semibold">What earns points, and how many</div>
            <p className="mt-0.5 text-[12px] text-muted-foreground">
              Every row is an action the CRM records. A rep's points are the sum over rows of weight
              × (their actual ÷ the target) × 25, capped at three times the target per row. The
              Intelligence scorecard uses the same rows as a 0–100 score. Add any action from the
              catalog, set its weight and target, and the boards update on their next load.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Label htmlFor="scope" className="text-[12px] text-muted-foreground">
              Applies to
            </Label>
            <Select value={scopeKey} onValueChange={setScopeKey}>
              <SelectTrigger id="scope" className="h-8 w-[220px] text-xs">
                <SelectValue placeholder="Company" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={COMPANY} className="text-xs">
                  Company-wide default
                </SelectItem>
                {app.visibleLocations.map((l) => (
                  <SelectItem key={l.id} value={l.id} className="text-xs">
                    {l.code} — {l.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      <Tabs defaultValue="sales">
        <TabsList>
          {GROUPS.map((g) => (
            <TabsTrigger key={g.id} value={g.id}>
              {g.label}
            </TabsTrigger>
          ))}
        </TabsList>
        {GROUPS.map((g) => (
          <TabsContent key={g.id} value={g.id} className="mt-3">
            <GroupEditor
              group={g.id}
              blurb={g.blurb}
              scope={scope}
              officeName={officeName}
              all={weightsQ.data ?? NO_WEIGHTS}
              loading={weightsQ.isLoading}
              disabled={app.writesDisabled}
              onSaved={invalidate}
            />
          </TabsContent>
        ))}
      </Tabs>

      <MinActivityCard
        scope={scope}
        officeName={officeName}
        rows={settingsQ.data ?? []}
        loading={settingsQ.isLoading}
        disabled={app.writesDisabled}
        onSaved={invalidate}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* One role group                                                      */
/* ------------------------------------------------------------------ */

function GroupEditor({
  group,
  blurb,
  scope,
  officeName,
  all,
  loading,
  disabled,
  onSaved,
}: {
  group: RoleGroup;
  blurb: string;
  scope: Scope;
  officeName: string;
  all: Weight[];
  loading: boolean;
  disabled: boolean;
  onSaved: () => void;
}) {
  const stored = React.useMemo(() => effectiveRows(all, group, scope), [all, group, scope]);
  const [rows, setRows] = React.useState<DraftRow[]>(stored);
  const [dirty, setDirty] = React.useState(false);
  const [picking, setPicking] = React.useState(false);

  // A fresh load or a scope change replaces the draft; an unsaved edit does not.
  React.useEffect(() => {
    setRows(stored);
    setDirty(false);
  }, [stored]);

  const isOffice = scope.locationId != null;
  const overrides = isOffice && officeOverrides(all, group, scope.locationId!);
  const total = weightTotal(rows);
  const points = previewPoints(rows);
  const problems = rowProblems(rows);
  const plan = React.useMemo(() => planSave(rows, all, group, scope), [rows, all, group, scope]);
  const nothingToWrite =
    plan.inserts.length === 0 && plan.updates.length === 0 && plan.deleteIds.length === 0;

  const update = (component: string, patch: Partial<DraftRow>) => {
    setRows((rs) => rs.map((r) => (r.component === component ? { ...r, ...patch } : r)));
    setDirty(true);
  };
  const remove = (component: string) => {
    setRows((rs) => rs.filter((r) => r.component !== component));
    setDirty(true);
  };
  const add = (action: ActionDef) => {
    setRows((rs) => [...rs, draftFromAction(action, scope)]);
    setDirty(true);
    setPicking(false);
  };

  const save = useMutation({
    mutationFn: () => applySavePlan(plan),
    onSuccess: () => {
      onSaved();
      setDirty(false);
      toast.success(`${group === "sales" ? "Sales" : "Chase"} scorecard saved`, {
        description: `${officeName}: ${rows.filter((r) => r.enabled).length} components, ${total} weight, ${points.toLocaleString("en-US")} points for a perfect period.`,
      });
    },
    onError: (e) => toastDbError(e, { action: "save the scorecard weights" }),
  });
  const reset = useMutation({
    mutationFn: () => resetOfficeToCompany(group, scope.locationId!),
    onSuccess: () => {
      onSaved();
      toast.success(`${officeName} now follows the company ${group} scorecard`);
    },
    onError: (e) => toastDbError(e, { action: "reset this office to the company scorecard" }),
  });

  const busy = loading || save.isPending || reset.isPending || disabled;
  const taken = new Set(rows.map((r) => r.component));

  return (
    <div className="rounded-[var(--radius-card)] border border-[var(--border)] bg-card shadow-[var(--shadow-card)]">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] px-4 py-3">
        <div className="min-w-0">
          <p className="text-[12px] text-muted-foreground">{blurb}</p>
          {isOffice ? (
            <p className="mt-1 text-[12px]" data-testid="scope-note">
              {overrides ? (
                <>
                  <Badge variant="secondary" className="mr-1.5 align-middle">
                    This office overrides
                  </Badge>
                  Rows marked <em>Office</em> are {officeName}'s own; the rest still follow the
                  company. To switch a company row off here, set its weight to 0.
                </>
              ) : (
                <>
                  <Badge variant="outline" className="mr-1.5 align-middle">
                    Using company defaults
                  </Badge>
                  Edit any row to give {officeName} its own rule for that action; untouched rows
                  keep following the company.
                </>
              )}
            </p>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {isOffice && overrides ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => reset.mutate()}
              title="Delete this office's rows for this group; it follows the company again"
            >
              <RotateCcw className="mr-1 size-3.5" /> Reset to company
            </Button>
          ) : null}
          <Button variant="outline" size="sm" disabled={busy} onClick={() => setPicking(true)}>
            <Plus className="mr-1 size-3.5" /> Add component
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="p-4 text-[12.5px] text-muted-foreground">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="p-6 text-center text-[12.5px] text-muted-foreground">
          No components yet. Add one from the catalog.
        </div>
      ) : (
        <div className="divide-y divide-[var(--border)]">
          <div className="md:sticky md:top-[var(--table-sticky-top,0px)] md:z-10 bg-card hidden grid-cols-[1fr_96px_120px_120px_72px_32px] gap-2 px-4 py-1.5 text-[11px] uppercase tracking-wide text-muted-foreground sm:grid">
            <span>Action</span>
            <span>Weight</span>
            <span>Target</span>
            <span>Direction</span>
            <span>On</span>
            <span />
          </div>
          {rows.map((r) => (
            <ComponentRow
              key={r.component}
              row={r}
              isOffice={isOffice}
              disabled={busy}
              onChange={(patch) => update(r.component, patch)}
              onRemove={() => remove(r.component)}
            />
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border)] px-4 py-3">
        <div className="space-y-1 text-[12.5px]">
          <div>
            <span className="text-muted-foreground">Weights total </span>
            <span className="font-semibold tabular-nums" data-testid="weight-total">
              {total}
            </span>
            {total !== 100 && rows.length > 0 ? (
              <span className="ml-2 inline-flex items-center gap-1 text-warning">
                <AlertTriangle className="size-3.5" /> The seeds sum to 100. The math scales either
                way — this only changes what a perfect period is worth.
              </span>
            ) : null}
          </div>
          <div>
            <span className="text-muted-foreground">
              A rep who exactly hits every target scores{" "}
            </span>
            <span className="font-semibold tabular-nums" data-testid="points-preview">
              {points.toLocaleString("en-US")} points
            </span>
            <span className="text-muted-foreground"> (100 on the Intelligence scorecard).</span>
          </div>
          {problems.length > 0 ? (
            <div className="text-destructive">
              {problems[0].message} {problems.length > 1 ? `(+${problems.length - 1} more)` : null}
            </div>
          ) : null}
        </div>
        <Button
          size="sm"
          disabled={busy || !dirty || problems.length > 0 || nothingToWrite}
          onClick={() => save.mutate()}
        >
          {save.isPending ? "Saving…" : `Save ${group === "sales" ? "Sales" : "Chase"}`}
        </Button>
      </div>

      <ActionPicker
        open={picking}
        group={group}
        taken={taken}
        onClose={() => setPicking(false)}
        onPick={add}
      />
    </div>
  );
}

function ComponentRow({
  row,
  isOffice,
  disabled,
  onChange,
  onRemove,
}: {
  row: DraftRow;
  isOffice: boolean;
  disabled: boolean;
  onChange: (patch: Partial<DraftRow>) => void;
  onRemove: () => void;
}) {
  const a = row.action;
  const inherited = isOffice && row.source === "company";
  const canRemove = !inherited;
  return (
    <div className="grid grid-cols-1 gap-2 px-4 py-3 sm:grid-cols-[1fr_96px_120px_120px_72px_32px] sm:items-center">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[13px] font-semibold">{a?.label ?? row.component}</span>
          {isOffice ? (
            <Badge
              variant={row.source === "office" ? "secondary" : "outline"}
              className="text-[10px]"
            >
              {row.source === "office" ? "Office" : "Company"}
            </Badge>
          ) : null}
          {!a ? (
            <Badge variant="destructive" className="text-[10px]">
              Not in the catalog — scores nothing
            </Badge>
          ) : null}
        </div>
        <p className="text-[11.5px] text-muted-foreground">
          {a?.description ?? `Stored as "${row.component}".`}
        </p>
      </div>
      <div>
        {/* Plain Input on purpose: the shared formatted-number component is landing separately. */}
        <Input
          type="number"
          inputMode="decimal"
          min={0}
          aria-label={`${a?.label ?? row.component} weight`}
          className="h-9 tabular-nums"
          value={Number.isFinite(row.weight) ? row.weight : ""}
          disabled={disabled}
          onChange={(e) => onChange({ weight: Number(e.target.value) })}
        />
      </div>
      <div>
        <Input
          type="number"
          inputMode="decimal"
          min={0}
          step={a?.unit === "percent" ? 0.05 : 1}
          aria-label={`${a?.label ?? row.component} target`}
          className={`h-9 tabular-nums ${row.target == null ? "border-destructive" : ""}`}
          placeholder="Required"
          value={row.target ?? ""}
          disabled={disabled}
          onChange={(e) =>
            onChange({ target: e.target.value === "" ? null : Number(e.target.value) })
          }
        />
        <div className="mt-0.5 text-[10.5px] text-muted-foreground">
          {a ? UNIT_HINT[a.unit] : ""}
        </div>
      </div>
      <div>
        <Select
          value={row.direction}
          onValueChange={(v) => onChange({ direction: v as "higher" | "lower" })}
          disabled={disabled}
        >
          <SelectTrigger className="h-9 text-xs" aria-label="Direction">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="higher" className="text-xs">
              Higher is better
            </SelectItem>
            <SelectItem value="lower" className="text-xs">
              Lower is better
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="flex items-center">
        {inherited ? (
          <span
            className="text-[11px] text-muted-foreground"
            title="Company rows cannot be switched off per office; set the weight to 0 instead."
          >
            Company
          </span>
        ) : (
          <Switch
            checked={row.enabled}
            disabled={disabled}
            aria-label={`${a?.label ?? row.component} enabled`}
            onCheckedChange={(v) => onChange({ enabled: v })}
          />
        )}
      </div>
      <div className="flex justify-end">
        {canRemove ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            disabled={disabled}
            aria-label={isOffice ? "Back to the company rule" : "Remove component"}
            title={isOffice ? "Back to the company rule" : "Remove component"}
            onClick={onRemove}
          >
            <X className="size-3.5" />
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Minimum activity                                                    */
/* ------------------------------------------------------------------ */

/**
 * `scorecard_settings.min_activity_events` — below this many logged events
 * in the period the Intelligence scorecard refuses to score a person at all
 * ("Insufficient activity") rather than call a quiet fortnight a bad one.
 * Same family as the weights, and equally unreachable until now.
 */
function MinActivityCard({
  scope,
  officeName,
  rows,
  loading,
  disabled,
  onSaved,
}: {
  scope: Scope;
  officeName: string;
  rows: ScorecardSetting[];
  loading: boolean;
  disabled: boolean;
  onSaved: () => void;
}) {
  const { value, own, company } = minActivityAt(rows, scope);
  const [draft, setDraft] = React.useState(String(value));
  React.useEffect(() => setDraft(String(value)), [value, scope.locationId]);
  const n = Math.max(0, Math.round(Number(draft) || 0));
  const dirty = n !== value;
  const isOffice = scope.locationId != null;

  const save = useMutation({
    mutationFn: () => saveMinActivity(scope, n, own?.id ?? null),
    onSuccess: () => {
      onSaved();
      toast.success("Minimum activity saved", {
        description: `${officeName}: fewer than ${n} logged events in a period means “insufficient activity”.`,
      });
    },
    onError: (e) => toastDbError(e, { action: "save the minimum activity" }),
  });
  const clear = useMutation({
    mutationFn: () => clearOfficeMinActivity(own!.id),
    onSuccess: () => {
      onSaved();
      toast.success(`${officeName} follows the company minimum again`);
    },
    onError: (e) => toastDbError(e, { action: "reset the minimum activity" }),
  });
  const busy = loading || save.isPending || clear.isPending || disabled;

  return (
    <div className="rounded-[var(--radius-card)] border border-[var(--border)] bg-card p-4 shadow-[var(--shadow-card)]">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold">Minimum activity to be scored</div>
          <p className="mt-0.5 text-[12px] text-muted-foreground">
            On the Intelligence scorecard a person with fewer logged events than this in the period
            is shown as “Insufficient activity” instead of a score. Events are touchpoints, contact
            attempts, stage moves, jobs opened and chases accepted.
            {isOffice ? (
              <>
                {" "}
                {own ? (
                  <Badge variant="secondary" className="align-middle">
                    This office overrides
                  </Badge>
                ) : (
                  <Badge variant="outline" className="align-middle">
                    Using company default{company ? ` (${company.min_activity_events})` : ""}
                  </Badge>
                )}
              </>
            ) : null}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Input
            type="number"
            inputMode="numeric"
            min={0}
            aria-label="Minimum activity events"
            className="h-9 w-24 tabular-nums"
            value={draft}
            disabled={busy}
            onChange={(e) => setDraft(e.target.value)}
          />
          <span className="text-[12px] text-muted-foreground">events</span>
          {isOffice && own ? (
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => clear.mutate()}>
              Reset to company
            </Button>
          ) : null}
          <Button size="sm" disabled={busy || !dirty} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
}
