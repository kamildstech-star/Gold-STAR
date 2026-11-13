/**
 * The browser half of reading a card photo: finding a QR code in it, and
 * shrinking it for the wire.
 *
 * Both run on the device and need no network, which is the point — a card
 * with a QR code is fully read at the booth, signal or not. Only the printed
 * text needs the model.
 *
 * QR decoding tries the platform first. `BarcodeDetector.detect` takes any
 * `CanvasImageSource`, an `ImageBitmap` included, so on Chrome for Android
 * the same native decoder the badge scanner uses reads a still. Everywhere
 * else — every iPhone — `jsqr` (Apache-2.0, pure JavaScript, no workers)
 * reads the pixels off a canvas. It is imported on first use so the capture
 * screen's bundle does not carry a decoder for the cards that have no code.
 */
import { nativeDetector } from "@/lib/barcode-camera";
import { CARD_IMAGE_MAX_BYTES, CARD_IMAGE_MAX_EDGE, CARD_IMAGE_MIMES } from "@/lib/business-card";
import { resizeToWebp } from "@/lib/photos";

/** jsQR wants RGBA pixels; 1600px on the long edge keeps a card's QR at hundreds of pixels. */
const QR_DECODE_MAX_EDGE = 1600;

type Canvas2d = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

function drawToCanvas(
  bitmap: ImageBitmap,
  maxEdge: number,
): { ctx: Canvas2d; w: number; h: number } {
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas =
    typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(w, h)
      : Object.assign(document.createElement("canvas"), { width: w, height: h });
  const ctx = (canvas as OffscreenCanvas).getContext("2d", {
    willReadFrequently: true,
  }) as Canvas2d | null;
  if (!ctx) throw new Error("Canvas 2D unavailable");
  ctx.drawImage(bitmap, 0, 0, w, h);
  return { ctx, w, h };
}

/**
 * The raw string of the first QR code in the photo, or null. Never throws:
 * a photo the browser cannot decode is a photo with no readable code.
 */
export async function decodeQrFromPhoto(photo: Blob): Promise<string | null> {
  if (typeof createImageBitmap === "undefined") return null;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(photo);
  } catch {
    return null;
  }
  try {
    const native = await nativeDetector(["qr_code"]);
    if (native) {
      try {
        const hits = await native.detect(bitmap);
        const hit = hits.find((h) => h.rawValue && h.rawValue.trim());
        if (hit) return hit.rawValue;
      } catch {
        // fall through to the JavaScript decoder
      }
    }
    const { ctx, w, h } = drawToCanvas(bitmap, QR_DECODE_MAX_EDGE);
    const pixels = ctx.getImageData(0, 0, w, h);
    const { default: jsQR } = await import("jsqr");
    const code = jsQR(pixels.data, w, h, { inversionAttempts: "attemptBoth" });
    return code?.data?.trim() ? code.data : null;
  } catch {
    return null;
  } finally {
    bitmap.close();
  }
}

/**
 * The photo as the server will accept it: at most 1600px on the long edge,
 * WebP, as a base64 data URL. A browser that cannot re-encode (HEIC on a
 * desktop) sends the original if it is small enough and one of the accepted
 * types, and otherwise gives up rather than post a file the server refuses.
 */
export async function cardImageDataUrl(photo: Blob): Promise<string | null> {
  let blob: Blob = photo;
  try {
    blob = (await resizeToWebp(photo, CARD_IMAGE_MAX_EDGE, 0.82)).blob;
  } catch {
    const mime = (photo.type || "").toLowerCase();
    if (!(CARD_IMAGE_MIMES as readonly string[]).includes(mime)) return null;
  }
  if (blob.size > CARD_IMAGE_MAX_BYTES) return null;
  return blobToDataUrl(blob);
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the photo"));
    reader.readAsDataURL(blob);
  });
}
