/**
 * The photograph of the meter that goes with a drying reading.
 *
 * Melly Chein, 2026-09-04: interior temperature and humidity are typed by hand
 * "in addition to uploading the picture". The picture is what turns a typed
 * number into evidence — an adjuster who doubts a dew point can look at the
 * instrument that produced it, with the time it was taken.
 *
 * She also asked whether the system could read the numbers off the photo. It
 * could, later. It does not today, and this file is where that would land —
 * see the OCR SEAM block below. Nothing else in the app needs to change when a
 * reader is written: the entry form already calls `readMeterPhoto` for every
 * photo attached and already knows what to do with an answer.
 *
 * The image pipeline is the job photo module's (`makeVariants`), not a second
 * one: a 2048px WebP to keep and a 480px WebP for the list, encoded on the
 * tablet before anything touches the network. Field techs are on tablets in
 * basements, and a 6MB camera JPEG is the difference between a reading that
 * uploads on one bar and one that does not.
 */
import { makeVariants } from "@/lib/photos";
import { isUsableReading } from "@/lib/psychrometrics";

/** A meter photo, re-encoded and ready to travel with its reading. */
export type MeterPhoto = {
  /** Re-encoded WebP when the browser could; the original bytes when it could not. */
  blob: Blob;
  mime: string;
  width: number;
  height: number;
  /** A 480px WebP for the day list, or null when re-encoding failed. */
  thumb: Blob | null;
};

/**
 * Re-encode the camera's output exactly as the job photo grid and the trade
 * show capture do. A browser that cannot decode the file (HEIC on a desktop,
 * say) keeps the original — a reading with a large photo beats a reading with
 * no photo.
 */
export async function prepareMeterPhoto(file: Blob): Promise<MeterPhoto> {
  try {
    const v = await makeVariants(file);
    return {
      blob: v.display.blob,
      mime: "image/webp",
      width: v.display.width,
      height: v.display.height,
      thumb: v.thumb.blob,
    };
  } catch {
    return { blob: file, mime: file.type || "image/jpeg", width: 0, height: 0, thumb: null };
  }
}

/* ------------------------------------------------------------------ */
/* OCR SEAM                                                            */
/* ------------------------------------------------------------------ */

/**
 * ── OCR SEAM ──────────────────────────────────────────────────────────
 *
 * NOTHING HERE READS A PHOTO TODAY. `readMeterPhoto` returns null until a
 * reader is registered, and no reader is registered anywhere in the app. This
 * is the whole extension point, and it is deliberately narrow:
 *
 *   1. Write a function of type `MeterPhotoReader` — hosted OCR, an on-device
 *      model, whatever it turns out to be. It gets the same re-encoded WebP
 *      that is uploaded, so it never needs the original file or the network
 *      path.
 *   2. Call `registerMeterPhotoReader(fn)` once at app start.
 *
 * The entry form already awaits `readMeterPhoto` for every photo attached and
 * passes the answer through `applyMeterRead`, so registering a reader is the
 * only change needed to light it up.
 *
 * Three rules any reader has to live with, enforced by `applyMeterRead` rather
 * than trusted to the reader:
 *
 *   - it may only FILL EMPTY BOXES. A number a technician typed is the record
 *     and is never overwritten by a machine reading a photo of a display.
 *   - a low-confidence answer is discarded, not shown greyed out. A wrong dew
 *     point in a drying log is worse than a blank one, because a blank one gets
 *     re-taken and a wrong one gets argued in front of an adjuster.
 *   - anything physically impossible (0% RH, a temperature that is not a
 *     number) is refused by the same `isUsableReading` gate the typed path uses.
 *
 * When a reader does land, `source_detail` on the row should carry which reader
 * produced the numbers, and the UI must mark a machine-filled reading as such
 * before it is saved. The column for that is `values_source` — see
 * supabase/migrations/20260904090000_drying_interior_readings.sql.
 * ──────────────────────────────────────────────────────────────────────
 */
export type MeterRead = {
  temperatureF: number;
  relativeHumidity: number;
  /** 0..1. Below MIN_READ_CONFIDENCE the answer is dropped, not shown. */
  confidence: number;
};

export type MeterPhotoReader = (photo: Blob) => Promise<MeterRead | null>;

/** How sure a machine has to be before its numbers are offered to a crew. */
export const MIN_READ_CONFIDENCE = 0.85;

let registeredReader: MeterPhotoReader | null = null;

/** Install the reader. Pass null to remove it (what the tests do). */
export function registerMeterPhotoReader(reader: MeterPhotoReader | null): void {
  registeredReader = reader;
}

/** Whether anything can read a meter photo in this build. False today. */
export function meterPhotoReaderInstalled(): boolean {
  return registeredReader != null;
}

/**
 * Ask the registered reader for the numbers on this photo. Returns null when
 * no reader is installed — which is the case today — and never throws: a
 * reader that fails must not stop a technician saving a reading they typed.
 */
export async function readMeterPhoto(photo: Blob): Promise<MeterRead | null> {
  if (!registeredReader) return null;
  try {
    return await registeredReader(photo);
  } catch {
    return null;
  }
}

/** What the entry form's two boxes hold, as typed. */
export type TypedPair = { temp: string; rh: string };

/**
 * Merge a machine read into what the technician has typed, under the three
 * rules above. Pure, so the policy can be tested without an OCR engine.
 *
 * `filled` says whether anything was taken from the photo, which is what the
 * form uses to mark the reading as machine-assisted.
 */
export function applyMeterRead(
  typed: TypedPair,
  read: MeterRead | null,
  opts?: { minConfidence?: number },
): { temp: string; rh: string; filled: boolean } {
  const unchanged = { temp: typed.temp, rh: typed.rh, filled: false };
  if (!read) return unchanged;
  if (read.confidence < (opts?.minConfidence ?? MIN_READ_CONFIDENCE)) return unchanged;
  if (!isUsableReading(read.temperatureF, read.relativeHumidity)) return unchanged;

  // Only empty boxes. Whitespace counts as empty; a typed digit does not.
  const tempEmpty = typed.temp.trim() === "";
  const rhEmpty = typed.rh.trim() === "";
  if (!tempEmpty && !rhEmpty) return unchanged;

  return {
    temp: tempEmpty ? String(read.temperatureF) : typed.temp,
    rh: rhEmpty ? String(read.relativeHumidity) : typed.rh,
    filled: true,
  };
}
