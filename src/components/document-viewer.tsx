import { useEffect, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  FileArchive,
  FileImage,
  FileSpreadsheet,
  FileText,
  Loader2,
  Minus,
  MoreHorizontal,
  Plus,
  RotateCcw,
  RotateCw,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { moneyExact } from "@/lib/finance";
import { logDocumentEvent } from "@/lib/document-templates";
import { fetchEsx, type EsxDiagnostics, type EsxSummary } from "@/lib/esx";
import {
  DOCUMENT_TYPE_LABEL,
  documentExt,
  documentFileUrl,
  documentKind,
  type DocumentType,
} from "@/lib/documents";
import {
  documentTypeCaption,
  ensureDocumentThumbnail,
  openPdfDocument,
  pdfPageRasterEdge,
  peekThumbnail,
  thumbnailSource,
  type OpenPdfDocument,
  type ThumbState,
} from "@/lib/document-thumbnails";

export type ViewerDocument = {
  id: string;
  name: string;
  doc_type: DocumentType;
  mime?: string | null;
  size_bytes?: number | null;
  storage_path: string | null;
};

/** A text file only gets shown as text up to a size a browser can lay out. */
const TEXT_BYTES = 512 * 1024;
/**
 * Up to this, the viewer pulls the whole PDF once and hands the bytes to both
 * the renderer and the thumbnail generator, so neither goes back to the
 * network. Above it, nothing is pulled: pdf.js reads the file by byte range
 * through the route instead, which is what makes a 40MB photo report cost one
 * page rather than forty.
 */
const PDF_FETCH_BYTES = 8 * 1024 * 1024;

function money(n: number | null | undefined): string {
  return n == null ? "—" : moneyExact(n);
}

function qty(n: number | null | undefined): string {
  return n == null ? "—" : n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function useOnScreen(ref: React.RefObject<HTMLElement | null>): boolean {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    if (typeof IntersectionObserver === "undefined") {
      setSeen(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setSeen(true);
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref, seen]);
  return seen;
}

/* ------------------------------------------------------------------ */
/* Thumbnails                                                          */
/* ------------------------------------------------------------------ */

function KindIcon({ name, kind, className }: { name: string; kind: string; className?: string }) {
  const ext = documentExt(name);
  const Icon =
    kind === "image"
      ? FileImage
      : kind === "esx" || ext === "xlsx" || ext === "xls" || ext === "csv"
        ? FileSpreadsheet
        : kind === "other"
          ? FileArchive
          : FileText;
  return <Icon className={className} />;
}

/**
 * A tile that identifies a document at a glance. An image shows itself and a
 * PDF shows its first page — a stored thumbnail, made once in the browser and
 * read back through the file route (see `document-thumbnails.ts`). Everything
 * with no picture to show — an ESX, a spreadsheet, a draft rendered on demand
 * — gets a typed icon with its kind written under it, on the muted ground the
 * previews never use, so an icon is never mistaken for a preview of a blank
 * page. Every failure lands on that icon, never on a broken image.
 *
 * `detailed` is what the tile grid passes, and it is the only thing that makes
 * a thumbnail that does not exist yet — a document filed before thumbnails
 * were kept is drawn the first time a tile is looked at. The list view shows
 * a thumbnail when there is one and never starts a download to get one.
 */
export function DocumentThumb({
  doc,
  className,
  detailed = false,
}: {
  doc: ViewerDocument;
  className?: string;
  detailed?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const visible = useOnScreen(ref);
  const source = thumbnailSource(doc);
  const [state, setState] = useState<ThumbState | null>(() => peekThumbnail(doc.id));
  const kind = documentKind(doc.name, doc.mime);
  // Generated documents are named for the customer, not for a file, so a
  // dotless name is labelled by what the row says it is rather than "FILE".
  const label =
    documentExt(doc.name).toUpperCase() ||
    (kind === "pdf" ? "PDF" : kind === "image" ? "IMG" : "FILE");

  useEffect(() => {
    setState(peekThumbnail(doc.id));
  }, [doc.id]);

  useEffect(() => {
    if (!visible || !source) return;
    let live = true;
    void ensureDocumentThumbnail(doc, { generate: detailed }).then((next) => {
      if (live) setState(next);
    });
    return () => {
      live = false;
    };
    // `doc` is rebuilt by the panel on every render; the id is its identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, source, detailed, doc.id]);

  const ready = state?.kind === "ready";
  // A picture is coming: the file is being read and drawn. Only ever the
  // grid, and only for a document that can have one.
  const drawing = detailed && !!source && state === null && visible;

  return (
    <div
      ref={ref}
      className={cn(
        "relative flex shrink-0 items-center justify-center overflow-hidden rounded-sm border",
        ready ? "bg-white" : "bg-muted/40",
        drawing && "animate-pulse",
        className ?? "size-10",
      )}
    >
      {ready ? (
        <>
          <img
            src={state.url}
            alt=""
            loading="lazy"
            // A page is read from its top: the letterhead is what tells a COI
            // from an invoice. A photo is read from its middle.
            className={cn("size-full object-cover", source === "pdf" && "object-top")}
            onError={() => setState({ kind: "none" })}
          />
          {detailed && (
            <span className="absolute bottom-1 right-1 rounded-sm bg-background/85 px-1 text-[8px] font-medium leading-4 text-muted-foreground">
              {label}
            </span>
          )}
        </>
      ) : (
        <div className="flex size-full flex-col items-center justify-center gap-0.5 px-1 text-center text-muted-foreground">
          <KindIcon name={doc.name} kind={kind} className={detailed ? "size-6" : "size-4"} />
          <span className="text-[8px] font-medium leading-none">{label}</span>
          {detailed && (
            <span className="w-full truncate text-[9px] leading-tight">
              {documentTypeCaption(doc.name, doc.mime)}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Viewer                                                              */
/* ------------------------------------------------------------------ */

type Loaded =
  /** `bytes` when the load already pulled them; null means read it by range. */
  | { kind: "pdf"; bytes: ArrayBuffer | null }
  | { kind: "image" }
  | { kind: "text"; text: string }
  | { kind: "esx"; summary: EsxSummary }
  | { kind: "other" }
  /**
   * `downloadable` is false when the bytes themselves are what failed. Offering
   * Download then is what used to send people round in a circle.
   */
  | { kind: "error"; reason: string; diagnostics?: EsxDiagnostics; downloadable?: boolean };

/**
 * An `<img>` reports that it failed and nothing about why. Ask the route, so
 * what gets shown is the server's own reason rather than a guess.
 */
async function explainImageFailure(url: string): Promise<Loaded> {
  const refused = "This browser would not display the image.";
  try {
    const res = await fetch(url);
    if (!res.ok) return { kind: "error", reason: (await res.text()) || refused };
    return { kind: "error", reason: refused, downloadable: true };
  } catch {
    return { kind: "error", reason: refused, downloadable: true };
  }
}

/**
 * Opening a document points the browser at `/api/documents/$id/file`. The
 * route types the response from the filename, so an object stored as
 * `application/octet-stream` still renders, and a row with no stored file is
 * rendered to PDF server-side from its own wording.
 *
 * An image is still an `<img src>` pointed at that route — the browser does
 * the fetching and the session cookie rides along. A PDF is drawn by us; see
 * `PdfPages` below for why it can no longer be embedded.
 *
 * The Download button is a plain link to the same route with
 * `disposition=attachment`.
 */
export function DocumentViewer({
  doc,
  onOpenChange,
}: {
  doc: ViewerDocument | null;
  onOpenChange: (open: boolean) => void;
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(100);
  const [rotation, setRotation] = useState(0);
  // pdf.js is what knows how many pages there are, and it only knows once the
  // pane below has opened the document.
  const [pdfPages, setPdfPages] = useState<number | null>(null);

  // A row with no stored file is served as a PDF built from its own wording,
  // whatever the document happens to be named — and these are named for the
  // customer, so the name usually says nothing about the type.
  const kind = !doc ? "other" : doc.storage_path ? documentKind(doc.name, doc.mime) : "pdf";

  useEffect(() => {
    if (!doc) return;
    setLoaded(null);
    setPage(1);
    setZoom(100);
    setRotation(0);
    setPdfPages(null);

    const abort = new AbortController();
    const url = documentFileUrl(doc.id);

    void (async () => {
      // Viewing and downloading are different facts about a claim document, and
      // this log is evidence. Opening the viewer is a view.
      void logDocumentEvent(doc.id, "viewed", { via: "documents panel" });

      try {
        if (kind === "esx") {
          const res = await fetchEsx(url, abort.signal);
          if (abort.signal.aborted) return;
          setLoaded(
            res.ok
              ? { kind: "esx", summary: res.summary }
              : // The archive downloaded; it is the estimate inside it that
                // could not be read, and Xactimate can still open the file.
                {
                  kind: "error",
                  reason: res.reason,
                  diagnostics: res.diagnostics,
                  downloadable: true,
                },
          );
          return;
        }

        if (kind === "image") {
          // The <img> below does the fetching; failure lands on its onError.
          setLoaded({ kind: "image" });
          return;
        }

        if (kind === "pdf") {
          // Above the cap, hand the renderer the URL and let pdf.js range-read
          // it. Below it, one download serves the renderer and the thumbnail
          // generator both — the response is `no-store`, so anything that goes
          // back to the route pays for the file again.
          if (doc.storage_path && (doc.size_bytes ?? 0) > PDF_FETCH_BYTES) {
            setLoaded({ kind: "pdf", bytes: null });
            return;
          }
          const res = await fetch(url, { signal: abort.signal });
          if (abort.signal.aborted) return;
          if (!res.ok) {
            // The one place the server's own reason for refusing is legible.
            // A renderer can only ever report that it got no usable bytes.
            setLoaded({
              kind: "error",
              reason: (await res.text()) || `The document could not be opened (${res.status}).`,
            });
            return;
          }
          const buf = await res.arrayBuffer();
          if (abort.signal.aborted) return;
          setLoaded({ kind: "pdf", bytes: buf });
          // The bytes are in hand; if this document has no thumbnail yet,
          // this is the cheapest moment there will ever be to draw one.
          void ensureDocumentThumbnail(doc, { generate: true, bytes: buf });
          return;
        }

        if (kind === "text" && (doc.size_bytes ?? 0) <= TEXT_BYTES) {
          const res = await fetch(url, { signal: abort.signal });
          if (abort.signal.aborted) return;
          if (!res.ok) {
            setLoaded({
              kind: "error",
              reason: (await res.text()) || `The file could not be opened (${res.status}).`,
            });
            return;
          }
          const text = await res.text();
          if (abort.signal.aborted) return;
          setLoaded({ kind: "text", text });
          return;
        }

        setLoaded({ kind: "other" });
      } catch (e) {
        if (abort.signal.aborted || (e as Error)?.name === "AbortError") return;
        setLoaded({
          kind: "error",
          reason: "The file could not be downloaded for viewing.",
          downloadable: !!doc.storage_path,
        });
      }
    })();

    return () => abort.abort();
  }, [doc, kind]);

  if (!doc) return null;

  const fileUrl = documentFileUrl(doc.id);
  const downloadUrl = documentFileUrl(doc.id, { download: true });
  // The route names an on-demand render the same way. The `download` attribute
  // wins over Content-Disposition for a same-origin link, so keep them agreeing.
  const downloadName =
    doc.storage_path || doc.name.toLowerCase().endsWith(".pdf") ? doc.name : `${doc.name}.pdf`;
  const canDownload = loaded?.kind !== "error" || loaded.downloadable === true;
  const zoomable = loaded?.kind === "pdf" || loaded?.kind === "image";
  // One set of handlers for the inline toolbar and the phone's More menu.
  const zoomIn = () => setZoom((z) => Math.min(400, z + 25));
  const zoomOut = () => setZoom((z) => Math.max(25, z - 25));
  const resetZoom = () => setZoom(100);
  const rotate = () => setRotation((r) => (r + 90) % 360);

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[92vh] max-w-6xl flex-col gap-3">
        {/* Two rows below lg, one row from it. On a phone the toolbar used to
            sit beside the title as one shrink-0 strip — pager, zoom, rotate,
            New tab and Download, every button 44px under a finger, about 630px
            in all — so the title collapsed to nothing and the dialog scrolled
            sideways with Download past the right edge. An upright tablet did
            the same more mildly, which is why the side-by-side waits for lg. */}
        <DialogHeader className="flex-col gap-2 space-y-0 pr-0 text-left lg:flex-row lg:items-start lg:justify-between lg:gap-3 lg:pr-8">
          <div className="min-w-0 pr-10 lg:pr-0">
            <DialogTitle className="truncate text-base">{doc.name}</DialogTitle>
            <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="outline" className="font-normal">
                {DOCUMENT_TYPE_LABEL[doc.doc_type]}
              </Badge>
              <span className="uppercase">{documentExt(doc.name) || "file"}</span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 lg:shrink-0 lg:flex-nowrap">
            {/* The pager stays out on a phone: since #271 the page is drawn
                here rather than handed to the browser, so Next is how a crew
                member reads page two. */}
            {loaded?.kind === "pdf" && pdfPages != null && pdfPages > 1 && (
              <div className="flex items-center gap-0.5 rounded-sm border px-1">
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7"
                  aria-label="Previous page"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  <ChevronLeft className="size-4" />
                </Button>
                <span className="min-w-12 text-center text-xs tabular-nums sm:min-w-16">
                  {page} / {pdfPages}
                </span>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7"
                  aria-label="Next page"
                  disabled={page >= pdfPages}
                  onClick={() => setPage((p) => Math.min(pdfPages, p + 1))}
                >
                  <ChevronRight className="size-4" />
                </Button>
              </div>
            )}
            {/* Zoom, Rotate and New tab are inline from sm and in the More
                menu below it. Nothing is lost on a phone: the same handlers,
                one tap further away. */}
            {zoomable && (
              <div className="hidden items-center gap-0.5 rounded-sm border px-1 sm:flex">
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7"
                  aria-label="Zoom out"
                  onClick={zoomOut}
                >
                  <Minus className="size-4" />
                </Button>
                <span className="min-w-12 text-center text-xs tabular-nums">{zoom}%</span>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7"
                  aria-label="Zoom in"
                  onClick={zoomIn}
                >
                  <Plus className="size-4" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7"
                  aria-label="Reset zoom"
                  title="Reset zoom"
                  onClick={resetZoom}
                >
                  <RotateCcw className="size-3.5" />
                </Button>
              </div>
            )}
            {/* Rotate is a PDF control because the page itself is redrawn
                turned, which an uploaded photograph cannot be without a
                second rasteriser. Field tickets are photographed sideways
                often enough to be worth the one button. */}
            {loaded?.kind === "pdf" && (
              <Button
                size="icon"
                variant="ghost"
                className="hidden size-7 sm:inline-flex"
                aria-label="Rotate"
                title="Rotate"
                onClick={rotate}
              >
                <RotateCw className="size-4" />
              </Button>
            )}
            <Button size="sm" variant="ghost" className="hidden sm:inline-flex" asChild>
              <a href={fileUrl} target="_blank" rel="noreferrer">
                <ExternalLink className="mr-1.5 size-4" />
                New tab
              </a>
            </Button>
            {/* Download is the one action that never folds away. Below sm it
                is the icon alone, its name kept for a screen reader: the
                pager, Download and More are what fit across a 360px phone.
                The anchor needs its own 44px because the touch floor in
                styles.css reaches buttons, not links dressed as them. */}
            {canDownload ? (
              <Button
                size="sm"
                variant="outline"
                className="ml-auto touch:h-11 touch:min-w-11 sm:ml-0"
                asChild
                onClick={() => void logDocumentEvent(doc.id, "downloaded")}
              >
                <a href={downloadUrl} download={downloadName}>
                  <Download className="size-4 sm:mr-1.5" />
                  <span className="sr-only sm:not-sr-only">Download</span>
                </a>
              </Button>
            ) : (
              <Button size="sm" variant="outline" className="ml-auto sm:ml-0" disabled>
                <Download className="size-4 sm:mr-1.5" />
                <span className="sr-only sm:not-sr-only">Download</span>
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7 sm:hidden"
                  aria-label="More actions"
                >
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                {zoomable && (
                  <>
                    <DropdownMenuLabel className="text-xs font-normal tabular-nums text-muted-foreground">
                      Zoom {zoom}%
                    </DropdownMenuLabel>
                    {/* preventDefault keeps the menu open, so three taps on
                        Zoom in are three steps rather than three trips. */}
                    <DropdownMenuItem
                      onSelect={(e) => {
                        e.preventDefault();
                        zoomIn();
                      }}
                    >
                      <Plus className="size-4" /> Zoom in
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={(e) => {
                        e.preventDefault();
                        zoomOut();
                      }}
                    >
                      <Minus className="size-4" /> Zoom out
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={zoom === 100} onSelect={resetZoom}>
                      <RotateCcw className="size-4" /> Reset zoom
                    </DropdownMenuItem>
                    {loaded?.kind === "pdf" && (
                      <DropdownMenuItem
                        onSelect={(e) => {
                          e.preventDefault();
                          rotate();
                        }}
                      >
                        <RotateCw className="size-4" /> Rotate
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuSeparator />
                  </>
                )}
                <DropdownMenuItem asChild>
                  <a href={fileUrl} target="_blank" rel="noreferrer">
                    <ExternalLink className="size-4" /> Open in a new tab
                  </a>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-auto rounded-md border bg-muted/30">
          {!loaded ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Opening…
            </div>
          ) : loaded.kind === "pdf" ? (
            <PdfPages
              key={doc.id}
              name={doc.name}
              bytes={loaded.bytes}
              fileUrl={fileUrl}
              downloadUrl={downloadUrl}
              downloadName={downloadName}
              page={page}
              zoom={zoom}
              rotation={rotation}
              onPageCount={setPdfPages}
            />
          ) : loaded.kind === "image" ? (
            <div className="flex min-h-full items-start justify-center p-4">
              <img
                src={fileUrl}
                alt={doc.name}
                style={{ width: `${zoom}%` }}
                className="max-w-none"
                onError={() => void explainImageFailure(fileUrl).then(setLoaded)}
              />
            </div>
          ) : loaded.kind === "text" ? (
            <pre className="whitespace-pre-wrap break-words p-4 font-mono text-xs">
              {loaded.text}
            </pre>
          ) : loaded.kind === "esx" ? (
            <EsxView summary={loaded.summary} />
          ) : (
            <Unviewable
              name={doc.name}
              reason={
                loaded.kind === "error"
                  ? loaded.reason
                  : `A ${documentExt(doc.name).toUpperCase() || "file of this type"} cannot be shown in the browser.`
              }
              canDownload={canDownload}
              diagnostics={loaded.kind === "error" ? loaded.diagnostics : undefined}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* PDF                                                                 */
/* ------------------------------------------------------------------ */

/**
 * The PDF as drawn pages.
 *
 * This used to be an `<object type="application/pdf">` and it stopped working
 * the day the app grew a Content-Security-Policy. `object-src 'none'` is
 * ENFORCED on every response (`src/lib/security-response.ts` — it is one of
 * the three directives held outside the report-only policy precisely because
 * it was believed to break nothing), so Chrome refuses the embed and renders
 * the `<object>`'s fallback children instead. Mark got "This browser will not
 * display the PDF" on a desktop Chrome whose `navigator.pdfViewerEnabled` is
 * true: "it should be previewing pdfs". The message was never about his
 * browser. It was us.
 *
 * An `<iframe>` is not the fix. The same module stamps `X-Frame-Options:
 * DENY` and `frame-ancestors 'none'` onto every response on a published host,
 * the file route included, and `frame-src` does not list `'self'` — so a frame
 * is blocked in production today and would be blocked everywhere the day
 * `CSP_ENFORCED` flips. Loosening any of that to show a document is the wrong
 * trade, and it would not help the crews anyway: Chrome on Android has no
 * embedded PDF viewer to loosen our way into.
 *
 * So we draw the pages ourselves, with the pdf.js that is already a dependency
 * and already this app's one rasteriser — the same call the Documents tile
 * grid and the iOS branch of `PdfPreviewDialog` make. Nothing is embedded, so
 * no CSP directive is in play, and a desktop and a phone get the identical
 * thing. What is given up against a native viewer is text selection, in-page
 * search and vector zoom; New tab is one click away and hands over all three.
 */
function PdfPages({
  name,
  bytes,
  fileUrl,
  downloadUrl,
  downloadName,
  page,
  zoom,
  rotation,
  onPageCount,
}: {
  name: string;
  bytes: ArrayBuffer | null;
  fileUrl: string;
  downloadUrl: string;
  downloadName: string;
  page: number;
  zoom: number;
  rotation: number;
  onPageCount: (pages: number) => void;
}) {
  const [pdf, setPdf] = useState<OpenPdfDocument | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  // The object URL currently on screen, so a redraw can release the one it
  // replaces without the previous picture blinking out while the next draws.
  const shown = useRef<string | null>(null);
  const edge = pdfPageRasterEdge(zoom);

  useEffect(() => {
    return () => {
      if (shown.current) URL.revokeObjectURL(shown.current);
      shown.current = null;
    };
  }, []);

  // Opened once per document and held: paging through a forty-page photo
  // report costs one parse, and with bytes in hand it costs no network at all.
  useEffect(() => {
    let live = true;
    let opened: OpenPdfDocument | null = null;
    void (async () => {
      try {
        const input = bytes ?? new URL(fileUrl, window.location.href);
        opened = await openPdfDocument(input);
        if (!live) {
          opened.close();
          return;
        }
        setPdf(opened);
        onPageCount(opened.pageCount);
      } catch {
        if (live) setFailed(true);
      }
    })();
    return () => {
      live = false;
      opened?.close();
      setPdf(null);
    };
  }, [bytes, fileUrl, onPageCount]);

  useEffect(() => {
    if (!pdf) return;
    let live = true;
    // One page refusing to draw must not condemn the other thirty-nine, so
    // every new page, turn or zoom tier gets to try on its own merits.
    setFailed(false);
    void (async () => {
      try {
        const drawn = await pdf.renderPage({ page, maxEdge: edge, rotation, upscale: true });
        if (!live) return;
        const blob = await new Promise<Blob | null>((resolve) => drawn.canvas.toBlob(resolve));
        if (!live || !blob) return;
        const next = URL.createObjectURL(blob);
        if (shown.current) URL.revokeObjectURL(shown.current);
        shown.current = next;
        setImageUrl(next);
      } catch {
        // A page that will not draw is not a lost document: the escape hatch
        // below hands over the real file, which is the thing that matters.
        if (live) setFailed(true);
      }
    })();
    return () => {
      live = false;
    };
  }, [pdf, page, edge, rotation]);

  if (failed) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-sm font-medium">This document could not be drawn here.</p>
        {/* Deliberately not "your browser cannot show PDFs". That sentence was
            wrong for every person who ever read it, and it sent them looking
            at their extensions instead of telling us. */}
        <p className="max-w-sm text-xs text-muted-foreground">
          Opening it in a new tab hands it to the browser's own PDF viewer, and downloading it works
          either way.
        </p>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" asChild>
            <a href={fileUrl} target="_blank" rel="noreferrer">
              Open in a new tab
            </a>
          </Button>
          <Button size="sm" variant="outline" asChild>
            <a href={downloadUrl} download={downloadName}>
              Download
            </a>
          </Button>
        </div>
      </div>
    );
  }

  if (!imageUrl) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Drawing the page…
      </div>
    );
  }

  return (
    <div className="flex min-h-full items-start justify-center p-4">
      {/* Sized the same way the image branch sizes a photo, so zoom behaves
          identically whichever kind of document somebody opened. White,
          because a page's margins should read as paper. */}
      <img
        src={imageUrl}
        alt={name}
        style={{ width: `${zoom}%` }}
        className="max-w-none bg-white"
      />
    </div>
  );
}

function Unviewable({
  name,
  reason,
  canDownload,
  diagnostics,
}: {
  name: string;
  reason: string;
  canDownload: boolean;
  diagnostics?: EsxDiagnostics;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      <FileArchive className="size-8 text-muted-foreground" />
      <div className="text-sm font-medium">{name}</div>
      {/* Pointing at Download while Download is disabled is how this screen
          used to send people in a circle. */}
      <p className="max-w-md text-xs text-muted-foreground">
        {canDownload
          ? `${reason} Use Download to open it in the application that made it.`
          : reason}
      </p>
      {diagnostics && <EsxDiagnosticsView diagnostics={diagnostics} />}
    </div>
  );
}

/**
 * What the archive actually held, for a file nobody here can reproduce. This is
 * the difference between the next report being "it doesn't work" and being a
 * member name, a size and a first line to work from. The preview is escaped in
 * `esx.ts` and lands in the DOM as text, never as markup.
 */
function EsxDiagnosticsView({ diagnostics }: { diagnostics: EsxDiagnostics }) {
  return (
    <details className="mt-2 max-w-xl text-left text-xs text-muted-foreground">
      <summary className="cursor-pointer text-center">What was found in this file</summary>
      <div className="mt-2 space-y-2">
        <div>
          <div className="font-medium">Archive members</div>
          <ul className="mt-0.5 space-y-0.5">
            {diagnostics.members.slice(0, 20).map((m) => (
              <li key={m.name} className="break-all">
                <code>{m.name}</code> — {m.bytes.toLocaleString("en-US")} bytes
              </li>
            ))}
            {diagnostics.members.length > 20 && (
              <li>…and {diagnostics.members.length - 20} more</li>
            )}
          </ul>
        </div>
        {diagnostics.chosen && (
          <div>
            <div className="font-medium">
              Read as the estimate: <code>{diagnostics.chosen}</code>
            </div>
            <pre className="mt-0.5 whitespace-pre-wrap break-all rounded-sm border bg-background p-2 font-mono">
              {diagnostics.chosenHead}
            </pre>
          </div>
        )}
        {diagnostics.tried.length > 0 && (
          <div>
            <div className="font-medium">Tried, in order</div>
            <ul className="mt-0.5 space-y-0.5">
              {diagnostics.tried.map((t) => (
                <li key={t} className="break-all">
                  {t}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </details>
  );
}

/* ------------------------------------------------------------------ */
/* ESX                                                                 */
/* ------------------------------------------------------------------ */

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="truncate text-sm">{value ?? "—"}</div>
    </div>
  );
}

/**
 * What an ESX is actually asked: which claim, and what did the estimator write.
 * The Sketch drawing is proprietary and stays out; every number below is one the
 * file states, except the subtotal, which is labelled as ours.
 */
function EsxView({ summary }: { summary: EsxSummary }) {
  const t = summary.totals;
  return (
    <div className="space-y-4 p-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field label="Claim" value={summary.claimNumber} />
        <Field label="Policy" value={summary.policyNumber} />
        <Field label="Loss type" value={summary.typeOfLoss} />
        <Field label="Date of loss" value={summary.dateOfLoss} />
        <Field label="Insured" value={summary.insuredName} />
        <Field label="Carrier" value={summary.carrier} />
        <Field label="Adjuster" value={summary.adjuster} />
        <Field label="Property" value={summary.propertyAddress} />
      </div>

      {summary.areas.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {summary.areas.map((a) => (
            <Badge key={a} variant="outline" className="font-normal">
              {a}
            </Badge>
          ))}
        </div>
      )}

      {summary.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No line items were recognized in this estimate. Download it to open in Xactimate.
        </p>
      ) : (
        <div className="overflow-x-auto md:max-h-[75svh] md:overflow-auto rounded-sm border bg-background">
          <table className="w-full text-xs">
            <thead className="bg-muted text-left">
              <tr>
                <th className="px-2 py-1.5 font-medium">Area</th>
                <th className="px-2 py-1.5 font-medium">Code</th>
                <th className="px-2 py-1.5 font-medium">Description</th>
                <th className="px-2 py-1.5 text-right font-medium">Qty</th>
                <th className="px-2 py-1.5 font-medium">Unit</th>
                <th className="px-2 py-1.5 text-right font-medium">Price</th>
                <th className="px-2 py-1.5 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {summary.items.map((item, i) => (
                <tr key={`${item.code ?? "item"}-${i}`}>
                  <td className="px-2 py-1 text-muted-foreground">{item.area ?? "—"}</td>
                  <td className="whitespace-nowrap px-2 py-1 font-mono">{item.code ?? "—"}</td>
                  <td className="px-2 py-1">{item.description ?? "—"}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{qty(item.quantity)}</td>
                  <td className="px-2 py-1">{item.unit ?? "—"}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{money(item.unitPrice)}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{money(item.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Field label="RCV" value={t.rcv == null ? null : money(t.rcv)} />
        <Field label="ACV" value={t.acv == null ? null : money(t.acv)} />
        <Field label="Tax" value={t.tax == null ? null : money(t.tax)} />
        <Field label="Deductible" value={t.deductible == null ? null : money(t.deductible)} />
        <Field label="Net claim" value={t.netClaim == null ? null : money(t.netClaim)} />
      </div>
      {summary.itemsSubtotal != null && (
        <p className="text-xs text-muted-foreground">
          Sum of the {summary.items.length} line items read here:{" "}
          <span className="tabular-nums">{money(summary.itemsSubtotal)}</span>. This is our
          arithmetic, not a total the file states — check it against the estimate before quoting it.
        </p>
      )}

      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">What was read out of this file</summary>
        <div className="mt-2 space-y-1">
          <div>
            XML member: <code>{summary.member}</code>
          </div>
          <ul className="space-y-0.5">
            {Object.entries(summary.readFrom).map(([field, via]) => (
              <li key={field}>
                {field} ← <code>{via}</code>
              </li>
            ))}
          </ul>
          {summary.otherMembers.length > 0 && (
            <div>
              Not shown ({summary.otherMembers.length} other archive member
              {summary.otherMembers.length === 1 ? "" : "s"}, including the Sketch drawing, which is
              proprietary): <code>{summary.otherMembers.slice(0, 12).join(", ")}</code>
              {summary.otherMembers.length > 12 ? " …" : ""}
            </div>
          )}
        </div>
      </details>
    </div>
  );
}
