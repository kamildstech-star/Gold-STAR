/**
 * Thumbnails for the Documents tab.
 *
 * A job's tile grid used to show four near-identical page glyphs — `1p`, `ESX`,
 * `FILE` — and to learn which was the photo report you opened each one. Now a
 * document that has a visual shows it: an image shows a scaled copy of itself,
 * a PDF shows its first page. Everything else keeps a typed icon that is
 * visibly an icon, never a broken image.
 *
 * Made once, stored beside the file. The thumbnail is a small WebP at
 * `<documentId>/thumb.webp` in the private `documents` bucket (see
 * `documentThumbPath` for why that path needs no migration), the same way the
 * photo module keeps a `thumb` variant next to every original. It is produced
 * in the browser — at upload, while the bytes are still in hand, or lazily the
 * first time a tile is looked at for a document filed before this existed —
 * and read back through the same authorised file route as the document, so a
 * grid of forty documents costs forty small images and never forty files.
 *
 * PDFs are rasterised with pdf.js (`pdfjs-dist`, pinned), which is loaded on
 * demand inside `openPdfDocument` and nowhere else: it is a megabyte of code
 * that only a browser actually looking at a PDF ever needs, and it must stay
 * out of the main bundle and out of the server's entry graph. `pdf-lib`,
 * already a dependency, can read a PDF but cannot draw one.
 *
 * That one rasteriser is shared beyond thumbnails, deliberately — the iOS
 * branch of `PdfPreviewDialog` and the document viewer's PDF pane both draw
 * pages with it. There is one pdf.js in this app and there will not be two.
 */

import { supabase } from "@/integrations/supabase/client";
import {
  DOCUMENT_BUCKET,
  documentExt,
  documentFileUrl,
  documentKind,
  documentThumbPath,
} from "./documents";

/* ------------------------------------------------------------------ */
/* Policy — pure, tested                                               */
/* ------------------------------------------------------------------ */

/**
 * Longest edge of a stored thumbnail. A tile is ~200 CSS pixels wide on a
 * 2× screen; 512 covers that and keeps a page of text legible enough to tell a
 * COI from an invoice. The photo module's thumb variant is 480 for the same
 * reason. Text-heavy pages land around 15–30 KB at this size, photos 20–40 KB.
 */
export const THUMB_MAX_EDGE = 512;
export const THUMB_QUALITY = 0.72;

/** Largest image the browser is asked to decode for a thumbnail — a phone has to do this. */
export const IMAGE_THUMB_MAX_BYTES = 25 * 1024 * 1024;
/**
 * Largest PDF opened for page one. pdf.js reads by byte range through the file
 * route, so on a well-formed file this bounds the worst case (an unlinearised
 * PDF whose page-one objects are scattered) rather than the usual cost.
 */
export const PDF_THUMB_MAX_BYTES = 20 * 1024 * 1024;

/**
 * How large a page is rasterised for the document viewer, against how wide it
 * is being shown.
 *
 * The viewer's pane is around 1100 CSS pixels on a desktop dialog, so 1600 on
 * the longest edge is already sharper than the screen at 100% and comfortably
 * sharp on a phone. Past 150% the picture is being stretched and is worth
 * redrawing bigger. Two tiers and not a redraw per click, because a redraw is
 * a rasterise — and 2600 is about where a letter page stops being a sensible
 * allocation on a phone (2009 × 2600 is ~20MB of canvas). Anyone who needs to
 * zoom past that has New tab, which hands them the real vector PDF in the
 * browser's own viewer.
 */
export const PDF_PAGE_EDGE = 1600;
export const PDF_PAGE_EDGE_ZOOMED = 2600;
/** Above this zoom the page is being stretched, so redraw it larger. */
export const PDF_PAGE_ZOOM_STEP = 150;

export function pdfPageRasterEdge(zoom: number): number {
  return zoom > PDF_PAGE_ZOOM_STEP ? PDF_PAGE_EDGE_ZOOMED : PDF_PAGE_EDGE;
}

export type ThumbSource = "image" | "pdf";

