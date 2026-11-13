/**
 * Admin → Email templates: how long a person's email waits before it sends.
 *
 * David, 24 Sep: "Sending in 4:32 — Edit · Cancel." The window is one number
 * for the company (app_settings 'email_send'.delay_minutes, default 5); 0
 * turns the hold off and sends straight away. Only privileged users can write
 * app_settings (RLS app_settings_write), which is exactly who reaches this page.
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Clock } from "lucide-react";

import { useAppContext } from "@/components/app-context";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { toastDbError } from "@/lib/db-errors";
import { EMAIL_SEND_SETTINGS_KEY, MAX_SEND_DELAY_MINUTES, parseSendDelay } from "@/lib/email-hold";

export function EmailSendDelayCard() {
  const app = useAppContext();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["app-settings", EMAIL_SEND_SETTINGS_KEY],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("app_settings")
        .select("value")
        .eq("key", EMAIL_SEND_SETTINGS_KEY)
        .maybeSingle();
      if (error) throw error;
      return (data?.value ?? null) as Record<string, unknown> | null;
    },
  });
  const stored = parseSendDelay(q.data);
  const [draft, setDraft] = useState(String(stored));
  useEffect(() => setDraft(String(stored)), [stored]);
  const next = parseSendDelay(draft);

  const save = useMutation({
    mutationFn: async () => {
      // Merge, not replace: the row may carry release_hook_url as well.
      const value = { ...(q.data ?? {}), delay_minutes: next };
      const { error } = await supabase
        .from("app_settings")
        .upsert({ key: EMAIL_SEND_SETTINGS_KEY, value } as never, { onConflict: "key" });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success(
        next === 0
          ? "Emails now send straight away."
          : `Emails now wait ${next} minute${next === 1 ? "" : "s"} before sending.`,
      );
      void qc.invalidateQueries({ queryKey: ["app-settings", EMAIL_SEND_SETTINGS_KEY] });
    },
    onError: (e) => toastDbError(e, { action: "Save send delay" }),
  });

  return (
    <Card data-email-send-delay>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-1.5 text-sm">
          <Clock className="size-4" /> Undo window
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <p className="text-xs text-muted-foreground">
          Every email someone sends waits this long first. Until then the sender sees “Sending in
          4:32 — Edit · Cancel” and can fix the recipients, wording or files, or stop it. Automatic
          reminders to staff are not held.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <Label className="text-xs" htmlFor="email-send-delay">
              Minutes (0 sends straight away)
            </Label>
            <Input
              id="email-send-delay"
              type="number"
              inputMode="numeric"
              min={0}
              max={MAX_SEND_DELAY_MINUTES}
              className="h-9 w-28"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
          </div>
          <Button
            size="sm"
            disabled={app.writesDisabled || save.isPending || q.isLoading || next === stored}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
