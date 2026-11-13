/**
 * Job report review panel.
 *
 * Two jobs, in order. First the report is ASSEMBLED — David, reading a
 * generated one on a call: "That's pulling random information... I don't need
 * all this information in here... we should have a report section here that's
 * blank. And you manually have to choose what updates you want to put in,
 * meaning the updates from today's field form, the updates, today's updated
 * pictures, or select the updated pictures that you want to put in instead of
 * just giving me this all this jibber." So the composer starts with nothing
 * ticked, and Generate stays off until something is.
 *
 * Then the review step, which is deliberately unmissable: a draft is shown with
 * a standing warning, the underlying figures sit beside the narrative so a
 * reader can check every number against a row, and export/attach/email are
 * locked until the report has been approved by a person.
 */
import { ReportDatesPicker } from "@/components/report-dates-picker";
import { ALL_DAYS, snapshotPeriodLabel, type ReportDates } from "@/lib/job-report-dates";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { toastDbError } from "@/lib/db-errors";
import { useServerFn } from "@tanstack/react-start";
import {
  AlertTriangle,
  Check,
  Download,
  Eraser,
  FileText,
  Images,
  Mail,
  Paperclip,
  Sparkles,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { RecordFocus } from "@/lib/job-page-search";

import { useAppContext, useWritesDisabled } from "@/components/app-context";
import { EmailComposer } from "@/components/email-composer";
import { JobPhotoPicker } from "@/components/job-photo-picker";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  REPORT_SECTION_DEFS,
  REPORT_SECTION_GROUPS,
  emptyReportReason,
  emptySections,
  lastUsedSections,
  type ReportSections,
} from "@/lib/job-report-sections";
import { loadAllJobPhotos } from "@/lib/job-photos";
import { generateJobReport } from "@/lib/job-reports.functions";
import {
  REPORT_TYPES,
  REPORT_TYPE_BLURB,
  REPORT_TYPE_LABEL,
  approveReport,
  clearDraftReports,
  attachReportToJob,
  buildReportPdf,
  downloadReportPdf,
  reportFileName,
  suggestedReportName,
  figuresForSections,
  listJobReports,
  reportBody,
  templateReason,
  reportContentsSummary,
  reportPhotoIds,
  reportSections,
  saveReportEdit,
  snapshotGaps,
  snapshotLabourNote,
  type JobReport,
  type JobReportType,
} from "@/lib/job-reports";
import { useCan } from "@/lib/permissions";
import { checkMarks } from "@/lib/report-provenance";

