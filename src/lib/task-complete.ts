/**
 * The one way a task gets ticked.
 *
 * Mark, on a task row in the account Timeline: "tasks need to be smarter and
 * needs to act as a task this is just a non actionable item which needs to
 * change". The Needs-you-today card, the /tasks page and the Timeline all
 * offer Complete, and until this file each had its own update — one of them
 * queued for a dead zone, the others not. Three copies of "status = done" is
 * how one of them drifts, so every Complete in the app now comes through here.
 *
 * It goes through the offline queue the way /tasks always did: a tick in a
 * basement holds on the device and goes up when service returns, and the
 * caller is told `queued` so it can say so rather than "Task completed".
 * `completed_at` is stamped here, not on replay, so a task ticked at the end
 * of the job is not dated to the drive home.
 */
import { supabase } from "@/integrations/supabase/client";
import { newId, writeOrQueue } from "@/lib/offline-queue";

export type CompleteTaskInput = {
  taskId: string;
  /** What the sync list calls it while it waits. */
  label: string;
  /** Ticking a done task un-ticks it. */
  reopen?: boolean;
  /** How it was done (11 Nov). Blank = no note; reopening clears it. */
  note?: string | null;
};

export type CompleteTaskResult = {
  queued: boolean;
  /** What the row now says, so a caller can patch its own copy without a refetch. */
  status: "done" | "open";
  completedAt: string | null;
};

export async function completeTask(input: CompleteTaskInput): Promise<CompleteTaskResult> {
  const reopen = input.reopen === true;
  const capturedAt = new Date().toISOString();
  const note = reopen ? null : input.note?.trim() || null;
  const { queued } = await writeOrQueue({
    kind: "task_complete",
    id: newId(),
    payload: { taskId: input.taskId, reopen, capturedAt, note },
    label: input.label,
    write: async () => {
      const { error } = await supabase
        .from("tasks")
        .update({
          status: reopen ? "open" : "done",
          completed_at: reopen ? null : capturedAt,
          // Written with a note, and cleared on reopen; a plain Complete
          // leaves the column alone.
          ...(note ? { completion_note: note } : reopen ? { completion_note: null } : {}),
        })
        .eq("id", input.taskId);
      if (error) throw error;
    },
  });
  return {
    queued,
    status: reopen ? "open" : "done",
    completedAt: reopen ? null : capturedAt,
  };
}

/** What the toast says, so the three callers agree on the words. */
export const TASK_QUEUED_MESSAGE = "Held on this device — it syncs when you have signal.";
