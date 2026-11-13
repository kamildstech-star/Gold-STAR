/**
 * The raw writes behind a rep's to-do list — one definition shared by the
 * immediate attempt and by the offline queue draining it later, so what a
 * tap does cannot drift into two versions. Lives apart from `todo.ts` for the
 * same mechanical reason as `tradeshow-lead-writes.ts`: `offline-queue`
 * imports this file, so nothing in it may import `offline-queue` back.
 *
 * Every op is safe to run twice. A rep in a basement ticks something, the
 * response is lost, the queue sends it again an hour later: an `add` upserts
 * on an id chosen at the tap, a `pin` upserts on (user, task), a `remove` of
 * a row that is already gone is a no-op, and `promote` carries the task id
 * it will use so the database can recognise its own earlier success.
 *
 * The table postdates the generated Supabase types, so it is reached through
 * an untyped client — the same route `planned-routes.ts` takes.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type TodoOp =
  | { op: "add"; id: string; userId: string; title: string; jobId: string | null }
  | { op: "pin"; id: string; userId: string; taskId: string }
  | { op: "remove"; id: string }
  | { op: "done"; id: string; doneAt: string | null }
  | { op: "reorder"; order: { id: string; sortOrder: number }[] }
  | { op: "promote"; id: string; taskId: string; dueDate: string | null };

const untyped = (client: SupabaseClient) => client as unknown as SupabaseClient;

export async function applyTodoOp(op: TodoOp, client: SupabaseClient): Promise<void> {
  const db = untyped(client);
  switch (op.op) {
    case "add": {
      const { error } = await db
        .from("todo_items")
        .upsert(
          { id: op.id, user_id: op.userId, title: op.title, job_id: op.jobId, task_id: null },
          { onConflict: "id", ignoreDuplicates: true },
        );
      if (error) throw error;
      return;
    }
    case "pin": {
      // (user_id, task_id) is the unique constraint, so a second pin of the
      // same task — a replay, or two taps on two screens — is one row.
      const { error } = await db
        .from("todo_items")
        .upsert(
          { id: op.id, user_id: op.userId, task_id: op.taskId },
          { onConflict: "user_id,task_id", ignoreDuplicates: true },
        );
      if (error) throw error;
      return;
    }
    case "remove": {
      const { error } = await db.from("todo_items").delete().eq("id", op.id);
      if (error) throw error;
      return;
    }
    case "done": {
      const { error } = await db
        .from("todo_items")
        .update({ done_at: op.doneAt })
        .eq("id", op.id)
        .is("task_id", null);
      if (error) throw error;
      return;
    }
    case "reorder": {
      // A handful of rows, one update each. Not an upsert: an upsert row that
      // finds no match would try to insert a titleless item and hit the CHECK.
      for (const row of op.order) {
        const { error } = await db
          .from("todo_items")
          .update({ sort_order: row.sortOrder })
          .eq("id", row.id);
        if (error) throw error;
      }
      return;
    }
    case "promote": {
      // One call, one transaction: the task insert and the item update land
      // together or not at all. See promote_todo_item in the migration.
      const { error } = await db.rpc("promote_todo_item", {
        _todo_id: op.id,
        _task_id: op.taskId,
        _due_date: op.dueDate,
      });
      if (error) throw error;
      return;
    }
  }
}

/** What the sync list calls a queued op while it waits. */
export function todoOpLabel(op: TodoOp): string {
  switch (op.op) {
    case "add":
      return `To-do: ${op.title}`;
    case "pin":
      return "Add to my to-do";
    case "remove":
      return "Remove from my to-do";
    case "done":
      return op.doneAt ? "Tick a to-do" : "Untick a to-do";
    case "reorder":
      return "Reorder my to-do";
    case "promote":
      return "Make a to-do a task";
  }
}