export function JobReportPanel({
  jobId,
  jobNumber,
  address,
  locationId,
  accountId,
  lossType,
  focusReport = null,
}: {
  jobId: string;
  jobNumber: string;
  address: string;
  locationId: string | null;
  accountId: string | null;
  /** Seeds the file-name suggestion; a report is named after the loss. */
  lossType?: string | null;
  /** A report to select and scroll to — History's "Open record". */
  focusReport?: RecordFocus | null;
}) {
  const app = useAppContext();
  const qc = useQueryClient();
  const generate = useServerFn(generateJobReport);
  const canSeeMoney = useCan("job.view_costs");

  const [type, setType] = useState<JobReportType>("carrier_submission");
  /*
   * David, 17 Sep: the saved report took its name from the preset he picked —
   * "Carrier submission — initial job review". He wanted "a box that we can
   * type in whatever we want... what the file name should be called", naming
   * "Mitigation Report" off the job type as the example.
   *
   * Suggested, never imposed: the box starts filled from the loss type and he
   * can replace the lot. Blank falls back to the suggestion rather than saving
   * an unnamed file.
   */
  const [fileName, setFileName] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draftText, setDraftText] = useState("");
  const [emailOpen, setEmailOpen] = useState(false);

  /* The blank start. Nothing is ticked until somebody ticks it. */
  const [sections, setSections] = useState<ReportSections>(() => emptySections());
  const [photoIds, setPhotoIds] = useState<string[]>([]);
  /** Which days the next report covers (22 Oct): one, several, or the full job. */
  const [dates, setDates] = useState<ReportDates>(ALL_DAYS);
  const [pickerOpen, setPickerOpen] = useState(false);
  const seeded = useRef(false);

  const reports = useQuery({
    queryKey: ["job-reports", jobId],
    queryFn: () => listJobReports(jobId),
  });

  /* Memoised because the seeding effect below depends on it and `?? []` would
     otherwise be a fresh array on every render. */
  const list = useMemo(() => reports.data ?? [], [reports.data]);
  const selected: JobReport | null = list.find((r) => r.id === selectedId) ?? list[0] ?? null;

  /*
   * History's "Open record" on a work order / report: select it and bring the
   * report into view, once per request and once the list has it.
   */
  const reportRef = useRef<HTMLDivElement | null>(null);
  const focusedFor = useRef<number | null>(null);
  const focusLoaded = !!focusReport && list.some((r) => r.id === focusReport.id);
  useEffect(() => {
    if (!focusReport || !focusLoaded || focusedFor.current === focusReport.at) return;
    focusedFor.current = focusReport.at;
    setSelectedId(focusReport.id);
    requestAnimationFrame(() =>
      reportRef.current?.scrollIntoView?.({ block: "start", behavior: "smooth" }),
    );
  }, [focusReport, focusLoaded]);

  /*
   * "So they are not re-ticking the same boxes daily": the sections come back
   * from the last report on THIS job. Once, on first load — after that the
   * office is editing its own choice and must not have it snap back.
   *
   * The pictures deliberately do NOT carry over. "Today's updated pictures" is
   * the request, and re-attaching yesterday's photographs to today's update is
   * the one mistake this panel could make silently.
   */
  useEffect(() => {
    if (seeded.current || !reports.isSuccess) return;
    seeded.current = true;
    setSections(lastUsedSections(list));
  }, [reports.isSuccess, list]);

  useEffect(() => {
    setDraftText(selected ? reportBody(selected) : "");
  }, [selected?.id, selected?.edited_narrative, selected?.narrative]);

  // Every picture on the job, read to the end: a report's picker that stops
  // at the newest 600 is a report that cannot carry the first week's damage.
  const photosQ = useQuery({
    queryKey: ["job-photos-for-report", jobId],
    queryFn: () => loadAllJobPhotos(jobId),
    // Only once someone opens the picker: reading every photo on a large job
    // to render a panel that may never be asked to choose one is waste.
    enabled: sections.photos && pickerOpen,
  });

  const gen = useMutation({
    mutationFn: async () => {
      const res = await generate({
        data: {
          job_id: jobId,
          report_type: type,
          language: "en",
          sections,
          photo_ids: sections.photos ? photoIds : [],
          dates,
        },
      });
      return res;
    },
    onSuccess: async (res) => {
      await qc.invalidateQueries({ queryKey: ["job-reports", jobId] });
      await qc.invalidateQueries({ queryKey: ["job-report-photos", jobId] });
      setSelectedId(res.report.id);
      const flagged = res.unsupported.length;
      toast.success(
        res.engine === "template" ? "Draft written from a template" : "Draft generated",
        {
          description:
            flagged > 0
              ? `${flagged} figure${flagged === 1 ? "" : "s"} could not be matched to the job and ${flagged === 1 ? "is" : "are"} marked for checking.`
              : res.engine === "template"
                ? templateReason(res.aiErrors)
                : res.missing.length > 0
                  ? `${res.missing.length} data gap${res.missing.length === 1 ? "" : "s"} noted in the report. Read before sending.`
                  : "Read it through and approve before it goes anywhere.",
        },
      );
    },
    onError: (e: Error) => toast.error("Could not generate the report", { description: e.message }),
  });

  const save = useMutation({
    mutationFn: () => saveReportEdit(selected!.id, draftText),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["job-reports", jobId] });
      toast.success("Edits saved");
    },
    onError: (e: Error) => toast.error("Could not save", { description: e.message }),
  });

  /*
   * FE7: a fresh start. The generated drafts leave the list (kept in the
   * database as superseded) and the composer goes back to blank. Approved
   * reports and the job itself are not touched.
   */
  const [clearOpen, setClearOpen] = useState(false);
  const clearGenerated = useMutation({
    mutationFn: () => clearDraftReports(jobId),
    onSuccess: async (cleared) => {
      setSections(emptySections());
      setPhotoIds([]);
      setDates(ALL_DAYS);
      setFileName("");
      setSelectedId(null);
      setDraftText("");
      setClearOpen(false);
      await qc.invalidateQueries({ queryKey: ["job-reports", jobId] });
      toast.success(
        cleared > 0
          ? `Cleared ${cleared} generated draft${cleared === 1 ? "" : "s"}`
          : "Report choices cleared",
        { description: "Approved reports and the job's own records were kept." },
      );
    },
    onError: (e: Error) => toastDbError(e, { action: "Clear generated data" }),
  });

  const approve = useMutation({
    mutationFn: async () => {
      // A figure the check could not match to the job is a question for a
      // person; approving past it would send the question to the carrier.
      if (checkMarks(draftText).length > 0) {
        throw new Error("Resolve every [[check: …]] figure in the text before approving.");
      }
      if (draftText !== reportBody(selected!)) await saveReportEdit(selected!.id, draftText);
      await approveReport(selected!.id, app.userId!);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["job-reports", jobId] });
      toast.success("Report approved");
    },
    onError: (e: Error) => toast.error("Could not approve", { description: e.message }),
  });

  const attach = useMutation({
    mutationFn: () =>
      attachReportToJob({
        report: selected!,
        jobId,
        jobNumber,
        address,
        locationId,
        accountId,
        userId: app.userId!,
        documentName: fileName.trim() || suggestedName,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["job-documents", jobId] });
      qc.invalidateQueries({ queryKey: ["job-reports", jobId] });
      toast.success("Attached to the job as a PDF document");
    },
    onError: (e: Error) => toast.error("Could not attach", { description: e.message }),
  });

  const suggestedName = suggestedReportName(lossType, selected?.report_type ?? type);

  const exportPdf = async () => {
    if (!selected) return;
    // An unhandled rejection here is a button that does nothing, which is the
    // one failure a user cannot tell apart from a button that is not wired up.
    try {
      const bytes = await buildReportPdf(selected, jobNumber, address);
      downloadReportPdf(bytes, reportFileName(fileName, suggestedName));
    } catch (e) {
      toastDbError(e, { action: "build this report PDF" });
    }
  };

  /* Money sections are hidden outright from a role that may not see cost and
     margin — the same rule REPORT_FILTER_DEFS applies on an estimate. */
  const defs = REPORT_SECTION_DEFS.filter((d) => !d.finance || canSeeMoney);
  const nothingChosen =
    emptyReportReason(sections, photoIds) ??
    (dates.mode === "days" && dates.days.length === 0
      ? "Choose at least one day, or switch to Full job."
      : null);

  const chosenSectionsOf = selected ? reportSections(selected) : null;
  const attachedPhotos = selected ? reportPhotoIds(selected).length : 0;
  const gaps =
    selected && (!chosenSectionsOf || chosenSectionsOf.gaps) ? snapshotGaps(selected.snapshot) : [];
  const figures = selected ? figuresForSections(selected.snapshot, chosenSectionsOf) : [];
  const labourNote =
    selected && (!chosenSectionsOf || chosenSectionsOf.labour)
      ? snapshotLabourNote(selected.snapshot)
      : null;
  const isDraft = selected?.status === "draft";
  const marks = checkMarks(draftText);
  const writes = useWritesDisabled();
  const writesOff = app.writesDisabled;
  /*
   * A disabled button with no reason reads as broken - the client reported
   * these as "the buttons don't do anything" when they were refusing on
   * purpose. Draft and read-only are different refusals and say so separately.
   */
  const draftWhy = "Approve this report first — a draft is not sendable.";
  const offWhy = writes.reason ?? "You are in read-only preview.";
  const why = (needsApproval: boolean) =>
    writesOff ? offWhy : needsApproval && isDraft ? draftWhy : undefined;

  return (
    /* Its own size container: the panel now shares the Documents tab half and
       half with the documents list (David, 22 Sep), so a 1280px screen gives
       it about 600px, and viewport breakpoints would lay four columns into
       that. The grids below answer to the panel's width instead. */
    <Card className="@container">
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="flex items-center gap-2 text-sm">
          <FileText className="size-4" /> Reports
        </CardTitle>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={type} onValueChange={(v) => setType(v as JobReportType)}>
            <SelectTrigger className="h-8 w-[190px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {REPORT_TYPES.map((t) => (
                <SelectItem key={t} value={t} className="text-xs">
                  {REPORT_TYPE_LABEL[t]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            className="h-8"
            disabled={gen.isPending || writesOff || !!nothingChosen}
            title={writesOff ? offWhy : (nothingChosen ?? undefined)}
            onClick={() => gen.mutate()}
          >
            <Sparkles className="mr-1 size-3.5" />
            {gen.isPending ? "Generating…" : "Generate draft"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-8"
            disabled={writesOff || clearGenerated.isPending}
            title={writesOff ? offWhy : "Start the next report from blank"}
            onClick={() => setClearOpen(true)}
          >
            <Eraser className="mr-1 size-3.5" />
            Clear generated data
          </Button>
        </div>
        <AlertDialog open={clearOpen} onOpenChange={setClearOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Clear generated report data?</AlertDialogTitle>
              <AlertDialogDescription>
                Draft reports on this job that were never approved leave the list, and the report
                choices — what goes in, pictures, dates and file name — start blank. Approved
                reports, documents and everything on the job itself are kept.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={clearGenerated.isPending}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                disabled={clearGenerated.isPending}
                onClick={(e) => {
                  e.preventDefault();
                  clearGenerated.mutate();
                }}
              >
                {clearGenerated.isPending ? "Clearing…" : "Clear"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardHeader>

      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">{REPORT_TYPE_BLURB[type]}</p>

        <ReportDatesPicker jobId={jobId} value={dates} onChange={setDates} />

        {/* ------------------------------------------------------------- */}
        {/* What goes in. Blank until ticked — the whole point of the panel */}
        {/* ------------------------------------------------------------- */}
        <div className="rounded border">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
            <div className="text-xs font-medium">What goes in this report</div>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              disabled={!!nothingChosen && photoIds.length === 0}
              onClick={() => {
                setSections(emptySections());
                setPhotoIds([]);
              }}
            >
              Clear all
            </Button>
          </div>
          {/*
            Four columns rather than one column of eleven. David, 16 Sep: the
            panel was "one long scroll" to get through before he could generate
            anything. Same switches, same order within each group — it is the
            shape that changed, not the choice. Columns collapse to one on a
            phone, where a single list is the right answer anyway.
          */}
          <div className="grid gap-x-4 gap-y-3 p-3 @lg:grid-cols-2 @4xl:grid-cols-4">
            {REPORT_SECTION_GROUPS.map((group) => {
              const inGroup = defs.filter((d) => d.group === group);
              if (inGroup.length === 0) return null;
              const onCount = inGroup.filter((d) => sections[d.key]).length;
              return (
                <div key={group} className="min-w-0">
                  <div className="mb-1 flex items-baseline justify-between gap-2 border-b pb-1">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      {group}
                    </span>
                    {onCount > 0 && (
                      <span className="text-[10px] tabular-nums text-muted-foreground">
                        {onCount} on
                      </span>
                    )}
                  </div>
                  <div className="space-y-1">
                    {inGroup.map((d) => (
                      <label
                        key={d.key}
                        title={d.hint}
                        className="flex cursor-pointer items-center justify-between gap-2 rounded px-1 py-1 hover:bg-muted/50"
                      >
                        <span className="min-w-0 text-xs font-medium">{d.label}</span>
                        <Switch
                          checked={sections[d.key]}
                          disabled={writesOff}
                          onCheckedChange={(v) => setSections((s) => ({ ...s, [d.key]: v }))}
                        />
                      </label>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>

          {sections.photos && (
            <div className="flex flex-wrap items-center gap-2 border-t px-3 py-2">
              <Button
                size="sm"
                variant="outline"
                className="h-8 text-xs"
                disabled={writesOff}
                onClick={() => setPickerOpen(true)}
              >
                <Images className="mr-1.5 size-3.5" />
                {photoIds.length === 0 ? "Choose photos" : "Change selection"}
              </Button>
              <span className="text-[11px] text-muted-foreground">
                {photoIds.length === 0
                  ? "No pictures chosen yet. Nothing is attached until you pick them."
                  : `${photoIds.length} picture${photoIds.length === 1 ? "" : "s"} will be attached.`}
              </span>
            </div>
          )}

          {nothingChosen && (
            <p className="border-t px-3 py-2 text-[11px] text-muted-foreground">{nothingChosen}</p>
          )}
        </div>

        {list.length === 0 && !gen.isPending && (
          <div className="rounded border border-dashed p-6 text-center text-sm text-muted-foreground">
            No report generated yet. Tick what belongs in it above — the field form, the pictures,
            the dates — and only those are written up. Every draft still needs a person to read and
            approve it.
          </div>
        )}

        {list.length > 1 && (
          <div className="flex flex-wrap gap-1">
            {list.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => setSelectedId(r.id)}
                className={`rounded border px-2 py-1 text-xs ${
                  selected?.id === r.id ? "border-primary bg-primary/5" : "border-border"
                }`}
              >
                {REPORT_TYPE_LABEL[r.report_type]} v{r.version}
                {/* Which days it covers, so a day report is told from the full job's. */}
                {snapshotPeriodLabel(r.snapshot) !== "Full job"
                  ? ` · ${snapshotPeriodLabel(r.snapshot)}`
                  : ""}
                {r.language === "es" ? " · ES" : ""}
                {r.status === "approved" ? " ✓" : ""}
              </button>
            ))}
          </div>
        )}

        <div ref={reportRef} data-report-id={selected?.id} className="scroll-mt-24" />
        {selected && (
          <>
            {isDraft ? (
              <Alert variant="destructive">
                <AlertTriangle className="size-4" />
                <AlertTitle>Draft — not checked by a person yet</AlertTitle>
                <AlertDescription className="text-xs">
                  Read every sentence against the figures below before this leaves the building. A
                  wrong detail in a carrier submission is a liability. Nothing can be exported,
                  attached or emailed until you approve it.
                </AlertDescription>
              </Alert>
            ) : (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Badge variant="outline" className="gap-1">
                  <Check className="size-3" /> Approved
                </Badge>
                {selected.approved_at && new Date(selected.approved_at).toLocaleString("en-US")}
              </div>
            )}

            {/* What this particular report was built from. A reader of an old
                report needs to know it was not assembled at all. */}
            <p className="rounded border px-3 py-2 text-[11px] text-muted-foreground">
              <span className="font-medium text-foreground">Contains: </span>
              {reportContentsSummary(selected)}
              {selected.model && (
                <>
                  <br />
                  <span className="font-medium text-foreground">Written by: </span>
                  {selected.model}
                </>
              )}
            </p>

            {isDraft && marks.length > 0 && (
              <div className="rounded border border-amber-300 bg-amber-50 p-3 text-xs dark:bg-amber-950/20">
                <div className="mb-1 font-medium">
                  {marks.length} figure{marks.length === 1 ? "" : "s"} to check before approving
                </div>
                <p className="text-muted-foreground">
                  These could not be matched to anything on the job, so they are marked
                  &ldquo;[[check: …]]&rdquo; in the text: {marks.join(", ")}. Correct or remove each
                  one. The report cannot be approved while any remain.
                </p>
              </div>
            )}

            {gaps.length > 0 && (
              <div className="rounded border border-amber-300 bg-amber-50 p-3 text-xs dark:bg-amber-950/20">
                <div className="mb-1 font-medium">Not recorded on this job</div>
                <ul className="list-inside list-disc space-y-0.5 text-muted-foreground">
                  {gaps.map((g) => (
                    <li key={g}>{g}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* Attached photographs. Said here because a report that silently
                holds fourteen, and a report that holds none, look identical
                from this panel. */}
            {attachedPhotos > 0 && (
              <p className="rounded border px-3 py-2 text-xs text-muted-foreground">
                {attachedPhotos} photo{attachedPhotos === 1 ? "" : "s"} attached. The exported PDF
                names the count but does not draw them in yet.
              </p>
            )}

            <div className="grid gap-3 @3xl:grid-cols-[1fr_260px]">
              <Textarea
                value={draftText}
                onChange={(e) => setDraftText(e.target.value)}
                rows={22}
                className="font-mono text-xs leading-relaxed"
                readOnly={writesOff}
              />
              <div className="rounded border">
                <div className="border-b px-2 py-1.5 text-xs font-medium">Underlying figures</div>
                {/* "It says total hours — where is it picking it up from?" is
                    the question this line exists to answer, on the report
                    itself rather than only in the labour panel. */}
                {labourNote && (
                  <div className="border-b bg-muted/40 px-2 py-1.5 text-[11px] text-muted-foreground">
                    <span className="font-medium text-foreground">Labor source: </span>
                    {labourNote}
                  </div>
                )}
                {figures.length === 0 ? (
                  <p className="px-2 py-2 text-[11px] text-muted-foreground">
                    This report carries no figures — nothing that prints numbers was selected.
                  </p>
                ) : (
                  <div className="divide-y">
                    {figures.map((f) => (
                      <div key={f.label} className="px-2 py-1.5">
                        <div className="flex items-baseline justify-between gap-2 text-xs">
                          <span className="text-muted-foreground">{f.label}</span>
                          <span className="font-medium">{f.value}</span>
                        </div>
                        <div className="text-[10px] text-muted-foreground/70">{f.source}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="report-file-name" className="text-xs">
                File name
              </Label>
              <Input
                id="report-file-name"
                className="h-8 max-w-sm text-[13px]"
                value={fileName}
                placeholder={suggestedName}
                onChange={(e) => setFileName(e.target.value)}
              />
              <p className="text-[11px] text-muted-foreground">
                What the downloaded and attached file is called. Leave it as it is to use &ldquo;
                {suggestedName}&rdquo;.
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                className="h-8"
                title={writesOff ? offWhy : undefined}
                disabled={writesOff || save.isPending || draftText === reportBody(selected)}
                onClick={() => save.mutate()}
              >
                Save edits
              </Button>
              {isDraft && (
                <Button
                  size="sm"
                  className="h-8"
                  disabled={writesOff || approve.isPending || marks.length > 0}
                  title={
                    marks.length > 0
                      ? "Resolve every [[check: …]] figure in the text first."
                      : undefined
                  }
                  onClick={() => approve.mutate()}
                >
                  <Check className="mr-1 size-3.5" /> I have read this — approve
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                className="h-8"
                disabled={isDraft}
                title={isDraft ? draftWhy : undefined}
                onClick={exportPdf}
              >
                <Download className="mr-1 size-3.5" /> PDF
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-8"
                disabled={isDraft || writesOff || attach.isPending}
                title={why(true)}
                onClick={() => attach.mutate()}
              >
                <Paperclip className="mr-1 size-3.5" /> Attach to job
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-8"
                disabled={isDraft || writesOff}
                title={why(true)}
                onClick={() => setEmailOpen(true)}
              >
                <Mail className="mr-1 size-3.5" /> Email
              </Button>
            </div>

            {(writesOff || isDraft) && (
              <p className="text-[11px] text-muted-foreground">{writesOff ? offWhy : draftWhy}</p>
            )}

            <EmailComposer
              open={emailOpen}
              onOpenChange={setEmailOpen}
              context={{
                category: "notification",
                jobId,
                accountId,
                locationId,
                variables: {
                  job_number: jobNumber,
                  address,
                  report: reportBody(selected),
                },
              }}
            />
          </>
        )}
      </CardContent>

      <JobPhotoPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        photos={photosQ.data ?? []}
        loading={photosQ.isLoading}
        error={photosQ.isError ? "The job's photos could not be loaded." : null}
        initial={photoIds}
        title="Choose photos for this report"
        description="Tick the pictures to attach. Shift-click selects a run."
        confirmLabel={(n) => (n === 0 ? "Attach none" : `Attach ${n} photo${n === 1 ? "" : "s"}`)}
        onConfirm={(next) => {
          setPickerOpen(false);
          setPhotoIds(next);
        }}
      />
    </Card>
  );
}
