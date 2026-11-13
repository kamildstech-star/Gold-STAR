import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, History } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { useChaseSettings } from "@/lib/chase-settings";
import {
  fetchAttempts,
  attemptLine,
  needsManagerReview,
  suggestedRetry,
  type IncidentAttempt,
} from "@/lib/outcomes";

/**
 * What already failed here. A living lead carries its attempts so the next
 * chaser doesn't repeat the same knock at the same hour — top of the card,
 * never behind a tab.
 */
export function AttemptHistory({
  incidentId,
  attempts,
  className,
}: {
  incidentId: string;
  attempts?: IncidentAttempt[];
  className?: string;
}) {
  const { settings } = useChaseSettings();
  const q = useQuery({
    enabled: attempts === undefined,
    queryKey: ["chase", "attempts", incidentId],
    queryFn: () => fetchAttempts(incidentId),
  });
  const rows = attempts ?? q.data ?? [];

  const names = useQuery({
    enabled: rows.length > 0,
    queryKey: ["chase", "attempt-names", rows.map((r) => r.chaser_id).join(",")],
    queryFn: async () => {
      const ids = [...new Set(rows.map((r) => r.chaser_id).filter(Boolean))] as string[];
      if (ids.length === 0) return {} as Record<string, string>;
      const { data, error } = await supabase
        .from("profiles")
        .select("user_id,full_name")
        .in("user_id", ids);
      if (error) throw error;
      return Object.fromEntries(
        (data ?? []).map((p) => [p.user_id, p.full_name ?? "A chaser"]),
      ) as Record<string, string>;
    },
  });

  if (rows.length === 0) return null;

  const limit = Number(settings.max_attempts_before_review);
  const review = needsManagerReview(rows, limit);
  const retry = rows.map(suggestedRetry).find(Boolean) ?? null;

  return (
    <div
      className={`rounded-sm border border-amber-500/40 bg-amber-500/10 px-3 py-2 ${className ?? ""}`}
    >
      <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-amber-700 dark:text-amber-400">
        <History className="size-3.5" />
        {rows.length} attempt{rows.length === 1 ? "" : "s"} — handover notes
      </div>
      <ul className="mt-1 space-y-1">
        {rows.map((a) => (
          <li key={a.id} className="text-[13px] leading-snug">
            {attemptLine(a, a.chaser_id ? names.data?.[a.chaser_id] : null)}
            {a.note ? <span className="text-muted-foreground"> — {a.note}</span> : null}
          </li>
        ))}
      </ul>
      {retry && (
        <div className="mt-1.5 text-[12px] font-medium text-amber-800 dark:text-amber-300">
          Suggested: {retry}
        </div>
      )}
      {review && (
        <div className="mt-1.5 flex items-start gap-1.5 rounded-sm bg-amber-500/20 px-2 py-1.5 text-[12px] font-semibold text-amber-900 dark:text-amber-200">
          <AlertTriangle className="mt-[1px] size-3.5 shrink-0" />
          {rows.length} attempts with no contact — flagged for a manager decision.
        </div>
      )}
    </div>
  );
}

/** Compact chip for list rows: "2 attempts". */
export function AttemptCountChip({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-semibold text-amber-700 dark:text-amber-400">
      <History className="size-3" />
      {count} attempt{count === 1 ? "" : "s"}
    </span>
  );
}
