import { supabase } from "@/integrations/supabase/client";
import { fetchDefaultTaxRate, type JobPrefill } from "@/lib/estimates";

/**
 * Carrier invoices are built the same way estimates are: scopes, catalogue
 * lines, quantities and rates. `billed_amount` is a derived number — the
 * database recalculates it from the lines — except on a quick invoice, where
 * `line_itemized` stays false and someone types the figure directly.
 */

export interface InvoiceScope {
  id: string;
  invoice_id: string;
  name: string;
  room_name: string | null;
  notes: string | null;
  position: number;
}

export interface InvoiceLine {
  id: string;
  invoice_id: string;
  scope_id: string | null;
  catalog_item_id: string | null;
  position: number;
  code: string | null;
  name: string;
  description: string | null;
  uom: string;
  quantity: number;
  /**
   * `null` when the viewer does not hold `job.view_costs` — "cost hidden".
   * The column is not SELECT-granted; see src/lib/line-costs.ts.
   */
  unit_cost: number | null;
  unit_price: number;
  taxable: boolean;
  is_discount: boolean;
  note: string | null;
  subtotal: number;
}

/**
 * Everything an invoice snapshots off the job and its branch office. Exported
 * for the Quick Estimate conversion, whose sheet carries no office block of
 * its own (src/lib/estimate-invoice.ts).
 */
export async function invoiceJobSnapshot(job: JobPrefill) {
  const [{ data: loc, error: locErr }, rate] = await Promise.all([
    supabase
      .from("locations")
      .select("name, address, locality, region, postal_code, office_phone, office_email")
      .eq("id", job.location_id)
      .maybeSingle(),
    fetchDefaultTaxRate(),
  ]);
  if (locErr) throw locErr;
  const officeAddress = [loc?.address, loc?.locality, loc?.region, loc?.postal_code]
    .filter(Boolean)
    .join(", ");
  return {
    job_number: job.job_number,
    customer_name: job.customer_name,
    address: job.address,
    address_line2: job.address_line2,
    locality: job.locality,
    region: job.region,
    postal_code: job.postal_code,
    office_name: loc?.name ?? null,
    office_phone: loc?.office_phone ?? null,
    office_email: loc?.office_email ?? null,
    office_address: officeAddress || null,
    tax_rate: rate,
  };
}

export interface InvoiceJobPrefill extends JobPrefill {
  insurance_carrier?: string | null;
  claim_number?: string | null;
  adjuster_name?: string | null;
  adjuster_email?: string | null;
}

/**
 * Creates an invoice off a job — carrier, claim, address and office branding
 * carried across so nobody retypes what the record already knows.
 */
export async function createInvoiceFromJob(
  job: InvoiceJobPrefill,
  userId: string,
  opts?: {
    quick?: boolean;
    billedAmount?: number;
    dueDate?: string | null;
    /** Simple mode's description (Billing & Costs P4): the invoice title. */
    title?: string | null;
  },
) {
  const snap = await invoiceJobSnapshot(job);
  const { data, error } = await supabase
    .from("invoices")
    .insert({
      job_id: job.id,
      account_id: job.account_id,
      location_id: job.location_id,
      created_by: userId,
      invoice_number: "",
      carrier: job.insurance_carrier ?? null,
      claim_number: job.claim_number ?? null,
      adjuster_name: job.adjuster_name ?? null,
      adjuster_email: job.adjuster_email ?? null,
      due_date: opts?.dueDate ?? null,
      line_itemized: !opts?.quick,
      billed_amount: opts?.quick ? (opts.billedAmount ?? 0) : 0,
      ...snap,
      ...(opts?.title ? { title: opts.title } : {}),
    })
    // What "Pull from job" needs to price the job for this customer and office.
    .select("id, invoice_number, job_id, account_id, location_id, region, issue_date")
    .single();
  if (error) throw error;
  return data;
}

/** Turns a saved scope template into real lines on an invoice scope. */
export async function applyScopeTemplateToInvoice(
  templateId: string,
  invoiceId: string,
  scopeId: string,
  startPosition: number,
) {
  const { data: lines, error } = await supabase
    .from("estimate_scope_template_lines")
    .select(
      "catalog_item_id, code, name, description, uom, quantity, unit_cost, unit_price, taxable, position",
    )
    .eq("template_id", templateId)
    .order("position");
  if (error) throw error;
  if (!lines?.length) return 0;
  const { error: insErr } = await supabase.from("invoice_lines").insert(
    lines.map((l, i) => ({
      invoice_id: invoiceId,
      scope_id: scopeId,
      catalog_item_id: l.catalog_item_id,
      code: l.code,
      name: l.name,
      description: l.description,
      uom: l.uom,
      quantity: l.quantity,
      unit_cost: l.unit_cost,
      unit_price: l.unit_price,
      taxable: l.taxable,
      position: startPosition + i,
    })),
  );
  if (insErr) throw insErr;
  return lines.length;
}