export type ThumbDocument = {
  id: string;
  name: string;
  mime?: string | null;
  size_bytes?: number | null;
  storage_path: string | null;
};

/**
 * What a thumbnail of this document would be made from, or null when it gets
 * a typed icon instead: an ESX, a spreadsheet, a Word file, an SVG (live
 * markup from an untrusted upload), a document with no stored file (a draft
 * contract rendered on demand — its wording can still change), or a file too
 * big to ask a phone to decode.
 */
export function thumbnailSource(doc: ThumbDocument): ThumbSource | null {
  if (!doc.storage_path) return null;
  const kind = documentKind(doc.name, doc.mime);
  const size = doc.size_bytes ?? 0;
  if (kind === "image") return size <= IMAGE_THUMB_MAX_BYTES ? "image" : null;
  if (kind === "pdf") return size <= PDF_THUMB_MAX_BYTES ? "pdf" : null;
  return null;
}

/** Scale a width × height box to fit inside `maxEdge`, never enlarging. */
export function fitWithin(
  width: number,
  height: number,
  maxEdge: number,
): { width: number; height: number; scale: number } {
  const longest = Math.max(width, height);
  const scale = longest > 0 ? Math.min(1, maxEdge / longest) : 1;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scale,
  };
}

/**
 * What a typed icon says under itself, so a tile with no preview still names
 * its kind in words rather than leaving `FILE` to do the job. Read from the
 * filename first: an `.xlsx` uploaded from a Mac often carries no MIME at all.
 */
export function documentTypeCaption(name: string, mime?: string | null): string {
  const ext = documentExt(name);
  if (ext === "esx") return "Xactimate estimate";
  if (ext === "xlsx" || ext === "xls" || ext === "csv") return "Spreadsheet";
  if (ext === "docx" || ext === "doc") return "Word document";
  if (ext === "zip") return "Archive";
  const kind = documentKind(name, mime);
  if (kind === "pdf") return "PDF";
  if (kind === "image") return "Image";
  if (kind === "text") return "Text";
  return ext ? `${ext.toUpperCase()} file` : "File";
}

/** The `<img src>` for a document's thumbnail — the file route, `variant=thumb`. */
export function thumbnailUrl(id: string): string {
  return documentFileUrl(id, { variant: "thumb" });
}

/**
 * Storage answers a create on an existing key with 409. Two tabs generating
 * the same thumbnail is a race worth losing quietly, not an error to show.
 */
export function isAlreadyStored(err: unknown): boolean {
  const e = err as { statusCode?: string | number; status?: number; message?: string } | null;
  if (!e) return false;
  if (String(e.statusCode) === "409" || e.status === 409) return true;
  return /already exists|duplicate/i.test(e.message ?? "");
}

/* ------------------------------------------------------------------ */
/* Session memory and fetch discipline                                 */
/* ------------------------------------------------------------------ */

export type ThumbState = { kind: "ready"; url: string } | { kind: "none" };

type Entry = {
  promise: Promise<ThumbState>;
  /** Whether a generation was attempted, or only a look for a stored one. */
  generated: boolean;
  settled: ThumbState | null;
};

/**
 * One answer per document per page load. A tile that scrolls away and back,
 * or a switch from list to grid, must not ask again — and a file that cannot
 * be thumbnailed must not be downloaded again to find that out.
 */
const entries = new Map<string, Entry>();

/** Synchronous read for a component's initial render. */
export function peekThumbnail(id: string): ThumbState | null {
  return entries.get(id)?.settled ?? null;
}

// Tiles resolve on scroll, so a long grid can queue dozens of reads at once.
// Three at a time keeps the panel responsive and a phone off the rate limiter.
let inFlight = 0;
const waiting: (() => void)[] = [];

async function gated<T>(fn: () => Promise<T>): Promise<T> {
  if (inFlight >= 3) await new Promise<void>((resolve) => waiting.push(resolve));
  inFlight++;
  try {
    return await fn();
  } finally {
    inFlight--;
    waiting.shift()?.();
  }
}

