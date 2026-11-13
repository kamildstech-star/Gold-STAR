/**
 * Job photographs as one PDF.
 *
 * An adjuster files a document, and a carrier portal usually takes one upload
 * rather than fourteen JPEGs, so the Pictures tab needs a way to turn a
 * selection into a single sheaf. The result is filed as an ordinary
 * `documents` row, which is what makes it downloadable, auditable and servable
 * through `/api/documents/:id/file`.
 *
 * Two halves live here, deliberately separated:
 *
 *   - `jpegForPdf` runs in the browser. It decodes a stored photo and re-encodes
 *     it as a downscaled JPEG.
 *   - `buildPhotoPdf` is pure. It takes bytes pdf-lib can already embed, so it
 *     runs — and is tested — outside a browser.
 *
 * WHY THE RE-ENCODE IS NOT OPTIONAL. pdf-lib embeds JPEG and PNG and nothing
 * else. Every album photo's display variant is WebP (`photos.ts` writes it that
 * way) and an image filed as a document is whatever the phone shot, which for a
 * restoration crew is regularly HEIC. Handing either to `embedJpg` throws. The
 * canvas round-trip is also what strips EXIF: the browser's encoder writes no
 * metadata, so GPS coordinates baked into an original cannot ride into a PDF
 * that the sender ticked "don't show location" on.
 *
 * WHAT HAPPENS WHEN A PHOTO CANNOT BE DECODED. It is refused by name and the
 * refusal is carried all the way onto the last page of the PDF. Silently
 * dropping a photograph from a document somebody is about to send an adjuster
 * is the one outcome this feature must never produce.
 */

/* ── what may be printed on a picture ───────────────────────────────────── */

/**
 * Anything stamped on a photo is a decision about what an outsider sees, so
 * each one is a switch the sender sets before the file exists — the same rule
 * the share links follow. `share_links.display_options` cannot be reused as-is:
 * every key it defines describes the schedule chart (crew, equipment, dates),
 * and none of them describe a photograph.
 */
export type PhotoStampKey = "caption" | "room" | "taken_at" | "gps" | "tags" | "uploader";

export type PhotoStamps = Record<PhotoStampKey, boolean>;

export type PhotoStampDef = {
  key: PhotoStampKey;
  label: string;
  /** Why an outsider seeing this could be a problem, in the sender's words. */
  hint: string;
  default: boolean;
};

export const PHOTO_STAMP_OPTIONS: PhotoStampDef[] = [
  {
    key: "caption",
    label: "Caption",
    hint: "What the crew wrote about the picture. Usually the reason to send it.",
    default: true,
  },
  {
    key: "room",
    label: "Room or area",
    hint: "Which part of the property this is. An adjuster needs it to follow the scope.",
    default: true,
  },
  {
    key: "taken_at",
    label: "Date and time taken",
    hint: "Dates the evidence. Also shows exactly when crew were in the building.",
    default: true,
  },
  {
    key: "gps",
    label: "GPS coordinates",
    hint: "The precise location of the property, in a form that can be pasted into a map.",
    default: false,
  },
  {
    key: "tags",
    label: "Labels",
    hint: "Our internal tags. They are written for us, not for the recipient.",
    default: false,
  },
  {
    key: "uploader",
    label: "Who took it",
    hint: "Names a member of staff on every page of a document that leaves the building.",
    default: false,
  },
];

export const PHOTO_STAMP_DEFAULTS: PhotoStamps = Object.fromEntries(
  PHOTO_STAMP_OPTIONS.map((o) => [o.key, o.default]),
) as PhotoStamps;

/** An unknown or absent key resolves to its default, never to "on". */
export function normalizePhotoStamps(raw: unknown): PhotoStamps {
  const src = (raw ?? {}) as Record<string, unknown>;
  const out = { ...PHOTO_STAMP_DEFAULTS };
  for (const def of PHOTO_STAMP_OPTIONS) {
    const v = src[def.key];
    if (typeof v === "boolean") out[def.key] = v;
  }
  return out;
}

/** Everything the record holds about one photo, before any stamp is applied. */
export type PhotoCardSource = {
  caption: string | null;
  room: string | null;
  takenAtIso: string | null;
  lat: number | null;
  lon: number | null;
  tags: string[];
  uploader: string | null;
};

