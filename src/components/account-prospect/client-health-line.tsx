/**
 * The thin rail on the prospect layout when the account is a won client.
 *
 * Mark, of the prospect record: "we want this view for the active client."
 * Everything else on that layout is about the account and works unchanged on a
 * client — the chips, the AI read, the contact bar, the action row, Documents,
 * Polaris, the Timeline. The one panel that is genuinely about being a deal is
 * the stage rail, and this is what stands in its place: the four Farming bands
 * the /farming board is columned by, with the client's current one bubbled up
 * exactly as the current stage is on the deal rail.
 *
 * Why the health axis and not the finished pipeline: see the argument in
 * `src/lib/client-health-rail.ts`. In short — a completed pipeline is a line
 * with nothing left to aim at, and health is the axis a client actually moves
 * along.
 *
 * The write is the board's own: `healthMoveRefusal` decides whether a hand
 * move is allowed and `applyClientHealthStage` performs it, both from
 * `src/lib/client-health-move.ts`. Nothing about the rule is re-implemented
 * here, because two copies of "a move below the metric is refused" is how the
 * record eventually starts letting a rep clear a Critical that the board
 * would not.
 *
 * There is no drag. Dragging the pill is the pipeline's gesture, and it earns
 * its complexity there because the rail has up to seven destinations spread
 * across the width. Four bands a click apart do not need it.
 */
import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { useWritesDisabled } from "@/components/app-context";
import { railSpan } from "@/components/account-prospect/prospect-view-helpers";
import { HEALTH_META, type ClientHealthKey, type ClientHealthVerdict } from "@/lib/client-health";
import { clientHealthRail, healthRailSummary } from "@/lib/client-health-rail";
import {
  applyClientHealthStage,
  healthMoveRefusal,
  healthStageId,
  missingHealthStageMessage,
} from "@/lib/client-health-move";
import { fetchStages } from "@/lib/pipeline";
import { FARMING_PIPELINE_ID } from "@/lib/sales-pipeline";
import { cn } from "@/lib/utils";

