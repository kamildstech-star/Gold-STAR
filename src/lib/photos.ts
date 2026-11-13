// Client helpers for the photo module: EXIF read, canvas variants, IndexedDB
// offline queue, upload orchestration. Everything on the shutter path is
// synchronous or fire-and-forget; nothing here awaits the network.

import { get as idbGet, set as idbSet, del as idbDel, entries as idbEntries } from "idb-keyval";
import { ulid } from "ulidx";
import exifr from "exifr";

import {
  queueScope,
  requireQueueScope,
  assertQueueScope,
  queueClient,
  isPermanent,
  type QueueScope,
} from "./offline-queue";
import { createPhotoUploadUrls, finalizePhoto, type PhotoUploadTarget } from "./photos.functions";
import { SIGNED_URL_DEFAULT_SECONDS, signStoredFile } from "@/lib/signed-url";
import { isAlreadyExistsResponse, isStorageAlreadyExists } from "@/lib/storage-already-exists";

export type QueuedPhoto = {
  id: string; // ULID; becomes photos.id
  ownerId?: string; // Absent legacy captures stay quarantined in place.
  projectId: string;
  blob: Blob; // original bytes
  ext: string; // "jpg" / "png" / "heic"
  mime: string;
  capturedAt: string | null;
  exifLat: number | null;
  exifLon: number | null;
  exifRaw: Record<string, unknown>;
  width: number;
  height: number;
  /** Optional filing target. The shutter path leaves this null — speed first. */
  folderId?: string | null;
  /**
   * Photo tags to link once the row exists (the Field Camera's tag chip).
   * Applied after `finalizePhoto`, best-effort like the folder: a tag write
   * must never fail an upload, and it cannot be written before the row is
   * there because the link points at it.
   */
  tagIds?: string[];
  /**
   * A description to file as the photo's first comment once the row exists,
   * under `captionId` so a repeated attempt rewrites one caption rather than
   * adding a second. Held here, not in the small-payload queue, for the same
   * reason as the tags: the comment needs the photo row to point at.
   */
  caption?: string | null;
  captionId?: string | null;
  createdAt: number;
  status: "queued" | "uploading" | "error" | "rejected";
  /** When this attempt started, so an abandoned one can be told from a live one. */
  uploadingSince?: number;
  errorMessage?: string;
  attempts: number;
  /**
   * Set once a photo that gave up on "The resource already exists" has been
   * put back in the queue — see `isAlreadyStoredRejection`. Once, so a photo
   * that somehow fails that way again cannot be revived on every drain.
   */
  alreadyStoredRequeued?: boolean;
};

/**
 * How long an "uploading" photo is left alone before another pass reclaims it.
 *
 * The sibling constant in offline-queue.ts is two minutes. This one is longer
 * because the payload is: a full-resolution original plus two variants, on a
 * site connection, legitimately runs past two minutes and a reclaim would then
 * be racing a working upload rather than rescuing a dead one. Within this tab
 * the clock does not matter at all — `inFlight` below knows what is genuinely
 * open — so the five minutes only ever applies to another tab or another page
 * load, and a page load gets the much shorter window below instead.
 */
export const UPLOADING_STALE_MS = 5 * 60_000;

/**
 * The window used by the reclaim that runs when the app opens.
 *
 * A page that has only just started has nothing of its own in flight, so an
 * item still marked "uploading" belongs to a page that is gone. The only thing
 * the grace protects is a second tab, and Mark's three photos sat for four
 * hours — making him wait another five minutes for the fix to notice is not a
 * fix.
 */
export const STARTUP_STALE_MS = 20_000;

/**
 * Transient failures are retried, but not forever. A photo whose bytes will
 * never decode, whose job was deleted, or whose upload is refused for a reason
 * the error text does not name would otherwise be retried on every drain for
 * as long as the app is open — on a field phone that is battery and cellular
 * data spent on something that cannot succeed. At the cap it becomes
 * "rejected", which is terminal and carries its reason, exactly as the
 * small-payload queue does.
 */
export const MAX_UPLOAD_ATTEMPTS = 8;

/** No bytes moved for this long and the request is dead, whatever the radio says. */
const UPLOAD_STALL_MS = 90_000;

