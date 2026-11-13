import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { HeartPulse, PauseCircle } from "lucide-react";

import { cn } from "@/lib/utils";
import { fetchStages } from "@/lib/pipeline";
import { FARMING_PIPELINE_ID } from "@/lib/sales-pipeline";
import {
  HEALTH_META,
  computeClientHealth,
  useClientHealthSettings,
  type ClientHealthVerdict,
} from "@/lib/client-health";

/**
 * The account header's health chip: band plus the reason, from the same
 * definition the Active Clients board uses. "At Risk · No touch in 134 days".
 *
 * A type with no relationship clock (a homeowner) gets a muted chip saying so
 * instead. Not a green "Healthy" pill: green is a claim that somebody has been
 * keeping in touch, and on a one-time job nobody has or should.
 */

export function useAccountClientHealth(input: {
  /** Newest touchpoint that counts toward cadence. */
  lastTouchAt: string | null;
  /** When the relationship clock started, for a client with nothing logged. */
  sinceAt: string | null;
  healthStageId: string | null;
  /** From accountClocks() — false for a homeowner. Defaults to true. */
  clocksRun?: boolean;
}): ClientHealthVerdict {
  const { settings } = useClientHealthSettings();
  // Same key the kanban uses, so the stage list is fetched once per session.
  const stagesQ = useQuery({
    queryKey: ["farming-health-stages"],
    queryFn: () => fetchStages(FARMING_PIPELINE_ID),
    staleTime: 5 * 60_000,
    enabled: !!input.healthStageId,
  });
  const stageKey = input.healthStageId
    ? ((stagesQ.data ?? []).find((s) => s.id === input.healthStageId)?.key ?? null)
    : null;

  return useMemo(
    () =>
      computeClientHealth(
        {
          lastTouchAt: input.lastTouchAt,
          sinceAt: input.sinceAt,
          stageKey,
          clocksRun: input.clocksRun,
        },
        settings,
      ),
    [input.lastTouchAt, input.sinceAt, stageKey, input.clocksRun, settings],
  );
}

export function ClientHealthBadge({
  verdict,
  className,
}: {
  verdict: ClientHealthVerdict;
  className?: string;
}) {
  const meta = HEALTH_META[verdict.health];
  if (!verdict.tracked) {
    return (
      <span
        className={cn(
          "inline-flex max-w-full items-center gap-1.5 rounded-lg bg-muted px-3 py-1.5 text-[13px] font-medium text-muted-foreground",
          className,
        )}
        title={verdict.reason}
      >
        <PauseCircle className="size-4 shrink-0" />
        <span className="shrink-0">No clock</span>
        <span className="truncate font-normal opacity-80">· {verdict.reason}</span>
      </span>
    );
  }
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-medium",
        className,
      )}
      style={{ background: meta.soft, color: meta.text }}
      title={verdict.reason}
    >
      <HeartPulse className="size-4 shrink-0" style={{ color: meta.color }} />
      <span className="shrink-0">{meta.label}</span>
      <span className="truncate font-normal opacity-80">· {verdict.reason}</span>
    </span>
  );
}
