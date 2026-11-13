/**
 * "Drying report" on the Drying log tab: the job's drying record as a PDF laid
 * out like the MoistureMapper report Mark sent on 2026-10-06 — "there needs to
 * be a way to run a report that can make something like this for each job".
 *
 * It is handed the rows the tab already loaded (readings, rooms, placements,
 * moisture points) rather than reading them again, so the PDF, the workbook
 * beside it and the screen are the same data. drying-report.ts decides what
 * the report says; drying-report-pdf.ts draws it; this only collects the
 * job's cover facts and decides where the file goes.
 *
 * WHO MAY DO WHAT
 *  - Download goes through the export gate, exactly like "Download log" next
 *    to it: the same readings leaving the building as a file are the same
 *    export whether the file is a workbook or a PDF, and it is logged as one.
 *  - Save to job documents files it on the job like the photo PDF does — the
 *    copy stays inside the system, behind the Documents tab's own access — so
 *    it needs only a session that may write.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, FileText, FolderPlus, Link2, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { useAppContext } from "@/components/app-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { supabase } from "@/integrations/supabase/client";
import {
  MOISTURE_MATERIAL_LABEL,
  type MoisturePoint,
  type MoistureReading,
} from "@/lib/drying-materials";
import { todayLocal, type DryingReading } from "@/lib/drying-log";
import {
  buildDryingReportData,
  dryingReportFilename,
  windowDryingReport,
  type ReportPlacement,
} from "@/lib/drying-report";
import { buildDryingReportPdf } from "@/lib/drying-report-pdf";
import { uploadDocumentFile } from "@/lib/documents";
import { useExportGate } from "@/lib/export-guard";
import { roomLabel, type JobRoom } from "@/lib/job-rooms";
import { downloadPdf } from "@/lib/pdf-actions";
import { shortDate } from "@/lib/pdf-kit";

/** The logo the estimates and invoices fall back to, shipped with the app. */
const LOGO_URL = "/gold-star-logo.png";