const QUEUE_PREFIX = "photo-queue:";
const photoKey = (ownerId: string, id: string) =>
  QUEUE_PREFIX + encodeURIComponent(ownerId) + ":" + encodeURIComponent(id);

/* ---------- what this page is actually uploading right now ---------- */

/**
 * Live uploads in this tab, id → fraction done.
 *
 * It does two jobs, and both of them are about telling truth from guesswork.
 * The drain uses it to know that an item marked "uploading" really is open
 * here, so its own long upload is never reclaimed out from under it however
 * long it takes. The sheet uses it to decide whether it has a real percentage
 * to show: no entry means nothing is in flight, and the honest thing to show
 * then is the state, not a bar.
 */
const inFlight = new Map<string, number>();
const uploadListeners = new Set<() => void>();

/** Fraction uploaded (0–1) if this page is uploading it, else null. */
export function uploadProgress(id: string): number | null {
  return inFlight.get(id) ?? null;
}

/** Every live upload in this page, as a plain object the UI can hold in state. */
export function uploadProgressSnapshot(): Record<string, number> {
  return Object.fromEntries(inFlight);
}

export function subscribeUploads(fn: () => void): () => void {
  uploadListeners.add(fn);
  return () => void uploadListeners.delete(fn);
}

function notifyUploads() {
  uploadListeners.forEach((fn) => fn());
}

function setProgress(id: string, fraction: number) {
  const clamped = Math.max(0, Math.min(1, fraction));
  // A hundredth is the finest a 1.5px bar can show; anything more is churn.
  const prev = inFlight.get(id);
  if (prev !== undefined && Math.abs(prev - clamped) < 0.01 && clamped < 1) return;
  inFlight.set(id, clamped);
  notifyUploads();
}

export function newPhotoId(): string {
  return ulid();
}

export function extFromMime(mime: string): string {
  const map: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/heic": "heic",
    "image/heif": "heif",
  };
  return map[mime.toLowerCase()] ?? "jpg";
}

/**
 * What a file picker handed us, split into what the queue will take and what
 * it will not — and the second half is the point.
 *
 * Every upload screen used to drop anything whose `file.type` did not start
 * with "image/" and say nothing about it. That is not a theoretical loss: a
 * phone photo arriving through Windows Chrome, a Files-app share, or a few
 * Android pickers can come through with an empty `type`, and a `.heic` from an
 * iPhone very often does. The crew selects 182 and the app queues fewer, with
 * no line anywhere saying which or why. So the extension is consulted when the
 * browser has no opinion, and whatever is still not an image comes back named
 * so the caller can say so out loud.
 */
const IMAGE_EXTENSIONS: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  bmp: "image/bmp",
  heic: "image/heic",
  heif: "image/heif",
  avif: "image/avif",
  tif: "image/tiff",
  tiff: "image/tiff",
};

export type PickedImage = { file: File; mime: string; ext: string };

export function pickImageFiles(files: Iterable<File> | null | undefined): {
  images: PickedImage[];
  skipped: string[];
} {
  const images: PickedImage[] = [];
  const skipped: string[] = [];
  for (const file of Array.from(files ?? [])) {
    const suffix = (file.name.split(".").pop() ?? "").toLowerCase();
    const byExt = IMAGE_EXTENSIONS[suffix];
    const declared = (file.type ?? "").toLowerCase();
    if (declared.startsWith("image/")) {
      images.push({ file, mime: declared, ext: extFromMime(declared) });
    } else if (byExt) {
      // The browser had no opinion, so the name decides — and the suffix it
      // decided by is the one the object is stored under, so a HEIC that the
      // picker mistyped is not filed away as a .jpg nobody can open.
      images.push({ file, mime: byExt, ext: suffix });
    } else {
      skipped.push(file.name || "(unnamed file)");
    }
  }
  return { images, skipped };
}

