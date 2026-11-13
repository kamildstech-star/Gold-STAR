import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";
import { personLabel } from "@/lib/chat";
import { JOB_ASSIGNMENT_ROLE_LABELS } from "@/lib/jobs";
import { EQUIPMENT_TYPE_LABEL } from "@/lib/equipment";
import { Button } from "@/components/ui/button";
import { GanttChart } from "@/components/gantt-chart";
import {
  buildGanttBars,
  todayDayNumber,
  type GanttAssignment,
  type GanttJob,
  type GanttPlacement,
} from "@/lib/job-gantt";

type GanttData = {
  job: GanttJob | null;
  crew: GanttAssignment[];
  placements: GanttPlacement[];
  /** Sub-lists that failed to read. An unreadable list is not an empty one. */
  unread: string[];
};

/**
 * The job's work drawn as a schedule.
 *
 * Only rows that carry a real start and a real end are here — the job's own
 * dates, crew assignments, and equipment placements. Tasks are deliberately
 * absent: `tasks.due_date` is a single point, and a Gantt made of points is a
 * list with extra steps.
 */
export function JobGantt({ jobId, className }: { jobId: string; className?: string }) {
  const q = useQuery({
    queryKey: ["job-gantt", jobId],
    queryFn: async (): Promise<GanttData> => {
      const [jobRes, crewRes, placeRes] = await Promise.all([
        supabase
          .from("jobs")
          .select("job_number, loss_date, call_date, start_date, completion_date")
          .eq("id", jobId)
          .maybeSingle(),
        supabase
          .from("job_assignments")
          .select("id, role, start_date, end_date, profiles:user_id(full_name)")
          .eq("job_id", jobId),
        supabase
          .from("equipment_placements")
          .select(
            "id, placed_at, retrieved_at, expected_retrieval_date, equipment:equipment_id(asset_tag, equipment_type)",
          )
          .eq("job_id", jobId)
          .order("placed_at"),
      ]);
      /* Without the job row there is no window to draw, so that one throws.
         The other two degrade to a named warning instead of silently
         shortening the schedule. */
      if (jobRes.error) throw jobRes.error;
      return {
        job: (jobRes.data ?? null) as GanttJob | null,
        crew: (crewRes.data ?? []) as unknown as GanttAssignment[],
        placements: (placeRes.data ?? []) as unknown as GanttPlacement[],
        unread: [crewRes.error ? "crew" : null, placeRes.error ? "equipment" : null].filter(
          (v): v is string => v != null,
        ),
      };
    },
  });

  const today = todayDayNumber();
  const build = useMemo(
    () =>
      q.data
        ? buildGanttBars({
            job: q.data.job,
            crew: q.data.crew,
            placements: q.data.placements,
            today,
            roleLabel: (role) => JOB_ASSIGNMENT_ROLE_LABELS[role] ?? role,
            equipmentLabel: (type) => (type ? (EQUIPMENT_TYPE_LABEL[type] ?? type) : "Equipment"),
            personLabel,
          })
        : null,
    [q.data, today],
  );

  if (q.isLoading) {
    return <Shell className={className}>Loading the schedule…</Shell>;
  }

  if (q.isError || !build) {
    return (
      <Shell className={className} tone="error">
        <div className="flex flex-wrap items-center gap-2">
          <TriangleAlert className="size-4 shrink-0" />
          <span>The schedule could not be loaded, so nothing is drawn.</span>
          <Button size="sm" variant="outline" onClick={() => void q.refetch()}>
            Try again
          </Button>
        </div>
      </Shell>
    );
  }

  const undated = [
    build.undated.crew > 0 ? `${build.undated.crew} crew assignment(s) with no dates` : null,
    build.undated.equipment > 0
      ? `${build.undated.equipment} placement(s) with no placed date`
      : null,
  ].filter((v): v is string => v != null);

  return (
    <GanttChart
      bars={build.bars}
      today={today}
      className={className}
      warning={
        q.data && q.data.unread.length > 0
          ? `The ${q.data.unread.join(" and ")} list could not be read — those rows are missing from this chart, not absent from the job.`
          : undefined
      }
      footnote={
        undated.length > 0
          ? `Not drawn: ${undated.join(", ")}. A bar needs a date to sit on.`
          : undefined
      }
      empty="Nothing on this job has both a start and an end yet. Set the job's start and completion dates, give the crew assignments a date range, or place equipment — those are what the schedule is drawn from."
    />
  );
}

function Shell({
  children,
  className,
  tone,
}: {
  children: React.ReactNode;
  className?: string;
  tone?: "error";
}) {
  return (
    <div
      className={cn(
        "rounded-md border bg-card p-3 text-sm",
        tone === "error" ? "text-destructive" : "text-muted-foreground",
        className,
      )}
    >
      {children}
    </div>
  );
}
