/**
 * The raw writes behind the offline queue's newer kinds.
 *
 * One definition each, shared by the immediate attempt and by the queue
 * draining hours later, so "what it means to clock in" cannot drift into two
 * versions. They live here rather than in their domain modules for one
 * mechanical reason: `offline-queue` imports this file, so nothing in it may
 * import `offline-queue` back. The queue-aware wrappers do that instead, from
 * `timeclock.ts`, `job-update.ts`, `job-photos.ts` and `equipment-writes.ts`.
 *
 * Every function here takes the moment of capture as an argument. None of them
 * calls `new Date()`. A punch, a note or a caption belongs to when the user
 * made it, not to when the phone found a bar of signal.
 */
import { supabase } from "@/integrations/supabase/client";

/**
 * A refusal the server will repeat however many times it is asked. The queue
 * tests for this flag before it tests error text, so a permanent failure is
 * classified by type rather than by whether its wording happens to match a
 * phrase list. `equipment-scan.ts` throws its own class with the same flag.
 */
export class PermanentWriteError extends Error {
  readonly permanent = true;
  constructor(message: string) {
    super(message);
    this.name = "PermanentWriteError";
  }
}

function code(error: unknown): string {
  return String((error as { code?: string } | null)?.code ?? "");
}

function text(error: unknown): string {
  return String((error as { message?: string } | null)?.message ?? "");
}

/* ------------------------------------------------------------------ */
/* Time clock                                                          */
/* ------------------------------------------------------------------ */

export type ClockInRow = {
  /** The queue item id, so a drain that runs twice cannot open two shifts. */
  id: string;
  user_id: string;
  location_id: string;
  /** When the crew tapped the button. */
  clock_in_at: string;
  clock_in_lat: number | null;
  clock_in_lon: number | null;
};

/**
 * `shifts_one_open_idx` allows a user one shift with no clock-out. A queued
 * punch draining onto a day where another shift is already open hits it, and
 * no number of retries will change that — someone has to close the other
 * shift. Told apart from a primary-key conflict, which is what a write that in
 * fact succeeded looks like when its response was lost, and which the upsert
 * absorbs.
 */
export async function writeClockIn(row: ClockInRow): Promise<void> {
  const { error } = await supabase.from("shifts").upsert(row as never, { onConflict: "id" });
  if (!error) return;
  if (code(error) === "23505" && /one_open/i.test(text(error))) {
    throw new PermanentWriteError(
      "You already have a shift open that was never clocked out, so this clock-in cannot be filed. Close that shift, then add these hours by hand.",
    );
  }
  throw error;
}

export type ClockOutInput = {
  shiftId: string;
  /** When the crew tapped the button. */
  at: string;
  lat: number | null;
  lon: number | null;
};

/**
 * The read-back is not decoration. An update that matches no row returns
 * success with zero rows — a shift deleted, reassigned, or hidden from this
 * user by RLS all look identical to a clean save, and the queue would drop the
 * punch as sent. `shifts_select` always covers the user's own shifts, so an
 * empty result here really does mean the shift is not theirs any more.
 */
export async function writeClockOut(input: ClockOutInput): Promise<void> {
  const { data, error } = await supabase
    .from("shifts")
    .update({
      clock_out_at: input.at,
      clock_out_lat: input.lat,
      clock_out_lon: input.lon,
      status: "closed",
    })
    .eq("id", input.shiftId)
    .select("id");
  if (error) throw error;
  if (!data?.length) {
    throw new PermanentWriteError(
      "The shift these hours belong to is no longer on your record. Give the times to your manager to enter by hand.",
    );
  }
}

/* ------------------------------------------------------------------ */
/* Job record                                                          */
/* ------------------------------------------------------------------ */

export type JobNoteRow = {
  /** The queue item id, so a replay rewrites one note instead of filing two. */
  id: string;
  job_id: string;
  author_id: string | null;
  body: string;
  /** When it was written, not when it landed — the timeline reads by this. */
  created_at: string;
};

export async function writeJobNote(row: JobNoteRow): Promise<void> {
  const { error } = await supabase.from("job_notes").upsert(row as never, { onConflict: "id" });
  if (error) throw error;
}

/**
 * A field patch is idempotent on its own — the same columns set to the same
 * values, however many times it runs. There is deliberately no read-back: not
 * every role that may update a job may select it afterwards, and a false
 * "row not found" would reject an edit that had in fact been applied.
 */
export async function writeJobFields(jobId: string, patch: Record<string, unknown>): Promise<void> {
  if (Object.keys(patch).length === 0) return;
  const { error } = await supabase
    .from("jobs")
    .update(patch as never)
    .eq("id", jobId);
  if (error) throw error;
}

/* ------------------------------------------------------------------ */
/* Photo annotations                                                   */
/* ------------------------------------------------------------------ */

export type PhotoCaptionInput = {
  /** Existing caption comment to rewrite, or null to write the first one. */
  commentId: string | null;
  /** New comment id — the queue item id — used only when commentId is null. */
  id: string;
  photoId: string;
  authorId: string;
  body: string;
  /** When the caption was typed. */
  at: string;
};

/**
 * The caption is the photo's first comment, so an edit rewrites that row.
 * RLS lets only the comment's author change it, and refuses by returning zero
 * rows rather than an error — which is why the count is checked and turned
 * into a refusal a person can read.
 */
export async function writePhotoCaption(input: PhotoCaptionInput): Promise<void> {
  const body = input.body.trim();

  if (input.commentId) {
    const { data, error } = await supabase
      .from("photo_comments")
      .update(body ? { body } : { deleted_at: input.at })
      .eq("id", input.commentId)
      .select("id");
    if (error) throw error;
    if (!data?.length) {
      throw new PermanentWriteError("Only whoever wrote that description can change it.");
    }
    return;
  }
  if (!body) return;
  const { error } = await supabase.from("photo_comments").upsert(
    {
      id: input.id,
      photo_id: input.photoId,
      body,
      author_id: input.authorId,
      created_at: input.at,
    } as never,
    { onConflict: "id" },
  );
  if (error) throw error;
}

export type PhotoTagsInput = {
  photoId: string;
  /** Tag ids to attach and to detach. Replaying either is a no-op. */
  add: string[];
  remove: string[];
  userId: string | null;
};

export async function writePhotoTags(input: PhotoTagsInput): Promise<void> {
  if (input.remove.length) {
    const { error } = await supabase
      .from("photo_tags")
      .delete()
      .eq("photo_id", input.photoId)
      .in("tag_id", input.remove);
    if (error) throw error;
  }
  if (input.add.length) {
    // Ignore-duplicates rather than insert: a second drain of the same item
    // finds the links already there, and a duplicate key would reject the
    // whole batch including the tags that are not yet attached.
    const { error } = await supabase.from("photo_tags").upsert(
      input.add.map((tag_id) => ({ photo_id: input.photoId, tag_id, created_by: input.userId })),
      { onConflict: "photo_id,tag_id", ignoreDuplicates: true },
    );
    if (error) throw error;
  }
}

/* ------------------------------------------------------------------ */
/* Equipment                                                           */
/* ------------------------------------------------------------------ */

export type EquipmentNoteInput = {
  equipmentId: string;
  notes: string | null;
  /** When the note was typed, so `updated_at` is not the sync time. */
  at: string;
};

export async function writeEquipmentNote(input: EquipmentNoteInput): Promise<void> {
  const { error } = await supabase
    .from("equipment")
    .update({ notes: input.notes, updated_at: input.at })
    .eq("id", input.equipmentId);
  if (error) throw error;
}
