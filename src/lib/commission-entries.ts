/**
 * The named commission entries and a job's paid / outstanding status.
 *
 * David, 24 Sep: "in the backend we built different commission rates and
 * different names — Mark Adelman gets 20%, Nissen Goldstein gets 15%. I just
 * have a dropdown, I select his name and his rate automatically deducts... I
 * want to be able to mark off if the payment was actually made or still
 * outstanding."
 *
 * The entries are the `commission_rates` setting (20260918190000) — the same
 * list the job ledger already reads, extended with a kind (person or role) and
 * an active flag. Nothing is copied into a new table, so every seeded rate
 * (Salesman 10, Broker 10, PA 20, Shia Spira 25, Star Moore 30, the three Klein
 * rates) is simply the first rows of the admin screen. An entry is never
 * deleted: jobs point at its key. Deactivating it takes it out of the job
 * dropdown and leaves every job that used it exactly as it was.
 */

import { supabase } from "@/integrations/supabase/client";
import { parseCommissionSources, type CommissionSource } from "@/lib/job-ledger";

export const COMMISSION_RATES_KEY = "commission_rates";

export async function loadCommissionSources(): Promise<CommissionSource[]> {
  const { data, error } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", COMMISSION_RATES_KEY)
    .maybeSingle();
  if (error) throw error;
  return parseCommissionSources(data?.value);
}

export async function saveCommissionSources(sources: CommissionSource[], userId: string | null) {
  const { error } = await supabase
    .from("app_settings")
    .upsert(
      { key: COMMISSION_RATES_KEY, value: { sources } as never, updated_by: userId },
      { onConflict: "key" },
    );
  if (error) throw error;
}

/** A stable key from a name, unique within the list. Chosen once, never renamed. */
export function commissionKey(label: string, taken: readonly string[]): string {
  const base =
    label
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "entry";
  let key = base;
  for (let n = 2; taken.includes(key); n += 1) key = `${base}_${n}`;
  return key;
}

/** What stops an entry being saved, or null. */
export function commissionEntryProblem(
  draft: { label: string; pct: number | null },
  sources: readonly CommissionSource[],
  editingKey?: string,
): string | null {
  const label = draft.label.trim();
  if (!label) return "Give the name or role.";
  if (draft.pct == null || !Number.isFinite(draft.pct) || draft.pct < 0 || draft.pct > 100) {
    return "The rate is a percentage between 0 and 100.";
  }
  const clash = sources.find(
    (s) => s.key !== editingKey && s.label.trim().toLowerCase() === label.toLowerCase(),
  );
  return clash ? `There is already an entry called ${clash.label}.` : null;
}

/* ------------------------------------------------------------------ */
/* Paid / outstanding                                                  */
/* ------------------------------------------------------------------ */

export type JobCommissionPaid = {
  commission_source: string | null;
  commission_paid_on?: string | null;
  commission_paid_ref?: string | null;
  commission_paid_amount?: number | null;
  /** The General tab's referrer (Mark, 7 Oct: "it will pull the referring company from general"). */
  referred_by_account_id?: string | null;
  referred_by_contact_id?: string | null;
  commission_rate_pct?: number | null;
  commission_flat_amount?: number | null;
};

export type CommissionStatus = "none" | "outstanding" | "paid";

/**
 * Nobody to pay is no commission; somebody to pay and no paid date is
 * outstanding. "Somebody" is a "Came from" source, a referrer on the General
 * tab, or a rate typed on the job — any of which puts a referrer line on the
 * Commissions card.
 */
export function commissionStatus(job: JobCommissionPaid): CommissionStatus {
  const hasPayee =
    !!job.commission_source ||
    !!job.referred_by_account_id ||
    !!job.referred_by_contact_id ||
    job.commission_rate_pct != null ||
    job.commission_flat_amount != null;
  if (!hasPayee) return "none";
  return job.commission_paid_on ? "paid" : "outstanding";
}

export async function markCommissionPaid(input: {
  jobId: string;
  paidOn: string;
  reference: string | null;
  amount: number | null;
  userId: string | null;
}): Promise<void> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.paidOn)) throw new Error("Give the date it was paid.");
  const { data, error } = await supabase
    .from("jobs")
    .update({
      commission_paid_on: input.paidOn,
      commission_paid_ref: input.reference?.trim() || null,
      commission_paid_amount: input.amount,
      commission_paid_by: input.userId,
    } as never)
    .eq("id", input.jobId)
    .select("id");
  if (error) throw error;
  if ((data ?? []).length === 0)
    throw new Error("Only a manager of this job's office can mark it paid.");
}

export async function markCommissionOutstanding(jobId: string): Promise<void> {
  const { error } = await supabase
    .from("jobs")
    .update({
      commission_paid_on: null,
      commission_paid_ref: null,
      commission_paid_amount: null,
      commission_paid_by: null,
    } as never)
    .eq("id", jobId);
  if (error) throw error;
}
