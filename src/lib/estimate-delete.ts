/**
 * Deleting an estimate from a job's Billing tab.
 *
 * Mark, 2026-10-06, of an empty "ESTIMATE-2 v1 DRAFT — $0" beside his real
 * estimate and a Water calculator row: "add a delete button here". In the
 * same message: "in timeline have a restore button for each item that gets
 * removed or changed".
 *
 * A HARD DELETE, ON PURPOSE. The Timeline Restore (#300, src/lib/record-history.ts)
 * set the convention before this was written: "Hard delete stays a hard
 * DELETE. Do NOT add deleted_at / soft delete to a table to make it
 * restorable" — the `"A_record_history"` trigger keeps the before-image and
 * the Timeline puts the row back. So an estimate (with its scopes and lines)
 * and a Quick Estimate are deleted with a plain DELETE, and nothing here
 * writes history; the database does, whatever path the delete takes.
 *
 * Which makes one thing non-negotiable: Delete is only offered where the
 * trigger is actually there. `fetchDeleteSupport` asks the database
 * (`record_history_covers`, 20261006163000) per table; until that and #300's
 * migration are applied the answer is "no" and the Billing tab offers no
 * Delete at all, so nothing is ever deleted that could not come back.
 *
 * Who may delete is the table's DELETE policy and nobody else's call:
 * estimates_delete / job_calculations_delete — the office's managers and the
 * person who wrote it. RLS refuses everyone else by deleting nothing, which
 * would look like success; `.select("id")` turns that into a sentence.
 *
 * An invoiced estimate is refused by the database (the invoice's link to it
 * is ON DELETE SET NULL, and losing it would cut the invoice off from what it
 * billed); the Billing tab does not offer Delete on an invoiced row at all.
 */
import { supabase } from "@/integrations/supabase/client";

export type EstimateKind = "estimate" | "calculator";

export type DeleteSupport = Record<EstimateKind, boolean>;

export const NO_DELETE: DeleteSupport = { estimate: false, calculator: false };

const TABLE: Record<EstimateKind, "estimates" | "job_calculations"> = {
  estimate: "estimates",
  calculator: "job_calculations",
};

/**
 * Per kind, whether a delete would be restorable from the Timeline. Any error
 * — the function missing, a dropped connection — is "no": the cost of hiding
 * Delete for a minute is nothing beside a delete nobody can undo.
 */
export async function fetchDeleteSupport(): Promise<DeleteSupport> {
  const ask = async (kind: EstimateKind) => {
    // Not in the generated types until 20261006163000 is applied.
    const { data, error } = await (
      supabase.rpc as unknown as (
        fn: string,
        args: Record<string, unknown>,
      ) => Promise<{ data: unknown; error: unknown }>
    )("record_history_covers", { _table: TABLE[kind] });
    return !error && data === true;
  };
  const [estimate, calculator] = await Promise.all([
    ask("estimate").catch(() => false),
    ask("calculator").catch(() => false),
  ]);
  return { estimate, calculator };
}

/** Whether a row offers Delete: restorable here, and not already an invoice. */
export function canOfferDelete(
  kind: EstimateKind,
  support: DeleteSupport,
  invoiced: boolean,
): boolean {
  return support[kind] && !invoiced;
}

export async function deleteEstimateRow(kind: EstimateKind, id: string): Promise<void> {
  const { data, error } = await supabase.from(TABLE[kind]).delete().eq("id", id).select("id");
  if (error) throw error;
  if (!data?.length) {
    throw new Error(
      "You can't delete this estimate. Only the person who wrote it, or a manager of its office, can.",
    );
  }
}
