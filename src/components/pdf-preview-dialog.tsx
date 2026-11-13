import { useEffect, useMemo, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight, Download, Loader2, Printer, Share2 } from "lucide-react";
import { toast } from "sonner";
import { sharePdfFile } from "@/lib/pdf-share";
import { downloadPdf, pdfBlob, printPdf } from "@/lib/pdf-actions";
import { renderPdfPageToCanvas } from "@/lib/document-thumbnails";
import { isIosLike } from "@/lib/platform";
import { cn } from "@/lib/utils";

/**
 * Shows the rendered document exactly as it will leave the building — branding,
 * lines, totals — before anyone downloads or sends it. Preview never freezes a
 * version; only an actual send does.
 */
export function PdfPreviewDialog({
  open,
  onOpenChange,
  title,
  bytes,
  url,
  filename,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  /** In-memory render (fresh document). */
  bytes?: Uint8Array | null;
  /** Signed URL for a stored, frozen version. */
  url?: string | null;
  filename: string;
}) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !bytes) return;
    const u = URL.createObjectURL(pdfBlob(bytes));
    setObjectUrl(u);
    return () => {
      URL.revokeObjectURL(u);
      setObjectUrl(null);
    };
  }, [open, bytes]);

  const src = objectUrl ?? url ?? null;
  const [sharing, setSharing] = useState(false);

  /*
   * Read once, on the client, after mount. `isIosLike` answers false with no
   * navigator, so deciding this during render would have the server emit the
   * iframe and the client swap it — a hydration mismatch on every iPhone.
   */
  const [iosPreview, setIosPreview] = useState(false);
  useEffect(() => setIosPreview(isIosLike()), []);

  async function share() {
    if (!bytes) return;
    setSharing(true);
    try {
      const result = await sharePdfFile(bytes, filename, title);
      if (result === "unsupported") {
        downloadPdf(bytes, filename);
        toast.info("PDF downloaded. Attach it to an email or message to share it.");
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not share the PDF. Try Download instead.",
      );
    } finally {
      setSharing(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[90vh] max-w-5xl flex-col gap-3">
        <DialogHeader className="flex-col items-start gap-3 space-y-0 pr-8 sm:flex-row sm:items-center sm:justify-between">
          <DialogTitle className="truncate">{title}</DialogTitle>
          <div className="flex flex-wrap items-center gap-2">
            {bytes ? (
              <>
                {/*
                 * On iOS these are the preview: the body below is a picture of
                 * the document, and Share is how the real file reaches Files,
                 * Mail or Preview. So they get full size there.
                 *
                 * Print is dropped on iOS rather than left to fail quietly —
                 * `printPdf` opens a blob: URL in a hidden iframe, which is
                 * exactly what WebKit refuses, so the button would do nothing
                 * visible. Sharing to Preview and printing from there works.
                 */}
                <Button
                  size={iosPreview ? "default" : "sm"}
                  variant={iosPreview ? "default" : "outline"}
                  onClick={share}
                  disabled={sharing}
                >
                  <Share2 className="mr-1.5 size-4" /> {sharing ? "Sharing…" : "Share"}
                </Button>
                {!iosPreview && (
                  <Button size="sm" variant="outline" onClick={() => printPdf(bytes)}>
                    <Printer className="mr-1.5 size-4" /> Print
                  </Button>
                )}
                <Button
                  size={iosPreview ? "default" : "sm"}
                  variant="outline"
                  onClick={() => downloadPdf(bytes, filename)}
                >
                  <Download className="mr-1.5 size-4" /> Download
                </Button>
              </>
            ) : src ? (
              <Button size="sm" variant="outline" asChild>
                <a href={src} download={filename} target="_blank" rel="noreferrer">
                  <Download className="mr-1.5 size-4" /> Download
                </a>
              </Button>
            ) : null}
          </div>
        </DialogHeader>
        {/*
         * iOS and iPadOS get drawn pages; everything else keeps the iframe it
         * has always had. WebKit will not render a `blob:` URL in an iframe,
         * so a rep opening an estimate on an iPhone saw a blank grey box —
         * while the very same bytes shared and downloaded correctly. Rather
         * than degrade the desktop to the lowest common denominator, the one
         * platform that cannot do it gets a renderer.
         */}
        {iosPreview ? (
          <IosPdfPages bytes={bytes ?? null} url={url ?? null} />
        ) : src ? (
          <iframe
            title={title}
            src={`${src}#toolbar=0`}
            className="min-h-0 flex-1 rounded-md border bg-muted"
          />
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            Rendering the document…
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * The PDF as drawn pages, for the one platform that will not show the file.
 *
 * Rasterisation is `renderPdfPageToCanvas` from document-thumbnails.ts — the
 * same pdf.js path the Documents tile grid has used all along, so there is one
 * rasteriser in the app and not two. It is loaded on demand inside that
 * function, so no iPhone downloads a megabyte of pdf.js until it opens a
 * preview, and no desktop ever does.
 *
 * PAGE-THROUGH is offered because it was nearly free: the renderer already
 * reports `pageCount`, and asking for page N instead of page 1 is one
 * argument. Only the current page is drawn, on demand. Re-opening the document
 * per turn is deliberate — the input is bytes already in memory, so a turn
 * costs a parse and no network, and holding a pdf.js document open across
 * renders would mean owning its lifetime through unmounts and page changes for
 * no gain a reader would notice.
 *
 * The canvas is drawn at 1600px on the longest edge rather than the 512 a
 * thumbnail uses: this is a page somebody reads totals off, on a Retina screen.
 */
function IosPdfPages({ bytes, url }: { bytes?: Uint8Array | null; url?: string | null }) {
  /*
   * Memoised on the two primitives. Building `new URL(url)` inline in the
   * parent handed this a fresh object on every render, and the draw effect
   * below depends on it — which is an endless re-render, not a preview.
   */
  const source = useMemo<Blob | Uint8Array | URL | null>(() => {
    if (bytes) return bytes;
    if (url && typeof window !== "undefined") return new URL(url, window.location.href);
    return null;
  }, [bytes, url]);

  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  // A new document starts at page one rather than page nine of the last one.
  useEffect(() => setPage(1), [source]);

  useEffect(() => {
    if (!source) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    setFailed(false);

    void (async () => {
      try {
        const input =
          source instanceof Uint8Array ? (source.slice().buffer as ArrayBuffer) : source;
        const drawn = await renderPdfPageToCanvas(input, { page, maxEdge: 1600 });
        if (cancelled) return;
        setPageCount(drawn.pageCount);
        const blob = await new Promise<Blob | null>((resolve) => drawn.canvas.toBlob(resolve));
        if (cancelled || !blob) return;
        objectUrl = URL.createObjectURL(blob);
        setImageUrl(objectUrl);
      } catch {
        // A page that will not draw is not a lost document: Share and Download
        // above still hand over the real file, which is the thing that matters.
        if (!cancelled) setFailed(true);
      }
    })();

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [source, page]);

  const total = pageCount ?? 1;
  const many = total > 1;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="min-h-0 flex-1 overflow-auto rounded-md border bg-muted">
        {failed ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
            <p className="text-sm font-medium">This page could not be drawn here.</p>
            <p className="max-w-sm text-xs text-muted-foreground">
              The document itself is fine — use Share or Download above to open it in Files, Mail or
              Preview.
            </p>
          </div>
        ) : imageUrl ? (
          // Object-contain so a landscape page is never cropped, and white so
          // the margins read as paper rather than as the dialog's ground.
          <img
            src={imageUrl}
            alt={many ? `Page ${page} of ${total}` : "Document preview"}
            className="mx-auto block h-auto w-full bg-white"
          />
        ) : (
          <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Drawing the page…
          </div>
        )}
      </div>

      {/* The page line shows even on a one-page document: "Page 1 of 1" is how
          somebody knows nothing is missing below the fold. */}
      <div className="flex shrink-0 items-center justify-center gap-3">
        {many && (
          <Button
            size="sm"
            variant="outline"
            className="h-9"
            disabled={page <= 1}
            aria-label="Previous page"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            <ChevronLeft className="size-4" />
          </Button>
        )}
        <span
          className={cn("text-xs tabular-nums text-muted-foreground", !many && "py-2")}
          data-testid="ios-pdf-page-count"
        >
          {pageCount == null ? "…" : `Page ${page} of ${total}`}
        </span>
        {many && (
          <Button
            size="sm"
            variant="outline"
            className="h-9"
            disabled={page >= total}
            aria-label="Next page"
            onClick={() => setPage((p) => Math.min(total, p + 1))}
          >
            <ChevronRight className="size-4" />
          </Button>
        )}
      </div>
    </div>
  );
}
