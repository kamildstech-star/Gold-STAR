/**
 * The browser half of reading a paper ticket: getting the sheet onto the wire
 * without wrecking the handwriting, labelled as what it really is.
 *
 * An image is redrawn at 2200px on the long edge, which is the smallest size
 * at which a hand-drawn X in a 3mm checkbox still reads, and encoded as WebP
 * — or as JPEG where the browser cannot write WebP. That second half is the
 * 6 Oct fix. Safari cannot encode WebP from a canvas; asked for it, it quietly
 * hands back a PNG. The old code took that PNG, called it "image/webp", and a
 * PNG of a 2200px photo is 5-9MB where the WebP would have been well under
 * one: over the 8MB cap it was refused on the phone, under it it went up as a
 * 10MB request under the wrong name. Now the encoded blob's own type is
 * checked, a PNG fallback is re-encoded as JPEG, and the label sent is the
 * type the bytes actually are.
 *
 * A PDF is sent as it is — the gateway's model takes a PDF part natively. Its
 * data URL is built with the PDF prefix rather than whatever the browser
 * reports: a file picker that hands over a PDF with an empty type would
 * otherwise produce `data:application/octet-stream`, which the server's schema
 * refuses.
 *
 * Failure is a value with a reason, not a throw and not a bare null, so the
 * crew is told which thing went wrong (see `field-ticket-read-failure.ts`).
 */
import {
  TICKET_FILE_MAX_BYTES,
  TICKET_FILE_MIMES,
  TICKET_IMAGE_MAX_EDGE,
} from "@/lib/field-ticket-extract";

/** The fallback edge when a photo is still over the cap at full size. Still reads a tick. */
export const TICKET_IMAGE_FALLBACK_EDGE = 1600;

export type TicketFilePayload = {
  ok: true;
  dataUrl: string;
  mime: (typeof TICKET_FILE_MIMES)[number];
  fileName: string;
  bytes: number;
};

export type TicketFileProblem = {
  ok: false;
  reason: "file_unusable" | "file_too_big";
  /** For the audit row: what the browser said the file was, and how big. */
  mime: string;
  bytes: number;
  detail: string;
};

/**
 * Redraws a picture at `maxEdge` and encodes it. Injected so the decisions
 * around it — which type came back, whether it fits — can be tested without a
 * canvas. The default is `canvasEncode`.
 */
export type TicketImageEncoder = (file: Blob, maxEdge: number, quality: number) => Promise<Blob>;

const ALLOWED = TICKET_FILE_MIMES as readonly string[];
const IMAGE_MIMES = ALLOWED.filter((m) => m.startsWith("image/"));

export function isPdf(file: Blob): boolean {
  const name = "name" in file && typeof file.name === "string" ? file.name : "";
  return (file.type || "").toLowerCase() === "application/pdf" || /\.pdf$/i.test(name);
}

export async function ticketFileDataUrl(
  file: File | Blob,
  encode: TicketImageEncoder = canvasEncode,
): Promise<TicketFilePayload | TicketFileProblem> {
  const name = "name" in file && file.name ? file.name : "field-work-ticket";
  const type = (file.type || "").toLowerCase();
  const problem = (reason: TicketFileProblem["reason"], detail: string): TicketFileProblem => ({
    ok: false,
    reason,
    mime: type || "(none)",
    bytes: file.size,
    detail,
  });

  if (isPdf(file)) {
    if (file.size > TICKET_FILE_MAX_BYTES) return problem("file_too_big", "pdf over the cap");
    return {
      ok: true,
      dataUrl: await blobToDataUrl(file, "application/pdf"),
      mime: "application/pdf",
      fileName: name,
      bytes: file.size,
    };
  }

  let blob: Blob;
  try {
    blob = await encode(file, TICKET_IMAGE_MAX_EDGE, 0.85);
    if (blob.size > TICKET_FILE_MAX_BYTES) {
      blob = await encode(file, TICKET_IMAGE_FALLBACK_EDGE, 0.8);
    }
  } catch {
    // A browser that cannot decode the picture at all (HEIC on a desktop) can
    // still send the original when it is a type the model takes as it is.
    if (!IMAGE_MIMES.includes(type)) {
      return problem("file_unusable", `browser could not decode ${type || "an untyped file"}`);
    }
    blob = file;
  }

  const mime = (blob.type || "").toLowerCase();
  if (!IMAGE_MIMES.includes(mime)) {
    return problem("file_unusable", `encoder produced ${mime || "an untyped blob"}`);
  }
  if (blob.size > TICKET_FILE_MAX_BYTES) return problem("file_too_big", `${mime} over the cap`);
  return {
    ok: true,
    dataUrl: await blobToDataUrl(blob, mime),
    mime: mime as TicketFilePayload["mime"],
    fileName: name,
    bytes: blob.size,
  };
}

/**
 * Base64 from the bytes, with the prefix we choose. Not FileReader: that
 * writes whatever type the blob claims, and it does not exist in a test.
 */
export async function blobToDataUrl(blob: Blob, mime: string): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

/* ------------------------------------------------------------------ */
/* The real encoder                                                    */
/* ------------------------------------------------------------------ */

/**
 * WebP first, JPEG when the browser will not write WebP. Kept here rather
 * than in `photos.ts` because the job-photo pipeline wants WebP-or-nothing
 * variants for its album, and this wants the smallest honest picture of one
 * sheet of paper.
 */
export const canvasEncode: TicketImageEncoder = async (file, maxEdge, quality) => {
  const source = await decode(file);
  try {
    const scale = Math.min(1, maxEdge / Math.max(source.width, source.height));
    const w = Math.max(1, Math.round(source.width * scale));
    const h = Math.max(1, Math.round(source.height * scale));
    const canvas = Object.assign(document.createElement("canvas"), { width: w, height: h });
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D unavailable");
    // JPEG has no transparency; a PNG with an alpha channel would go black.
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(source.image, 0, 0, w, h);
    const webp = await toBlob(canvas, "image/webp", quality);
    if (webp.type === "image/webp") return webp;
    return await toBlob(canvas, "image/jpeg", quality);
  } finally {
    source.close();
  }
};

type Decoded = { image: CanvasImageSource; width: number; height: number; close: () => void };

async function decode(file: Blob): Promise<Decoded> {
  try {
    const bitmap = await createImageBitmap(file);
    return {
      image: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      close: () => bitmap.close(),
    };
  } catch {
    // Safari decodes some camera formats in an <img> that createImageBitmap
    // refuses. Worth one more try before calling the picture unusable.
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return {
        image: img,
        width: img.naturalWidth,
        height: img.naturalHeight,
        close: () => URL.revokeObjectURL(url),
      };
    } catch (err) {
      URL.revokeObjectURL(url);
      throw err;
    }
  }
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), type, quality),
  );
}
