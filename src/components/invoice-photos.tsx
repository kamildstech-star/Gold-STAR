/**
 * The Photos card on the invoice editor.
 *
 * The client's second of two places: "by invoices we're gonna have a little
 * button 'Add images' and it pulls up the images and you select which ones."
 * The picker is the Pictures tab's own tile grid in a select-only mode, so the
 * pictures look the same in both places and the ids that come out of it are
 * the ids the tab would have produced.
 *
 * That picker now lives in `@/components/job-photo-picker` — job reports ask
 * for the same act ("select the updated pictures that you want to put in"), and
 * two grids over the same photographs would drift apart. Only the wording and
 * the page-count warning below are the invoice's own.
 *
 * Two carriers, both optional and independent: the pictures themselves, which
 * print as a grid of small squares on the PDF, and a link to them, which
 * prints as a URL on the PDF and goes into the email. "On a job that we have
 * to add more pictures we should always be able to add the link of the
 * selected pictures to the invoice."
 *
 * The link has one setting — view-only, or the full-resolution originals may
 * be downloaded — and it starts view-only. One control, not two that can
 * contradict: hiding stamps while handing out the original leaks the GPS in
 * the file anyway.
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Copy, Images, Loader2, X } from "lucide-react";
import { toast } from "sonner";

import { useAppContext } from "@/components/app-context";
import { JobPhotoPicker } from "@/components/job-photo-picker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { toastDbError } from "@/lib/db-errors";
import { photoGridSheets } from "@/lib/invoice-photo-grid";
import {
  invoicePhotoLengthNote,
  disableInvoicePhotoLink,
  enableInvoicePhotoLink,
  readInvoicePhotoLink,
  setInvoicePhotoLinkDownload,
  setInvoicePhotos,
} from "@/lib/invoice-photos";
import {
  loadAllJobPhotos,
  loadJobPhotosByIds,
  signedPhotoUrl,
  type JobPhoto,
} from "@/lib/job-photos";
import { fmtDate } from "@/lib/jobs";

export type InvoiceForPhotoCard = {
  id: string;
  invoice_number: string;
  job_id: string | null;
  photo_ids: string[] | null;
  photo_share_link_id: string | null;
};

/** The whole job, for the picker — read only while it is open. */
const jobPhotosKey = (jobId: string) => ["job-photos-for-invoice", jobId] as const;
/** Just the pictures this invoice names. */
const attachedKey = (jobId: string, ids: string[]) =>
  ["invoice-attached-photos", jobId, ids.join(",")] as const;
const linkKey = (linkId: string | null) => ["invoice-photo-link", linkId] as const;

