/**
 * The 3-day drying clock, and the button that restarts it.
 *
 * David's scope-of-work email, 2 Sep, lists it as a step of its own: "Reset 3
 * days of drying time (new button linked to scanning and alerts)."
 *
 * Linked to scanning, literally: the window starts at the first equipment
 * placement on the job, which is what a tech's setup scan writes. Nobody types
 * a start date, and nobody can forget to. The only thing a person ever tells
 * this card is that the 72 hours should start again — a crew swapping in
 * bigger dehumidifiers on day three is starting a fresh window, and until now
 * there was no way to say so.
 *
 * The same card is rendered on the Drying tab and on the work ticket, because
 * the tech who needs it is the one filling in the ticket at the end of a shift
 * and the manager who needs it is reading the drying log. One component, so
 * the two can never disagree about how many hours are left.
 *
 * It is also on the job's Tasks tab, beside Mark's "Reset 3 days of drying
 * time" task, and it is the only reset button: one press restarts the clock,
 * moves every unit still on the job out to the new 72-hour date (which every
 * overdue-equipment alert reads), and re-dates the Monitoring and Pick up
 * equipment tasks. There used to be a second button that did only the dates.
 *
 * The arithmetic is in src/lib/drying-clock.ts and the write is in
 * src/lib/drying-reset.ts; this is the screen only.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { RotateCcw, Timer } from "lucide-react";

import { useAppContext } from "@/components/app-context";
import { useLabelLanguage } from "@/components/bilingual";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import { toastDbError } from "@/lib/db-errors";
import { isMissingSchema } from "@/lib/schema-fallback";
import {
  DRYING_WINDOW_HOURS,
  describeReset,
  dryingClock,
  type DryingClockPhase,
} from "@/lib/drying-clock";
import { listDryingResets, resetDryingClock } from "@/lib/drying-reset";
import { scheduleAutomaticTaskSync } from "@/lib/automatic-job-tasks";
import { cn } from "@/lib/utils";

/** Colour per phase. "due" is amber, not red: it is a prompt, not a failure. */
const PHASE_TONE: Record<DryingClockPhase, string> = {
  not_started: "text-muted-foreground",
  running: "text-success",
  due: "text-warning",
  overdue: "text-destructive",
};

const PHASE_BAR: Record<DryingClockPhase, string> = {
  not_started: "bg-muted-foreground/40",
  running: "bg-success",
  due: "bg-warning",
  overdue: "bg-destructive",
};

