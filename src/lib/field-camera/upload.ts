/**
 * Field Camera → the job's album, through the SAME path the Pictures tab
 * uses: `ensureJobAlbum`, then `enqueuePhoto` into the IndexedDB photo queue,
 * then `drainQueue`. Nothing here talks to storage directly, so a shot taken
 * in a basement with no bars sits on the phone and goes up when signal
 * returns, exactly like a photo from the Pictures tab — and shows up in the
 * same "still on this phone" notice and sync sheet.
 *
 * What is added is the capture record. There is no column for it and none is
 * needed: `photos.exif_raw` is already a jsonb of capture facts (it holds the
 * EXIF of an uploaded file), and a canvas-encoded JPEG has no EXIF of its own,
 * so the field is free to carry where, when, who and how instead. The row's
 * own `captured_at`, `exif_lat` and `exif_lon` are filled from the device, so
 * the map, the per-day counts and the report PDFs read a camera shot the same
 * way they read any other photo.
 */
import { ensureJobAlbum, FIELD_CAMERA_SOURCE } from "@/lib/job-photos";
import { newId } from "@/lib/offline-queue";
import type { JobForAlbum } from "@/lib/photo-projects";
import {
  dequeuePhoto,
  drainQueue,
  enqueuePhoto,
  listQueue,
  newPhotoId,
  updateQueueItem,
  uploadProgress,
} from "@/lib/photos";
import { supabase } from "@/integrations/supabase/client";
import type { AddressSource } from "./geo";
import type { StampField } from "./stamp";

/** The value of `exif_raw.source` that marks a live, in-app capture. */
export { FIELD_CAMERA_SOURCE };

export type FieldCaptureMeta = {
  v: 1;
  taken_at: string;
  time_zone: string;
  utc_offset_min: number;
  lat: number | null;
  lon: number | null;
  accuracy_m: number | null;
  /** How old the fix was when the shutter fired, in seconds. */
  fix_age_s: number | null;
  address: string | null;
  address_source: AddressSource;
  job_id: string;
  job_number: string | null;
  room_id: string | null;
  folder_id: string | null;
  tag_ids: string[];
  note: string | null;
  user_id: string;
  crew_name: string | null;
  facing: "environment" | "user";
  zoom: number;
  stamp_fields: StampField[];
  width: number;
  height: number;
};

/** The jsonb written to `photos.exif_raw` for a Field Camera shot. Pure. */
export function captureRecord(meta: FieldCaptureMeta): Record<string, unknown> {
  return { source: FIELD_CAMERA_SOURCE, field_camera: meta };
}

/** Does an `exif_raw` value mark a Field Camera shot? */
export function isFieldCameraRaw(raw: unknown): boolean {
  return (
    !!raw && typeof raw === "object" && (raw as { source?: unknown }).source === FIELD_CAMERA_SOURCE
  );
}

export type QueuedShot = { photoId: string; projectId: string; captionId: string | null };

/**
 * Hold one stamped shot for upload and start the drain. Returns as soon as
 * the bytes are in IndexedDB — the shutter never waits on the network.
 *
 * `albumFor` exists for the tests and for a caller that already knows the
 * album; by default it is `ensureJobAlbum`, which creates the album on a
 * job's first photo exactly as the Pictures tab does.
 */
export async function queueFieldShot(input: {
  job: JobForAlbum;
  userId: string;
  blob: Blob;
  meta: FieldCaptureMeta;
  folderId: string | null;
  tagIds: string[];
  note: string | null;
  albumFor?: (job: JobForAlbum, userId: string) => Promise<string>;
  onLanded?: () => void;
}): Promise<QueuedShot> {
  const projectId = await (input.albumFor ?? ensureJobAlbum)(input.job, input.userId);
  const photoId = newPhotoId();
  const note = input.note?.trim() || null;
  const captionId = note ? newId() : null;
  await enqueuePhoto({
    id: photoId,
    projectId,
    blob: input.blob,
    ext: "jpg",
    mime: "image/jpeg",
    capturedAt: input.meta.taken_at,
    exifLat: input.meta.lat,
    exifLon: input.meta.lon,
    exifRaw: captureRecord(input.meta),
    width: input.meta.width,
    height: input.meta.height,
    folderId: input.folderId,
    tagIds: input.tagIds,
    caption: note,
    captionId,
  });
  void drainQueue(projectId).finally(() => input.onLanded?.());
  return { photoId, projectId, captionId };
}

/**
 * Change the note on a shot from the review strip. Still on the phone: the
 * queued item is edited, so the caption lands with the photo. Already landed:
 * the caption row is written (or rewritten, under the id it was filed with).
 */
export async function setShotNote(
  shot: QueuedShot,
  note: string,
  userId: string,
): Promise<{ captionId: string | null }> {
  const body = note.trim();
  const queued = (await listQueue(shot.projectId)).some((q) => q.id === shot.photoId);
  const captionId = shot.captionId ?? (body ? newId() : null);
  if (queued && uploadProgress(shot.photoId) === null) {
    await updateQueueItem(shot.photoId, { caption: body || null, captionId });
    return { captionId };
  }
  if (!captionId) return { captionId: null };
  const { error } = await supabase.from("photo_comments").upsert(
    {
      id: captionId,
      photo_id: shot.photoId,
      body: body || "",
      author_id: userId,
      deleted_at: body ? null : new Date().toISOString(),
    } as never,
    { onConflict: "id" },
  );
  if (error) throw error;
  return { captionId };
}

/**
 * Take a shot back. Still on the phone and not mid-upload: it is dropped from
 * the queue and never leaves. Otherwise the row is soft-deleted the same way
 * the Pictures tab removes a photo (the file is retained). Returns whether a
 * row may still land later — the caller re-applies the delete after the drain.
 */
export async function discardShot(shot: QueuedShot, userId: string): Promise<{ pending: boolean }> {
  const queued = (await listQueue(shot.projectId)).some((q) => q.id === shot.photoId);
  if (queued && uploadProgress(shot.photoId) === null) {
    await dequeuePhoto(shot.photoId);
    return { pending: false };
  }
  const { error } = await supabase
    .from("photos")
    .update({
      deleted_at: new Date().toISOString(),
      deleted_by: userId,
      deleted_reason: "Discarded in the Field Camera review",
    })
    .eq("id", shot.photoId);
  if (error) throw error;
  return { pending: queued };
}

export type ShotStatus = "queued" | "uploading" | "uploaded" | "failed";

/**
 * A shot's state from the queue's own records: in the queue and in flight is
 * uploading, in the queue with an error is failed, in the queue otherwise is
 * queued, and gone from the queue is uploaded (the queue deletes an item only
 * after `finalizePhoto` succeeds). Pure.
 */
export function shotStatus(
  photoId: string,
  pending: readonly { id: string; status: string }[],
  inFlight: Readonly<Record<string, number>>,
): ShotStatus {
  const q = pending.find((p) => p.id === photoId);
  if (!q) return "uploaded";
  if (photoId in inFlight) return "uploading";
  if (q.status === "error" || q.status === "rejected") return "failed";
  return "queued";
}
