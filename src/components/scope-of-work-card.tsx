/**
 * The job's Scope of Work, gathered from its rooms.
 *
 * David, 12 Oct: "Generate Scope" pulls every room's scope into a downloadable
 * report, and the same list is viewable on the job so the office and the crew
 * on site see one scope. This card is both: the bullet list per room on
 * screen, and the buttons that turn it into the PDF (src/lib/scope-of-work-pdf.ts).
 *
 * It reads the rooms through the Rooms tab's own query key, so a line typed on
 * a room shows here at once.
 *
 * David, 23 Oct: the separate "Scope of work · English / Español" box repeated
 * this one, so it is gone from the job page and Translate lives here — the
 * Spanish of this same list, stored and correctable (work-order-translation).
 * A job that still has the old single scope text shows it here, read-only.
 */
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ClipboardList, Download, FileUp, Languages, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { useAppContext } from "@/components/app-context";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { WorkOrderTranslation } from "@/components/work-order-translation";
import { uploadDocumentFile } from "@/lib/documents";
import { useExportGate } from "@/lib/export-guard";
import { fetchJobRooms, roomLabel } from "@/lib/job-rooms";
import { downloadPdf } from "@/lib/pdf-actions";
import { shortDate } from "@/lib/pdf-kit";
import type { JobForAlbum } from "@/lib/photo-projects";
import { buildScopeOfWork, scopeItemCount, scopeOfWorkText } from "@/lib/scope-of-work";
import { formatDateUS } from "@/lib/date-format";
import { fetchWriteUps, writeUpAmount, type WriteUpItem } from "@/lib/job-write-ups";

