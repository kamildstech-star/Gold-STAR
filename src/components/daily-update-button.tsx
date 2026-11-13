/**
 * "Daily update" on the Drying log tab: the day's update email, drafted from
 * the day's field work ticket and drying log (lib/daily-update.ts), shown for
 * a read, then opened in the job's own email window to edit and send.
 *
 * It sits beside "Drying report" because it is handed the same rows the tab
 * already loaded; only the tickets are read here.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Copy, Mail, Send } from "lucide-react";
import { toast } from "sonner";

import { JobEmailDialog } from "@/components/job-email-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { buildDailyUpdate } from "@/lib/daily-update";
import { todayLocal, type DryingReading } from "@/lib/drying-log";
import {
  MOISTURE_MATERIAL_LABEL,
  type MoisturePoint,
  type MoistureReading,
} from "@/lib/drying-materials";
import {
  buildDryingReportData,
  windowDryingReport,
  type ReportPlacement,
} from "@/lib/drying-report";
import { listFieldWorkTickets } from "@/lib/field-work-ticket";
import { roomLabel, type JobRoom } from "@/lib/job-rooms";

export function DailyUpdateButton({
  jobId,
  jobNumber,
  address,
  readings,
  rooms,
  placements,
  moisture,
  className,
}: {
  jobId: string;
  jobNumber?: string | null;
  address?: string | null;
  readings: DryingReading[];
  rooms: JobRoom[];
  placements: ReportPlacement[];
  moisture: { points: MoisturePoint[]; readings: MoistureReading[] } | null;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [emailOpen, setEmailOpen] = useState(false);
  const [date, setDate] = useState(todayLocal());

  const ticketsQ = useQuery({
    queryKey: ["daily-update-tickets", jobId],
    enabled: open,
    queryFn: () => listFieldWorkTickets(jobId),
  });

  const update = useMemo(() => {
    if (!date) return null;
    // Everything up to the day, so "drier than yesterday" has a yesterday.
    const cut = windowDryingReport(
      { rows: readings, placements, moisture, today: date },
      null,
      date,
    );
    const hasLog = cut.rows.length > 0 || cut.placements.length > 0;
    const drying = hasLog
      ? buildDryingReportData({
          rows: cut.rows,
          rooms,
          roomLabel,
          placements: cut.placements,
          moisture: cut.moisture,
          materialLabel: MOISTURE_MATERIAL_LABEL,
          jobNumber,
          address,
          today: date,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        })
      : null;
    return buildDailyUpdate({
      date,
      address: address ?? null,
      jobNumber: jobNumber ?? null,
      tickets: ticketsQ.data?.rows ?? [],
      drying,
    });
  }, [date, readings, rooms, placements, moisture, jobNumber, address, ticketsQ.data]);

  const copy = async () => {
    if (!update) return;
    try {
      await navigator.clipboard.writeText(`${update.subject}\n\n${update.text}`);
      toast.success("Daily update copied");
    } catch {
      toast.error("Could not copy. Select the text and copy it instead.");
    }
  };

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className={className}
        onClick={() => setOpen(true)}
      >
        <Mail className="mr-1 size-4" /> Daily update
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Daily update email</DialogTitle>
            <DialogDescription>
              Drafted from the day&rsquo;s field work ticket and drying log. Read it, then open it
              in the job&rsquo;s email to edit and send.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-1">
            <Label htmlFor="daily-update-date">Day</Label>
            <Input
              id="daily-update-date"
              type="date"
              value={date}
              max={todayLocal()}
              onChange={(e) => setDate(e.target.value)}
              className="w-44"
            />
          </div>

          {ticketsQ.isError && (
            <p className="text-xs text-destructive">
              The field work tickets could not be read, so the work section is missing.
            </p>
          )}

          {update && (
            <div className="space-y-2 rounded-md border bg-muted/30 p-3 text-sm">
              <p className="font-semibold text-foreground">{update.subject}</p>
              <div className="whitespace-pre-wrap text-foreground">{update.text}</div>
            </div>
          )}
          {update && !update.hasContent && (
            <p className="text-xs text-muted-foreground">
              No ticket, reading or equipment is recorded for this day yet.
            </p>
          )}

          <DialogFooter className="gap-2 sm:gap-2">
            <Button type="button" variant="outline" onClick={() => void copy()} disabled={!update}>
              <Copy className="mr-1 size-4" /> Copy
            </Button>
            <Button
              type="button"
              disabled={!update || ticketsQ.isLoading}
              onClick={() => {
                setOpen(false);
                setEmailOpen(true);
              }}
            >
              <Send className="mr-1 size-4" /> Open in email
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <JobEmailDialog
        jobId={jobId}
        open={emailOpen}
        onOpenChange={setEmailOpen}
        draft={update ? { subject: update.subject, html: update.html } : null}
      />
    </>
  );
}
