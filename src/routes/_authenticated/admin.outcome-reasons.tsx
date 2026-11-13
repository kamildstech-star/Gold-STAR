import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { fetchReasonTree } from "@/lib/outcomes";
import { ChaseSettingsCard } from "@/components/admin/chase-settings-card";
import { AssignmentRulesCard } from "@/components/admin/assignment-rules-card";

export const Route = createFileRoute("/_authenticated/admin/outcome-reasons")({
  head: () => ({
    meta: [
      { title: "Outcome reasons · Recovery Hub" },
      {
        name: "description",
        content:
          "Edit the chase outcome reason trees — competitors, TPAs and objections — without a deploy.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: OutcomeReasonsAdmin,
});

/**
 * Competitor and TPA lists change constantly. They live in the database so a
 * Sales Head can edit them here; the survival rule per reason stays fixed.
 */
function OutcomeReasonsAdmin() {
  const qc = useQueryClient();
  const tree = useQuery({ queryKey: ["chase", "reason-tree", "admin"], queryFn: fetchReasonTree });
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["chase", "reason-tree"] });
    qc.invalidateQueries({ queryKey: ["chase", "reason-tree", "admin"] });
  };

  const addChild = async (parentId: string) => {
    const label = (drafts[parentId] ?? "").trim();
    if (!label) return;
    const { error } = await supabase.from("incident_outcome_reasons").insert({
      parent_id: parentId,
      key: label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_|_$/g, ""),
      label,
      sort_order: 99,
    });
    if (error) {
      toast.error(error.message);
      return;
    }
    setDrafts((d) => ({ ...d, [parentId]: "" }));
    refresh();
  };

  const toggle = async (id: string, active: boolean) => {
    const { error } = await supabase
      .from("incident_outcome_reasons")
      .update({ is_active: active })
      .eq("id", id);
    if (error) toast.error(error.message);
    else refresh();
  };

  const remove = async (id: string) => {
    const { error } = await supabase.from("incident_outcome_reasons").delete().eq("id", id);
    if (error) toast.error(error.message);
    else refresh();
  };

  return (
    <div className="mx-auto max-w-3xl space-y-3 p-3">
      <p className="text-[13px] text-muted-foreground">
        Whether the lead survives is fixed per top-level reason — the options underneath are yours
        to edit.
      </p>

      <ChaseSettingsCard />

      <AssignmentRulesCard />

      {(tree.data ?? []).map((r) => (
        <Card key={r.id}>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 py-3">
            <CardTitle className="text-sm">{r.label}</CardTitle>
            <Badge variant={r.wins_lead ? "default" : r.kills_lead ? "secondary" : "outline"}>
              {r.wins_lead ? "Won" : r.kills_lead ? "Kills lead" : "Stays live"}
            </Badge>
          </CardHeader>
          <CardContent className="space-y-2 pb-3">
            {r.option_list_key && (
              <p className="text-[13px] text-muted-foreground">
                Sub-options come from the managed{" "}
                <span className="font-medium text-foreground">{r.option_list_key}</span> list — edit
                them in Admin → Dropdown options.
              </p>
            )}
            {!r.option_list_key && r.children.length === 0 && (
              <p className="text-[13px] text-muted-foreground">No sub-options.</p>
            )}
            {r.children.map((c) => (
              <div key={c.id} className="flex items-center gap-2 rounded-sm border px-2 py-1.5">
                <span className="flex-1 text-[13px]">{c.label}</span>
                <Switch
                  checked={c.is_active}
                  onCheckedChange={(v) => void toggle(c.id, v)}
                  aria-label="Active"
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  onClick={() => void remove(c.id)}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            ))}
            <div className="flex gap-2 pt-1">
              <Input
                value={drafts[r.id] ?? ""}
                onChange={(e) => setDrafts((d) => ({ ...d, [r.id]: e.target.value }))}
                placeholder="Add an option"
                className="h-9"
              />
              <Button variant="outline" className="h-9" onClick={() => void addChild(r.id)}>
                <Plus className="mr-1 size-4" /> Add
              </Button>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