async function loadLogo(): Promise<Uint8Array | null> {
  try {
    const res = await fetch(LOGO_URL);
    if (!res.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  } catch {
    // The cover prints the company name in type instead.
    return null;
  }
}

type JobFacts = {
  location_id: string;
  account_id: string | null;
  customer_name: string | null;
  claim_number: string | null;
  insurance_carrier: string | null;
  loss_date: string | null;
  loss_type: string | null;
};

export function DryingReportButton({
  jobId,
  jobNumber,
  address,
  readings,
  rooms,
  placements,
  moisture,
  waterCategory,
  waterClass,
  disabled,
  className,
}: {
  jobId: string;
  jobNumber?: string | null;
  address?: string | null;
  readings: DryingReading[];
  rooms: JobRoom[];
  placements: ReportPlacement[];
  /** Null when the moisture-point tables are not migrated. */
  moisture: { points: MoisturePoint[]; readings: MoistureReading[] } | null;
  waterCategory?: number | null;
  waterClass?: number | null;
  disabled?: boolean;
  className?: string;
}) {
  const app = useAppContext();
  const qc = useQueryClient();
  const entity = jobNumber ?? jobId;
  const gate = useExportGate({ entity });
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<"download" | "save" | "share" | null>(null);
  const [sharedUrl, setSharedUrl] = useState<string | null>(null);
  /** 28 Oct: the dates the report covers. Blank = from the first / to the last. */
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const rangeBad = !!from && !!to && from > to;
  const ranged = windowDryingReport(
    { rows: readings, placements, moisture, today: todayLocal() },
    from || null,
    to || null,
  );

  const factsQ = useQuery({
    queryKey: ["drying-report-job", jobId],
    enabled: open,
    queryFn: async (): Promise<JobFacts> => {
      const { data, error } = await supabase
        .from("jobs")
        .select(
          "location_id, account_id, customer_name, claim_number, insurance_carrier, loss_date, loss_type",
        )
        .eq("id", jobId)
        .single();
      if (error) throw error;
      return data as JobFacts;
    },
  });

  const areaRooms = new Set([
    ...ranged.rows.map((r) => r.room_id).filter(Boolean),
    ...(ranged.moisture?.points ?? []).map((p) => p.room_id).filter(Boolean),
    ...ranged.placements.map((p) => p.room_id).filter(Boolean),
  ]);
  const pointsRead = (ranged.moisture?.points ?? []).filter((p) =>
    ranged.moisture!.readings.some((r) => r.point_id === p.id),
  ).length;

  async function build() {
    // The clock is read once, here, at the moment somebody asks for the file.
    const generatedAt = new Date();
    const now = todayLocal(generatedAt);
    // The chosen dates; the report's own "today" is the range's end if earlier.
    const cut = windowDryingReport(
      { rows: readings, placements, moisture, today: now },
      from || null,
      to || null,
    );
    const today = cut.today;
    const data = buildDryingReportData({
      rows: cut.rows,
      rooms,
      roomLabel,
      placements: cut.placements,
      moisture: cut.moisture,
      materialLabel: MOISTURE_MATERIAL_LABEL,
      jobNumber,
      address,
      today,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    const facts = factsQ.data;
    const bytes = await buildDryingReportPdf({
      data,
      job: {
        customerName: facts?.customer_name,
        carrier: facts?.insurance_carrier,
        claimNumber: facts?.claim_number,
        lossDate: facts?.loss_date,
        lossType: facts?.loss_type,
        waterCategory,
        waterClass,
      },
      preparedBy: app.fullName,
      generatedAt,
      logoPng: await loadLogo(),
    });
    return { bytes, today, filename: dryingReportFilename(jobNumber, today) };
  }

  async function download() {
    setBusy("download");
    try {
      const built = await build();
      await gate.runExport({
        surface: "drying-report",
        entity,
        recordCount: ranged.rows.length,
        format: "pdf",
        filters: { job_id: jobId, ...(from ? { from } : {}), ...(to ? { to } : {}) },
        download: () => downloadPdf(built.bytes, built.filename),
      });
    } catch (e) {
      toast.error("Could not build the drying report", {
        description: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setBusy(null);
    }
  }

  /**
   * David, 13 Oct: send the drying report to the insurance company as a LINK.
   * Files the customer copy on the job (as Save does), then makes a 30-day
   * share link to that one file — the same links, expiry and revoke as the
   * schedule and photo links — and copies it.
   */
  async function share() {
    const facts = factsQ.data;
    if (!facts) return;
    setBusy("share");
    try {
      const built = await build();
      const doc = await uploadDocumentFile({
        file: new File([built.bytes.slice().buffer as ArrayBuffer], built.filename, {
          type: "application/pdf",
        }),
        scope: { locationId: facts.location_id, jobId, accountId: facts.account_id },
        docType: "job_report",
        userId: app.userId,
        name: `Drying report - ${jobNumber ?? "job"} (${shortDate(built.today)})`,
      });
      qc.invalidateQueries({ queryKey: ["job-documents", jobId] });
      const { createDryingReportShareLink, REPORT_SHARE_DAYS } = await import("@/lib/report-share");
      const link = await createDryingReportShareLink({
        jobId,
        documentId: doc.id,
        userId: app.userId,
      });
      setSharedUrl(link.url);
      try {
        await navigator.clipboard.writeText(link.url);
        toast.success("Link copied", {
          description: `Paste it into your email to the carrier. It works for ${REPORT_SHARE_DAYS} days.`,
        });
      } catch {
        toast.success("Link made", { description: "Copy it from the box below." });
      }
    } catch (e) {
      const missing = /invalid input value for enum|job_drying_report/i.test(
        e instanceof Error ? e.message : String((e as { message?: string })?.message ?? ""),
      );
      toast.error("Could not make the link", {
        description: missing
          ? "Report links are waiting on database update 20261014121000. The report was still filed on the job."
          : e instanceof Error
            ? e.message
            : undefined,
      });
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    const facts = factsQ.data;
    if (!facts) return;
    setBusy("save");
    try {
      const built = await build();
      await uploadDocumentFile({
        file: new File([built.bytes.slice().buffer as ArrayBuffer], built.filename, {
          type: "application/pdf",
        }),
        scope: { locationId: facts.location_id, jobId, accountId: facts.account_id },
        // The job's report column; there is no drying-specific document type,
        // and adding an enum value would be a migration for a label.
        docType: "job_report",
        userId: app.userId,
        name: `Drying report - ${jobNumber ?? "job"} (${shortDate(built.today)})`,
      });
      qc.invalidateQueries({ queryKey: ["job-documents", jobId] });
      toast.success("Drying report filed on the job", {
        description: "It is on the Documents tab, with the other reports.",
      });
      setOpen(false);
    } catch (e) {
      toast.error("Could not file the drying report", {
        description: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className={className}
        disabled={disabled}
        onClick={() => setOpen(true)}
        title="A PDF of this job's drying: conditions, equipment, each area, and every reading"
      >
        <FileText className="mr-1.5 size-3.5" />
        Drying report
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Drying report</DialogTitle>
            <DialogDescription>
              A PDF for the carrier: outside conditions and equipment applied by day, then each
              area, then every reading as a table. Built from the same readings as the log download,
              so the two never disagree.
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3" data-drying-report-dates>
            <div className="space-y-1">
              <Label htmlFor="drying-report-from">From</Label>
              <Input
                id="drying-report-from"
                type="date"
                value={from}
                max={to || undefined}
                onChange={(e) => setFrom(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="drying-report-to">To</Label>
              <Input
                id="drying-report-to"
                type="date"
                value={to}
                min={from || undefined}
                onChange={(e) => setTo(e.target.value)}
              />
            </div>
            <p className="col-span-2 text-xs text-muted-foreground">
              {rangeBad
                ? "From is after To — pick dates in order."
                : from || to
                  ? `Only ${from ? `from ${shortDate(from)}` : "up"}${to ? ` to ${shortDate(to)}` : " to the latest reading"}.`
                  : "Leave both blank for the whole job."}
            </p>
          </div>
          <ul className="space-y-1.5 text-sm">
            <li>
              {ranged.rows.length} reading{ranged.rows.length === 1 ? "" : "s"},{" "}
              {ranged.placements.length} equipment placement
              {ranged.placements.length === 1 ? "" : "s"}
            </li>
            <li>
              {areaRooms.size} room{areaRooms.size === 1 ? "" : "s"} with readings, points or
              equipment, each drawn on a room schematic (rooms to their recorded size — Gold Star
              has no floor-plan sketch, so it is not a floor plan)
            </li>
            <li className={moisture && pointsRead > 0 ? undefined : "text-muted-foreground"}>
              {moisture == null
                ? "Material moisture points: not set up in this database yet, so the moisture content graphs are left out."
                : pointsRead > 0
                  ? `Material moisture: ${pointsRead} fixed point${pointsRead === 1 ? "" : "s"} charted against the dry goal.`
                  : "Material moisture: no fixed points read on this job, so the moisture content graphs are left out."}
            </li>
          </ul>
          {factsQ.isError && (
            <p className="text-sm text-destructive">
              The job's details could not be read, so the cover will be shorter and the report
              cannot be filed. Download still works.
            </p>
          )}
          <DialogFooter className="gap-2 sm:gap-2">
            {gate.allowed && (
              <Button
                type="button"
                variant="outline"
                onClick={() => void download()}
                disabled={busy != null || factsQ.isLoading || rangeBad}
              >
                {busy === "download" ? (
                  <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                ) : (
                  <Download className="mr-1.5 size-3.5" />
                )}
                Download PDF
              </Button>
            )}
            <Button
              type="button"
              onClick={() => void save()}
              disabled={busy != null || !factsQ.data || app.writesDisabled || rangeBad}
              title={app.writesDisabled ? (app.writesDisabledReason ?? undefined) : undefined}
            >
              {busy === "save" ? (
                <Loader2 className="mr-1.5 size-3.5 animate-spin" />
              ) : (
                <FolderPlus className="mr-1.5 size-3.5" />
              )}
              Save to job documents
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => void share()}
              disabled={busy != null || !factsQ.data || app.writesDisabled || rangeBad}
              title="File the customer copy and make a link to send to the insurance company"
            >
              {busy === "share" ? (
                <Loader2 className="mr-1.5 size-3.5 animate-spin" />
              ) : (
                <Link2 className="mr-1.5 size-3.5" />
              )}
              Share link
            </Button>
          </DialogFooter>
          {sharedUrl ? (
            <div className="space-y-1" data-drying-share-link>
              <p className="text-xs text-muted-foreground">
                Send this link to the carrier. Anyone with it can open this copy of the report for
                30 days; after that it stops working.
              </p>
              <input
                readOnly
                className="h-9 w-full rounded-md border bg-muted/30 px-2 text-xs"
                value={sharedUrl}
                onFocus={(e) => e.currentTarget.select()}
              />
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
