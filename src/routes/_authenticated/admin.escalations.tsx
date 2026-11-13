/**
 * Escalation rules, per location — each office runs differently, so the
 * thresholds and the person who gets told are set per location, never globally.
 * The target is always an explicit choice; nothing is inferred.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { useAppContext } from "@/components/app-context";
import { HiddenSectionsBar } from "@/lib/hidden-sections";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { supabase } from "@/integrations/supabase/client";
import { personLabel } from "@/lib/chat";
import {
  RECORD_TYPES,
  RECORD_TYPE_LABEL,
  TARGET_KINDS,
  TARGET_KIND_LABEL,
  WATCHABLE_STATUSES,
  defaultRulesFor,
  deleteRule,
  listRules,
  saveRule,
  type EscalationRecordType,
  type EscalationTargetKind,
  type RuleDraft,
} from "@/lib/escalations";

export const Route = createFileRoute("/_authenticated/admin/escalations")({
  head: () => ({
    meta: [
      { title: "Escalation rules — Gold Star Recovery Hub" },
      {
        name: "description",
        content:
          "Per-location rules that escalate estimates, invoices, jobs, accounts and leads to a named person when nothing has moved on them.",
      },
      { property: "og:title", content: "Escalation rules — Gold Star Recovery Hub" },
      {
        property: "og:description",
        content: "Set how many days of silence counts as stalled, and who hears about it.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: EscalationsAdmin,
});

const emptyDraft = (locationId: string): RuleDraft => ({
  location_id: locationId,
  name: "",
  record_type: "invoice",
  statuses: [],
  stale_days: 14,
  target_kind: "record_owner",
  target_user_id: null,
  step2_days: 21,
  step2_target_kind: "location_manager",
  step2_target_user_id: null,
  step3_days: null,
  step3_target_kind: null,
  step3_target_user_id: null,
  active: true,
});

function EscalationsAdmin() {
  const app = useAppContext();
  const qc = useQueryClient();
  const [locationId, setLocationId] = useState<string>(
    app.currentLocationId ?? app.visibleLocations[0]?.id ?? "",
  );
  const [draft, setDraft] = useState<RuleDraft | null>(null);

  const rules = useQuery({
    queryKey: ["escalation-rules", locationId],
    queryFn: () => listRules(locationId ? [locationId] : null),
    enabled: !!locationId,
  });

  const people = useQuery({
    queryKey: ["escalation-people"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("user_id, full_name")
        .order("full_name");
      if (error) throw error;
      return data ?? [];
    },
  });

  const save = useMutation({
    mutationFn: (d: RuleDraft) => saveRule(d, app.userId!),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["escalation-rules"] });
      setDraft(null);
      toast.success("Rule saved");
    },
    onError: (e: Error) => toast.error("Could not save the rule", { description: e.message }),
  });

  const remove = useMutation({
    mutationFn: deleteRule,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["escalation-rules"] }),
    onError: (e: Error) => toast.error("Could not delete", { description: e.message }),
  });

  const seed = useMutation({
    mutationFn: async () => {
      for (const d of defaultRulesFor(locationId)) await saveRule(d, app.userId!);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["escalation-rules"] });
      toast.success("Starter rules added");
    },
    onError: (e: Error) => toast.error("Could not add rules", { description: e.message }),
  });

  const personName = (id: string | null) => {
    if (!id) return null;
    const p = people.data?.find((x) => x.user_id === id);
    return p ? personLabel(p) : "Removed user";
  };

  const list = rules.data ?? [];

  return (
    <div className="space-y-3">
      {/* The title is the Settings header's; this row keeps the count and the controls. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13px] text-muted-foreground">
          {list.length} {list.length === 1 ? "rule" : "rules"}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={locationId} onValueChange={setLocationId}>
            <SelectTrigger className="h-8 w-[220px] text-xs">
              <SelectValue placeholder="Location" />
            </SelectTrigger>
            <SelectContent>
              {app.visibleLocations.map((l) => (
                <SelectItem key={l.id} value={l.id} className="text-xs">
                  {l.code} — {l.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            className="h-8"
            disabled={!locationId || app.writesDisabled}
            onClick={() => setDraft(emptyDraft(locationId))}
          >
            <Plus className="mr-1 size-3.5" /> New rule
          </Button>
        </div>
        <HiddenSectionsBar className="w-full" />
      </div>

      <p className="text-sm text-muted-foreground">
        A record is stalled when nothing has moved on it — no status change, no payment received, no
        touchpoint logged, no email sent — for the number of days set below. A due date passing on
        its own is not a trigger.
      </p>

      {list.length === 0 && !rules.isLoading && (
        <Card>
          <CardContent className="space-y-3 py-6 text-center">
            <p className="text-sm text-muted-foreground">
              No rules for this location yet, so nothing escalates here.
            </p>
            <Button
              size="sm"
              variant="outline"
              disabled={!locationId || seed.isPending || app.writesDisabled}
              onClick={() => seed.mutate()}
            >
              Add starter rules (invoice, estimate, job)
            </Button>
          </CardContent>
        </Card>
      )}

      {list.map((r) => (
        <Card key={r.id}>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 py-3">
            <CardTitle className="text-sm">
              {r.name}{" "}
              <span className="text-xs font-normal text-muted-foreground">
                · {RECORD_TYPE_LABEL[r.record_type]}
                {r.active ? "" : " · paused"}
              </span>
            </CardTitle>
            <div className="flex gap-1">
              <Button
                size="sm"
                variant="ghost"
                className="h-7"
                disabled={app.writesDisabled}
                onClick={() => setDraft({ ...(r as unknown as RuleDraft), id: r.id })}
              >
                Edit
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="size-7"
                disabled={app.writesDisabled}
                onClick={() => remove.mutate(r.id)}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-1 py-0 pb-3 text-xs text-muted-foreground">
            <div>
              Watching {r.statuses && r.statuses.length > 0 ? r.statuses.join(", ") : "any status"}{" "}
              · stalled after {r.stale_days} days
            </div>
            <div>
              Step 1 → {TARGET_KIND_LABEL[r.target_kind]}
              {r.target_user_id ? ` (${personName(r.target_user_id)})` : ""}
            </div>
            {r.step2_days && (
              <div>
                Step 2 at {r.step2_days} days →{" "}
                {r.step2_target_kind ? TARGET_KIND_LABEL[r.step2_target_kind] : "—"}
                {r.step2_target_user_id ? ` (${personName(r.step2_target_user_id)})` : ""}
              </div>
            )}
            {r.step3_days && (
              <div>
                Step 3 at {r.step3_days} days →{" "}
                {r.step3_target_kind ? TARGET_KIND_LABEL[r.step3_target_kind] : "—"}
                {r.step3_target_user_id ? ` (${personName(r.step3_target_user_id)})` : ""}
              </div>
            )}
          </CardContent>
        </Card>
      ))}

      {draft && (
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="text-sm">{draft.id ? "Edit rule" : "New rule"}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label className="text-xs">Name</Label>
                <Input
                  className="h-8"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder="Invoice gone quiet"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Record type</Label>
                <Select
                  value={draft.record_type}
                  onValueChange={(v) =>
                    setDraft({ ...draft, record_type: v as EscalationRecordType, statuses: [] })
                  }
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {RECORD_TYPES.map((t) => (
                      <SelectItem key={t} value={t} className="text-xs">
                        {RECORD_TYPE_LABEL[t]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-1">
              <Label className="text-xs">Statuses to watch (none selected means any status)</Label>
              <div className="flex flex-wrap gap-1">
                {WATCHABLE_STATUSES[draft.record_type].map((s) => {
                  const on = draft.statuses.includes(s);
                  return (
                    <button
                      key={s}
                      type="button"
                      onClick={() =>
                        setDraft({
                          ...draft,
                          statuses: on
                            ? draft.statuses.filter((x) => x !== s)
                            : [...draft.statuses, s],
                        })
                      }
                      className={`rounded border px-2 py-0.5 text-xs ${
                        on ? "border-primary bg-primary/5" : "border-border"
                      }`}
                    >
                      {s.replace(/_/g, " ")}
                    </button>
                  );
                })}
              </div>
            </div>

            {([1, 2, 3] as const).map((step) => {
              const daysKey = step === 1 ? "stale_days" : step === 2 ? "step2_days" : "step3_days";
              const kindKey =
                step === 1 ? "target_kind" : step === 2 ? "step2_target_kind" : "step3_target_kind";
              const userKey =
                step === 1
                  ? "target_user_id"
                  : step === 2
                    ? "step2_target_user_id"
                    : "step3_target_user_id";
              const dayVal = draft[daysKey as keyof RuleDraft] as number | null;
              const kindVal = draft[kindKey as keyof RuleDraft] as EscalationTargetKind | null;
              const userVal = draft[userKey as keyof RuleDraft] as string | null;
              return (
                <div key={step} className="grid gap-3 rounded border p-2 sm:grid-cols-3">
                  <div className="space-y-1">
                    <Label className="text-xs">
                      Step {step} — days without movement{step > 1 ? " (blank = off)" : ""}
                    </Label>
                    <Input
                      className="h-8"
                      type="number"
                      min={1}
                      value={dayVal ?? ""}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          [daysKey]: e.target.value === "" ? null : Number(e.target.value),
                        } as RuleDraft)
                      }
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Tell</Label>
                    <Select
                      value={kindVal ?? "none"}
                      onValueChange={(v) =>
                        setDraft({
                          ...draft,
                          [kindKey]: v === "none" ? null : (v as EscalationTargetKind),
                        } as RuleDraft)
                      }
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {step > 1 && (
                          <SelectItem value="none" className="text-xs">
                            Nobody
                          </SelectItem>
                        )}
                        {TARGET_KINDS.map((k) => (
                          <SelectItem key={k} value={k} className="text-xs">
                            {TARGET_KIND_LABEL[k]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Named person</Label>
                    <Select
                      value={userVal ?? "none"}
                      disabled={kindVal !== "named_user"}
                      onValueChange={(v) =>
                        setDraft({ ...draft, [userKey]: v === "none" ? null : v } as RuleDraft)
                      }
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue placeholder="Choose" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none" className="text-xs">
                          —
                        </SelectItem>
                        {(people.data ?? []).map((p) => (
                          <SelectItem key={p.user_id} value={p.user_id} className="text-xs">
                            {p.full_name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              );
            })}

            <div className="flex items-center gap-2">
              <Switch
                checked={draft.active}
                onCheckedChange={(v) => setDraft({ ...draft, active: v })}
              />
              <span className="text-xs">Active</span>
            </div>

            <div className="flex gap-2">
              <Button
                size="sm"
                className="h-8"
                disabled={!draft.name.trim() || save.isPending || app.writesDisabled}
                onClick={() => {
                  if (draft.target_kind === "named_user" && !draft.target_user_id) {
                    toast.error("Choose the person for step 1.");
                    return;
                  }
                  save.mutate(draft);
                }}
              >
                Save rule
              </Button>
              <Button size="sm" variant="ghost" className="h-8" onClick={() => setDraft(null)}>
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
