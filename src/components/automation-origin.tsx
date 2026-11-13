import { useQuery } from "@tanstack/react-query";
import { Zap } from "lucide-react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { supabase } from "@/integrations/supabase/client";

/**
 * Provenance for an automated task. Tasks that appear from nowhere get
 * ignored, so a rep can tap this and see which rule created it and why.
 */
export function AutomationOrigin({
  ruleId,
  reason,
}: {
  ruleId: string | null;
  reason: string | null;
}) {
  const q = useQuery({
    queryKey: ["automation-rule-name", ruleId],
    enabled: !!ruleId,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data } = await supabase
        .from("automation_rules")
        .select("name, description")
        .eq("id", ruleId!)
        .maybeSingle();
      return data;
    },
  });

  if (!ruleId && !reason) return null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="mt-0.5 inline-flex items-center gap-1 rounded-md border border-[var(--brand-gold)]/50 px-1 py-px text-[10px] text-muted-foreground hover:bg-muted"
        >
          <Zap className="size-3 text-[var(--brand-gold)]" />
          Auto: {q.data?.name ?? "rule"}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 text-xs">
        <div className="font-medium">{q.data?.name ?? "Automation rule"}</div>
        {reason ? <p className="mt-1 text-muted-foreground">{reason}</p> : null}
        {q.data?.description ? (
          <p className="mt-1 text-muted-foreground">{q.data.description}</p>
        ) : null}
        <p className="mt-2 text-[10px] text-muted-foreground">
          Created by an internal automation. Nothing was sent to the client.
        </p>
      </PopoverContent>
    </Popover>
  );
}