// ---------- EXIF ----------
export async function readExif(blob: Blob): Promise<{
  capturedAt: string | null;
  lat: number | null;
  lon: number | null;
  raw: Record<string, unknown>;
}> {
  try {
    const parsed = await exifr.parse(blob, { gps: true, tiff: true, exif: true });
    if (!parsed) return { capturedAt: null, lat: null, lon: null, raw: {} };
    const dt: Date | undefined = parsed.DateTimeOriginal ?? parsed.CreateDate ?? parsed.ModifyDate;
    return {
      capturedAt: dt instanceof Date && !isNaN(dt.getTime()) ? dt.toISOString() : null,
      lat: typeof parsed.latitude === "number" ? parsed.latitude : null,
      lon: typeof parsed.longitude === "number" ? parsed.longitude : null,
      raw: sanitizeExif(parsed),
    };
  } catch {
    return { capturedAt: null, lat: null, lon: null, raw: {} };
  }
}

function sanitizeExif(parsed: Record<string, unknown>): Record<string, unknown> {
  // Strip binary / non-serializable fields; keep human-relevant keys.
  const out: Record<string, unknown> = {};
  const keep = [
    "Make",
    "Model",
    "Software",
    "LensModel",
    "FocalLength",
    "FNumber",
    "ExposureTime",
    "ISO",
    "Orientation",
    "DateTimeOriginal",
    "CreateDate",
    "GPSLatitude",
    "GPSLongitude",
    "GPSAltitude",
    "latitude",
    "longitude",
    "ExifImageWidth",
    "ExifImageHeight",
  ];
  for (const k of keep) {
    const v = parsed[k];
    if (v instanceof Date) out[k] = v.toISOString();
    else if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") out[k] = v;
  }
  return out;
}

// ---------- Canvas variants ----------
type Variant = { blob: Blob; width: number; height: number };

export async function makeVariants(
  blob: Blob,
): Promise<{ display: Variant; thumb: Variant; width: number; height: number }> {
  const bitmap = await createImageBitmap(blob);
  const width = bitmap.width;
  const height = bitmap.height;

  const display = await resize(bitmap, 2048, 0.8);
  const thumb = await resize(bitmap, 480, 0.7);
  bitmap.close();
  return { display, thumb, width, height };
}

/**
 * One WebP at a chosen edge. Exported for the business-card reader, which
 * needs a 1600px copy for the wire rather than the 2048/480 pair kept on a
 * lead; the same canvas path, so a browser that cannot decode the file fails
 * here the same way `makeVariants` does and the caller keeps the original.
 */
export async function resizeToWebp(blob: Blob, maxEdge: number, quality: number): Promise<Variant> {
  const bitmap = await createImageBitmap(blob);
  try {
    return await resize(bitmap, maxEdge, quality);
  } finally {
    bitmap.close();
  }
}

async function resize(bitmap: ImageBitmap, maxEdge: number, quality: number): Promise<Variant> {
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas =
    typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(w, h)
      : Object.assign(document.createElement("canvas"), { width: w, height: h });
  const ctx = (canvas as OffscreenCanvas).getContext("2d") as
    OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
  if (!ctx) throw new Error("Canvas 2D unavailable");
  ctx.drawImage(bitmap, 0, 0, w, h);
  const blob =
    canvas instanceof OffscreenCanvas
      ? await canvas.convertToBlob({ type: "image/webp", quality })
      : await new Promise<Blob>((resolve, reject) =>
          (canvas as HTMLCanvasElement).toBlob(
            (b) => (b ? resolve(b) : reject(new Error("toBlob failed"))),
            "image/webp",
            quality,
          ),
        );
  return { blob, width: w, height: h };
}

// ---------- IndexedDB queue ----------
export async function enqueuePhoto(
  item: Omit<QueuedPhoto, "ownerId" | "status" | "attempts" | "createdAt">,
): Promise<void> {
  const scope = await requireQueueScope();
  const full: QueuedPhoto = {
    ...item,
    ownerId: scope.ownerId,
    status: "queued",
    attempts: 0,
    createdAt: Date.now(),
  };
  await idbSet(photoKey(scope.ownerId, item.id), full);
}

