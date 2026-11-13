/**
 * Everything Billing should call an estimate, from wherever it was priced.
 *
 * Gold Star prices work in two places and always has:
 *
 *   · the Job Calculator (`/estimates`) writes `job_calculations` — a pricing
 *     sheet that can exist before there is a job, off nothing but an address;
 *   · a job's billing panel writes `quotes` — a carrier-facing document, and
 *     `quotes.job_id` is NOT NULL, so a quote cannot exist without a job.
 *
 * Billing → Estimates read `quotes` alone, so an estimate built in the
 * calculator was invisible there for ever. David, 16 Sep: an estimate made in
 * the calculator "does not appear in the billing estimates section", and looked
 * to him like it had been lost on leaving the tab.
 *
 * The two are merged here at read time rather than copied into one table. A
 * calculator estimate with no job physically cannot become a `quotes` row, and
 * a copy would be a second thing to keep in step every time either side is
 * edited. One list, two sources, each still owned where it is written.
 */

import { supabase } from "@/integrations/supabase/client";
import { isMissingSchema } from "@/lib/schema-fallback";
import { QUOTE_STATUS_LABEL, type QuoteStatus } from "@/lib/billing";
import { ESTIMATE_STATUS_LABEL, estimateLabel, type EstimateStatus } from "@/lib/estimates";
import { JOB_CALCULATOR_TYPE_LABEL, type JobCalculatorType } from "@/lib/job-calculator";

/**
 * Where a row came from, which is also how the list links back to it.
 *
 * "estimate" is a job's own `estimates` document -- the one with versions,
 * a PDF and Convert to invoice -- which the job page merges with the same
 * job's calculator sheets (`mergeJobEstimates`). The office-wide Billing page
 * reads `quotes`, and that half is unchanged.
 */
export type EstimateSource = "quote" | "calculator" | "estimate";

export type BillingEstimate = {
  /** Unique across both sources — see `rowKey`. */
  key: string;
  id: string;
  source: EstimateSource;
  title: string;
  /** Null for a calculator estimate that has not been attached to a job yet. */
  jobId: string | null;
  total: number;
  /** Quotes are versioned; a calculator sheet is not. */
  version: number | null;
  statusLabel: string;
  /** ISO. Sorted on, newest first. */
  at: string;
  /** Address or customer, when the row carries one. Calculator rows usually do. */
  subtitle: string | null;
  /**
   * The calculator's job type ("Water", "Fire"), which on a job page is what
   * tells two of its sheets apart -- the customer and address are the job's
   * and the same on every row. Null for a quote or an estimate.
   */
  jobType: string | null;
};

export type QuoteRow = {
  id: string;
  title: string | null;
  status: QuoteStatus;
  total: number | null;
  version: number | null;
  job_id: string;
  created_at: string;
};

/** A job's own estimate document, as the job billing panel loads it. */
export type EstimateRow = {
  id: string;
  seq: number | null;
  status: EstimateStatus;
  title: string | null;
  total: number;
  /** Plain date, YYYY-MM-DD. */
  estimate_date: string;
  current_version: number | null;
};

export type CalculationRow = {
  id: string;
  job_id: string | null;
  customer_name: string | null;
  address: string | null;
  locality: string | null;
  job_type: string | null;
  customer_price: number | null;
  created_at: string;
  updated_at: string | null;
};

/** Source-prefixed, because a quote and a calculation could share an id. */
export function rowKey(source: EstimateSource, id: string): string {
  return `${source}:${id}`;
}

export function quoteToEstimate(q: QuoteRow): BillingEstimate {
  return {
    key: rowKey("quote", q.id),
    id: q.id,
    source: "quote",
    title: q.title?.trim() || "Quote",
    jobId: q.job_id,
    total: Number(q.total ?? 0),
    version: q.version ?? null,
    statusLabel: QUOTE_STATUS_LABEL[q.status] ?? q.status,
    at: q.created_at,
    subtitle: null,
    jobType: null,
  };
}

export function estimateToBillingEstimate(e: EstimateRow): BillingEstimate {
  return {
    key: rowKey("estimate", e.id),
    id: e.id,
    source: "estimate",
    title: estimateLabel(e.seq),
    jobId: null,
    total: Number(e.total ?? 0),
    version: e.current_version ?? 1,
    statusLabel: ESTIMATE_STATUS_LABEL[e.status] ?? e.status,
    at: e.estimate_date,
    subtitle: e.title?.trim() || "Scope",
    jobType: null,
  };
}

