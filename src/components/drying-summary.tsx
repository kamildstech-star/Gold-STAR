import { AlertTriangle, ClipboardCheck } from "lucide-react";

import { cn } from "@/lib/utils";
import { describeWaterCategory, isGrosslyContaminated } from "@/lib/water-category";
import { describeWaterClass, needsSpecialtyDrying } from "@/lib/water-class";
import type { JobHoursTotal } from "@/lib/equipment-hours";

/**
 * The drying log in five lines — what an auditor reads before the calendar.
 *
 * Heshy Landau's checklist (1 Sep, via David) is what an insurance audit of a
 * drying job is held to. Each line here is one of its questions, answered from
 * what the log already holds, and each says plainly when the answer is
 * missing rather than leaving a blank that reads as "fine":
 *
 *   category and class    how dirty, and how much to evaporate
 *   dehumidifiers         did each machine on site pull water on the latest
 *                         day it was read (grain depression)
 *   materials             how many fixed test points have reached their dry
 *                         standard
 *   equipment hours       hour-meter hours run, the billing evidence
 *
 * Presentational only. The panel computes; this prints.
 */
export function DryingSummaryCard({
  waterCategory,
  waterClass,
  dehus,
  materials,
  hours,
}: {
  waterCategory: number | null;
  waterClass: number | null;
  /** Null when nothing is on site and nothing was ever read. */
  dehus: { onSite: number; judged: number; pulling: number; date: string | null } | null;
  /** Null while the test-point tables are not applied; undefined while loading. */
  materials: { total: number; dry: number } | null | undefined;
  /** Null while the hour-meter columns are not applied; undefined while loading. */
  hours: JobHoursTotal | null | undefined;
}) {
  const lines: { label: string; value: string; warn?: boolean }[] = [
    {
      label: "Water",
      value: `${describeWaterCategory(waterCategory)} · ${describeWaterClass(waterClass)}`,
      warn: waterCategory == null || waterClass == null,
    },
  ];

  if (dehus) {
    lines.push({
      label: "Dehumidifiers",
      value:
        dehus.judged === 0
          ? `${dehus.onSite} on site — no inlet / outlet pair logged yet`
          : `${dehus.pulling} of ${dehus.judged} pulling moisture${dehus.date ? ` (${dehus.date.slice(5)})` : ""}${
              dehus.onSite > dehus.judged ? ` · ${dehus.onSite - dehus.judged} not read` : ""
            }`,
      warn: dehus.judged === 0 || dehus.pulling < dehus.judged || dehus.onSite > dehus.judged,
    });
  }

  lines.push({
    label: "Materials",
    value:
      materials === undefined
        ? "…"
        : materials === null
          ? "Test points pending migration"
          : materials.total === 0
            ? "No fixed test points set up"
            : `${materials.dry} of ${materials.total} test points at dry standard`,
    warn: materials != null && (materials.total === 0 || materials.dry < materials.total),
  });

  lines.push({
    label: "Equipment hours",
    value:
      hours === undefined
        ? "…"
        : hours === null
          ? "Hour meters pending migration"
          : hours.counted === 0 && hours.running === 0 && hours.missing === 0
            ? "No metered equipment on this job"
            : [
                `${hours.hours} h run on ${hours.counted} unit${hours.counted === 1 ? "" : "s"}`,
                hours.running ? `${hours.running} still running` : null,
                hours.missing ? `${hours.missing} missing a meter reading` : null,
                hours.backwards ? `${hours.backwards} to check` : null,
              ]
                .filter(Boolean)
                .join(" · "),
    warn: hours != null && (hours.missing > 0 || hours.backwards > 0),
  });

  return (
    <div className="space-y-1.5 rounded-md border p-3">
      <p className="flex items-center gap-1.5 text-sm font-medium">
        <ClipboardCheck className="size-4 shrink-0 text-muted-foreground" />
        Drying summary
      </p>
      <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-[max-content_1fr]">
        {lines.map((l) => (
          <div key={l.label} className="contents">
            <dt className="text-muted-foreground">{l.label}</dt>
            <dd className={cn("min-w-0 tabular-nums", l.warn && "text-warning")}>{l.value}</dd>
          </div>
        ))}
      </dl>
      {isGrosslyContaminated(waterCategory) && (
        <p className="flex items-start gap-1.5 text-[11px] text-destructive">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" />
          <span>Category 3: porous materials are removed, not dried.</span>
        </p>
      )}
      {needsSpecialtyDrying(waterClass) && (
        <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
          <AlertTriangle className="mt-0.5 size-3 shrink-0 text-warning" />
          <span>
            Class 4: bound water in dense materials dries slowly and usually needs specialty
            equipment — expect it to run past the usual three days.
          </span>
        </p>
      )}
    </div>
  );
}
