/**
 * Restarting the 3-day drying window, from a basement.
 *
 * David's scope of work, 2 Sep: "Reset 3 days of drying time (new button
 * linked to scanning and alerts)." The arithmetic is in drying-clock.ts; this
 * is the reading and the writing of the statement itself.
 *
 * Two rules shape it. The write goes through the offline queue like every
 * other field capture — the crew pressing this is standing next to the
 * equipment they just swapped, which is where the signal is worst — and the
 * table is append-only, so a mistaken reset is corrected by resetting again
 * with a reason rather than by editing away the first one.
 *
 * Table: `job_drying_resets` (migration 20260919121000). It was written
 * before the generated Supabase types knew it, so it is reached through an
 * untyped client and a missing table is "not set up yet", never an error on
 * the page — the same pattern as `planned-routes.ts` and `todo.ts`.
 *
 * ONE RESET, EVERYTHING FOLLOWS. There used to be two buttons: this
 * one, which restarted the clock but said in so many words that "expected
 * retrieval dates on the units already placed are not changed", and one on the
 * Tasks tab that moved the dates but left the clock running from the first
 * drop. "Linked to scanning and alerts" means one press does both, so a reset
 * now also pushes every unit still on the job out to the new 72-hour date. The
 * overdue-equipment alerts (Equipment page, the job's Equipment tab, the unit
 * page, Kahi's sync alerts, the overdue report) all read that column; the
 * Monitoring and Pick up equipment tasks are re-dated from it and from the
 * reset itself by `scheduleAutomaticTaskSync`, which the queue calls after
 * this write lands.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { supabase } from "@/integrations/supabase/client";
import { isMissingSchema } from "@/lib/schema-fallback";
import { newId, writeOrQueue } from "@/lib/offline-queue";
import { plannedRetrievalDate, type DryingReset } from "@/lib/drying-clock";

export type DryingResetInsert = {
  id: string;
  job_id: string;
  reset_at: string;
  reset_by: string | null;
  previous_started_at: string | null;
  note: string | null;
};

/**
 * Shared by the immediate write and by the queue draining hours later, so
 * there is one definition of what a reset is. Upsert on the client-generated
 * id: a retry after a response that never arrived updates the row it already
 * wrote instead of logging two restarts of the same window.
 */
export async function writeDryingReset(
  row: DryingResetInsert,
  client: typeof supabase = supabase,
): Promise<void> {
  // Dates first: they work on any database, and a reset row that landed with
  // its dates unmoved is the old two-button split all over again.
  await pushRetrievalDates(row.job_id, retrievalDateAfterReset(row.reset_at), client);
  const { error } = await (client as unknown as SupabaseClient)
    .from("job_drying_resets")
    .upsert(row, { onConflict: "id" });
  if (error) throw error;
}

/**
 * The expected-retrieval date a reset sets: 72 hours from the moment the crew
 * pressed it — not from when it synced — as a calendar date, by the same rule
 * the setup scan pre-fills with.
 */
export function retrievalDateAfterReset(resetAt: string): string {
  return plannedRetrievalDate(new Date(resetAt));
}

/**
 * Push every unit still on the job out to `date`. Only ever forward: a unit
 * somebody already planned to leave longer keeps its later date, and a unit
 * with no date gets one, so nothing on site is left without a date to be
 * overdue against. The filter is evaluated by the server, so a queue replay
 * of the same reset is a no-op rather than a second move.
 */
export async function pushRetrievalDates(
  jobId: string,
  date: string,
  client: typeof supabase = supabase,
): Promise<number> {
  const { data, error } = await client
    .from("equipment_placements")
    .update({ expected_retrieval_date: date })
    .eq("job_id", jobId)
    .is("retrieved_at", null)
    .or(`expected_retrieval_date.is.null,expected_retrieval_date.lt.${date}`)
    .select("id");
  if (error) throw error;
  return data?.length ?? 0;
}

/**
 * Every reset on the job, newest first.
 *
 * A missing table is "nobody has reset anything", not an error: until the
 * migration is applied the clock simply runs from the first placement, which
 * is exactly what it did before this feature existed.
 */
export async function listDryingResets(jobId: string): Promise<DryingReset[] | null> {
  const { data, error } = await (supabase as unknown as SupabaseClient)
    .from("job_drying_resets")
    .select("id, reset_at, reset_by, previous_started_at, note")
    .eq("job_id", jobId)
    .order("reset_at", { ascending: false })
    .limit(50);
  if (error) {
    // Null, not []: "not set up yet" and "no resets" look identical to a
    // caller given an empty array, and the button has to say different things.
    if (isMissingSchema(error)) return null;
    throw error;
  }
  return (data ?? []) as unknown as DryingReset[];
}

/**
 * Press the button.
 *
 * `previousStartedAt` is passed in rather than re-read here because the clock
 * the crew is looking at is the clock they are restarting — reading it again
 * could pick up a reset that synced from another phone in between, and the
 * audit line would then describe a window this person never saw.
 */
export async function resetDryingClock(input: {
  jobId: string;
  userId: string | null;
  previousStartedAt: string | null;
  note: string | null;
}): Promise<{ queued: boolean }> {
  const id = newId();
  const row: DryingResetInsert = {
    id,
    job_id: input.jobId,
    // The moment the crew pressed it. A reset that syncs three hours later
    // must not move the window three hours forward.
    reset_at: new Date().toISOString(),
    reset_by: input.userId,
    previous_started_at: input.previousStartedAt,
    note: input.note?.trim() || null,
  };
  return writeOrQueue({
    kind: "drying_reset",
    id,
    payload: row as unknown as Record<string, unknown>,
    label: "3-day drying reset",
    write: () => writeDryingReset(row),
  });
}
