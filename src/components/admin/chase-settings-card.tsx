import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { supabase } from "@/integrations/supabase/client";
import {
  CHASE_SETTING_LABEL,
  saveChaseSettings,
  useChaseSettings,
  type ChaseSettings,
} from "@/lib/chase-settings";

/**
 * Every number the chase module runs on, in one place. The database reads the
 * same record, so changing a value here changes escalation, locks, dedupe and
 * search without a deploy.
 */
export function ChaseSettingsCard() {
  const qc = useQueryClient();
  const { settings } = useChaseSettings();
  const [draft, setDraft] = useState<ChaseSettings>(settings);
  const [busy, setBusy] = useState(false);

  useEffect(() => setDraft(settings), [settings]);

  const save = async () => {
    setBusy(true);
    try {
      const { data } = await supabase.auth.getUser();
      await saveChaseSettings(draft, data.user?.id ?? null);
      qc.invalidateQueries({ queryKey: ["chase"] });
      toast.success("Chase settings saved");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save settings");
    } finally {
      setBusy(false);
    }
  };

  const keys = Object.keys(CHASE_SETTING_LABEL) as (keyof ChaseSettings)[];

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 py-3">
        <CardTitle className="text-sm">Chase settings</CardTitle>
        <Button size="sm" className="h-8" disabled={busy} onClick={() => void save()}>
          Save
        </Button>
      </CardHeader>
      <CardContent className="grid gap-3 pb-3 sm:grid-cols-2">
        {keys.map((k) => {
          const isText = typeof CHASE_SETTING_LABEL[k] === "string" && typeof draft[k] === "string";
          return (
            <div key={k} className="space-y-1">
              <Label htmlFor={`chase-${k}`} className="text-[12px] text-muted-foreground">
                {CHASE_SETTING_LABEL[k]}
              </Label>
              <Input
                id={`chase-${k}`}
                className="h-9"
                type={isText ? "text" : "number"}
                value={String(draft[k] ?? "")}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    [k]: isText ? e.target.value : Number(e.target.value),
                  }))
                }
              />
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