export function ClientHealthLine({
  accountId,
  accountName,
  verdict,
  onMoved,
  className,
}: {
  accountId: string;
  /** Named in the refusal: "Brooklyn Facilities stays At Risk". */
  accountName: string;
  verdict: ClientHealthVerdict;
  onMoved: () => void;
  className?: string;
}) {
  const qc = useQueryClient();
  const writes = useWritesDisabled();

  // Same query key the board and the header badge use, so the four stages are
  // fetched once per session however many of the three are on screen.
  const stagesQ = useQuery({
    queryKey: ["farming-health-stages"],
    queryFn: () => fetchStages(FARMING_PIPELINE_ID),
    staleTime: 5 * 60_000,
  });

  const rail = useMemo(() => clientHealthRail(verdict), [verdict]);
  const summary = healthRailSummary(verdict);

  const move = useMutation({
    mutationFn: ({ to, stageId }: { to: ClientHealthKey; stageId: string }) =>
      applyClientHealthStage({ accountId, to, stageId, source: "Client record" }),
    onSuccess: (_d, vars) => {
      toast.success(`${accountName} moved to ${HEALTH_META[vars.to].label}`);
      void qc.invalidateQueries({ queryKey: ["active-clients"] });
      onMoved();
    },
    onError: (e: Error) => toast.error(e.message || "Could not change this client's health stage"),
  });

  const busy = writes.disabled || stagesQ.isLoading || move.isPending;

  const pick = (to: ClientHealthKey) => {
    if (busy || to === verdict.health) return;
    const refusal = healthMoveRefusal(
      {
        name: accountName,
        healthMetric: verdict.metric,
        healthReason: verdict.reason,
        healthTracked: verdict.tracked,
      },
      to,
    );
    if (refusal) {
      toast.info(refusal.title, { description: refusal.description });
      return;
    }
    const stageId = healthStageId(stagesQ.data, to);
    if (!stageId) {
      toast.error(missingHealthStageMessage(to));
      return;
    }
    move.mutate({ to, stageId });
  };

  /*
   * A homeowner has no relationship clock at all, so it has no band — see the
   * type gate in `client-health.ts`. Four markers with one of them lit would
   * say it is Healthy, which is a claim about a follow-up that was never owed.
   * The reason line is the honest thing to show, and it is what the header
   * badge shows for the same account.
   */
  if (!rail.tracked) {
    return (
      <div
        data-testid="client-health-line"
        className={cn("px-6 pb-3 pt-1 text-[12.5px] text-muted-foreground", className)}
      >
        {summary}
      </div>
    );
  }

  const span = railSpan(rail.steps.length);

  return (
    <div
      data-testid="client-health-line"
      className={cn("flex items-start gap-2 px-6 pb-3 pt-1 sm:gap-3", className)}
    >
      <ol className="relative flex min-w-0 flex-1" aria-label="Client health">
        {/*
          A plain track, not a filled one. On a pipeline the stretch behind the
          pill is the road travelled; here the band to the left is not
          something this client completed, and a coloured fill would read as
          progress toward Critical. See `client-health-rail.ts`.
        */}
        {span.width > 0 && (
          <span
            aria-hidden
            className="absolute top-[15px] h-0.5 -translate-y-1/2 rounded-full bg-border"
            style={{ left: `${span.left}%`, width: `${span.width}%` }}
          />
        )}
        {rail.steps.map((step) => {
          const meta = HEALTH_META[step.key];
          return (
            <li key={step.key} className="relative z-10 flex min-w-0 flex-1 justify-center">
              {step.current ? (
                <span
                  aria-current="step"
                  title={verdict.reason}
                  className="flex h-[30px] max-w-full items-center gap-1.5 rounded-full px-3.5 text-[13px] font-semibold shadow-sm ring-4 ring-background"
                  style={{ backgroundColor: meta.soft, color: meta.text }}
                >
                  <span className="truncate">{meta.label}</span>
                  {verdict.daysSinceTouch != null && (
                    <span className="shrink-0 whitespace-nowrap text-[11.5px] font-medium opacity-75">
                      · {verdict.daysSinceTouch} day
                      {verdict.daysSinceTouch === 1 ? "" : "s"}
                    </span>
                  )}
                </span>
              ) : (
                <button
                  type="button"
                  disabled={busy || step.locked}
                  onClick={() => pick(step.key)}
                  title={
                    writes.disabled
                      ? (writes.reason ?? "Read only")
                      : step.locked
                        ? // The same sentence the refusal toast would carry,
                          // said before the click instead of after it.
                          `${verdict.reason} — health is computed from activity, so this client cannot be set to ${meta.label} by hand`
                        : `Set health to ${meta.label}`
                  }
                  className="group flex w-full min-w-0 flex-col items-center gap-1 disabled:cursor-not-allowed"
                >
                  <span className="flex h-[30px] items-center">
                    <span
                      className={cn(
                        "block size-2.5 rounded-full ring-4 ring-background transition",
                        step.locked ? "opacity-40" : "group-hover:scale-125",
                      )}
                      style={{ backgroundColor: meta.color }}
                    />
                  </span>
                  <span
                    className={cn(
                      "max-w-full truncate px-1 text-[11.5px] leading-tight text-muted-foreground transition",
                      !step.locked && "group-hover:text-foreground",
                    )}
                  >
                    {meta.label}
                  </span>
                </button>
              )}
            </li>
          );
        })}
      </ol>

      {/*
        Why the band is what it is. On the deal rail this space carries the
        days in stage; here the days alone would not explain a hand-set
        Ghosted, so the verdict's own sentence is printed in full.
      */}
      <p className="mt-[7px] hidden max-w-[22rem] shrink-0 truncate text-[12px] text-muted-foreground sm:block">
        {verdict.reason}
      </p>
    </div>
  );
}
