import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  fetchAssignmentRules,
  updateAssignmentRule,
  type AssignmentRule,
} from "@/lib/assignment-rules";

/**
 * How many chasers may work one fire, and how long they have to arrive before
 * it reopens for everyone else. Single family locks one chaser; bigger losses
 * take a crowd. The Sales Head owns these numbers, not a developer.
 */
export function AssignmentRulesCard() {
  const qc = useQueryClient();
  const rules = useQuery({
    queryKey: ["chase", "assignment-rules"],
    queryFn: fetchAssignmentRules,
  });

  const patch = async (rule: AssignmentRule, values: Partial<AssignmentRule>) => {
    try {
      await updateAssignmentRule(rule.id, values);
      void qc.invalidateQueries({ queryKey: ["chase", "assignment-rules"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save");
    }
  };

  return (
    <Card>
      <CardHeader className="py-3">
        <CardTitle className="text-sm">Chaser assignment rules</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 pb-3">
        <p className="text-[13px] text-muted-foreground">
          Per severity: how many chasers can respond, whether the claim also locks duplicate reports
          in the same zone, and how long a chaser has to log arrival before the fire reopens.
        </p>
        {(rules.data ?? []).map((r) => (
          <div key={r.id} className="rounded-sm border px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-[13px] font-semibold">{r.label}</div>
                {r.description && (
                  <div className="text-[12px] text-muted-foreground">{r.description}</div>
                )}
              </div>
              <Switch
                checked={r.is_active}
                onCheckedChange={(v) => void patch(r, { is_active: v })}
                aria-label="Active"
              />
            </div>
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
              <div className="space-y-1">
                <Label className="text-[11px] text-muted-foreground">Chasers allowed</Label>
                <Input
                  type="number"
                  min={1}
                  max={20}
                  className="h-9"
                  defaultValue={r.max_responders}
                  onBlur={(e) => {
                    const v = Number(e.target.value);
                    if (v >= 1 && v <= 20 && v !== r.max_responders)
                      void patch(r, { max_responders: v });
                  }}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-[11px] text-muted-foreground">
                  Arrival timeout (minutes)
                </Label>
                <Input
                  type="number"
                  min={5}
                  max={1440}
                  className="h-9"
                  defaultValue={r.arrival_timeout_minutes}
                  onBlur={(e) => {
                    const v = Number(e.target.value);
                    if (v >= 5 && v <= 1440 && v !== r.arrival_timeout_minutes)
                      void patch(r, { arrival_timeout_minutes: v });
                  }}
                />
              </div>
              <div className="flex items-center justify-between gap-2 sm:pt-5">
                <Label className="text-[12px]">Lock the zone</Label>
                <Switch
                  checked={r.zone_exclusive}
                  onCheckedChange={(v) => void patch(r, { zone_exclusive: v })}
                  aria-label="Zone exclusive"
                />
              </div>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