/** What actually gets drawn beside a picture. Nothing else reaches the PDF. */
export type PhotoCard = { title: string | null; details: string[] };

function fmtWhen(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleString("en-US");
}

/**
 * Apply the stamp choices.
 *
 * Redaction happens here rather than in the drawing code so that a switch left
 * off means the value was never handed to the renderer at all — the same
 * arrangement `redactGanttBars` uses, for the same reason.
 */
export function photoCard(src: PhotoCardSource, stamps: PhotoStamps): PhotoCard {
  const details: string[] = [];
  if (stamps.room && src.room) details.push(src.room);
  if (stamps.taken_at) {
    const when = fmtWhen(src.takenAtIso);
    if (when) details.push(when);
  }
  if (stamps.gps && src.lat != null && src.lon != null) {
    details.push(`${src.lat.toFixed(6)}, ${src.lon.toFixed(6)}`);
  }
  if (stamps.uploader && src.uploader) details.push(src.uploader);
  if (stamps.tags && src.tags.length > 0) details.push(src.tags.join(", "));
  return { title: stamps.caption ? src.caption?.trim() || null : null, details };
}

/* ── browser: stored photo → embeddable JPEG ────────────────────────────── */

/**
 * Long edge and quality for the embedded copy.
 *
 * A page is 612pt wide with 40pt margins, so a picture is never drawn wider
 * than 532pt ≈ 7.4in. At 1600px across that is over 200dpi, which is more than
 * a printed claim file or a carrier portal will ever resolve, and it is roughly
 * a tenth of the bytes of the original.
 */
export const PHOTO_PDF_MAX_EDGE = 1600;
export const PHOTO_PDF_QUALITY = 0.8;

export type PreparedImage =
  { ok: true; jpeg: Uint8Array; width: number; height: number } | { ok: false; reason: string };

/**
 * Why a browser refused a photo, said in terms of the file rather than the API.
 *
 * HEIC is the case that matters. Safari decodes it; Chrome and Firefox on
 * Windows and Android do not, and `createImageBitmap` simply rejects. The name
 * of the format has to appear in the message or the sender has no idea why one
 * picture out of fourteen is missing.
 */
function undecodable(mime: string, name: string): string {
  const kind = `${mime} ${name}`.toLowerCase();
  if (/hei[cf]/.test(kind)) {
    return "This browser cannot open HEIC photos. Safari can, or re-save it as a JPEG.";
  }
  return "This browser could not open the image file.";
}

/**
 * Decode, downscale and re-encode as JPEG.
 *
 * Never falls back to embedding the original bytes even when they are already
 * JPEG: the original carries its EXIF, GPS included, and the point of the
 * canvas round-trip is that the stamp switches decide what the recipient gets.
 */
export async function jpegForPdf(
  blob: Blob,
  name: string,
  maxEdge: number = PHOTO_PDF_MAX_EDGE,
  quality: number = PHOTO_PDF_QUALITY,
): Promise<PreparedImage> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    return { ok: false, reason: undecodable(blob.type, name) };
  }
  try {
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas =
      typeof OffscreenCanvas !== "undefined"
        ? new OffscreenCanvas(w, h)
        : Object.assign(document.createElement("canvas"), { width: w, height: h });
    const ctx = (canvas as OffscreenCanvas).getContext("2d") as
      OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
    if (!ctx) return { ok: false, reason: "This browser would not give us a drawing surface." };
    // A photo with transparency (a PNG screenshot of a moisture map) would
    // otherwise composite onto black once JPEG drops the alpha channel.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bitmap, 0, 0, w, h);
    const out =
      canvas instanceof OffscreenCanvas
        ? await canvas.convertToBlob({ type: "image/jpeg", quality })
        : await new Promise<Blob | null>((resolve) =>
            (canvas as HTMLCanvasElement).toBlob(resolve, "image/jpeg", quality),
          );
    if (!out) return { ok: false, reason: "This browser could not re-encode the image." };
    return { ok: true, jpeg: new Uint8Array(await out.arrayBuffer()), width: w, height: h };
  } finally {
    bitmap.close();
  }
}

/* ── the document ───────────────────────────────────────────────────────── */

export type PhotoPdfItem = {
  /** JPEG or PNG. Anything else is what `jpegForPdf` exists to prevent. */
  bytes: Uint8Array;
  width: number;
  height: number;
  card: PhotoCard;
};