async function patchPhoto(
  id: string,
  patch: Partial<QueuedPhoto>,
  scope: QueueScope,
): Promise<void> {
  const key = photoKey(scope.ownerId, id);
  const cur = await idbGet<QueuedPhoto>(key);
  if (!cur || cur.ownerId !== scope.ownerId) return;
  await idbSet(key, { ...cur, ...patch, id: cur.id, ownerId: cur.ownerId });
}
export async function updateQueueItem(id: string, patch: Partial<QueuedPhoto>): Promise<void> {
  await patchPhoto(id, patch, await requireQueueScope());
}
export async function dequeuePhoto(id: string): Promise<void> {
  const scope = await requireQueueScope();
  await idbDel(photoKey(scope.ownerId, id));
}
export async function listQueue(projectId?: string): Promise<QueuedPhoto[]> {
  const scope = await queueScope();
  if (!scope) return [];
  const all = await idbEntries<string, QueuedPhoto>();
  try {
    await assertQueueScope(scope);
  } catch {
    return [];
  }
  return all
    .filter(([k, v]) => v?.ownerId === scope.ownerId && k === photoKey(scope.ownerId, v.id))
    .map(([, v]) => v)
    .filter((v) => !projectId || v.projectId === projectId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

// ---------- Upload orchestration ----------

/**
 * PUT one blob at a signed URL, reporting bytes as they leave.
 *
 * `fetch` cannot tell you how far a request body has got, and it has no idle
 * timeout either — a radio that goes away without closing the socket leaves
 * the promise pending with no bytes moving and nothing ever rejects. Both
 * problems are the same problem, and XMLHttpRequest solves both: `upload
 * .onprogress` is where the honest percentage in the sheet comes from, and a
 * watchdog reset by those same events turns a silently dead connection into a
 * normal failure the queue can retry. `fetch` stays as the fallback for any
 * runtime without XHR.
 *
 * There is no `x-upsert` header. It used to be here, and it was the reason
 * nobody suspected a duplicate could strand a photo: on a signed URL it does
 * nothing — storage-js says as much — because upsert is fixed when the URL is
 * signed. A "the object already exists" answer is therefore possible, and it
 * means the bytes are there: two attempts raced, and the other one won.
 */
async function putSigned(
  url: string,
  blob: Blob,
  mime: string,
  onProgress?: (sent: number) => void,
): Promise<void> {
  if (typeof XMLHttpRequest === "undefined") {
    const res = await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": mime },
      body: blob,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      if (isAlreadyExistsResponse(res.status, txt)) {
        onProgress?.(blob.size);
        return;
      }
      throw new Error(`Upload failed (${res.status}): ${txt.slice(0, 200)}`);
    }
    onProgress?.(blob.size);
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const alive = () => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        xhr.abort();
        reject(new Error("Upload stalled — no data moved for 90 seconds."));
      }, UPLOAD_STALL_MS);
    };
    const done = () => {
      if (watchdog) clearTimeout(watchdog);
    };

    xhr.open("PUT", url, true);
    xhr.setRequestHeader("Content-Type", mime);
    xhr.upload.onprogress = (e) => {
      alive();
      if (e.lengthComputable) onProgress?.(e.loaded);
    };
    xhr.onload = () => {
      done();
      const ok = xhr.status >= 200 && xhr.status < 300;
      if (ok || isAlreadyExistsResponse(xhr.status, String(xhr.responseText ?? ""))) {
        onProgress?.(blob.size);
        resolve();
        return;
      }
      reject(new Error(`Upload failed (${xhr.status}): ${String(xhr.responseText).slice(0, 200)}`));
    };
    xhr.onerror = () => {
      done();
      reject(new Error("Upload failed — no connection."));
    };
    xhr.onabort = () => done();
    alive();
    xhr.send(blob);
  });
}

/** PUT one of a photo's objects, unless the server says it is already stored. */
async function putTarget(
  target: PhotoUploadTarget,
  blob: Blob,
  mime: string,
  onProgress: (sent: number) => void,
): Promise<void> {
  if (target.alreadyStored) {
    onProgress(blob.size);
    return;
  }
  if (!target.signedUrl) throw new Error("No upload URL was issued for this photo.");
  await putSigned(target.signedUrl, blob, mime, onProgress);
}