/* ------------------------------------------------------------------ */
/* Resolving                                                           */
/* ------------------------------------------------------------------ */

export type EnsureOptions = {
  /**
   * Make one if none is stored. The tile grid says yes; the list view says no,
   * because a compact list is not the place to start downloading files —
   * it shows a thumbnail when one exists and an icon otherwise.
   */
  generate?: boolean;
  /** The document's own bytes, when the caller already has them (upload, viewer). */
  bytes?: Blob | ArrayBuffer;
  /** Just uploaded: nothing to look for, go straight to making one. */
  fresh?: boolean;
};

/**
 * Resolve a document's thumbnail: find the stored one, or make and store it,
 * and remember the answer for the rest of the page load. Never throws — a
 * thumbnail is a convenience, and every failure is the typed icon.
 */
export function ensureDocumentThumbnail(
  doc: ThumbDocument,
  opts: EnsureOptions = {},
): Promise<ThumbState> {
  const source = thumbnailSource(doc);
  if (!source) return Promise.resolve({ kind: "none" });

  const existing = entries.get(doc.id);
  // A look that found nothing is not the last word once a generation is asked for.
  if (existing && (existing.generated || !opts.generate)) return existing.promise;

  const entry: Entry = {
    generated: !!opts.generate,
    settled: null,
    promise: gated(() => resolve(doc, source, opts)).then((state) => {
      entry.settled = state;
      return state;
    }),
  };
  entries.set(doc.id, entry);
  return entry.promise;
}

async function resolve(
  doc: ThumbDocument,
  source: ThumbSource,
  opts: EnsureOptions,
): Promise<ThumbState> {
  const url = thumbnailUrl(doc.id);
  try {
    if (!opts.fresh) {
      const found = await probeThumbnail(url);
      if (found === "ready") return { kind: "ready", url };
      if (found === "denied" || !opts.generate) return { kind: "none" };
    }
    const blob = await makeThumbnail(doc, source, opts.bytes);
    if (!blob) return { kind: "none" };
    await storeThumbnail(doc.id, blob);
    return { kind: "ready", url };
  } catch {
    return { kind: "none" };
  }
}

/**
 * Is there a stored thumbnail? One byte answers it: the route forwards `Range`,
 * so the reply is a 206 with a single byte when the object exists and a 404
 * when it does not, and the real image is fetched exactly once, by the `<img>`.
 *
 * "Denied" is reserved for an answer that says *you* may not have this — a
 * lapsed session, a document outside the caller's locations. Making one would
 * fail the same way, so nobody tries.
 *
 * A server-side failure is deliberately NOT a denial. It used to be, and the
 * cost was invisible: a document whose thumbnail read returned a 5xx was read
 * as forbidden, so the code declined to draw the thumbnail it could perfectly
 * well have drawn, and the row kept its icon for ever. Treating it as missing
 * lets the generator have its go.
 */
async function probeThumbnail(url: string): Promise<"ready" | "missing" | "denied"> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Range: "bytes=0-0" },
      credentials: "same-origin",
    });
  } catch {
    // Offline or the request never landed. Nothing is known about the object,
    // and a thumbnail is never worth an exception reaching the caller.
    return "missing";
  }
  void res.body?.cancel().catch(() => {});
  if (res.ok) return "ready";
  if (res.status >= 500) return "missing";
  if (res.status === 404) return "missing";
  return "denied";
}

async function makeThumbnail(
  doc: ThumbDocument,
  source: ThumbSource,
  bytes?: Blob | ArrayBuffer,
): Promise<Blob | null> {
  if (typeof document === "undefined") return null;
  const canvas =
    source === "image"
      ? await renderImage(bytes ?? (await fetchDocument(doc.id)))
      : await renderPdfPage(bytes ?? new URL(documentFileUrl(doc.id), window.location.href));
  return encode(canvas);
}

async function fetchDocument(id: string): Promise<Blob> {
  const res = await fetch(documentFileUrl(id), { credentials: "same-origin" });
  if (!res.ok) throw new Error(`document ${res.status}`);
  return res.blob();
}

