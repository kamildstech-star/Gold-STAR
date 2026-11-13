/**
 * One sentence, shared by every panel that shows labour money.
 *
 * BACKLOG records a bug where two money panels on the same job disagreed and
 * nothing on screen reconciled them. Labour reopens exactly that risk: the
 * man-hours now come from the daily field forms, while the labour COST still
 * comes from the database rollups, which price named people out of
 * `time_entries` and cannot price a crew size. So the hours figure can legally
 * exceed what the money covers.
 *
 * The fix for that class of problem is not to hide one of the numbers. It is
 * that every panel showing labour money states the same coverage, computed
 * from the same rollup, in the same words. If this component renders nothing,
 * cost covers every hour.
 */
import { fmtHours } from "@/lib/labour";
import type { JobLabourRollup } from "@/lib/job-labour-rollup";

export function LabourCostCoverage({
  rollup,
  className,
}: {
  rollup: JobLabourRollup | null | undefined;
  className?: string;
}) {
  if (!rollup || !rollup.costIncomplete) return null;
  return (
    <p className={className ?? "text-[11px] text-warning"}>
      Labor cost prices {fmtHours(rollup.costedMinutes)} of {fmtHours(rollup.totalMinutes)}{" "}
      man-hours. The rest come from daily field forms, which record a crew size rather than named
      people and have no rate against them yet — so those hours are in the hours figure and not in
      the money.
      {rollup.supersededMinutes > 0 && (
        <>
          {" "}
          Labor cost does still include {fmtHours(rollup.supersededMinutes)} clocked on days a field
          form covers; the form is what the hours are counted from, so that money has no matching
          line in the figure above.
        </>
      )}
    </p>
  );
}