/**
 * Has any attempt at this photo ever started?
 *
 * `uploadingSince` is stamped when an attempt starts and never cleared, so it
 * survives what `attempts` and `status` do not: a Retry tap, or the
 * already-exists requeue below, puts a photo back at "queued" with zero
 * attempts, and without this the server check would be skipped on exactly the
 * photos most likely to be half on the server already.
 */
export function hasBeenAttempted(
  item: Pick<QueuedPhoto, "attempts" | "status" | "uploadingSince">,
): boolean {
  return item.attempts > 0 || item.status !== "queued" || item.uploadingSince !== undefined;
}

/**
 * Has the server already got this photo?
 *
 * Asked before an attempt that is a repeat, which is the one case where the
 * answer can differ from the queue's own view: the upload and `finalizePhoto`
 * both succeeded and the phone died in the gap before the queue entry was
 * deleted. The rows are keyed on the photo id and upsert, so finishing again
 * would not produce a duplicate row — but it would push a full-resolution
 * original over cellular for nothing, and a crew watching a progress bar for a
 * photo that is already filed is its own kind of lie.
 *
 * This asks about the ROW, and that is the whole order of operations:
 * row there → done, nothing sent; row missing but objects stored → the server
 * marks those objects `alreadyStored`, they are skipped, and `finalizePhoto`
 * writes the row; neither → upload, then write the row. The storage objects,
 * unlike the rows, are not upserts — see `createPhotoUploadUrls`.
 *
 * A read that fails answers "no". Not knowing has to mean uploading again,
 * because the alternative is deleting work on a guess.
 */
async function alreadyOnServer(item: QueuedPhoto, scope: QueueScope): Promise<boolean> {
  try {
    const { data, error } = await queueClient(scope)
      .from("photos")
      .select("id")
      .eq("id", item.id)
      .is("deleted_at", null)
      .maybeSingle();
    return !error && !!data;
  } catch {
    return false;
  }
}

/**
 * Tags and a caption that ride with a queued photo (the Field Camera sets
 * them; the Pictures tab never does). Best-effort, like the folder: Supabase
 * reports a refused write as `{ error }` rather than throwing, and either way
 * the photo itself has landed — a lost tag is recoverable by hand, a photo
 * failed over a tag is not. Both writes are idempotent (ignore-duplicates on
 * the tag links, the caption keyed on its own id), so a repeat attempt after
 * a crash part-way through lands each one once.
 */
async function attachPhotoExtras(
  item: Pick<QueuedPhoto, "id" | "ownerId" | "tagIds" | "caption" | "captionId">,
  scope: QueueScope,
): Promise<void> {
  const client = queueClient(scope);
  try {
    if (item.tagIds?.length) {
      await client.from("photo_tags").upsert(
        item.tagIds.map((tag_id) => ({ photo_id: item.id, tag_id, created_by: scope.ownerId })),
        { onConflict: "photo_id,tag_id", ignoreDuplicates: true },
      );
    }
    const body = item.caption?.trim();
    if (body && item.captionId) {
      await client
        .from("photo_comments")
        .upsert(
          { id: item.captionId, photo_id: item.id, body, author_id: scope.ownerId } as never,
          {
            onConflict: "id",
            ignoreDuplicates: true,
          },
        );
    }
  } catch {
    // A thrown network error here is still not a reason to fail the upload.
  }
}

/**
 * Upload one queued photo. Called by the drain loop. Idempotent — a repeat
 * call after a partial failure re-uploads whatever's needed and calls
 * finalizePhoto again (which upserts on photoId).
 */