export function DryingClockCard({
  jobId,
  /** The ticket renders it inside its own form, so it drops the card chrome. */
  bare = false,
  className,
}: {
  jobId: string;
  bare?: boolean;
  className?: string;
}) {
  const { bi } = useLabelLanguage();
  const app = useAppContext();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");

  /**
   * When the first machine went in. Not filtered to open placements: a job
   * whose first dehumidifier has already gone back still started drying when
   * that dehumidifier arrived.
   */
  const startQ = useQuery({
    queryKey: ["drying-clock-start", jobId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("equipment_placements")
        .select("placed_at")
        .eq("job_id", jobId)
        .order("placed_at", { ascending: true })
        .limit(1);
      if (error) {
        if (isMissingSchema(error)) return null;
        throw error;
      }
      return data?.[0]?.placed_at ?? null;
    },
  });

  const resetsQ = useQuery({
    queryKey: ["drying-resets", jobId],
    queryFn: () => listDryingResets(jobId),
  });

  /** Null from the query means the table is not there yet — see the migration. */
  const resetsAvailable = resetsQ.data !== null;
  const resets = useMemo(() => resetsQ.data ?? [], [resetsQ.data]);

  const clock = useMemo(
    () => dryingClock({ firstPlacedAt: startQ.data ?? null, resets }),
    [startQ.data, resets],
  );

  const save = useMutation({
    mutationFn: async () => {
      const res = await resetDryingClock({
        jobId,
        userId: app.userId,
        previousStartedAt: clock.startedAt,
        note: describeReset({
          who: app.fullName,
          at: new Date().toISOString(),
          previousStartedAt: clock.startedAt,
          reason,
        }),
      });
      // The queue has already asked for the re-dating; waiting on it here is
      // what lets the task list below be refreshed with the new dates in it.
      if (!res.queued && app.userId) await scheduleAutomaticTaskSync(jobId, app.userId);
      return res;
    },
    onSuccess: (res) => {
      toast.success("3-day drying window restarted", {
        description: res.queued
          ? "Held on this phone until you have signal."
          : `72 hours from now. Equipment due-back dates and alerts moved with it. Recorded against ${app.fullName ?? "you"}.`,
      });
      setOpen(false);
      setReason("");
      void qc.invalidateQueries({ queryKey: ["drying-resets", jobId] });
      void qc.invalidateQueries({ queryKey: ["job-tasks", jobId] });
      void qc.invalidateQueries({ queryKey: ["tasks"] });
      void qc.invalidateQueries({ queryKey: ["job-onsite", jobId] });
    },
    onError: (e) => toastDbError(e, { action: "restart the drying window" }),
  });

  const body = (
    <div className={cn("space-y-2", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Timer className={cn("size-4 shrink-0", PHASE_TONE[clock.phase])} />
          <span className="text-sm font-semibold">{bi("3-day drying", "Secado de 3 días")}</span>
        </div>
        <span className={cn("text-sm font-semibold tabular-nums", PHASE_TONE[clock.phase])}>
          {clock.dayLabel}
        </span>
      </div>

      {/* A bar, because "Day 2 of 3" is a number and how much of the window is
          gone is a shape. Both, because a tech reads one and a manager the other. */}
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full transition-[width]", PHASE_BAR[clock.phase])}
          style={{ width: `${Math.round(clock.progress * 100)}%` }}
        />
      </div>

      <p className="text-xs text-muted-foreground">
        {clock.phase === "not_started" ? (
          <>
            The window starts when the first unit is scanned onto this job. Nothing has been placed
            yet.
          </>
        ) : (
          <>
            {clock.fromReset ? "Restarted" : "Started"}{" "}
            {new Date(clock.startedAt!).toLocaleString("en-US")} ·{" "}
            {clock.hoursRemaining! > 0
              ? `${Math.round(clock.hoursRemaining!)} hours left of ${DRYING_WINDOW_HOURS}`
              : `${Math.abs(Math.round(clock.hoursRemaining!))} hours past the ${DRYING_WINDOW_HOURS}`}
            {clock.resetCount > 0 &&
              ` · restarted ${clock.resetCount} time${clock.resetCount === 1 ? "" : "s"}`}
          </>
        )}
      </p>

      {/*
        Prominent and gloved-thumb sized, because it is pressed standing in a
        basement beside the machine that was just swapped, not at a desk.
      */}
      <Button
        variant={clock.phase === "overdue" ? "default" : "outline"}
        className="h-12 w-full sm:h-11"
        disabled={app.writesDisabled || !resetsAvailable}
        title={
          !resetsAvailable
            ? "The drying-reset migration has not been applied yet."
            : (app.writesDisabledReason ?? undefined)
        }
        onClick={() => setOpen(true)}
      >
        <RotateCcw className="mr-1.5 size-4" />
        {bi("Reset 3-day drying", "Reiniciar 3 días")}
      </Button>

      {!resetsAvailable && (
        <p className="text-xs text-muted-foreground">
          Restarts cannot be recorded until the drying-reset migration is applied. The window above
          still counts from the first placement.
        </p>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[92svh] w-[calc(100vw-1.5rem)] max-w-md overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Restart the 3-day drying window?</DialogTitle>
            <DialogDescription>
              The 72 hours start again from now, and the drying progress on this job resets with
              them. This is recorded against your name and cannot be edited afterwards — a mistake
              is corrected by resetting again, not by deleting this.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-1.5">
            <Label htmlFor="drying-reset-reason">{bi("Why?", "¿Por qué?")}</Label>
            <Textarea
              id="drying-reset-reason"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Swapped in two larger dehumidifiers"
            />
            <p className="text-xs text-muted-foreground">
              Optional, and worth the ten seconds: this is what the office reads when a carrier asks
              why the job was billed for six days of equipment instead of three.
            </p>
          </div>

          {/* Said plainly: it is what makes the alerts stop and start again. */}
          <p
            data-reset-moves-dates
            className="rounded-sm border border-dashed p-2 text-xs text-muted-foreground"
          >
            Every unit still on this job is expected back 72 hours from now, so the
            overdue-equipment alerts and the Monitoring and Pick up equipment tasks follow the new
            window. A unit already planned to stay longer keeps its later date.
          </p>

          <DialogFooter className="gap-2 sm:justify-between">
            <Button variant="ghost" className="h-11 sm:h-9" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              className="h-12 w-full sm:h-9 sm:w-auto"
              disabled={save.isPending}
              onClick={() => save.mutate()}
            >
              Restart the 72 hours
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );

  if (bare) return body;
  return (
    <Card>
      <CardContent className="p-3">{body}</CardContent>
    </Card>
  );
}
