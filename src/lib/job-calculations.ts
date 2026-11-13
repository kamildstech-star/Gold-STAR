import { supabase } from "@/integrations/supabase/client";
import { isMissingSchema } from "@/lib/schema-fallback";
import { crmMatchFor, type CrmCandidate, type EstimateJobPrefill } from "@/lib/estimate-to-job";
import {
  JOB_CALCULATOR_TYPES,
  calculateCustomerPricing,
  calculateJob,
  normalizeEquipment,
  usableCustomLines,
  type CalculatorRates,
  type CustomLine,
  type JobCalculationInput,
  type JobCalculatorType,
  type SavedJobCalculation,
} from "@/lib/job-calculator";

/**
 * Since 20260909110000_calculator_cost_visibility, `job_calculations` has NO
 * table-level SELECT grant for `authenticated`; columns are granted one by
 * one, the way `estimate_lines` (20260909100000) and the catalog are. The
 * three snapshot columns that state what a job costs Gold Star —
 * `internal_cost`, `equipment_profit`, `overall_profit` — are left out.
 *
 *  - `select("*")`, or naming one of them, fails for EVERYONE with
 *    "permission denied for table job_calculations". Always select
 *    `JOB_CALCULATION_SELECT`, including on the `.select()` after a write.
 *  - Holders of `job.view_costs` read the stored snapshot through
 *    `job_calculation_costs(_calculation_id)`, a SECURITY DEFINER reader that
 *    answers only for them (empty set for anyone else). The editor does not
 *    need it: it recomputes the internal figures live from the inputs, and
 *    only for holders (`calculateInternalFigures`).
 *  - Writing is unchanged: the client still stores the snapshot on save so
 *    rows stay auditable when the rate constants move.
 */
export const JOB_CALCULATION_PUBLIC_COLUMNS = [
  "id",
  "location_id",
  "job_id",
  "job_date",
  "customer_name",
  "contact_number",
  "email",
  "address",
  "address_line2",
  "locality",
  "region",
  "postal_code",
  "job_type",
  "days",
  "workers",
  "regular_hours",
  "after_hours",
  "emergency",
  "garbage_fee",
  "miscellaneous_fee",
  "equipment_quantities",
  "customer_price",
  "created_by",
  "created_at",
  "updated_at",
  // Granted in 20261006141500. Read back so reopening an estimate keeps them:
  // without the read, they loaded empty and the next Save wrote [] and NULL.
  "custom_lines",
  "note",
] as const;

/** The same list as a PostgREST column string; a test pins the pair together. */
export const JOB_CALCULATION_SELECT =
  "id,location_id,job_id,job_date,customer_name,contact_number,email,address,address_line2,locality,region,postal_code,job_type,days,workers,regular_hours,after_hours,emergency,garbage_fee,miscellaneous_fee,equipment_quantities,customer_price,created_by,created_at,updated_at,custom_lines,note";

/** A `job_calculations` row as the `authenticated` role may read it. */
export type JobCalculationRow = {
  id: string;
  location_id: string;
  job_id: string | null;
  job_date: string;
  customer_name: string | null;
  contact_number: string | null;
  email: string | null;
  address: string | null;
  address_line2: string | null;
  locality: string | null;
  region: string | null;
  postal_code: string | null;
  job_type: string;
  days: number;
  workers: number;
  regular_hours: number;
  after_hours: number;
  emergency: boolean;
  garbage_fee: number;
  miscellaneous_fee: number;
  equipment_quantities: unknown;
  customer_price: number;
  created_by: string;
  created_at: string;
  updated_at: string;
  custom_lines?: unknown;
  note?: string | null;
};

export type JobCalculationListRow = Pick<
  JobCalculationRow,
  | "id"
  | "location_id"
  | "job_id"
  | "job_date"
  | "customer_name"
  | "address"
  | "locality"
  | "job_type"
  | "customer_price"
  | "created_at"
  | "updated_at"
> & { job: { job_number: string | null } | null };

export type CalculationJobOption = {
  id: string;
  job_number: string;
  customer_name: string | null;
  address: string | null;
  locality: string | null;
};

function validJobType(value: string): JobCalculatorType {
  return (JOB_CALCULATOR_TYPES as readonly string[]).includes(value)
    ? (value as JobCalculatorType)
    : "water";
}

