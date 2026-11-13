import { useQuery } from "@tanstack/react-query";
import { FileText, Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { toastDbError } from "@/lib/db-errors";
import { REPORT_TYPE_LABEL, type JobReportType } from "@/lib/job-reports";
import { attachPhotosToReport, listReportsForPhotos } from "@/lib/report-photos";

/**
 * "Attach to a report" from the same selection that shares.
 *
 * Deliberately only lists reports that already exist. Generating one is a
 * different act with its own review loop, and a button here that quietly made a
 * report would put an unread draft on a claim.
 */
export function PhotoAttachReport({
  jobId,
  ids,
  disabled,
  onAttached,
}: {
  jobId: string;
  ids: string[];
  disabled: boolean;
  onAttached: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const reportsQ = useQuery({
    queryKey: ["job-report-photos", jobId],
    queryFn: () => listReportsForPhotos(jobId),
    enabled: open,
  });

  const notMigrated = reportsQ.data?.migrated === false;
  const reports = reportsQ.data?.reports ?? [];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          className="h-11 sm:h-7"
          disabled={disabled || ids.length === 0}
        >
          <FileText className="mr-1 size-4" />
          Attach to report
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 space-y-2 p-2">
        {reportsQ.isLoading ? (
          <p className="text-xs text-muted-foreground">Loading reports…</p>
        ) : notMigrated ? (
          <p className="text-xs text-muted-foreground">
            Attaching photos to a report needs a database update before it can be switched on.
          </p>
        ) : reportsQ.isError ? (
          <p className="text-xs text-destructive">
            This job&apos;s reports could not be read, so attaching is off for now.
          </p>
        ) : reports.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No reports on this job yet. Generate one on the Reports panel first.
          </p>
        ) : (
          <>
            <ul className="space-y-1">
              {reports.map((r) => (
                <li key={r.id}>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-auto w-full justify-start whitespace-normal py-1.5 text-left text-xs"
                    disabled={busy != null}
                    onClick={async () => {
                      setBusy(r.id);
                      try {
                        const n = await attachPhotosToReport(r, ids);
                        await reportsQ.refetch();
                        onAttached();
                        setOpen(false);
                        toast.success(
                          n === 0
                            ? "Those photos are already on that report"
                            : `${n} photo${n === 1 ? "" : "s"} attached`,
                        );
                      } catch (e) {
                        toastDbError(e, { action: "Attach photos to report" });
                      } finally {
                        setBusy(null);
                      }
                    }}
                  >
                    {busy === r.id && <Loader2 className="mr-1 size-3.5 animate-spin" />}
                    <span>
                      {REPORT_TYPE_LABEL[r.reportType as JobReportType] ?? r.reportType} · v
                      {r.version}
                      <span className="block text-[11px] text-muted-foreground">
                        {r.status === "approved" ? "Approved" : "Draft"} · {r.photoIds.length} photo
                        {r.photoIds.length === 1 ? "" : "s"} attached
                      </span>
                    </span>
                  </Button>
                </li>
              ))}
            </ul>
            <p className="text-[11px] text-muted-foreground">
              Attaching records the photos against the report and switches its Photos section on.
              The exported PDF names them; it does not draw them in yet.
            </p>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
