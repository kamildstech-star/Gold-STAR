/**
 * Reading a job's field record and pulling it into an invoice — the I/O half
 * of src/lib/invoice-pull.ts, shared by the invoice editor's "Pull from job"
 * panel and the Billing tab's "Pull from job" button.
 *
 * David, 13 Oct: "Generate invoice from the job ledger" did not work. The
 * Billing tab's Quick invoice › "Pull from job" only CREATED an empty invoice
 * and left the actual pull to a second button inside the editor, so pressing
 * it produced a blank bill. It now creates the invoice and pulls the job into
 * it in one press, through exactly the code the panel uses.
 *
 * Prices are CHARGE rates (the Quick Estimate's resolver: customer agreement,
 * then the location's bill rate, then state, then defaults) — never the cost
 * rates the running cost uses.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { fetchCalculatorRates } from "@/lib/job-calculator-pricing";
import { loadJobLabourRollup } from "@/lib/job-labour-rollup";
import {
  UNTAGGED_TICKET_CLASSES,
  planInvoicePull,
  type PullLine,
  type PullPlacement,
  type PullPlan,
  type PullRates,
  type PullTicket,
} from "@/lib/invoice-pull";
import type { LabourDay } from "@/lib/job-labour-rollup";
import { normalizeStateCode } from "@/lib/us-states";

/** What an invoice carries that decides how the job is priced. */
export type PullInvoice = {
  id: string;
  job_id: string | null;
  account_id: string | null;
  location_id: string | null;
  region: string | null;
  issue_date: string;
};

export type PullData = {
  days: LabourDay[];
  placements: PullPlacement[];
  tickets: PullTicket[];
  rates: PullRates;
};

/** Everything on the job the pull reads. Throws on a failed read — never a silent empty. */
export async function loadInvoicePullData(
  client: SupabaseClient,
  invoice: Pick<PullInvoice, "job_id" | "account_id" | "location_id" | "region" | "issue_date">,
): Promise<PullData> {
  const jobId = invoice.job_id;
  if (!jobId) throw new Error("This invoice is not on a job, so there is nothing to pull.");
  const [labour, placements, tickets, rates] = await Promise.all([
    loadJobLabourRollup(client, jobId),
    client
      .from("equipment_placements")
      .select("placed_at, retrieved_at, equipment:equipment_id(equipment_type)")
      .eq("job_id", jobId),
    client
      .from("field_work_tickets")
      .select("work_date, approved_at, equip_injector, equip_ozone, equip_hydroxyl")
      .eq("job_id", jobId),
    // CHARGE rates, exactly as the Quick Estimate resolves them for this
    // customer, office and state on the invoice's date — never cost rates.
    fetchCalculatorRates({
      jobId: invoice.job_id ?? null,
      accountId: invoice.account_id,
      locationId: invoice.location_id,
      stateCode: normalizeStateCode(invoice.region),
      onDate: invoice.issue_date,
    }),
  ]);
  if (placements.error) throw placements.error;
  // Was ignored: a failed ticket read pulled a job with no untagged equipment.
  if (tickets.error) throw tickets.error;
  return {
    days: labour.rollup.days,
    placements: (
      (placements.data ?? []) as unknown as {
        placed_at: string;
        retrieved_at: string | null;
        equipment: { equipment_type: string } | null;
      }[]
    ).map((p) => ({
      placed_at: p.placed_at,
      retrieved_at: p.retrieved_at,
      equipment_type: p.equipment?.equipment_type ?? null,
    })),
    tickets: ((tickets.data ?? []) as Record<string, unknown>[]).map((t) => ({
      work_date: String(t.work_date),
      approved: !!t.approved_at,
      counts: Object.fromEntries(
        Object.keys(UNTAGGED_TICKET_CLASSES).map((k) => [k, Number(t[`equip_${k}`]) || 0]),
      ),
    })),
    rates: rates.rates,
  };
}

export function planFromData(data: PullData, includeUnapproved: boolean): PullPlan {
  return planInvoicePull({
    labourDays: data.days,
    placements: data.placements,
    tickets: data.tickets,
    rates: data.rates,
    includeUnapproved,
  });
}

/** The pulled lines, in a scope of their own, as ordinary editable lines. Sends nothing. */
export async function insertInvoicePull(
  client: SupabaseClient,
  input: {
    invoiceId: string;
    scopeCount: number;
    lines: readonly PullLine[];
    now?: Date;
    /** The scope's name before the date; "From the job" unless said. */
    scopeName?: string;
  },
): Promise<number> {
  if (input.lines.length === 0) throw new Error("Nothing on the job to pull yet.");
  const pulledOn = (input.now ?? new Date()).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
  const { data: scope, error: scopeErr } = await client
    .from("invoice_scopes")
    .insert({
      invoice_id: input.invoiceId,
      name: `${input.scopeName ?? "From the job"} (${pulledOn})`,
      position: input.scopeCount,
    })
    .select("id")
    .single();
  if (scopeErr) throw scopeErr;
  const { error } = await client.from("invoice_lines").insert(
    input.lines.map((l, i) => ({
      invoice_id: input.invoiceId,
      scope_id: (scope as { id: string }).id,
      name: l.name,
      description: l.description,
      uom: l.uom,
      quantity: l.quantity,
      unit_price: l.unit_price,
      ...(l.catalog_item_id ? { catalog_item_id: l.catalog_item_id, code: l.code ?? null } : {}),
      // As a hand-added line is: the office's tax rate decides, not this —
      // unless the line says (the T&M bill's taxable categories, TM3/TM4).
      taxable: (l as { taxable?: boolean }).taxable ?? true,
      position: i,
    })),
  );
  if (error) throw error;
  return input.lines.length;
}

/**
 * The one-press path: read the job, plan with approved hours only, insert.
 * Returns how many lines went in and what was held back for approval, so the
 * caller can say which — a job with nothing approved yet is not an error, the
 * editor opens with the breakdown and the "include unapproved" choice.
 */
export async function pullJobIntoInvoice(
  client: SupabaseClient,
  invoice: PullInvoice,
): Promise<{ lines: number; amount: number; heldBack: number }> {
  const plan = planFromData(await loadInvoicePullData(client, invoice), false);
  const heldBack = plan.excluded.length;
  if (plan.lines.length === 0) return { lines: 0, amount: 0, heldBack };
  const lines = await insertInvoicePull(client, {
    invoiceId: invoice.id,
    scopeCount: 0,
    lines: plan.lines,
  });
  return { lines, amount: plan.totals.amount, heldBack };
}
