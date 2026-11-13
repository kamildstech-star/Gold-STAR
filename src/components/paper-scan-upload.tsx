/**
 * "Sign-in paper" and "Supply list paper" beside the day on the Field Form
 * tab (12 Nov). Upload a photo or PDF of the paper sheet — or take one with
 * the camera — and it is:
 *
 *  1. refused if that same photo was scanned on this job before;
 *  2. read by the vision model, every row shown to check, the paper's own
 *     date taken as the sheet's date;
 *  3. for a sign-in sheet, the missing times asked for: anyone with no time
 *     out gets the default (5 PM) unless one is typed, and a lunch can be
 *     given for everyone with none written;
 *  4. saved onto that date's sheet (rows signed on the paper count as signed,
 *     so the T&M bill bills them) and the photo filed in Documents as a PDF
 *     named with that date — not in Pictures.
 *
 * The pure rules are src/lib/paper-scan.ts.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle, Camera, ChevronDown, FileUp, Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { useAppContext } from "@/components/app-context";
import { useLabelLanguage } from "@/components/bilingual";
import { useHandheld } from "@/components/file-pick";
import type { Person } from "@/components/tm-form-editors";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { toastDbError } from "@/lib/db-errors";
import { fileIntoJobFolder, uploadDocumentFile } from "@/lib/documents";
import { FIELD_CAMERA_FAILURE, openFieldCamera, stopCamera } from "@/lib/field-camera/capture";
import { newId } from "@/lib/offline-queue";
import {
  DEFAULT_TIME_OUT,
  applySupplyScan,
  fillMissingTimes,
  missingTimes,
  paperScanDocName,
  paperScanFilename,
  scannedHours,
  usPaperDate,
  type PaperScanKind,
} from "@/lib/paper-scan";
import { photoHash, photoToPdf, sheetDataUrl } from "@/lib/paper-scan-pdf";
import { applyScan, type ScannedRow } from "@/lib/sign-in-scan";
import { readSignInSheet } from "@/lib/sign-in-scan.functions";
import { readSupplySheet } from "@/lib/supply-sheet-scan.functions";
import { signInHours } from "@/lib/tm-bill";
import { refreshTmDerived } from "@/lib/tm-derived";
import {
  TM_FORM_META,
  findPaperScan,
  getTmForm,
  jobLocationFor,
  jobNameFor,
  mergePaperScans,
  prefillSupplyList,
  writeTmForm,
  type JobFacts,
  type SignInPayload,
  type SupplyLine,
  type SupplyListPayload,
} from "@/lib/tm-forms";
import { laborCodes, type TmRateCode } from "@/lib/tm-rate-codes";
import { cn } from "@/lib/utils";

export type PaperScanJob = {
  id: string;
  location_id: string;
  account_id: string | null;
  job_number: string | null;
};

type SignInReview = {
  kind: "sign_in";
  rows: (ScannedRow & { keep: boolean })[];
  heading: string;
};
type SupplyReview = {
  kind: "supply_list";
  lines: (SupplyLine & { keep: boolean })[];
  totalCrew: string;
};
type Review = (SignInReview | SupplyReview) & {
  file: File;
  hash: string;
  date: string;
  /** False when the paper had no readable date and the picked day was used. */
  dateFromPaper: boolean;
};

const PICK_ACCEPT = "image/*,application/pdf";