function blank(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D unavailable");
  // A page is white and a PNG's transparency should read as paper, not as
  // whatever the tile's background is that day.
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);
  return [canvas, ctx];
}

async function renderImage(bytes: Blob | ArrayBuffer): Promise<HTMLCanvasElement> {
  const blob = bytes instanceof Blob ? bytes : new Blob([bytes]);
  // `from-image` honours EXIF orientation, so a phone photo taken upright
  // does not thumbnail on its side. HEIC is not decodable here and throws,
  // which lands on the icon like every other failure.
  const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
  try {
    const fit = fitWithin(bitmap.width, bitmap.height, THUMB_MAX_EDGE);
    const [canvas, ctx] = blank(fit.width, fit.height);
    ctx.drawImage(bitmap, 0, 0, fit.width, fit.height);
    return canvas;
  } finally {
    bitmap.close();
  }
}

export type RenderedPdfPage = {
  canvas: HTMLCanvasElement;
  /** Total pages in the document, so a caller can offer page-through. */
  pageCount: number;
  /** The page actually drawn, after clamping to the document's range. */
  page: number;
};

export type OpenPdfDocument = {
  pageCount: number;
  /** Draw one page. Clamped to the document's range, never throwing on 9-of-4. */
  renderPage(opts?: {
    page?: number;
    maxEdge?: number;
    /**
     * A quarter turn to add to however the page already sits. pdf.js rotates
     * the viewport, so the canvas comes back the right way round at the right
     * dimensions and nothing downstream has to know a rotation happened.
     */
    rotation?: number;
    /**
     * Draw a small page LARGER than its own point size to reach `maxEdge`.
     * Off by default, which is what a thumbnail wants. A page somebody is
     * reading wants it on: a letter page is 612×792 points, so without this
     * `maxEdge: 1600` yields a 612px picture that the pane then stretches,
     * and the preview is soft for no reason.
     */
    upscale?: boolean;
  }): Promise<{ canvas: HTMLCanvasElement; page: number }>;
  /** Release the worker. Every caller owns this; none of them may skip it. */
  close(): void;
};

/**
 * Open a PDF with pdf.js and keep it open. Loaded here and only here, on
 * demand — it is a megabyte of code that only a browser actually looking at a
 * PDF needs, and it must stay out of the main bundle and out of the server's
 * entry graph.
 *
 * Given a URL, pdf.js reads by byte range — the route forwards `Range` and
 * advertises `Accept-Ranges` — so page one of a large photo report pulls the
 * cross-reference table and that page's objects, not the whole file. Given
 * bytes (the upload, the viewer, or the iOS preview, which already holds the
 * document it just built) nothing is fetched at all. The buffer is copied
 * first because pdf.js transfers it to its worker, which would detach the
 * caller's copy — which is also what makes it safe to open the same `bytes`
 * twice.
 *
 * Held open rather than reopened per page because the document viewer pages
 * through: a forty-page photo report should cost one parse, not forty.
 */