export function inputFromRow(row: JobCalculationRow): JobCalculationInput {
  return {
    jobDate: row.job_date,
    jobType: validJobType(row.job_type),
    customerName: row.customer_name ?? "",
    contactNumber: row.contact_number ?? "",
    email: row.email ?? "",
    address: row.address ?? "",
    addressLine2: row.address_line2 ?? "",
    locality: row.locality ?? "",
    region: row.region ?? "",
    postalCode: row.postal_code ?? "",
    days: Number(row.days),
    workers: Number(row.workers),
    regularHours: Number(row.regular_hours),
    afterHours: Number(row.after_hours),
    emergency: Boolean(row.emergency),
    garbageFee: Number(row.garbage_fee),
    miscellaneousFee: Number(row.miscellaneous_fee),
    equipment: normalizeEquipment(row.equipment_quantities),
    // `note` ships in 20260918160000. A database without it reads as no note,
    // which is the same answer as an empty box — the calculator opens either
    // way rather than failing on one unknown column, exactly as custom_lines
    // does below.
    note: String((row as { note?: unknown }).note ?? ""),
    customLines: customLinesFromRow(row),
  };
}

/**
 * `custom_lines` ships in 20260917120500. A database without it simply has no
 * typed-in lines to read, which is the same answer as an empty list — so the
 * calculator opens either way rather than failing on one unknown column.
 */
function customLinesFromRow(row: JobCalculationRow): CustomLine[] {
  const raw = (row as { custom_lines?: unknown }).custom_lines;
  if (!Array.isArray(raw)) return [];
  return usableCustomLines(
    raw.map((entry) => {
      const l = entry as { label?: unknown; amount?: unknown };
      return { label: String(l?.label ?? ""), amount: Number(l?.amount ?? 0) };
    }),
  );
}