export type PhotoPdfSkip = { name: string; reason: string };

export type PhotoPdfInput = {
  jobNumber: string;
  address: string;
  customerName?: string | null;
  preparedBy?: string | null;
  preparedAtIso: string;
  /** One picture to a page reads as evidence; two fits a walkthrough. */
  perPage: 1 | 2;
  items: PhotoPdfItem[];
  /** Photos the sender chose that could not be included. Printed, not hidden. */
  skipped: PhotoPdfSkip[];
};

/**
 * Helvetica is Latin-1 only; anything outside it throws mid-render. Newlines go
 * too: every string here is drawn as one line, and a caption typed with a line
 * break in it would otherwise draw a control character into the page.
 */
function safe(text: string): string {
  return text
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/\s+/g, " ")
    .replace(/[^\x20-\x7E\u00A0-\u00FF]/g, "")
    .trim();
}

/**
 * pdf-lib builds its `DataView` from `bytes.buffer` without passing the view's
 * byteOffset, so a Uint8Array that is a window onto a larger buffer — every
 * Node `Buffer`, and anything sliced without copying — parses from the wrong
 * place and is rejected as "SOI not found in JPEG". Copying is cheap next to
 * the decode that produced these bytes.
 */
function standalone(bytes: Uint8Array): Uint8Array {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) return bytes;
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

/**
 * JPEG or PNG, chosen by the file's own magic bytes rather than by a mime
 * string a caller passed in. `jpegForPdf` always hands over JPEG, but a PNG
 * costs nothing to accept and refusing one for the sake of a label would be a
 * failure invented here.
 */
async function embed(
  pdf: import("pdf-lib").PDFDocument,
  raw: Uint8Array,
): Promise<import("pdf-lib").PDFImage> {
  const bytes = standalone(raw);
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return pdf.embedPng(bytes);
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return pdf.embedJpg(bytes);
  throw new Error("Only JPEG and PNG can be placed in a PDF.");
}

const PW = 612;
const PH = 792;
const M = 40;
const W = PW - M * 2;
const FOOT = 30;