export async function openPdfDocument(input: Blob | ArrayBuffer | URL): Promise<OpenPdfDocument> {
  const [pdfjs, worker] = await Promise.all([
    import("pdfjs-dist/legacy/build/pdf.mjs"),
    import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url"),
  ]);
  if (!pdfjs.GlobalWorkerOptions.workerSrc) pdfjs.GlobalWorkerOptions.workerSrc = worker.default;

  const data =
    input instanceof URL
      ? undefined
      : new Uint8Array(input instanceof Blob ? await input.arrayBuffer() : input.slice(0));

  const task = pdfjs.getDocument({
    // `same-origin` credentials, so the browser attaches the file route's
    // session cookie exactly as it does for an <img>.
    ...(data ? { data } : { url: input as URL, withCredentials: false }),
    // One page at a time is wanted. With streaming on, pdf.js keeps reading
    // the whole file behind the ranges; with it off it aborts the full request
    // the moment the headers say ranges work, and auto-fetch off stops it
    // going back for the rest. Neither flag costs anything when the input is
    // bytes, where there is no network.
    disableStream: true,
    disableAutoFetch: true,
    rangeChunkSize: 128 * 1024,
    stopAtErrors: false,
  });

  const pdf = await task.promise.catch((error: unknown) => {
    // A document that will not open still has a worker behind it.
    void task.destroy().catch(() => {});
    throw error;
  });

  return {
    pageCount: pdf.numPages,
    async renderPage(opts = {}) {
      // A caller asking for page 9 of a 4-page document gets page 4 rather
      // than a throw: paging is a UI control and clamping is what it expects.
      const wanted = Math.min(Math.max(1, Math.round(opts.page ?? 1)), Math.max(1, pdf.numPages));
      const page = await pdf.getPage(wanted);
      // `rotation` REPLACES the page's own /Rotate rather than adding to it,
      // so a page that is stored sideways has to be told to stay that way.
      const turn = ((((page.rotate + (opts.rotation ?? 0)) % 360) + 360) % 360) as
        0 | 90 | 180 | 270;
      const base = page.getViewport({ scale: 1, rotation: turn });
      const maxEdge = opts.maxEdge ?? THUMB_MAX_EDGE;
      const longest = Math.max(base.width, base.height) || 1;
      // Same arithmetic as `fitWithin`, minus its refusal to enlarge, which is
      // right for a thumbnail and wrong for a page being read. See `upscale`.
      const scale = opts.upscale ? maxEdge / longest : Math.min(1, maxEdge / longest);
      const viewport = page.getViewport({ scale, rotation: turn });
      const [canvas, ctx] = blank(
        Math.max(1, Math.round(viewport.width)),
        Math.max(1, Math.round(viewport.height)),
      );
      await page.render({ canvas, canvasContext: ctx, viewport, intent: "display" }).promise;
      page.cleanup();
      return { canvas, page: wanted };
    },
    close() {
      void task.destroy().catch(() => {});
    },
  };
}

/**
 * One page of a PDF, for a caller that wants exactly one and is done.
 *
 * Exported because the iOS PDF preview needs exactly this and must not grow a
 * second rasteriser: WebKit will not render a `blob:` URL in an iframe, so on
 * an iPhone the preview draws pages here instead. `maxEdge` is the one thing
 * it needs differently — a preview fills a phone screen, a thumbnail is 512.
 */
export async function renderPdfPageToCanvas(
  input: Blob | ArrayBuffer | URL,
  opts: { page?: number; maxEdge?: number } = {},
): Promise<RenderedPdfPage> {
  const pdf = await openPdfDocument(input);
  try {
    const drawn = await pdf.renderPage({ page: opts.page, maxEdge: opts.maxEdge });
    return { canvas: drawn.canvas, pageCount: pdf.pageCount, page: drawn.page };
  } finally {
    pdf.close();
  }
}

/** Page one at thumbnail size — what the tile grid stores. */
async function renderPdfPage(input: Blob | ArrayBuffer | URL): Promise<HTMLCanvasElement> {
  return (await renderPdfPageToCanvas(input)).canvas;
}

/**
 * WebP where the browser can write it. Safari cannot and hands back a PNG
 * regardless of what was asked for; the object is uploaded with the type it
 * really has, and the route serves the type the object records.
 */
function encode(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise<Blob>((resolveBlob, reject) =>
    canvas.toBlob(
      (b) => (b ? resolveBlob(b) : reject(new Error("toBlob failed"))),
      "image/webp",
      THUMB_QUALITY,
    ),
  );
}

async function storeThumbnail(id: string, blob: Blob): Promise<void> {
  const { error } = await supabase.storage
    .from(DOCUMENT_BUCKET)
    .upload(documentThumbPath(id), blob, {
      contentType: blob.type || "image/webp",
      // Create, never replace: a signed document's objects are immutable by
      // policy and a thumbnail is made once. Losing the race to another tab
      // is fine — the object it wrote is the same picture.
      upsert: false,
    });
  if (error && !isAlreadyStored(error)) throw error;
}