export function savedCalculationFromRow(row: JobCalculationRow): SavedJobCalculation {
  const input = inputFromRow(row);
  // The pricing's `equipment` is the priced lines; the input's is the
  // quantities the editor shows and saves back. Drop the first so it can
  // never land on the second — see SavedJobCalculation.
  const { equipment: _pricedLines, ...pricing } = calculateCustomerPricing(input);
  return {
    ...input,
    ...pricing,
    id: row.id,
    locationId: row.location_id,
    jobId: row.job_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * `rates` is what the editor priced the sheet at — the customer's price list,
 * the branch, the state, or the defaults (fetchCalculatorRates). Saved with
 * the defaults, a customer on their own agreement had one price on screen and
 * another stored, and the invoice converted from it billed the defaults.
 */
function rowPayload(input: JobCalculationInput, rates?: CalculatorRates) {
  const result = calculateJob(input, rates);
  return {
    job_date: input.jobDate,
    customer_name: input.customerName.trim() || null,
    contact_number: input.contactNumber.trim() || null,
    email: input.email.trim() || null,
    address: input.address.trim() || null,
    address_line2: input.addressLine2.trim() || null,
    locality: input.locality.trim() || null,
    region: input.region.trim() || null,
    postal_code: input.postalCode.trim() || null,
    job_type: input.jobType,
    days: Math.max(0, input.days),
    workers: Math.max(0, input.workers),
    regular_hours: Math.max(0, input.regularHours),
    after_hours: Math.max(0, input.afterHours),
    emergency: input.emergency,
    garbage_fee: Math.max(0, input.garbageFee),
    miscellaneous_fee: Math.max(0, input.miscellaneousFee),
    equipment_quantities: normalizeEquipment(input.equipment),
    // Empty stays NULL: "skippable" has to mean the column is empty, not that
    // it holds an empty string that later prints as a blank block.
    note: input.note.trim() || null,
    custom_lines: usableCustomLines(input.customLines),
    customer_price: result.customerPrice,
    internal_cost: result.internalCost,
    equipment_profit: result.equipmentProfit,
    overall_profit: result.overallProfit,
  };
}

export async function listJobCalculations(locationId: string | null) {
  let query = supabase
    .from("job_calculations")
    .select(
      "id,location_id,job_id,job_date,customer_name,address,locality,job_type,customer_price,created_at,updated_at,job:jobs(job_number)",
    )
    .order("updated_at", { ascending: false })
    .limit(500);
  if (locationId) query = query.eq("location_id", locationId);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as unknown as JobCalculationListRow[];
}

/** The calculations attached to one job, newest first — for the job's rail. */
/**
 * The sheets attached to one job, in the shape `lib/billing-estimates` merges
 * with the job's own estimate documents (the job page's rail lists both as
 * one). All public columns, so nothing here needs `job.view_costs`.
 */
export async function listJobCalculationsForJob(jobId: string) {
  const { data, error } = await supabase
    .from("job_calculations")
    .select(
      "id,job_id,job_date,job_type,customer_name,address,locality,customer_price,created_at,updated_at",
    )
    .eq("job_id", jobId)
    .order("updated_at", { ascending: false })
    .limit(20);
  if (error) throw error;
  return (data ?? []) as Pick<
    JobCalculationRow,
    | "id"
    | "job_id"
    | "job_date"
    | "job_type"
    | "customer_name"
    | "address"
    | "locality"
    | "customer_price"
    | "created_at"
    | "updated_at"
  >[];
}

export async function loadJobCalculation(id: string) {
  const { data, error } = await supabase
    .from("job_calculations")
    .select(JOB_CALCULATION_SELECT)
    .eq("id", id)
    .single();
  if (error) throw error;
  return savedCalculationFromRow(data as unknown as JobCalculationRow);
}

export async function listJobsForCalculation(locationId: string) {
  const { data, error } = await supabase
    .from("jobs")
    .select("id,job_number,customer_name,address,locality")
    .eq("location_id", locationId)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw error;
  return (data ?? []) as CalculationJobOption[];
}

export async function saveJobCalculation(args: {
  id?: string;
  locationId: string;
  createdBy: string;
  input: JobCalculationInput;
  /** The rates the sheet was priced at on screen. Omitted: the defaults. */
  rates?: CalculatorRates;
}) {
  /*
   * `custom_lines` arrives in 20260917120500 and is not in the generated types
   * until it is applied, hence the cast. A database that has not had it yet
   * refuses the whole statement over that one column, so the write is retried
   * without it — losing the typed-in lines is bad, losing the whole estimate
   * because of them is worse. This is the same step-down `writeFieldWorkTicket`
   * makes for its own late column.
   */
  const write = async (payload: Record<string, unknown>) => {
    const run = (body: Record<string, unknown>) =>
      args.id
        ? supabase
            .from("job_calculations")
            .update(body as never)
            .eq("id", args.id)
            .select(JOB_CALCULATION_SELECT)
            .single()
        : supabase
            .from("job_calculations")
            .insert(body as never)
            .select(JOB_CALCULATION_SELECT)
            .single();

    const first = await run(payload);
    if (!first.error) return first.data;
    if (!isMissingSchema(first.error) || !("custom_lines" in payload)) throw first.error;
    const { custom_lines: _dropped, ...rest } = payload;
    const retry = await run(rest);
    if (retry.error) throw retry.error;
    return retry.data;
  };

  const base = rowPayload(args.input, args.rates) as Record<string, unknown>;
  const data = await write(
    args.id ? base : { ...base, location_id: args.locationId, created_by: args.createdBy },
  );
  return savedCalculationFromRow(data as unknown as JobCalculationRow);
}

/**
 * The estimate's customer, looked up in the CRM at the moment of conversion.
 *
 * `job_calculations` stores the name, the number and the email but no contact
 * or account id — the calculator is a pricing sheet, and adding two foreign
 * keys to it would mean a second place that decides who a customer is. So the
 * link is resolved here, from what was typed, using the same duplicate finder
 * the customer type-ahead already uses. `crmMatchFor` decides what counts as
 * certain; anything less certain stays free text and the rep chooses.
 *
 * A failed look-up is not a failed conversion: the job form opens with the
 * name as typed.
 */
export async function findCalculationCustomerInCrm(
  prefill: Pick<EstimateJobPrefill, "customerName" | "phone" | "email">,
): Promise<CrmCandidate | null> {
  const name = prefill.customerName.trim();
  if (!name) return null;
  const { data, error } = await supabase.rpc("find_customer_duplicates", {
    _name: name,
    _phone: prefill.phone || undefined,
    _email: prefill.email || undefined,
  });
  if (error) {
    console.error("[db-error] Matching the estimate's customer to the CRM:", error);
    return null;
  }
  return crmMatchFor((data ?? []) as unknown as CrmCandidate[], prefill);
}

export async function attachJobCalculation(calculationId: string, jobId: string) {
  const { error } = await supabase
    .from("job_calculations")
    .update({ job_id: jobId })
    .eq("id", calculationId);
  if (error) throw error;
}
