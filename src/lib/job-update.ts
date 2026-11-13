import { toast } from "sonner";
import { toastDbError } from "@/lib/db-errors";
import { newId, writeOrQueue } from "@/lib/offline-queue";
import { writeJobFields, writeJobNote } from "@/lib/offline-writes";

/**
 * Single write path for job edits.
 *
 * The database trigger `log_job_field_changes` records who changed what from
 * what to what, so every caller here lands on the job timeline automatically —
 * inline edits, the full form, and anything else that goes through it.
 *
 * A crew standing in the basement marking the job complete is doing the same
 * thing as a coordinator at a desk, so the edit is held on the device when the
 * network will not take it. What the caller must not do is show a held edit as
 * a saved one; `saveJobField` says which happened, and `updateJobFields`
 * returns false only when the edit is actually lost.
 */
export async function updateJobFields(
  jobId: string,
  patch: Record<string, unknown>,
): Promise<boolean> {
  return (await updateJobFieldsQueued(jobId, patch)).ok;
}

export type JobWriteResult = { ok: boolean; queued: boolean };

export async function updateJobFieldsQueued(
  jobId: string,
  patch: Record<string, unknown>,
  label = "Job update",
): Promise<JobWriteResult> {
  if (Object.keys(patch).length === 0) return { ok: true, queued: false };
  try {
    /*
     * Setting the same columns to the same values again changes nothing, so
     * the patch needs no idempotency key of its own — but the queue item still
     * gets one, because that is how the pending list addresses it.
     */
    const { queued } = await writeOrQueue({
      kind: "job_field",
      id: newId(),
      payload: { jobId, patch },
      label,
      write: () => writeJobFields(jobId, patch),
    });
    return { ok: true, queued };
  } catch (error) {
    toastDbError(error, { action: "save the job" });
    return { ok: false, queued: false };
  }
}

export async function saveJobField(
  jobId: string,
  key: string,
  value: unknown,
  label: string,
): Promise<boolean> {
  const res = await updateJobFieldsQueued(jobId, { [key]: value }, label);
  if (res.queued) toast.warning(`${label} held on this device — it saves when you have signal.`);
  else if (res.ok) toast.success(`${label} saved`);
  return res.ok;
}

/**
 * A note written on site.
 *
 * The queue item id is the note's primary key, so a drain that starts twice
 * updates one note instead of filing the same paragraph against the job twice,
 * and `created_at` is when it was typed — the job timeline is read in order,
 * and a note that lands at the top of the day's list because that is when the
 * van found signal tells the wrong story about the day.
 */
export async function addJobNote(input: {
  jobId: string;
  authorId: string | null;
  body: string;
}): Promise<{ queued: boolean }> {
  const body = input.body.trim();
  if (!body) return { queued: false };
  const id = newId();
  // Stamped once, before the attempt, and carried into the queue — so the note
  // reads the same whether it went up now or after the drive out.
  const capturedAt = new Date().toISOString();
  return writeOrQueue({
    kind: "job_note",
    id,
    payload: { jobId: input.jobId, authorId: input.authorId, body, capturedAt },
    label: body.slice(0, 60),
    write: () =>
      writeJobNote({
        id,
        job_id: input.jobId,
        author_id: input.authorId,
        body,
        created_at: capturedAt,
      }),
  });
}