export function calculationToEstimate(c: CalculationRow): BillingEstimate {
  const where = [c.address, c.locality].filter(Boolean).join(", ");
  return {
    key: rowKey("calculator", c.id),
    id: c.id,
    source: "calculator",
    // A calculator sheet has no title of its own; it is known by who and where.
    title: c.customer_name?.trim() || where || "Job Calculator estimate",
    jobId: c.job_id,
    total: Number(c.customer_price ?? 0),
    version: null,
    // It is a priced sheet, not a carrier document, so it has no quote status.
    // Saying which of the two it is beats inventing a status it never had.
    statusLabel: c.job_id ? "Calculator · on a job" : "Calculator",
    at: c.updated_at ?? c.created_at,
    subtitle: c.customer_name?.trim() && where ? where : null,
    jobType: c.job_type
      ? (JOB_CALCULATOR_TYPE_LABEL[c.job_type as JobCalculatorType] ?? c.job_type)
      : null,
  };
}

/**
 * Newest first, whichever table it came from. A date-only `at` parses as
 * midnight UTC, which is the day before in New York; between a calculator
 * sheet saved at 9am and an estimate dated the same day that is close enough,
 * and the alternative is a timezone dance for a sort key.
 */
function newestFirst(rows: BillingEstimate[]): BillingEstimate[] {
  return rows.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

export function mergeBillingEstimates(
  quotes: readonly QuoteRow[],
  calculations: readonly CalculationRow[],
): BillingEstimate[] {
  return newestFirst([...quotes.map(quoteToEstimate), ...calculations.map(calculationToEstimate)]);
}

/**
 * One job's list: its own estimate documents and the calculator sheets
 * attached to it, in one order.
 *
 * Mark, 2026-09-16, of the job page's Estimates card beside its rail panel:
 * "and the estimates is a duplicate, just have the sidebar." The card listed
 * `estimates`, the rail listed `job_calculations`, and to anyone not reading
 * the code that is two copies of one list. Now it is one list, merged here
 * the way the Billing page's is, so the two screens agree on what a row is.
 */
export function mergeJobEstimates(
  estimates: readonly EstimateRow[],
  calculations: readonly CalculationRow[],
): BillingEstimate[] {
  return newestFirst([
    ...estimates.map(estimateToBillingEstimate),
    ...calculations.map(calculationToEstimate),
  ]);
}

/** The total Billing prints above the list, over both sources. */
export function estimatesTotal(rows: readonly BillingEstimate[]): number {
  return rows.reduce((sum, r) => sum + (Number.isFinite(r.total) ? r.total : 0), 0);
}

/**
 * Read both sources for one office.
 *
 * A calculator estimate is fetched whether or not it has a job, which is the
 * whole point: the ones David could not find were the ones with nothing but an
 * address on them.
 */
export async function listBillingEstimates(locationId: string | null): Promise<BillingEstimate[]> {
  let quoteQ = supabase
    .from("quotes")
    .select("id, title, status, total, version, job_id, created_at")
    .order("created_at", { ascending: false })
    .limit(500);
  if (locationId) quoteQ = quoteQ.eq("location_id", locationId);

  let calcQ = supabase
    .from("job_calculations")
    .select(
      "id, job_id, customer_name, address, locality, job_type, customer_price, created_at, updated_at",
    )
    .order("updated_at", { ascending: false })
    .limit(500);
  if (locationId) calcQ = calcQ.eq("location_id", locationId);

  const [quotes, calcs] = await Promise.all([quoteQ, calcQ]);
  if (quotes.error) throw quotes.error;
  /*
   * The calculator table is the newer of the two, so a database that has not
   * had its migration yet still shows the quotes it does have.
   *
   * But ONLY that. This used to swallow every error the calculator read could
   * produce, which meant an RLS refusal or a bad column presented as "the
   * calculator estimates simply are not there" — indistinguishable from the
   * merge not existing at all, and impossible to diagnose from the screen.
   * David spent two rounds on "it's still not talking to the estimates";
   * a failure this half of the list can hide is exactly how that happens.
   */
  if (calcs.error && !isMissingSchema(calcs.error)) throw calcs.error;
  const calcRows = calcs.error ? [] : ((calcs.data ?? []) as unknown as CalculationRow[]);

  return mergeBillingEstimates((quotes.data ?? []) as unknown as QuoteRow[], calcRows);
}