export function InvoicePhotosCard({
  invoice,
  migrated,
  onChanged,
}: {
  invoice: InvoiceForPhotoCard;
  /** False until the invoice photo columns exist in the database. */
  migrated: boolean;
  /** The invoice row changed — the editor refetches it. */
  onChanged: () => void;
}) {
  const app = useAppContext();
  const qc = useQueryClient();
  const [pickerOpen, setPickerOpen] = useState(false);

  const jobId = invoice.job_id;
  const ids = useMemo(() => invoice.photo_ids ?? [], [invoice.photo_ids]);
  const linkId = invoice.photo_share_link_id;

  /*
   * The card resolves the ids the invoice names and nothing else. It used to
   * read the whole album and look them up, and that read stopped at the newest
   * 600 photos: on a large job an attached photo from the first week showed
   * here as "no longer on the job" while sitting on the Pictures tab.
   * The previous answer stays up while an add or remove refetches, so the
   * grid does not flash back to spinners for photos already shown.
   */
  const photosQ = useQuery({
    queryKey: attachedKey(jobId ?? "", ids),
    enabled: migrated && !!jobId && ids.length > 0,
    queryFn: () => loadJobPhotosByIds(jobId!, ids),
    placeholderData: (prev) => prev,
  });
  /** Every picture on the job, uncapped, for ticking — only while the picker is open. */
  const pickerQ = useQuery({
    queryKey: jobPhotosKey(jobId ?? ""),
    enabled: migrated && !!jobId && pickerOpen,
    queryFn: () => loadAllJobPhotos(jobId!),
  });

  const linkQ = useQuery({
    queryKey: linkKey(linkId),
    enabled: !!linkId,
    queryFn: () => readInvoicePhotoLink(linkId!),
  });

  const byId = useMemo(() => new Map((photosQ.data ?? []).map((p) => [p.id, p])), [photosQ.data]);
  const attached = useMemo(
    () => ids.map((id) => byId.get(id)).filter((p): p is JobPhoto => !!p),
    [ids, byId],
  );
  // Only once this invoice's pictures are in: before that — or while the last
  // answer stands in for the next — every new id looks missing.
  const missing = photosQ.data && !photosQ.isPlaceholderData ? ids.length - attached.length : 0;

  const write = useMutation({
    mutationFn: (next: string[]) =>
      setInvoicePhotos({ id: invoice.id, photoShareLinkId: linkId }, next, app.userId),
    onSuccess: (res) => {
      onChanged();
      void qc.invalidateQueries({ queryKey: linkKey(linkId) });
      if (res.linkRemoved) {
        toast.info("The photo link was turned off", {
          description: "An invoice with no photos has nothing to link to.",
        });
      }
    },
    onError: (e) => toastDbError(e, { action: "Change the invoice's photos" }),
  });

  const enable = useMutation({
    mutationFn: (allowDownloadOriginal: boolean) =>
      enableInvoicePhotoLink({
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoice_number,
        jobId: jobId!,
        userId: app.userId,
        ids,
        allowDownloadOriginal,
      }),
    onSuccess: () => {
      onChanged();
      toast.success("Photo link created", {
        description: "It prints on the invoice PDF and goes into the invoice email.",
      });
    },
    onError: (e) => toastDbError(e, { action: "Create the invoice's photo link" }),
  });

  const disable = useMutation({
    mutationFn: () => disableInvoicePhotoLink(invoice.id, linkId!, app.userId),
    onSuccess: () => {
      onChanged();
      toast.success("Photo link turned off", {
        description: "Anyone who already has the link will find it no longer opens.",
      });
    },
    onError: (e) => toastDbError(e, { action: "Turn off the invoice's photo link" }),
  });

  const setDownload = useMutation({
    mutationFn: (allow: boolean) => setInvoicePhotoLinkDownload(linkId!, allow),
    onSuccess: () => void qc.invalidateQueries({ queryKey: linkKey(linkId) }),
    onError: (e) => toastDbError(e, { action: "Change what the photo link allows" }),
  });

  const busy = write.isPending || enable.isPending || disable.isPending || setDownload.isPending;
  const link = linkQ.data ?? null;
  const linkOn = Boolean(linkId);
  const linkDead = linkOn && linkQ.isSuccess && (!link || !link.live);
  const lengthNote = invoicePhotoLengthNote(ids.length);

  const copy = (url: string) => {
    void navigator.clipboard.writeText(url);
    toast.success("Link copied");
  };

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2 space-y-0 pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          Photos
          {ids.length > 0 && (
            <Badge variant="secondary" className="tabular-nums">
              {ids.length}
            </Badge>
          )}
        </CardTitle>
        <Button
          size="sm"
          variant="outline"
          className="h-11 sm:h-7"
          disabled={!migrated || !jobId || app.writesDisabled || busy}
          title={
            !migrated
              ? "Attaching photos to an invoice needs a database update first."
              : !jobId
                ? "This invoice is not attached to a job, so there are no job photos to add."
                : undefined
          }
          onClick={() => setPickerOpen(true)}
        >
          <Images className="mr-1.5 size-3.5" /> Add images
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {!migrated ? (
          <p className="text-xs text-muted-foreground">
            Attaching photos to an invoice needs a database update before it can be switched on.
          </p>
        ) : !jobId ? (
          <p className="text-xs text-muted-foreground">
            This invoice is not attached to a job, so there are no job photos to add.
          </p>
        ) : ids.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No photos on this invoice. Add images here, or select them on the job&apos;s Pictures
            tab and choose <span className="font-medium">Attach to invoice</span>. They print as a
            grid of small squares after the totals.
          </p>
        ) : (
          <>
            {photosQ.isError ? (
              <p className="flex items-start gap-1.5 text-xs text-destructive">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                The job&apos;s photos could not be loaded, so the {ids.length} attached cannot be
                shown here. They are still on the invoice.
              </p>
            ) : (
              <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-6 md:grid-cols-8">
                {attached.map((p, i) => (
                  <AttachedThumb
                    key={p.id}
                    photo={p}
                    index={i + 1}
                    disabled={app.writesDisabled || busy}
                    onRemove={() => write.mutate(ids.filter((id) => id !== p.id))}
                  />
                ))}
                {photosQ.isLoading &&
                  ids.map((id) => (
                    <div
                      key={id}
                      className="grid aspect-square place-items-center rounded-sm bg-muted"
                    >
                      <Loader2 className="size-4 animate-spin text-muted-foreground" />
                    </div>
                  ))}
              </div>
            )}
            {missing > 0 && (
              <p className="flex flex-wrap items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400">
                <AlertTriangle className="size-3.5 shrink-0" />
                {missing} attached photo{missing === 1 ? " is" : "s are"} no longer on the job and
                will not print.
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  disabled={app.writesDisabled || busy}
                  onClick={() => write.mutate(ids.filter((id) => byId.has(id)))}
                >
                  Remove {missing === 1 ? "it" : "them"}
                </Button>
              </p>
            )}
            {lengthNote && (
              <p className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                {lengthNote}
              </p>
            )}
          </>
        )}

        {migrated && jobId && (
          <div className="space-y-2 border-t pt-3">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="invoice-photo-link" className="text-xs">
                Include link to photos
                <span className="block text-[11px] font-normal text-muted-foreground">
                  Prints on the invoice and goes into the email. Needs no login to open.
                </span>
              </Label>
              <Switch
                id="invoice-photo-link"
                checked={linkOn}
                disabled={app.writesDisabled || busy || (!linkOn && ids.length === 0)}
                onCheckedChange={(v) => (v ? enable.mutate(false) : disable.mutate())}
              />
            </div>

            {linkOn && linkQ.isLoading ? (
              <p className="text-xs text-muted-foreground">Reading the link…</p>
            ) : linkDead ? (
              <div className="space-y-1.5 rounded-sm border border-amber-500/40 bg-amber-500/5 p-2 text-xs">
                <p className="flex items-center gap-1.5 font-medium text-amber-700 dark:text-amber-500">
                  <AlertTriangle className="size-3.5 shrink-0" />
                  {!link
                    ? "This invoice's photo link no longer exists."
                    : link.revokedAt
                      ? "This invoice's photo link was revoked."
                      : "This invoice's photo link has expired."}{" "}
                  It will not print.
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7"
                  disabled={app.writesDisabled || busy || ids.length === 0}
                  onClick={() => enable.mutate(link?.allowDownloadOriginal ?? false)}
                >
                  Make a new link
                </Button>
              </div>
            ) : linkOn && link ? (
              <div className="space-y-2">
                <div className="flex gap-2">
                  <Input readOnly value={link.url} className="h-8 font-mono text-xs" />
                  <Button
                    size="sm"
                    variant="secondary"
                    className="h-8"
                    aria-label="Copy link"
                    onClick={() => copy(link.url)}
                  >
                    <Copy className="size-3.5" />
                  </Button>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Select
                    value={link.allowDownloadOriginal ? "original" : "view"}
                    disabled={app.writesDisabled || busy}
                    onValueChange={(v) => setDownload.mutate(v === "original")}
                  >
                    <SelectTrigger className="h-8 w-[15.5rem] text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="view">View only</SelectItem>
                      <SelectItem value="original">Allow full-resolution download</SelectItem>
                    </SelectContent>
                  </Select>
                  <span className="text-[11px] text-muted-foreground">
                    Shows {link.count} photo{link.count === 1 ? "" : "s"} · expires{" "}
                    {fmtDate(link.expiresAt.slice(0, 10))}
                  </span>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {link.allowDownloadOriginal
                    ? "The original camera files can be downloaded, and they carry whatever the phone wrote into them — capture time and GPS included."
                    : "Re-saved copies only, with no capture time or location inside the file. The link follows this invoice's photos as they change."}
                </p>
              </div>
            ) : null}
          </div>
        )}
      </CardContent>

      {jobId && (
        <JobPhotoPicker
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          photos={pickerQ.data ?? []}
          loading={pickerQ.isLoading}
          error={pickerQ.isError ? "The job's photos could not be loaded." : null}
          initial={ids}
          title="Add images to the invoice"
          description="Tick the photos to print on the invoice. Shift-click selects a run."
          /* The page-count warning is the invoice's own rule about how many
             pictures belong on a sheet — see invoicePhotoLengthNote. */
          footerNote={(count) =>
            invoicePhotoLengthNote(count) ? (
              <span
                className="flex items-center gap-1 text-amber-700 dark:text-amber-400"
                title={invoicePhotoLengthNote(count) ?? undefined}
              >
                <AlertTriangle className="size-3.5" /> {photoGridSheets(count)} pages of pictures
              </span>
            ) : null
          }
          onConfirm={(next) => {
            setPickerOpen(false);
            if (next.join("|") !== ids.join("|")) write.mutate(next);
          }}
        />
      )}
    </Card>
  );
}