export async function uploadQueued(item: QueuedPhoto): Promise<void> {
  const scope = await requireQueueScope();
  if (item.ownerId !== scope.ownerId) throw new Error("Queue owner mismatch");
  const stored = await idbGet<QueuedPhoto>(photoKey(scope.ownerId, item.id));
  if (!stored || stored.ownerId !== scope.ownerId) throw new Error("Queued photo unavailable");
  item = stored;
  await assertQueueScope(scope);

  /*
   * A repeat attempt asks the server first. See `alreadyOnServer` — the one
   * way reclaiming an interrupted upload could make things worse is by
   * re-sending a photo that in fact landed, and this is where that is paid
   * for, once, only on the attempts where it can happen.
   */
  const isRepeat = hasBeenAttempted(item);
  if (isRepeat && (await alreadyOnServer(item, scope))) {
    await assertQueueScope(scope);
    await idbDel(photoKey(scope.ownerId, item.id));
    return;
  }

  await patchPhoto(item.id, { status: "uploading", uploadingSince: Date.now() }, scope);
  setProgress(item.id, 0);
  try {
    const [{ display, thumb, width, height }, exif] = await Promise.all([
      makeVariants(item.blob),
      Promise.resolve({
        capturedAt: item.capturedAt,
        lat: item.exifLat,
        lon: item.exifLon,
        raw: item.exifRaw,
      }),
    ]);

    await assertQueueScope(scope);
    const signed = await createPhotoUploadUrls({
      headers: { Authorization: `Bearer ${scope.token}` },
      data: { projectId: item.projectId, photoId: item.id, ext: item.ext },
    });

    await assertQueueScope(scope);
    /*
     * The bar tracks all three objects at once, weighted by size, because the
     * original is most of the bytes and a bar that jumped to a third and sat
     * there would be no more truthful than the fixed 60% this replaces.
     */
    const total = item.blob.size + display.blob.size + thumb.blob.size || 1;
    const sent = [0, 0, 0];
    const report = (i: number) => (n: number) => {
      sent[i] = n;
      setProgress(item.id, (sent[0]! + sent[1]! + sent[2]!) / total);
    };
    /*
     * An object an earlier attempt already stored is not sent again — the
     * server says so per object, so a photo whose original landed but whose
     * thumbnail did not sends only the thumbnail. Then `finalizePhoto` writes
     * the row, which is the step that attempt never reached.
     */
    await Promise.all([
      putTarget(signed.original, item.blob, item.mime, report(0)),
      putTarget(signed.display, display.blob, "image/webp", report(1)),
      putTarget(signed.thumb, thumb.blob, "image/webp", report(2)),
    ]);

    await assertQueueScope(scope);
    await finalizePhoto({
      headers: { Authorization: `Bearer ${scope.token}` },
      data: {
        projectId: item.projectId,
        photoId: item.id,
        ext: item.ext,
        mime: item.mime,
        sizeBytes: item.blob.size,
        width,
        height,
        capturedAt: exif.capturedAt,
        exifLat: exif.lat,
        exifLon: exif.lon,
        exifRaw: exif.raw,
        displayWidth: display.width,
        displayHeight: display.height,
        displayBytes: display.blob.size,
        thumbWidth: thumb.width,
        thumbHeight: thumb.height,
        thumbBytes: thumb.blob.size,
      },
    });

    await assertQueueScope(scope);
    if (item.folderId) {
      // Filing is best-effort: a folder write must never fail an upload.
      await queueClient(scope)
        .from("photos")
        .update({ folder_id: item.folderId })
        .eq("id", item.id);
    }

    await assertQueueScope(scope);
    await attachPhotoExtras(item, scope);

    await assertQueueScope(scope);
    await idbDel(photoKey(scope.ownerId, item.id));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const attempts = item.attempts + 1;
    const spent = attempts >= MAX_UPLOAD_ATTEMPTS;
    await patchPhoto(
      item.id,
      {
        // A refusal the server will repeat, or a photo that has had its run of
        // attempts, stops and says why rather than being retried forever.
        status: spent || isPermanent(e) ? "rejected" : "error",
        errorMessage: spent ? `Gave up after ${attempts} attempts. Last error: ${msg}` : msg,
        attempts,
      },
      scope,
    );
    throw e;
  } finally {
    inFlight.delete(item.id);
    notifyUploads();
  }
}

/**
 * Hand back any upload that was abandoned part-way, so a later drain will take
 * it. Mirrors what `drain` in offline-queue.ts does inline for a "sending"
 * item; it is a function here because the photo queue also needs to run it the
 * moment the app opens.
 *
 * The attempt is counted. It really was attempted, and a photo that strands
 * every single time has to reach the cap like any other failure rather than
 * being reclaimed round and round for the life of the install.
 *
 * `now` and `staleMs` are arguments and not defaults read inside a loop so a
 * test can pin them; the clock is never implicit here.
 */
