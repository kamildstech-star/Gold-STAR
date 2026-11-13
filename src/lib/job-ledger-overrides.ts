import type { SupabaseClient } from "@supabase/supabase-js";

import { supabase } from "@/integrations/supabase/client";
import type { LedgerOverrides } from "@/lib/job-ledger";
import { isMissingSchema } from "@/lib/schema-fallback";

/**
 * The figures typed into the Job ledger strip (migration 20261007224500,
 * hidden until applied). One row per (job, cell); deleting the row is "Back
 * to calculated".
 *
 * These are ledger-only figures. Nothing here reads or writes invoices,
 * payments, placements, tickets or time entries, and nothing should: a typed
 * Billed is what Mark wants the ledger to say, not a change to what the
 * customer was invoiced.
 *
 * `available: false` is the migration not being applied yet; the strip keeps
 * every cell read-only and says editing is not available yet.
 */

// The table is newer than the generated types.
const db = () => supabase as unknown as SupabaseClient;

export const LEDGER_OVERRIDES_KEY = (jobId: string) => ["job-ledger-overrides", jobId] as const;

export type LedgerOverridesRead = { available: boolean; values: LedgerOverrides };

export async function fetchLedgerOverrides(jobId: string): Promise<LedgerOverridesRead> {
  const { data, error } = await db()
    .from("job_ledger_overrides")
    .select("cell_key, value, updated_at")
    .eq("job_id", jobId);
  if (error) {
    if (isMissingSchema(error)) return { available: false, values: {} };
    throw error;
  }
  const values: LedgerOverrides = {};
  for (const row of (data ?? []) as { cell_key: string; value: unknown; updated_at?: string }[]) {
    const value = Number(row.value);
    if (Number.isFinite(value)) values[row.cell_key] = { value, updatedAt: row.updated_at ?? null };
  }
  return { available: true, values };
}

/** Type a figure into a cell. Who and when are stamped by the database. */
export async function saveLedgerOverride(jobId: string, cellKey: string, value: number) {
  const { error } = await db()
    .from("job_ledger_overrides")
    .upsert({ job_id: jobId, cell_key: cellKey, value }, { onConflict: "job_id,cell_key" });
  if (error) throw error;
}

/** Back to calculated (or, for an entry, back to a dash). */
export async function clearLedgerOverride(jobId: string, cellKey: string) {
  const { error } = await db()
    .from("job_ledger_overrides")
    .delete()
    .eq("job_id", jobId)
    .eq("cell_key", cellKey);
  if (error) throw error;
}