/**
 * One attached picture, numbered in print order, with its remove button
 * always visible — a hover-only control is unreachable on the tablet the
 * office does invoices on.
 */
function AttachedThumb({
  photo,
  index,
  disabled,
  onRemove,
}: {
  photo: JobPhoto;
  index: number;
  disabled: boolean;
  onRemove: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const path = photo.thumbPath ?? photo.displayPath ?? photo.originalPath;
    let alive = true;
    signedPhotoUrl(photo.bucket, path).then((u) => alive && setUrl(u));
    return () => {
      alive = false;
    };
  }, [photo]);
  return (
    <div className="relative aspect-square overflow-hidden rounded-sm bg-muted">
      {url ? (
        <img
          src={url}
          alt={photo.caption ?? `Photo ${index}`}
          loading="lazy"
          className="h-full w-full object-cover"
        />
      ) : (
        <span className="grid h-full w-full place-items-center">
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        </span>
      )}
      <span className="pointer-events-none absolute bottom-0.5 left-0.5 rounded-sm bg-black/60 px-1 text-[10px] tabular-nums text-white">
        {index}
      </span>
      <button
        type="button"
        aria-label={`Remove photo ${index} from the invoice`}
        title="Remove from the invoice"
        disabled={disabled}
        onClick={onRemove}
        className="absolute right-0.5 top-0.5 grid size-6 place-items-center rounded-full bg-black/60 text-white hover:bg-black/80 disabled:opacity-40"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