export async function buildPhotoPdf(input: PhotoPdfInput): Promise<Uint8Array> {
  /*
   * Loaded here, never at the top of the file. pdf-lib's tslib CommonJS interop
   * throws the moment it is evaluated under Workers ("Cannot destructure
   * property '__extends'"), and this module is reachable from a route, so a
   * static import would 500 every page in the app for a dependency only this
   * one button needs. `document-render.ts` is loaded the same way, for the same
   * reason.
   */
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");

  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const NAVY = rgb(0.063, 0.141, 0.239);
  const GREY = rgb(0.42, 0.42, 0.42);
  const GOLD = rgb(0.722, 0.627, 0.188);
  const INK = rgb(0.1, 0.1, 0.1);

  pdf.setTitle(`Job photographs — ${input.jobNumber}`);
  pdf.setSubject(input.address);
  pdf.setCreator("Gold Star Restoration");

  let page = pdf.addPage([PW, PH]);
  let top = PH - M;

  /** Every page names the job, so a page separated from the rest still does. */
  const header = () => {
    page.drawText(safe(`Job ${input.jobNumber}`), {
      x: M,
      y: top - 9,
      size: 9,
      font: bold,
      color: NAVY,
    });
    const right = safe(input.address);
    const rw = font.widthOfTextAtSize(right, 8);
    page.drawText(right, { x: M + W - rw, y: top - 9, size: 8, font, color: GREY });
    page.drawRectangle({ x: M, y: top - 16, width: W, height: 2, color: GOLD });
    return top - 26;
  };

  const newPage = () => {
    page = pdf.addPage([PW, PH]);
    top = PH - M;
    return header();
  };

  let y = header();

  /* Cover block — page one only, so page two onward is all photographs. */
  page.drawText("JOB PHOTOGRAPHS", { x: M, y: y - 14, size: 15, font: bold, color: NAVY });
  y -= 32;
  const coverRows: [string, string][] = [
    ["Property", input.address],
    ...(input.customerName ? ([["Customer", input.customerName]] as [string, string][]) : []),
    [
      "Photographs",
      `${input.items.length} included${input.skipped.length ? `, ${input.skipped.length} not included` : ""}`,
    ],
    [
      "Prepared",
      `${new Date(input.preparedAtIso).toLocaleString("en-US")}${input.preparedBy ? ` by ${input.preparedBy}` : ""}`,
    ],
  ];
  for (const [k, v] of coverRows) {
    page.drawText(safe(`${k}:`), { x: M, y, size: 8, font: bold, color: GREY });
    page.drawText(safe(v), { x: M + 74, y, size: 8, font, color: NAVY });
    y -= 12;
  }
  y -= 8;

  /* Photographs */
  const slots = input.perPage;
  for (let i = 0; i < input.items.length; i++) {
    const item = input.items[i]!;
    // A fresh page whenever this page's slots are used up. The cover eats into
    // page one, so page one carries one fewer picture rather than a squashed
    // one — a photograph scaled to fit a leftover gap is not evidence.
    if (i > 0 && i % slots === 0) y = newPage();
    else if (i === 0 && slots === 2) y -= 0;

    const remaining = y - FOOT - 8;
    const perSlot = slots === 2 && i % slots === 0 ? Math.floor((remaining - 10) / 2) : remaining;
    const captionH =
      (item.card.title ? 13 : 0) +
      (item.card.details.length ? 11 : 0) +
      (item.card.title || item.card.details.length ? 4 : 0);
    const boxH = Math.max(60, perSlot - captionH);

    const scale = Math.min(W / item.width, boxH / item.height);
    const dw = Math.max(1, item.width * scale);
    const dh = Math.max(1, item.height * scale);

    const img = await embed(pdf, item.bytes);
    page.drawImage(img, { x: M + (W - dw) / 2, y: y - dh, width: dw, height: dh });
    y -= dh + 12;

    if (item.card.title) {
      // One line only: a caption is a label under a photograph, and a paragraph
      // that reflows would push the next picture off the page it belongs on.
      let title = safe(item.card.title);
      while (title.length > 1 && bold.widthOfTextAtSize(title, 9) > W) title = title.slice(0, -1);
      page.drawText(title, { x: M, y, size: 9, font: bold, color: INK });
      y -= 13;
    }
    if (item.card.details.length) {
      let line = safe(item.card.details.join("  ·  "));
      while (line.length > 1 && font.widthOfTextAtSize(line, 8) > W) line = line.slice(0, -1);
      page.drawText(line, { x: M, y, size: 8, font, color: GREY });
      y -= 11;
    }
    y -= 6;
  }

  /*
   * What is missing, on the face of the document. The sender is told before
   * they send; this is so the recipient is told too, because a claim file with
   * a silent gap in it is worse than one with a labelled gap.
   */
  if (input.skipped.length) {
    y = newPage();
    page.drawText("NOT INCLUDED IN THIS PDF", {
      x: M,
      y: y - 12,
      size: 11,
      font: bold,
      color: NAVY,
    });
    y -= 30;
    for (const line of [
      `${input.skipped.length} selected photograph${input.skipped.length === 1 ? " is" : "s are"} not in this document.`,
      "They are still on the job record and can be sent as image files.",
    ]) {
      page.drawText(safe(line), { x: M, y, size: 9, font, color: INK });
      y -= 13;
    }
    y -= 8;
    for (const s of input.skipped) {
      if (y < FOOT + 20) y = newPage();
      page.drawText(safe(s.name), { x: M, y, size: 8, font: bold, color: INK });
      y -= 10;
      let reason = safe(s.reason);
      while (reason.length > 1 && font.widthOfTextAtSize(reason, 8) > W - 12) {
        reason = reason.slice(0, -1);
      }
      page.drawText(reason, { x: M + 12, y, size: 8, font, color: GREY });
      y -= 14;
    }
  }

  const pages = pdf.getPages();
  pages.forEach((p, i) => {
    const label = `Page ${i + 1} of ${pages.length}`;
    const w = font.widthOfTextAtSize(label, 7);
    p.drawText(label, { x: M + W - w, y: FOOT - 8, size: 7, font, color: GREY });
    p.drawText(safe(`Gold Star Restoration · Job ${input.jobNumber}`), {
      x: M,
      y: FOOT - 8,
      size: 7,
      font,
      color: GREY,
    });
  });

  return pdf.save();
}

/** "3.4 MB", for a sender deciding whether a carrier's mail gateway will take it. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Carrier mail gateways commonly refuse over 10 MB; warn before that edge. */
export const PHOTO_PDF_SIZE_WARNING = 8 * 1024 * 1024;