export function PaperScanUpload({
  kind,
  job,
  facts,
  day,
  people,
  catalogue,
  savedDays,
  disabled,
  onFiled,
}: {
  kind: PaperScanKind;
  job: PaperScanJob;
  facts: JobFacts;
  /** The day picked on the tab: the sheet's date when the paper has none. */
  day: string;
  people: readonly Person[];
  catalogue: readonly TmRateCode[];
  /** Days that already have a saved sheet of this kind. */
  savedDays: ReadonlySet<string>;
  disabled?: boolean;
  /** The sheet was saved for `date`: the tab moves to that day. */
  onFiled: (date: string) => void;
}) {
  const { bi } = useLabelLanguage();
  const app = useAppContext();
  const qc = useQueryClient();
  const handheld = useHandheld();
  const readSignIn = useServerFn(readSignInSheet);
  const readSupply = useServerFn(readSupplySheet);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const cameraInput = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [review, setReview] = useState<Review | null>(null);
  const meta = TM_FORM_META[kind];
  const label =
    kind === "sign_in"
      ? bi("Sign-in paper", "Hoja de entrada")
      : bi("Supply paper", "Hoja de materiales");
  const blocked = disabled || app.writesDisabled || busy != null;

  async function pick(file: File) {
    if (app.writesDisabled) {
      toast.error(app.writesDisabledReason ?? "Writes disabled");
      return;
    }
    setBusy(bi("Checking…", "Revisando…"));
    try {
      const hash = await photoHash(file);
      const dup = await findPaperScan(job.id, hash);
      if (dup) {
        toast.error(bi("This sheet was already uploaded", "Esta hoja ya se subió"), {
          description: `It is on the ${TM_FORM_META[dup.kind].title.toLowerCase()} for ${usPaperDate(dup.form_date)}. The same photo is not added twice.`,
        });
        return;
      }
      setBusy(bi("Reading the sheet…", "Leyendo la hoja…"));
      const image = await sheetDataUrl(file);
      if (kind === "sign_in") {
        const res = await readSignIn({ data: { image_data_url: image } });
        if (!res.ok) {
          toast.error(bi("The sheet could not be read", "No se pudo leer la hoja"), {
            description: res.error,
          });
          return;
        }
        setReview({
          kind: "sign_in",
          file,
          hash,
          date: res.sheet.date ?? day,
          dateFromPaper: Boolean(res.sheet.date),
          heading: [res.sheet.jobName, res.sheet.jobLocation].filter(Boolean).join(" · "),
          rows: res.sheet.rows.map((r) => ({ ...r, keep: true })),
        });
      } else {
        const res = await readSupply({ data: { image_data_url: image } });
        if (!res.ok) {
          toast.error(bi("The sheet could not be read", "No se pudo leer la hoja"), {
            description: res.error,
          });
          return;
        }
        setReview({
          kind: "supply_list",
          file,
          hash,
          date: res.sheet.date ?? day,
          dateFromPaper: Boolean(res.sheet.date),
          totalCrew: res.sheet.totalCrew,
          lines: res.sheet.lines.map((l) => ({ ...l, keep: true })),
        });
      }
    } catch (e) {
      toast.error(bi("The sheet could not be read", "No se pudo leer la hoja"), {
        description: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setBusy(null);
    }
  }

  const onInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (f) void pick(f);
  };

  return (
    <div className="flex items-center gap-1" data-paper-scan={kind}>
      <input
        ref={fileInput}
        type="file"
        accept={PICK_ACCEPT}
        className="sr-only"
        onChange={onInput}
      />
      <input
        ref={cameraInput}
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        onChange={onInput}
      />
      {/* 13 Nov: one button per sheet — upload a file or take a photo, from its menu. */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            className="h-11 gap-1.5 px-3 sm:h-10"
            disabled={blocked}
            title={`Upload or photograph the paper ${meta.paperTitle}`}
            data-paper-scan-button
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : <FileUp className="size-4" />}
            <span className="max-w-[10rem] truncate">{busy ?? label}</span>
            {!busy && <ChevronDown className="size-3.5 text-muted-foreground" />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[13rem]">
          <DropdownMenuItem
            className="min-h-11 gap-2 sm:min-h-9"
            onSelect={() => fileInput.current?.click()}
          >
            <FileUp className="size-4" />
            {bi("Upload photo or PDF", "Subir foto o PDF")}
          </DropdownMenuItem>
          <DropdownMenuItem
            className="min-h-11 gap-2 sm:min-h-9"
            onSelect={() => (handheld ? cameraInput.current?.click() : setCameraOpen(true))}
          >
            <Camera className="size-4" />
            {bi("Take a photo", "Tomar foto")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {cameraOpen && (
        <CameraDialog
          title={`Photograph the ${meta.paperTitle}`}
          onClose={() => setCameraOpen(false)}
          onCapture={(f) => {
            setCameraOpen(false);
            void pick(f);
          }}
        />
      )}

      {review && (
        <ReviewDialog
          review={review}
          onChange={setReview}
          onClose={() => setReview(null)}
          job={job}
          facts={facts}
          people={people}
          catalogue={catalogue}
          savedDays={savedDays}
          onSaved={(date) => {
            setReview(null);
            void qc.invalidateQueries({ queryKey: ["tm-forms", job.id] });
            void qc.invalidateQueries({ queryKey: ["tm-form", job.id] });
            void qc.invalidateQueries({ queryKey: ["job-documents", job.id] });
            refreshTmDerived(qc, job.id);
            onFiled(date);
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Checking what was read                                              */
/* ------------------------------------------------------------------ */

function ReviewDialog({
  review,
  onChange,
  onClose,
  onSaved,
  job,
  facts,
  people,
  catalogue,
  savedDays,
}: {
  review: Review;
  onChange: (r: Review) => void;
  onClose: () => void;
  onSaved: (date: string) => void;
  job: PaperScanJob;
  facts: JobFacts;
  people: readonly Person[];
  catalogue: readonly TmRateCode[];
  savedDays: ReadonlySet<string>;
}) {
  const { bi } = useLabelLanguage();
  const app = useAppContext();
  const [saving, setSaving] = useState(false);
  const [defaults, setDefaults] = useState({
    timeOut: DEFAULT_TIME_OUT,
    lunchStart: "",
    lunchEnd: "",
  });
  const labor = useMemo(() => laborCodes(catalogue), [catalogue]);
  const codes = useMemo(() => new Set(labor.map((c) => c.code)), [labor]);
  const labelOf = useMemo(() => new Map(catalogue.map((c) => [c.code, c.label])), [catalogue]);
  const meta = TM_FORM_META[review.kind];
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(review.date);

  const keptRows = review.kind === "sign_in" ? review.rows.filter((r) => r.keep) : [];
  const filledRows = fillMissingTimes(keptRows, defaults);
  const missing = missingTimes(keptRows);
  const hours = scannedHours(filledRows);
  const keptLines = review.kind === "supply_list" ? review.lines.filter((l) => l.keep) : [];
  const count = review.kind === "sign_in" ? keptRows.length : keptLines.length;

  const editRow = (i: number, patch: Partial<ScannedRow & { keep: boolean }>) =>
    review.kind === "sign_in" &&
    onChange({ ...review, rows: review.rows.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const editLine = (i: number, patch: Partial<SupplyLine & { keep: boolean }>) =>
    review.kind === "supply_list" &&
    onChange({
      ...review,
      lines: review.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)),
    });

  async function save() {
    if (!validDate || count === 0) return;
    if (app.writesDisabled) {
      toast.error(app.writesDisabledReason ?? "Writes disabled");
      return;
    }
    setSaving(true);
    const scope = { locationId: job.location_id, jobId: job.id, accountId: job.account_id };
    const date = review.date;
    try {
      // The paper first, as a PDF named with its own date, in this sheet's folder.
      const name = paperScanDocName(review.kind, date);
      const pdf = await photoToPdf(review.file, name);
      const doc = await uploadDocumentFile({
        file: new File(
          [pdf.slice().buffer as ArrayBuffer],
          paperScanFilename(review.kind, date, job.job_number),
          {
            type: "application/pdf",
          },
        ),
        scope,
        docType: "job_report",
        userId: app.userId ?? null,
        name,
      });
      await fileIntoJobFolder({
        documentId: doc.id,
        scope,
        folderName: meta.folder,
        folderAliases: meta.formerFolders,
        userId: app.userId ?? null,
      }).catch(() => undefined);
      const scan = { hash: review.hash, documentId: doc.id, at: new Date().toISOString() };

      // Then the rows onto that day's sheet.
      let payload: SignInPayload | SupplyListPayload;
      let summary: string;
      if (review.kind === "sign_in") {
        const stored = await getTmForm(job.id, "sign_in", date);
        const base: SignInPayload = stored?.payload ?? {
          jobName: jobNameFor(facts),
          jobLocation: jobLocationFor(facts),
          rows: [],
          removed: [],
        };
        const res = applyScan(
          base,
          filledRows.map(({ keep: _keep, ...r }) => r),
          { newId, people, codes },
        );
        payload = { ...res.sheet, paperScans: mergePaperScans(res.sheet.paperScans, [scan]) };
        summary = `${res.added} added, ${res.updated} filled in · ${hours} h worked`;
      } else {
        const stored = await getTmForm(job.id, "supply_list", date);
        const base =
          stored?.payload ?? prefillSupplyList({ job: facts, crewCount: 0, previous: null });
        const res = applySupplyScan(
          base,
          keptLines.map(({ code, qty }) => ({ code, qty })),
          review.totalCrew,
        );
        payload = { ...res.sheet, paperScans: mergePaperScans(res.sheet.paperScans, [scan]) };
        summary = `${res.added} line${res.added === 1 ? "" : "s"} added`;
      }
      await writeTmForm({
        id: newId(),
        job_id: job.id,
        kind: review.kind,
        form_date: date,
        payload: payload as unknown as Record<string, unknown>,
        captured_at: new Date().toISOString(),
        created_by: app.userId ?? null,
      });
      toast.success(`${meta.title} for ${usPaperDate(date)} saved`, {
        description: `${summary}. On the T&M bill for that day; the paper is in Documents › ${meta.folder}.`,
      });
      onSaved(date);
    } catch (e) {
      toastDbError(e, { action: `Save the paper ${meta.paperTitle}` });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !saving && onClose()}>
      <DialogContent className="flex max-h-[92vh] max-w-5xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>
            {bi(`Check the paper ${meta.short.toLowerCase()} sheet`, "Revise la hoja de papel")} ·{" "}
            {count}
          </DialogTitle>
          <DialogDescription>
            {(review.kind === "sign_in" && review.heading) || meta.paperTitle}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-end gap-3">
          <label className="space-y-1">
            <span className="block text-sm font-semibold">
              {bi("Sheet date", "Fecha de la hoja")}
            </span>
            <Input
              type="date"
              className="h-11 w-44 sm:h-9"
              value={review.date}
              onChange={(e) => onChange({ ...review, date: e.target.value, dateFromPaper: false })}
            />
          </label>
          {review.kind === "supply_list" && (
            <label className="space-y-1">
              <span className="block text-sm font-semibold">
                {bi("Total crew", "Personal total")}
              </span>
              <Input
                inputMode="numeric"
                className="h-11 w-24 sm:h-9"
                value={review.totalCrew}
                onChange={(e) =>
                  onChange({ ...review, totalCrew: e.target.value.replace(/[^0-9]/g, "") })
                }
              />
            </label>
          )}
          <p className="pb-2 text-xs text-muted-foreground">
            {review.dateFromPaper
              ? bi(
                  "Read from the paper. The sheet and the T&M bill use this date.",
                  "Leída del papel.",
                )
              : bi("Check the date: the paper's could not be read.", "Revise la fecha.")}
            {savedDays.has(review.date) &&
              ` ${bi("That day already has a sheet: these are added to it.", "Ese día ya tiene hoja: se agregan.")}`}
          </p>
        </div>

        {review.kind === "sign_in" && (missing.noOut.length > 0 || missing.noLunch.length > 0) && (
          <div
            className="space-y-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm"
            data-missing-times
          >
            <p className="flex items-start gap-2 font-medium text-foreground">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
              {[
                missing.noOut.length > 0 &&
                  `${missing.noOut.length} ${missing.noOut.length === 1 ? "person has" : "people have"} no time out`,
                missing.noLunch.length > 0 &&
                  `${missing.noLunch.length} ${missing.noLunch.length === 1 ? "has" : "have"} no lunch written`,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
            <div className="flex flex-wrap items-end gap-3">
              {missing.noOut.length > 0 && (
                <label className="space-y-1">
                  <span className="block text-xs text-muted-foreground">
                    {bi("Time out for them", "Hora de salida")}
                  </span>
                  <Input
                    type="time"
                    className="h-11 w-32 bg-background sm:h-9"
                    value={defaults.timeOut}
                    onChange={(e) => setDefaults((d) => ({ ...d, timeOut: e.target.value }))}
                  />
                </label>
              )}
              {missing.noLunch.length > 0 && (
                <div className="space-y-1">
                  <span className="block text-xs text-muted-foreground">
                    {bi("Lunch for them (blank = no break)", "Almuerzo (vacío = sin descanso)")}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <Input
                      type="time"
                      aria-label="Lunch start"
                      className="h-11 w-32 bg-background sm:h-9"
                      value={defaults.lunchStart}
                      onChange={(e) => setDefaults((d) => ({ ...d, lunchStart: e.target.value }))}
                    />
                    <span className="text-muted-foreground">–</span>
                    <Input
                      type="time"
                      aria-label="Lunch end"
                      className="h-11 w-32 bg-background sm:h-9"
                      value={defaults.lunchEnd}
                      onChange={(e) => setDefaults((d) => ({ ...d, lunchEnd: e.target.value }))}
                    />
                  </span>
                </div>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {bi(
                "Used for every empty box when you save. Type a time in a row below to give that person their own.",
                "Se usa en cada casilla vacía al guardar. Escriba una hora en la fila para cambiarla.",
              )}
            </p>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-auto rounded-md border">
          {review.kind === "sign_in" ? (
            <table className="w-full min-w-[50rem] text-sm" data-scan-rows>
              <thead className="sticky top-0 z-10 bg-muted text-left text-xs text-muted-foreground">
                <tr>
                  <th className="w-8 p-1.5" />
                  <th className="p-1.5">{bi("Employee", "Empleado")}</th>
                  <th className="w-20 p-1.5">{bi("Code", "Código")}</th>
                  <th className="w-24 p-1.5">{bi("In", "Entrada")}</th>
                  <th className="w-24 p-1.5">{bi("Lunch", "Almuerzo")}</th>
                  <th className="w-24 p-1.5">{bi("Back", "Regreso")}</th>
                  <th className="w-24 p-1.5">{bi("Out", "Salida")}</th>
                  <th className="w-14 p-1.5 text-center">{bi("Hotel", "Hotel")}</th>
                  <th className="w-16 p-1.5 text-center">{bi("Signed", "Firmó")}</th>
                  <th className="w-14 p-1.5 text-right">{bi("Hours", "Horas")}</th>
                </tr>
              </thead>
              <tbody>
                {review.rows.map((r, i) => {
                  const badCode = r.rateCode && !codes.has(r.rateCode);
                  const filled = fillMissingTimes([r], defaults)[0]!;
                  return (
                    <tr key={i} className={cn("border-t", !r.keep && "opacity-45")}>
                      <td className="p-1.5 text-center">
                        <Checkbox
                          checked={r.keep}
                          onCheckedChange={(v) => editRow(i, { keep: v === true })}
                          aria-label={`Add ${r.employee}`}
                        />
                      </td>
                      <td className="p-1">
                        <Input
                          className="h-8"
                          value={r.employee}
                          aria-label="Employee"
                          onChange={(e) => editRow(i, { employee: e.target.value })}
                        />
                      </td>
                      <td className="p-1">
                        <select
                          className={cn(
                            "h-8 w-full rounded-md border bg-background px-1 text-sm",
                            badCode && "border-warning",
                          )}
                          aria-label={`${r.employee} rate code`}
                          title={
                            badCode ? `"${r.rateCode}" is not a rate code; pick one` : undefined
                          }
                          value={codes.has(r.rateCode) ? r.rateCode : ""}
                          onChange={(e) => editRow(i, { rateCode: e.target.value })}
                        >
                          <option value="">{badCode ? `${r.rateCode}?` : "—"}</option>
                          {labor.map((c) => (
                            <option key={c.code} value={c.code}>
                              {c.code}
                            </option>
                          ))}
                        </select>
                      </td>
                      {(["timeIn", "lunchStart", "lunchEnd", "timeOut"] as const).map((k) => {
                        const fromDefault = r.keep && r.timeIn && !r[k] && filled[k];
                        return (
                          <td key={k} className="p-1">
                            <Input
                              type="time"
                              className={cn(
                                "h-8 px-1",
                                fromDefault && "border-warning/60 text-muted-foreground",
                              )}
                              aria-label={`${r.employee} ${k}`}
                              title={
                                fromDefault
                                  ? "Not on the paper: the default above is used"
                                  : undefined
                              }
                              value={r[k] || (fromDefault ? filled[k] : "")}
                              onChange={(e) => editRow(i, { [k]: e.target.value })}
                            />
                          </td>
                        );
                      })}
                      <td className="p-1.5 text-center">
                        <Checkbox
                          checked={r.lodging}
                          onCheckedChange={(v) => editRow(i, { lodging: v === true })}
                          aria-label={`${r.employee} hotel or per diem`}
                        />
                      </td>
                      <td className="p-1.5 text-center">
                        <Checkbox
                          checked={r.signed}
                          onCheckedChange={(v) => editRow(i, { signed: v === true })}
                          aria-label={`${r.employee} signed the paper`}
                        />
                      </td>
                      <td className="p-1.5 text-right tabular-nums">
                        {r.keep ? signInHours(filled).hours : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <table className="w-full text-sm" data-scan-lines>
              <thead className="sticky top-0 z-10 bg-muted text-left text-xs text-muted-foreground">
                <tr>
                  <th className="w-8 p-1.5" />
                  <th className="w-20 p-1.5">{bi("Code", "Código")}</th>
                  <th className="p-1.5">{bi("Item", "Artículo")}</th>
                  <th className="w-28 p-1.5 text-right">{bi("Quantity", "Cantidad")}</th>
                </tr>
              </thead>
              <tbody>
                {review.lines.map((l, i) => (
                  <tr key={l.code} className={cn("border-t", !l.keep && "opacity-45")}>
                    <td className="p-1.5 text-center">
                      <Checkbox
                        checked={l.keep}
                        onCheckedChange={(v) => editLine(i, { keep: v === true })}
                        aria-label={`Add ${l.code}`}
                      />
                    </td>
                    <td className="p-1.5 font-medium tabular-nums">{l.code}</td>
                    <td className="p-1.5 text-muted-foreground">{labelOf.get(l.code) ?? ""}</td>
                    <td className="p-1">
                      <Input
                        inputMode="decimal"
                        className="h-8 text-right"
                        aria-label={`${l.code} quantity`}
                        value={String(l.qty)}
                        onChange={(e) => editLine(i, { qty: Number(e.target.value) || 0 })}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <DialogFooter className="gap-2 sm:items-center sm:justify-between">
          <span className="text-xs text-muted-foreground">
            {review.kind === "sign_in"
              ? `${keptRows.length} ${keptRows.length === 1 ? "person" : "people"} · ${hours} h worked (in to out, less lunch). Rows signed on the paper count as signed on the T&M bill.`
              : bi(
                  "Lines already on that day's sheet keep their quantity; the paper fills the rest.",
                  "Las líneas ya guardadas conservan su cantidad.",
                )}
          </span>
          <div className="flex gap-2">
            <Button variant="outline" className="h-11 sm:h-9" disabled={saving} onClick={onClose}>
              {bi("Cancel", "Cancelar")}
            </Button>
            <Button
              className="h-11 sm:h-9"
              disabled={saving || count === 0 || !validDate}
              onClick={() => void save()}
            >
              {saving && <Loader2 className="mr-1.5 size-4 animate-spin" />}
              {validDate
                ? bi(
                    `Save to ${usPaperDate(review.date)}`,
                    `Guardar en ${usPaperDate(review.date)}`,
                  )
                : bi("Pick a date", "Elija fecha")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* The camera, on a computer                                           */
/* ------------------------------------------------------------------ */

/**
 * A phone's camera opens through the file input's `capture`; a laptop
 * ignores that, so its webcam is opened here and one frame taken.
 */
function CameraDialog({
  title,
  onClose,
  onCapture,
}: {
  title: string;
  onClose: () => void;
  onCapture: (file: File) => void;
}) {
  const video = useRef<HTMLVideoElement | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const [error, setError] = useState<{ title: string; detail: string } | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let live = true;
    openFieldCamera("environment")
      .then((s) => {
        if (!live) return stopCamera(s);
        stream.current = s;
        if (video.current) {
          video.current.srcObject = s;
          void video.current.play().then(() => setReady(true));
        }
      })
      .catch((e: unknown) => {
        const reason = (e as { reason?: keyof typeof FIELD_CAMERA_FAILURE }).reason ?? "unknown";
        setError(FIELD_CAMERA_FAILURE[reason] ?? FIELD_CAMERA_FAILURE.unknown);
      });
    return () => {
      live = false;
      stopCamera(stream.current);
      stream.current = null;
    };
  }, []);

  function take() {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    const canvas = document.createElement("canvas");
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    canvas.getContext("2d")!.drawImage(v, 0, 0);
    canvas.toBlob(
      (b) => {
        if (!b) return;
        onCapture(new File([b], `paper-sheet-${Date.now()}.jpg`, { type: "image/jpeg" }));
      },
      "image/jpeg",
      0.92,
    );
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>Hold the sheet flat, straight on, in good light.</DialogDescription>
        </DialogHeader>
        {error ? (
          <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
            <p className="font-medium text-foreground">{error.title}</p>
            <p className="text-muted-foreground">
              {error.detail.replace(
                /use (Take photo|Choose photos) below[^.]*/i,
                "use the upload button instead",
              )}
            </p>
          </div>
        ) : (
          <video
            ref={video}
            playsInline
            muted
            className="aspect-[4/3] w-full rounded-md bg-black object-contain"
          />
        )}
        <DialogFooter>
          <Button variant="outline" className="h-11 sm:h-9" onClick={onClose}>
            Cancel
          </Button>
          <Button className="h-11 sm:h-9" disabled={!ready || !!error} onClick={take}>
            <Camera className="mr-1.5 size-4" /> Take photo
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
