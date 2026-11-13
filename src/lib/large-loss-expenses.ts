/**
 * Large-loss expense tracking on a job.
 *
 * David, 13 Oct: on large jobs — large loss, T&M, reconstruction — track what
 * the job spends on third-party contractors, supplies and equipment, and keep
 * the receipt with each one. Not on every job: it is switched on per job with
 * `jobs.is_large_loss` (migration 20261014120000). Whether it should instead
 * be a permanent tab is David's open call — `LARGE_LOSS_ALWAYS_ON` flips it.
 *
 * NO NEW TABLE. An entry is a row in `public.expenses` with the job's id and a
 * `job_*` kind. `job_running_cost()` already adds every expense on a job to
 * the running cost (its `exp` CTE), so an entry here moves the job's cost the
 * moment it is saved, with no change to the cost engine. The receipt is filed
 * as a job document (in an "Expense receipts" folder) and its storage path
 * kept on the expense, so it is on the job's Documents tab too.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { supabase } from "@/integrations/supabase/client";
import { isMissingSchema } from "@/lib/schema-fallback";
import { roundMoney } from "@/lib/money";

/**
 * Toggle-activated by default (David to confirm, 13 Oct). True shows the
 * section on every job and hides the switch.
 */
export const LARGE_LOSS_ALWAYS_ON = false;

export const LARGE_LOSS_CATEGORIES = [
  { kind: "job_contractor", label: "Third-party contractor" },
  { kind: "job_supplies", label: "Supplies" },
  { kind: "job_equipment", label: "Equipment" },
  { kind: "job_other", label: "Other" },
] as const;
export type LargeLossKind = (typeof LARGE_LOSS_CATEGORIES)[number]["kind"];

export const LARGE_LOSS_KINDS: readonly string[] = LARGE_LOSS_CATEGORIES.map((c) => c.kind);
export const isLargeLossKind = (kind: string | null | undefined): kind is LargeLossKind =>
  !!kind && LARGE_LOSS_KINDS.includes(kind);
export const largeLossLabel = (kind: string) =>
  LARGE_LOSS_CATEGORIES.find((c) => c.kind === kind)?.label ?? kind;

/** The folder each receipt is filed into on the job's Documents. */
export const RECEIPTS_FOLDER = "Expense receipts";

export type LargeLossExpense = {
  id: string;
  kind: LargeLossKind;
  amount: number;
  spent_on: string;
  merchant: string | null;
  description: string | null;
  receipt_path: string | null;
  user_id: string;
  created_at: string;
};

export type LargeLossTotals = {
  total: number;
  byKind: Record<LargeLossKind, number>;
  count: number;
  withReceipt: number;
};

/** Dollars to the cent (named before money.ts existed). */
const cents = roundMoney;

export function largeLossTotals(
  rows: readonly Pick<LargeLossExpense, "kind" | "amount" | "receipt_path">[],
): LargeLossTotals {
  const byKind = Object.fromEntries(LARGE_LOSS_KINDS.map((k) => [k, 0])) as Record<
    LargeLossKind,
    number
  >;
  let total = 0;
  let withReceipt = 0;
  for (const r of rows) {
    const amt = Number(r.amount) || 0;
    byKind[r.kind] = cents((byKind[r.kind] ?? 0) + amt);
    total += amt;
    if (r.receipt_path) withReceipt += 1;
  }
  return { total: cents(total), byKind, count: rows.length, withReceipt };
}

export type LargeLossDraft = {
  kind: LargeLossKind;
  amount: number;
  spentOn: string;
  vendor: string;
  description: string;
};

/** What a draft is missing, in words, or null when it can be saved. */
export function largeLossDraftProblem(d: Partial<LargeLossDraft>): string | null {
  if (!d.kind || !isLargeLossKind(d.kind)) return "Pick what it was for.";
  if (!d.amount || !Number.isFinite(d.amount) || d.amount <= 0) return "Enter the amount.";
  if (!d.spentOn) return "Enter the date.";
  return null;
}

