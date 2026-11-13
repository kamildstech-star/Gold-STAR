import { supabase } from "@/integrations/supabase/client";

/**
 * Who we bill.
 *
 * The counterpart to billing-entity.ts, which answers "which Gold Star entity
 * is doing the billing". This answers "whose name and address go at the top of
 * the invoice" — and in restoration that is routinely not the person standing
 * at the loss. The site is a rental unit and the bill goes to the managing
 * agent; the owner is an LLC; the payer is the carrier.
 *
 * It is a pointer at `accounts` rather than a name and address copied onto the
 * job: the payer is almost always a company already in the CRM, and a second
 * copy of its address is a second copy that goes stale. When the job names
 * nobody, the bill is addressed to the job's own customer, which is what most
 * jobs want.
 */

export type BillToAccount = {
  id?: string | null;
  name: string | null;
  address_line1: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  email: string | null;
  phone?: string | null;
};

export const BILL_TO_ACCOUNT_FIELDS =
  "id, name, address_line1, city, state, postal_code, email, phone";

/** The payer embedded through the job, for the document builders' one query. */
export const BILL_TO_JOB_EMBED = `bill_to_account_id, bill_to_attention, bill_to:accounts!jobs_bill_to_account_id_fkey(${BILL_TO_ACCOUNT_FIELDS}), job_customer:accounts!jobs_account_id_fkey(${BILL_TO_ACCOUNT_FIELDS})`;

export type JobBillToSource = {
  bill_to?: BillToAccount | null;
  bill_to_attention?: string | null;
  /** The job's own customer: the last fallback when the document has none. */
  job_customer?: BillToAccount | null;
};

export type BillTo = {
  account: BillToAccount | null;
  attention: string | null;
  /** The job names a payer other than its own customer. */
  explicit: boolean;
};

export function resolveBillTo(
  job: JobBillToSource | null | undefined,
  customerAccount: BillToAccount | null | undefined,
): BillTo {
  const named = job?.bill_to ?? null;
  return {
    // The job's own customer last: an invoice saved without an account (older
    // ones were) printed "Received from -" on its receipt (12 Nov).
    account: named ?? customerAccount ?? job?.job_customer ?? null,
    attention: job?.bill_to_attention?.trim() || null,
    explicit: Boolean(named),
  };
}

/**
 * The printed Bill To block. Both PDFs render it from here: the estimate and
 * the invoice are deliberate twins, and a customer holding both must not find
 * the same job addressed to two different companies.
 */
export function billToLines(
  billTo: BillTo,
  fallbackName?: string | null,
  /**
   * Off where a Customer block sits beside this one and already carries the
   * address — the estimate prints both, and the same address twice reads as a
   * layout mistake rather than as information.
   */
  opts?: { email?: boolean },
): string[] {
  const a = billTo.account;
  return [
    a?.name || fallbackName || "-",
    billTo.attention ? `Attn: ${billTo.attention}` : null,
    a?.address_line1,
    [a?.city, a?.state, a?.postal_code].filter(Boolean).join(", "),
    opts?.email === false ? null : a?.email,
  ].filter(Boolean) as string[];
}

/**
 * Throws rather than returning null on a read failure — "we could not read the
 * payer" and "this job has no payer set" are opposite answers and the card has
 * to be able to tell them apart.
 */
export async function fetchBillToAccount(accountId: string): Promise<BillToAccount | null> {
  const { data, error } = await supabase
    .from("accounts")
    .select(BILL_TO_ACCOUNT_FIELDS)
    .eq("id", accountId)
    .maybeSingle();
  if (error) throw error;
  return (data as BillToAccount | null) ?? null;
}