export async function reclaimStalledUploads(
  opts: { now?: number; staleMs?: number } = {},
): Promise<number> {
  const scope = await queueScope();
  if (!scope) return 0;
  const now = opts.now ?? Date.now();
  const staleMs = opts.staleMs ?? UPLOADING_STALE_MS;
  let reclaimed = 0;
  for (const item of await listQueue()) {
    if (!isStalledUpload(item, now, staleMs)) continue;
    const attempts = item.attempts + 1;
    const spent = attempts >= MAX_UPLOAD_ATTEMPTS;
    await patchPhoto(
      item.id,
      {
        status: spent ? "rejected" : "queued",
        attempts,
        errorMessage: spent
          ? `Gave up after ${attempts} attempts. Last error: the upload kept being interrupted.`
          : "The upload was interrupted. Picking it back up.",
      },
      scope,
    );
    reclaimed += 1;
  }
  if (reclaimed) notifyUploads();
  return reclaimed;
}

/**
 * Is this item's attempt dead rather than slow?
 *
 * In this tab the answer is certain — `inFlight` holds exactly what has a
 * request open — so a genuinely long upload here is never reclaimed no matter
 * how long it runs. Everything else is judged on its stamp, and an item
 * written before this field existed has no stamp, which reads as "long ago"
 * and is precisely right: those are the ones that have been sitting.
 */
export function isStalledUpload(
  item: Pick<QueuedPhoto, "id" | "status" | "uploadingSince">,
  now: number,
  staleMs: number = UPLOADING_STALE_MS,
): boolean {
  if (item.status !== "uploading") return false;
  if (inFlight.has(item.id)) return false;
  return now - (item.uploadingSince ?? 0) >= staleMs;
}

/**
 * A retry asked for by hand. The attempt budget exists to stop a field phone
 * burning battery and cellular data on something hopeless; a person tapping
 * Retry is not that, so the budget starts over and the old error goes with it.
 */
export async function retryPhoto(id: string): Promise<void> {
  const scope = await requireQueueScope();
  const cur = await idbGet<QueuedPhoto>(photoKey(scope.ownerId, id));
  if (!cur || cur.ownerId !== scope.ownerId) return;
  await assertQueueScope(scope);
  await patchPhoto(id, { status: "queued", attempts: 0, errorMessage: undefined }, scope);
  await drainQueue(cur.projectId, 3, { includeRejected: true });
}

/**
 * What a queued photo is really doing, in words.
 *
 * `live` is whether the page asking has a request open for it, and that is the
 * fact that matters: the stored status reads "uploading" for an attempt the
 * app was killed in the middle of exactly as it does for one moving bytes
 * right now. Mark's three said "Uploading…" for four hours. They are picked
 * back up on their own, and this is the row saying so rather than pretending.
 */
export function photoStateLabel(p: Pick<QueuedPhoto, "status">, live: boolean): string {
  if (live) return "Uploading…";
  if (p.status === "rejected") return "Stopped — needs attention";
  if (p.status === "uploading") return "Interrupted — will retry on its own";
  if (p.status === "error") return "Failed — will retry";
  return "Waiting to upload";
}

let reclaimedThisLoad = false;

/**
 * The reclaim that runs when the app opens. Once per page load — three
 * components mount the sync hook and all three would otherwise race.
 */
export async function reclaimOnStartup(): Promise<number> {
  if (reclaimedThisLoad) return 0;
  reclaimedThisLoad = true;
  return reclaimStalledUploads({ staleMs: STARTUP_STALE_MS });
}

/**
 * Which items this pass should pick up.
 *
 * Pure and exported so the rule can be tested without an upload: an item
 * stuck in "uploading" past the window is taken, one inside it is left to the
 * page that is presumably still working on it, and a terminal one is left
 * alone unless the user has explicitly asked for everything.
 */
export function drainableNow(
  items: QueuedPhoto[],
  now: number,
  opts: { includeRejected?: boolean; staleMs?: number } = {},
): QueuedPhoto[] {
  return items.filter((item) => {
    if (item.status === "rejected") return opts.includeRejected === true;
    if (item.status === "uploading") return isStalledUpload(item, now, opts.staleMs);
    return !inFlight.has(item.id);
  });
}