/** The `expenses` row an entry becomes. Pure, so the shape is tested. */
export function largeLossExpenseRow(input: {
  draft: LargeLossDraft;
  jobId: string;
  locationId: string | null;
  userId: string;
  receiptPath: string | null;
}) {
  return {
    user_id: input.userId,
    created_by: input.userId,
    job_id: input.jobId,
    // The job's office, so its managers see the entry (expenses RLS).
    location_id: input.locationId,
    kind: input.draft.kind,
    amount: cents(input.draft.amount),
    spent_on: input.draft.spentOn,
    merchant: input.draft.vendor.trim() || null,
    description: input.draft.description.trim() || null,
    receipt_path: input.receiptPath,
    recurrence: "one_off",
    // A job cost, not a personal claim: nothing to reimburse.
    reimbursed: true,
  };
}

const db = () => supabase as unknown as SupabaseClient;

/** Is the section switched on for this job? `available: false` before the migration. */
export async function fetchLargeLossFlag(
  jobId: string,
  client: SupabaseClient = db(),
): Promise<{ available: boolean; on: boolean }> {
  const { data, error } = await client
    .from("jobs")
    .select("is_large_loss")
    .eq("id", jobId)
    .maybeSingle();
  if (error) {
    if (isMissingSchema(error)) return { available: false, on: LARGE_LOSS_ALWAYS_ON };
    throw error;
  }
  const on = Boolean((data as { is_large_loss?: boolean } | null)?.is_large_loss);
  return { available: true, on: LARGE_LOSS_ALWAYS_ON || on };
}

export async function setLargeLossFlag(
  jobId: string,
  on: boolean,
  client: SupabaseClient = db(),
): Promise<void> {
  const { error } = await client.from("jobs").update({ is_large_loss: on }).eq("id", jobId);
  if (error) throw error;
}

export async function listLargeLossExpenses(
  jobId: string,
  client: SupabaseClient = db(),
): Promise<LargeLossExpense[]> {
  const { data, error } = await client
    .from("expenses")
    .select("id, kind, amount, spent_on, merchant, description, receipt_path, user_id, created_at")
    .eq("job_id", jobId)
    .in("kind", LARGE_LOSS_KINDS as string[])
    .order("spent_on", { ascending: false });
  if (error) throw error;
  return ((data ?? []) as LargeLossExpense[]).map((r) => ({ ...r, amount: Number(r.amount) }));
}

/**
 * Save one entry: the receipt first (filed on the job's Documents, in the
 * "Expense receipts" folder), then the expense carrying the receipt's path.
 * The uploads are passed in so the whole sequence is testable.
 */
export async function addLargeLossExpense(
  input: {
    draft: LargeLossDraft;
    jobId: string;
    locationId: string;
    accountId: string | null;
    userId: string;
    receipt: File | null;
  },
  deps: {
    client?: SupabaseClient;
    upload: (file: File) => Promise<{ id: string; path: string }>;
    file: (documentId: string) => Promise<unknown>;
  },
): Promise<{ id: string; receiptPath: string | null }> {
  const problem = largeLossDraftProblem(input.draft);
  if (problem) throw new Error(problem);
  let receiptPath: string | null = null;
  if (input.receipt) {
    const doc = await deps.upload(input.receipt);
    receiptPath = doc.path;
    await deps.file(doc.id);
  }
  const client = deps.client ?? db();
  const { data, error } = await client
    .from("expenses")
    .insert(
      largeLossExpenseRow({
        draft: input.draft,
        jobId: input.jobId,
        locationId: input.locationId,
        userId: input.userId,
        receiptPath,
      }),
    )
    .select("id")
    .single();
  if (error) throw error;
  return { id: (data as { id: string }).id, receiptPath };
}

export async function deleteLargeLossExpense(id: string, client: SupabaseClient = db()) {
  const { error } = await client.from("expenses").delete().eq("id", id);
  if (error) throw error;
}
