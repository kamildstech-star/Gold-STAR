/**
 * Turn a selection of job photographs into one PDF.
 *
 * An adjuster files documents and a carrier portal usually accepts one upload,
 * so "send the pictures" needs to be able to mean one file rather than
 * fourteen. The PDF is filed as an ordinary `documents` row on the job, which
 * is what makes it downloadable, attachable and auditable — and is why there is
 * no `blob:` URL anywhere here.
 *
 * Two things are deliberately in the sender's face before anything is filed:
 * exactly which photographs made it in and which did not, and how big the file
 * is. A photograph silently missing from a claim package, or a 40 MB attachment
 * a carrier's mail gateway bounces, are both failures the sender only finds out
 * about from the recipient.
 */
import { useCallback, useMemo, useState } from "react";
import { AlertTriangle, Download, FileText, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { useAppContext } from "@/components/app-context";
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
import { Progress } from "@/components/ui/progress";
import { documentFileUrl, uploadDocumentFile } from "@/lib/documents";
import { signedPhotoUrl, type JobPhoto } from "@/lib/job-photos";
import type { Label } from "@/lib/labels";
import type { JobForAlbum } from "@/lib/photo-projects";
import {
  PHOTO_PDF_SIZE_WARNING,
  PHOTO_STAMP_DEFAULTS,
  PHOTO_STAMP_OPTIONS,
  buildPhotoPdf,
  formatBytes,
  jpegForPdf,
  photoCard,
  type PhotoPdfItem,
  type PhotoPdfSkip,
  type PhotoStamps,
} from "@/lib/photo-pdf";

/** The filename an adjuster sees, which is all we have for an album photo. */
function photoName(p: JobPhoto): string {
  return p.originalPath.split("/").pop() || `${p.id}.jpg`;
}

type Built = { bytes: Uint8Array; size: number; included: number; skipped: PhotoPdfSkip[] };

export function PhotoPdfDialog({
  job,
  photos,
  tags,
  open,
  onOpenChange,
  onFiled,
}: {
  job: JobForAlbum;
  /** The current selection, in the order the grid shows it. */
  photos: JobPhoto[];
  tags: Label[] | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onFiled?: () => void;
}) {
  const app = useAppContext();
  const [stamps, setStamps] = useState<PhotoStamps>({ ...PHOTO_STAMP_DEFAULTS });
  const [perPage, setPerPage] = useState<1 | 2>(2);
  const [progress, setProgress] = useState<number | null>(null);
  const [built, setBuilt] = useState<Built | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filing, setFiling] = useState(false);
  const [filedId, setFiledId] = useState<string | null>(null);

  const tagName = useMemo(() => new Map((tags ?? []).map((t) => [t.id, t.name])), [tags]);

  const reset = useCallback(() => {
    setBuilt(null);
    setFiledId(null);
    setError(null);
    setProgress(null);
  }, []);

  const build = useCallback(async () => {
    reset();
    setProgress(0);
    const items: PhotoPdfItem[] = [];
    const skipped: PhotoPdfSkip[] = [];

    try {
      for (let i = 0; i < photos.length; i++) {
        const p = photos[i]!;
        const name = photoName(p);
        // The display variant, not the original: it is already downscaled, and
        // for an album photo it is a WebP the browser is known to decode even
        // when the original off the phone is a HEIC it cannot.
        const path = p.displayPath ?? p.originalPath;
        try {
          const url = await signedPhotoUrl(p.bucket, path);
          if (!url) throw new Error("Storage would not sign a link for this file.");
          const res = await fetch(url);
          if (!res.ok) throw new Error(`Storage returned ${res.status}.`);
          const prepared = await jpegForPdf(await res.blob(), name);
          if (!prepared.ok) {
            skipped.push({ name, reason: prepared.reason });
          } else {
            items.push({
              bytes: prepared.jpeg,
              width: prepared.width,
              height: prepared.height,
              card: photoCard(
                {
                  caption: p.caption,
                  room: p.room,
                  takenAtIso: p.takenAt,
                  lat: p.lat,
                  lon: p.lon,
                  tags: p.tagIds.map((id) => tagName.get(id) ?? "").filter(Boolean),
                  uploader: p.uploaderName,
                },
                stamps,
              ),
            });
          }
        } catch (e) {
          skipped.push({
            name,
            reason: e instanceof Error ? e.message : "This photo could not be read.",
          });
        }
        setProgress(Math.round(((i + 1) / photos.length) * 100));
      }

      if (items.length === 0) {
        // A PDF of nothing but an apology is not a document to hand anybody.
        setBuilt({ bytes: new Uint8Array(), size: 0, included: 0, skipped });
        setError("None of the selected photographs could be put in a PDF.");
        return;
      }

      const bytes = await buildPhotoPdf({
        jobNumber: job.job_number,
        address: job.address,
        customerName: job.customer_name ?? null,
        preparedBy: app.fullName ?? null,
        preparedAtIso: new Date().toISOString(),
        perPage,
        items,
        skipped,
      });
      setBuilt({ bytes, size: bytes.byteLength, included: items.length, skipped });
    } catch (e) {
      setError(e instanceof Error ? e.message : "The PDF could not be built.");
    } finally {
      setProgress(null);
    }
  }, [photos, stamps, perPage, job, app.fullName, tagName, reset]);

  const file = useCallback(async () => {
    if (!built || built.included === 0) return;
    setFiling(true);
    try {
      const stamp = new Date().toISOString().slice(0, 10);
      const filename = `photos-${job.job_number}-${stamp}.pdf`;
      const doc = await uploadDocumentFile({
        file: new File([built.bytes.slice().buffer as ArrayBuffer], filename, {
          type: "application/pdf",
        }),
        scope: {
          locationId: job.location_id,
          jobId: job.id,
          accountId: job.account_id ?? null,
        },
        docType: "photo_report",
        userId: app.userId,
        name: `Photographs — ${job.job_number} (${built.included})`,
      });
      setFiledId(doc.id);
      toast.success("PDF filed on the job", {
        description: "It is on the Documents tab, and can be sent from there.",
      });
      onFiled?.();
    } catch (e) {
      toast.error("Could not file the PDF", {
        description: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setFiling(false);
    }
  }, [built, job, app.userId, onFiled]);

  const busy = progress != null;
  const tooBig = (built?.size ?? 0) >= PHOTO_PDF_SIZE_WARNING;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="size-4" /> Photos as one PDF
          </DialogTitle>
          <DialogDescription>
            {photos.length} selected photograph{photos.length === 1 ? "" : "s"} in a single document
            you can attach to an email or upload to a carrier portal.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <fieldset className="space-y-2" disabled={busy || filing}>
            <legend className="text-xs font-medium">Print on each photograph</legend>
            {PHOTO_STAMP_OPTIONS.map((o) => (
              <label key={o.key} className="flex cursor-pointer items-start gap-2">
                <Checkbox
                  checked={stamps[o.key]}
                  onCheckedChange={(v) => {
                    setStamps((prev) => ({ ...prev, [o.key]: v === true }));
                    // Anything already built was built to the old choices.
                    reset();
                  }}
                  className="mt-0.5"
                />
                <span className="min-w-0">
                  <span className="block text-sm leading-tight">{o.label}</span>
                  <span className="block text-[11px] leading-tight text-muted-foreground">
                    {o.hint}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>

          <div className="flex items-center gap-2">
            <span className="text-xs font-medium">Layout</span>
            {([1, 2] as const).map((n) => (
              <Button
                key={n}
                type="button"
                size="sm"
                variant={perPage === n ? "default" : "outline"}
                className="h-7"
                disabled={busy || filing}
                onClick={() => {
                  setPerPage(n);
                  reset();
                }}
              >
                {n} per page
              </Button>
            ))}
          </div>

          {busy ? (
            <div className="space-y-1">
              <Progress value={progress ?? 0} />
              <p className="text-xs text-muted-foreground">Preparing photographs… {progress}%</p>
            </div>
          ) : null}

          {error ? (
            <p className="flex items-start gap-1.5 text-xs text-destructive">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              {error}
            </p>
          ) : null}

          {built && built.included > 0 ? (
            <div className="rounded-md border p-2 text-xs">
              <p className="font-medium">
                {built.included} photograph{built.included === 1 ? "" : "s"} ·{" "}
                {formatBytes(built.size)}
              </p>
              {tooBig ? (
                <p className="mt-1 text-amber-700 dark:text-amber-400">
                  Over {formatBytes(PHOTO_PDF_SIZE_WARNING)}. Many carriers refuse email attachments
                  above 10 MB — send fewer photographs, or upload it to their portal.
                </p>
              ) : null}
            </div>
          ) : null}

          {/* Named, never a count. "12 of 14 included" tells the sender nothing
              about which two the adjuster will not be looking at. */}
          {built && built.skipped.length > 0 ? (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2">
              <p className="flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-500">
                <AlertTriangle className="size-3.5 shrink-0" />
                {built.skipped.length} photograph{built.skipped.length === 1 ? " is" : "s are"} not
                in this PDF
              </p>
              <ul className="mt-1 space-y-1">
                {built.skipped.map((s) => (
                  <li key={s.name} className="text-[11px] leading-tight">
                    <span className="font-medium">{s.name}</span>
                    <span className="text-muted-foreground"> — {s.reason}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-[11px] text-muted-foreground">
                They are listed on the last page of the PDF too, so the recipient knows as well.
              </p>
            </div>
          ) : null}

          {filedId ? (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-success/40 bg-success/5 p-2 text-xs">
              <span className="font-medium">Filed on the job.</span>
              {/* Plain same-origin links. The viewer's blob: URLs were what ad
                  blockers refused, so nothing here builds one. */}
              <a
                className="underline"
                href={documentFileUrl(filedId)}
                target="_blank"
                rel="noreferrer"
              >
                Open
              </a>
              <a
                className="inline-flex items-center gap-1 underline"
                href={documentFileUrl(filedId, { download: true })}
              >
                <Download className="size-3" /> Download
              </a>
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {filedId ? "Done" : "Cancel"}
          </Button>
          {built && built.included > 0 && !filedId ? (
            <Button onClick={() => void file()} disabled={filing || app.writesDisabled}>
              {filing && <Loader2 className="mr-1 size-4 animate-spin" />}
              File on the job
            </Button>
          ) : (
            <Button
              onClick={() => void build()}
              disabled={busy || photos.length === 0 || Boolean(filedId)}
            >
              {busy && <Loader2 className="mr-1 size-4 animate-spin" />}
              {built ? "Build again" : "Build PDF"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