export function ScopeOfWorkCard({
  job,
  legacyScope,
  className,
}: {
  job: JobForAlbum;
  /** The job's old single scope text (jobs.scope), shown read-only when set. */
  legacyScope?: string | null;
  className?: string;
}) {
  const app = useAppContext();
  const qc = useQueryClient();
  const exportGate = useExportGate();
  const [busy, setBusy] = useState<"download" | "save" | null>(null);

  const roomsQ = useQuery({
    queryKey: ["job-rooms", job.id],
    queryFn: () => fetchJobRooms(job.id),
  });
  const scope = useMemo(() => buildScopeOfWork(roomsQ.data?.rooms ?? []), [roomsQ.data]);
  /*
   * FE11: what the write-ups say was done, under each room. Read alongside
   * the scope, never mixed into it — the scope is what is to be done, these
   * are what was.
   */
  const writeUpsQ = useQuery({
    queryKey: ["job-write-ups", job.id],
    queryFn: () => fetchWriteUps(job.id),
  });
  const doneByRoom = useMemo(() => {
    const by = new Map<string | null, WriteUpItem[]>();
    for (const i of writeUpsQ.data?.items ?? []) {
      by.set(i.room_id, [...(by.get(i.room_id) ?? []), i]);
    }
    return by;
  }, [writeUpsQ.data]);
  const doneList = (roomId: string | null) => {
    const done = doneByRoom.get(roomId);
    if (!done?.length) return null;
    return (
      <ul className="ml-4 text-sm text-muted-foreground" data-write-up-done>
        {done.map((i) => (
          <li key={i.id}>
            <span className="tabular-nums">{formatDateUS(i.visit_date)}</span> — done:{" "}
            {i.description}
            {writeUpAmount(i) ? ` (${writeUpAmount(i)})` : ""}
          </li>
        ))}
      </ul>
    );
  };
  const count = scopeItemCount(scope);
  const older = legacyScope?.trim() || "";
  const english = [scopeOfWorkText(scope), older].filter(Boolean).join("\n\n");
  const [spanish, setSpanish] = useState(false);

  const build = async () => {
    const { buildScopeOfWorkPdf } = await import("@/lib/scope-of-work-pdf");
    return buildScopeOfWorkPdf({
      job: {
        job_number: job.job_number ?? null,
        job_name: job.job_name ?? null,
        customer_name: job.customer_name ?? null,
        address: job.address ?? null,
      },
      scope,
    });
  };

  async function download() {
    setBusy("download");
    try {
      const built = await build();
      // Downloads are logged and limited, like every other report (export-guard).
      await exportGate.runExport({
        surface: "scope-of-work",
        entity: job.job_number ?? job.id,
        recordCount: count,
        format: "pdf",
        filters: { job_id: job.id },
        download: () => downloadPdf(built.bytes, built.filename),
      });
    } catch (e) {
      toast.error("The scope of work could not be made", {
        description: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    setBusy("save");
    try {
      const built = await build();
      await uploadDocumentFile({
        file: new File([built.bytes.slice().buffer as ArrayBuffer], built.filename, {
          type: "application/pdf",
        }),
        scope: { locationId: job.location_id, jobId: job.id, accountId: job.account_id ?? null },
        // The job's report column, with the drying report; no new document type.
        docType: "job_report",
        userId: app.userId ?? null,
        name: `Scope of work - ${job.job_number ?? "job"} (${shortDate(new Date().toISOString())})`,
      });
      void qc.invalidateQueries({ queryKey: ["job-documents", job.id] });
      toast.success("Scope of work saved to the job's documents");
    } catch (e) {
      toast.error("The scope of work did not save", {
        description: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className={className} data-scope-of-work>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0 pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <ClipboardList className="size-4" /> Scope of work by room
          {count > 0 && (
            <span className="text-xs font-normal tabular-nums text-muted-foreground">
              · {count} item{count === 1 ? "" : "s"}
            </span>
          )}
        </CardTitle>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            size="sm"
            variant={spanish ? "secondary" : "outline"}
            disabled={roomsQ.isLoading || !english}
            onClick={() => setSpanish((v) => !v)}
            title="Show this scope in Spanish for the crew"
            data-scope-translate
          >
            <Languages className="mr-1.5 size-3.5" />
            {spanish ? "Hide Spanish" : "Translate"}
          </Button>
          {exportGate.allowed && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy != null || roomsQ.isLoading}
              onClick={() => void download()}
              title="Download every room's scope as one PDF"
            >
              {busy === "download" ? (
                <Loader2 className="mr-1.5 size-3.5 animate-spin" />
              ) : (
                <Download className="mr-1.5 size-3.5" />
              )}
              Generate Scope
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            disabled={busy != null || roomsQ.isLoading || count === 0 || app.writesDisabled}
            onClick={() => void save()}
            title="File the Scope-of-Work PDF on the job's Documents"
          >
            {busy === "save" ? (
              <Loader2 className="mr-1.5 size-3.5 animate-spin" />
            ) : (
              <FileUp className="mr-1.5 size-3.5" />
            )}
            Save to documents
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {roomsQ.isError ? (
          <p className="text-sm text-destructive">
            Rooms could not be loaded — this is not an empty scope.
          </p>
        ) : roomsQ.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : scope.length === 0 && !older && doneByRoom.size === 0 ? (
          <p className="text-sm text-muted-foreground">
            No room has scope yet. Type it under each room on the Rooms tab.
          </p>
        ) : (
          /* FE1: a fixed-height box, each room's name pinned while its items
             scroll under it, so a big scope no longer grows the page. */
          <div
            className="max-h-[28rem] space-y-2 overflow-y-auto overscroll-contain pr-1"
            data-scope-scroll
          >
            {scope.map((room) => (
              <section key={room.roomId}>
                <h4 className="sticky top-0 z-[1] bg-card py-0.5 text-sm font-semibold">
                  {room.label}
                </h4>
                <ul className="ml-4 list-disc text-sm">
                  {room.items.map((item) => (
                    <li key={item.key}>{item.text}</li>
                  ))}
                </ul>
                {doneList(room.roomId)}
              </section>
            ))}
            {/* Rooms with write-ups but no scope, and lines with no room. */}
            {[...doneByRoom.keys()]
              .filter((k) => !scope.some((r) => r.roomId === k))
              .sort((a, b) => (a === null ? 1 : b === null ? -1 : 0))
              .map((k) => {
                const room = k ? roomsQ.data?.rooms.find((r) => r.id === k) : null;
                return (
                  <section key={k ?? "general-done"}>
                    <h4 className="sticky top-0 z-[1] bg-card py-0.5 text-sm font-semibold">
                      {room ? roomLabel(room) : "General"}
                    </h4>
                    {doneList(k)}
                  </section>
                );
              })}
            {older && (
              <section>
                <h4 className="sticky top-0 z-[1] bg-card py-0.5 text-sm font-semibold">General</h4>
                <p className="whitespace-pre-wrap text-sm">{older}</p>
              </section>
            )}
            {spanish && english && (
              <WorkOrderTranslation
                inline
                entityType="job"
                entityId={job.id}
                field="room_scope"
                text={english}
              />
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
