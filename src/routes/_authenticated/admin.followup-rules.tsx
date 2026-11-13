import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  TOUCHPOINT_TYPES,
  deleteFollowupRule,
  describeRule,
  fetchFollowupRules,
  saveFollowupRule,
  type FollowupRule,
  type FollowupRuleInput,
  type TouchpointType,
} from "@/lib/followup-rules";

export const Route = createFileRoute("/_authenticated/admin/followup-rules")({
  head: () => ({
    meta: [
      { title: "Follow-up rules · Recovery Hub" },
      {
        name: "description",
        content:
          "Decide which internal follow-up task is created automatically when a rep logs a meeting, a call or sends an estimate.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: FollowupRulesAdmin,
});

const BLANK: FollowupRuleInput = {
  name: "",
  trigger_event: "touchpoint",
  touchpoint_type: "meeting_in_person",
  require_meeting_held: true,
  task_title: "Send recap",
  task_description: null,
  due_in_days: 1,
  priority: "normal",
  is_active: true,
  run_order: 10,
};

/**
 * Auto follow-up tasks. A meeting held becomes "send recap" tomorrow, an
 * estimate sent becomes "follow up" in three days — without the rep having to
 * remember, and without the manager having to ask.
 *
 * These rules create internal tasks only. They never send anything to a client.
 */
function FollowupRulesAdmin() {
  const qc = useQueryClient();
  const rules = useQuery({ queryKey: ["followup-rules"], queryFn: fetchFollowupRules });
  const [draft, setDraft] = useState<FollowupRuleInput | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: ["followup-rules"] });

  const save = async () => {
    if (!draft) return;
    if (!draft.name.trim() || !draft.task_title.trim()) {
      toast.error("Give the rule a name and a task title.");
      return;
    }
    try {
      await saveFollowupRule(draft);
      setDraft(null);
      refresh();
      toast.success("Rule saved");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the rule");
    }
  };

  const toggle = async (r: FollowupRule, active: boolean) => {
    try {
      await saveFollowupRule({ ...r, is_active: active });
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not update the rule");
    }
  };

  const remove = async (id: string) => {
    try {
      await deleteFollowupRule(id);
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not delete the rule");
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-3 p-3">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[13px] text-muted-foreground">
          Internal tasks only — nothing is ever sent to a client.
        </p>
        <Button size="sm" onClick={() => setDraft({ ...BLANK })}>
          <Plus className="mr-1 size-4" /> New rule
        </Button>
      </div>

      {draft && (
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="text-sm">{draft.id ? "Edit rule" : "New rule"}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 pb-3">
            <div className="grid gap-2 sm:grid-cols-2">
              <Input
                placeholder="Rule name"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
              <Select
                value={draft.trigger_event}
                onValueChange={(v) =>
                  setDraft({
                    ...draft,
                    trigger_event: v as FollowupRuleInput["trigger_event"],
                    touchpoint_type: v === "estimate_sent" ? null : draft.touchpoint_type,
                  })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="touchpoint">When a touchpoint is logged</SelectItem>
                  <SelectItem value="estimate_sent">When an estimate is sent</SelectItem>
                </SelectContent>
              </Select>

              {draft.trigger_event === "touchpoint" && (
                <Select
                  value={draft.touchpoint_type ?? "any"}
                  onValueChange={(v) =>
                    setDraft({
                      ...draft,
                      touchpoint_type: v === "any" ? null : (v as TouchpointType),
                    })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="any">Any touchpoint</SelectItem>
                    {TOUCHPOINT_TYPES.map((t) => (
                      <SelectItem key={t.value} value={t.value}>
                        {t.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}

              <Input
                placeholder="Task title"
                value={draft.task_title}
                onChange={(e) => setDraft({ ...draft, task_title: e.target.value })}
              />
              <Input
                type="number"
                min={0}
                placeholder="Due in days"
                value={draft.due_in_days}
                onChange={(e) => setDraft({ ...draft, due_in_days: Number(e.target.value) })}
              />
              <Select
                value={draft.priority}
                onValueChange={(v) =>
                  setDraft({ ...draft, priority: v as FollowupRuleInput["priority"] })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {["low", "normal", "high", "urgent"].map((p) => (
                    <SelectItem key={p} value={p}>
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <Textarea
              placeholder="Task description (optional)"
              value={draft.task_description ?? ""}
              onChange={(e) => setDraft({ ...draft, task_description: e.target.value || null })}
            />

            {draft.trigger_event === "touchpoint" && (
              <label className="flex items-center gap-2 text-[13px]">
                <Switch
                  checked={draft.require_meeting_held}
                  onCheckedChange={(v) => setDraft({ ...draft, require_meeting_held: v })}
                />
                Only when the meeting actually happened
              </label>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setDraft(null)}>
                Cancel
              </Button>
              <Button size="sm" onClick={() => void save()}>
                Save rule
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {rules.isLoading && <p className="text-[13px] text-muted-foreground">Loading…</p>}
      {!rules.isLoading && (rules.data ?? []).length === 0 && !draft && (
        <p className="text-[13px] text-muted-foreground">
          No rules yet. Add one and reps stop relying on memory.
        </p>
      )}

      {(rules.data ?? []).map((r) => (
        <Card key={r.id}>
          <CardContent className="flex items-center gap-2 p-3">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{r.name}</div>
              <div className="truncate text-[13px] text-muted-foreground">{describeRule(r)}</div>
            </div>
            <Switch
              checked={r.is_active}
              onCheckedChange={(v) => void toggle(r, v)}
              aria-label="Active"
            />
            <Button variant="ghost" size="sm" onClick={() => setDraft({ ...r })}>
              Edit
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              onClick={() => void remove(r.id)}
              aria-label="Delete rule"
            >
              <Trash2 className="size-4" />
            </Button>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