/**
 * A photo that gave up because Storage said "The resource already exists".
 *
 * Every one of those was our bug, not the photo's: its bytes were stored, and
 * the queue spent its attempts being told so. Mark's 182nd photo from 5 October
 * is sitting in exactly this state on his phone. It should land without him
 * re-shooting it or finding a Retry button, so the next drain puts it back with
 * a fresh budget — once, marked, so nothing can be revived round and round.
 */
export function isAlreadyStoredRejection(
  item: Pick<QueuedPhoto, "status" | "errorMessage" | "alreadyStoredRequeued">,
): boolean {
  return (
    item.status === "rejected" &&
    item.alreadyStoredRequeued !== true &&
    isStorageAlreadyExists(item.errorMessage ?? "")
  );
}

async function requeueAlreadyStoredRejections(
  items: QueuedPhoto[],
  scope: QueueScope,
): Promise<QueuedPhoto[]> {
  const out: QueuedPhoto[] = [];
  for (const item of items) {
    if (!isAlreadyStoredRejection(item)) {
      out.push(item);
      continue;
    }
    const patch: Partial<QueuedPhoto> = {
      status: "queued",
      attempts: 0,
      errorMessage: undefined,
      alreadyStoredRequeued: true,
    };
    await patchPhoto(item.id, patch, scope);
    out.push({ ...item, ...patch });
  }
  return out;
}

/** One drain per project at a time — three mounted hooks all call this. */
const draining = new Set<string>();

/**
 * Drain the queue for a project. Runs up to N in parallel. Callers can
 * fire-and-forget; failed items stay in IDB with status='error' for retry.
 *
 * The `uploading` filter here used to be unconditional, and that is the whole
 * of the bug Mark hit: an attempt the app was killed in the middle of stayed
 * "uploading" and every later pass skipped it, so three job-site photos sat on
 * a phone for four hours showing a progress bar while nothing was happening,
 * and the job's album quietly read 179 of 182.
 */
export async function drainQueue(
  projectId: string,
  parallel = 3,
  opts: { includeRejected?: boolean; now?: number } = {},
): Promise<void> {
  const scope = await queueScope();
  if (!scope) return;
  if (draining.has(projectId)) return;
  draining.add(projectId);
  try {
    parallel = Math.max(1, Math.floor(parallel) || 1);
    const listed = await requeueAlreadyStoredRejections(await listQueue(projectId), scope);
    const items = drainableNow(listed, opts.now ?? Date.now(), {
      includeRejected: opts.includeRejected,
    });
    const inflight: Promise<void>[] = [];
    for (const item of items) {
      while (inflight.length >= parallel) {
        await Promise.race(inflight);
      }
      try {
        await assertQueueScope(scope);
      } catch {
        break;
      }
      const p = uploadQueued(item)
        .catch(() => {}) // errors already recorded on the item
        .finally(() => {
          const i = inflight.indexOf(p);
          if (i >= 0) inflight.splice(i, 1);
        });
      inflight.push(p);
    }
    await Promise.all(inflight);
  } finally {
    draining.delete(projectId);
  }
}

// ---------- Client-side thumb URL cache ----------
const urlCache = new Map<string, { url: string; expiresAt: number }>();

export async function signedVariantUrl(path: string): Promise<string> {
  const scope = await requireQueueScope();
  const key = photoKey(scope.ownerId, path);
  const now = Date.now();
  const cached = urlCache.get(key);
  if (cached && cached.expiresAt > now + 60_000) return cached.url;
  // Ten minutes (was thirty); the cache above re-signs a minute before expiry,
  // so a grid kept open simply asks again.
  const { data, error } = await signStoredFile(queueClient(scope), "project-photos", path, {
    seconds: SIGNED_URL_DEFAULT_SECONDS,
  });
  if (error || !data) throw new Error(error?.message ?? "Failed to sign URL");
  await assertQueueScope(scope);
  urlCache.set(key, { url: data.signedUrl, expiresAt: now + SIGNED_URL_DEFAULT_SECONDS * 1000 });
  return data.signedUrl;
}
