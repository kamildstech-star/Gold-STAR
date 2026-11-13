import { supabase } from "@/integrations/supabase/client";
import type { TablesInsert } from "@/integrations/supabase/types";
import { ESTIMATE_LINE_SELECT, fetchEstimateLineCosts, mergeLineCosts } from "@/lib/line-costs";
import { syncDraftRevision } from "@/lib/revisions";
import { invoiceJobSnapshot } from "@/lib/invoices";
import { planCalculatorInvoiceWithRates } from "@/lib/calculator-invoice";
import { JOB_CALCULATOR_TYPE_LABEL } from "@/lib/job-calculator";
import {
  JOB_CALCULATION_SELECT,
  inputFromRow,
  type JobCalculationRow,
} from "@/lib/job-calculations";
import { fetchCalculatorCatalog, fetchCalculatorRates } from "@/lib/job-calculator-pricing";
import { normalizeStateCode } from "@/lib/us-states";

/**
 * Estimate -> invoice. The invoice bills what was scoped, so every scope, line,
 * quantity and rate is copied onto the invoice, along with the customer, job,
 * carrier, claim and billing-location snapshot. `estimate_id` records the
 * source so the Billing tab can show the variance when the invoice later
 * diverges from the scope it came from. The estimate's version at the moment of
 * conversion is recorded too, so "which version did we bill?" has an answer.
 *
 * Copied rather than referenced on purpose: an invoice is a billed document.
 * Editing the estimate afterwards must not silently rewrite what was billed.
 *
 * A Quick Estimate (Job Calculator sheet) converts through the same writer —
 * see `convertCalculationToInvoice` below and src/lib/calculator-invoice.ts.
 */
export type ConvertResult = { invoiceId: string; existing: boolean };

export async function convertEstimateToInvoice(
  estimateId: string,
  userId: string | null,
): Promise<ConvertResult> {
  const { data: est, error } = await supabase
    .from("estimates")
    .select(
      "id, job_id, location_id, account_id, current_version, title, total, tax_rate, status, notes, job_number, customer_name, address, address_line2, locality, region, postal_code, office_name, office_phone, office_email, office_address",
    )
    .eq("id", estimateId)
    .single();
  if (error || !est) throw error ?? new Error("Estimate not found");

  const { data: existing } = await supabase
    .from("invoices")
    .select("id")
    .eq("estimate_id", estimateId)
    .limit(1)
    .maybeSingle();
  if (existing?.id) return { invoiceId: existing.id, existing: true };

  const { data: job } = await supabase
    .from("jobs")
    .select("id, account_id, insurance_carrier, claim_number, adjuster_name, adjuster_email")
    .eq("id", est.job_id)
    .maybeSingle();

  const content = await readEstimateContent(est.id);
  const invoiceId = await writeConvertedInvoice(
    {
      job_id: est.job_id,
      estimate_id: est.id,
      source_estimate_version: est.current_version ?? 1,
      location_id: est.location_id,
      ...invoicePayer(job, est.account_id),
      billed_amount: Number(est.total ?? 0),
      title: est.title,
      notes: est.notes ?? null,
      created_by: userId,
      tax_rate: Number(est.tax_rate ?? 0),
      job_number: est.job_number,
      customer_name: est.customer_name,
      address: est.address,
      address_line2: est.address_line2,
      locality: est.locality,
      region: est.region,
      postal_code: est.postal_code,
      office_name: est.office_name,
      office_phone: est.office_phone,
      office_email: est.office_email,
      office_address: est.office_address,
    },
    content,
  );
  return { invoiceId, existing: false };
}

/**
 * Quick Estimate -> invoice. Mark, 2026-10-06, of the calculator rows on a
 * job's Billing tab: "these need to be able to be converted to invoices."
 *
 * The sheet's lines come from `planCalculatorInvoice`, which re-derives them
 * from the saved inputs with the same arithmetic that priced the sheet and
 * refuses unless they total the saved `customer_price` to the cent. From there
 * it is the detailed estimate's conversion: the same bill-to rule, the same
 * writer, the same draft revision. `job_calculation_id` is the link that says
 * the sheet has been invoiced, and its unique index is what makes a double
 * click produce one invoice, not two.
 */
export async function convertCalculationToInvoice(
  calculationId: string,
  userId: string | null,
): Promise<ConvertResult> {
  const row = await readCalculation(calculationId);
  if (!row.job_id) {
    throw new Error(
      "This Quick Estimate is not on a job yet. Invoices are raised against a job's carrier — attach it to the job first.",
    );
  }

  const existing = await invoiceForCalculation(calculationId);
  if (existing) return { invoiceId: existing, existing: true };

  const input = inputFromRow(row);

  const [{ data: job, error: jobErr }, catalog] = await Promise.all([
    supabase
      .from("jobs")
      .select(
        "id, job_number, location_id, customer_name, account_id, address, address_line2, locality, region, postal_code, call_date, insurance_carrier, claim_number, adjuster_name, adjuster_email",
      )
      .eq("id", row.job_id)
      .single(),
    // An office that has priced the calculator from its catalog (GSC- codes)
    // gets those catalog items on the lines, so the fill trigger costs them
    // like any catalog line. No catalog rows is the normal case and costs
    // nothing: the lines go on with no catalog item, as typed lines do.
    fetchCalculatorCatalog().catch(() => new Map<string, { id: string }>()),
  ]);
  if (jobErr || !job) throw jobErr ?? new Error("Job not found");

  // Billed at the client's prices: the job's customer agreement, branch and
  // state, as the sheet was priced on screen — the defaults only for a sheet
  // saved before it was priced that way.
  const clientRates = await fetchCalculatorRates({
    accountId: job.account_id,
    locationId: job.location_id,
    stateCode: normalizeStateCode(job.region),
    onDate: input.jobDate || new Date().toISOString().slice(0, 10),
  })
    .then((r) => [r.rates])
    .catch(() => []);
  const plan = planCalculatorInvoiceWithRates(input, Number(row.customer_price), clientRates);
  if (!plan.ok) {
    throw new Error(plan.reason);
  }

  const snap = await invoiceJobSnapshot(job);
  const label = JOB_CALCULATOR_TYPE_LABEL[input.jobType];
  try {
    const invoiceId = await writeConvertedInvoice(
      {
        job_id: job.id,
        job_calculation_id: row.id,
        location_id: job.location_id,
        ...invoicePayer(job),
        billed_amount: plan.total,
        title: `Quick Estimate · ${label}`,
        notes: input.note.trim() || null,
        created_by: userId,
        ...snap,
      },
      {
        scopes: [
          {
            key: "calc",
            name: `${label} — Quick Estimate`,
            room_name: null,
            notes: null,
            position: 0,
          },
        ],
        lines: plan.lines.map((l) => ({
          ...l,
          key: `calc:${l.position}`,
          scope_key: "calc",
          catalog_item_id: l.code ? (catalog.get(l.code.toLowerCase())?.id ?? null) : null,
          note: null,
        })),
      },
    );
    return { invoiceId, existing: false };
  } catch (e) {
    // Two tabs, or a double tap: the unique index refused the second
    // invoice. The first one is the answer.
    if ((e as { code?: string } | null)?.code === "23505") {
      const first = await invoiceForCalculation(calculationId);
      if (first) return { invoiceId: first, existing: true };
    }
    throw e;
  }
}

/**
 * The sheet, typed-in lines and note included. `JOB_CALCULATION_SELECT`
 * carries them since #302 (grant 20261006141500), so the plan sees every line
 * `customer_price` was made of; a sheet whose lines still did not add up
 * would be refused by the to-the-cent check, never invoiced short.
 */
async function readCalculation(id: string): Promise<JobCalculationRow> {
  const { data, error } = await supabase
    .from("job_calculations")
    .select(JOB_CALCULATION_SELECT)
    .eq("id", id)
    .single();
  if (error || !data) throw error ?? new Error("Estimate not found");
  return data as unknown as JobCalculationRow;
}

async function invoiceForCalculation(calculationId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("invoices")
    .select("id")
    .eq("job_calculation_id" as never, calculationId)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as { id: string } | null)?.id ?? null;
}

/**
 * Who the invoice is raised against. "The customer is never invoiced —
 * invoices here are raised against the carrier": the carrier, claim and
 * adjuster are the job's, and the account is the document's own if it has one,
 * else the job's. Both conversions — a detailed estimate and a Quick Estimate
 * — take the bill-to from here, so they cannot drift apart.
 */
export function invoicePayer(
  job: {
    account_id: string | null;
    insurance_carrier: string | null;
    claim_number: string | null;
    adjuster_name: string | null;
    adjuster_email: string | null;
  } | null,
  documentAccountId?: string | null,
) {
  return {
    account_id: documentAccountId ?? job?.account_id ?? null,
    carrier: job?.insurance_carrier ?? null,
    claim_number: job?.claim_number ?? null,
    adjuster_name: job?.adjuster_name ?? null,
    adjuster_email: job?.adjuster_email ?? null,
  };
}

/** What a converted invoice is made of: scopes, and lines keyed so discounts can follow them. */
export type InvoiceContent = {
  scopes: {
    key: string;
    name: string;
    room_name: string | null;
    notes: string | null;
    position: number;
  }[];
  lines: {
    key: string;
    scope_key: string | null;
    catalog_item_id: string | null;
    position: number;
    code: string | null;
    name: string;
    description: string | null;
    uom: string;
    quantity: number;
    /** Left out (null/undefined) when the caller may not see cost. */
    unit_cost?: number | null;
    unit_price: number;
    taxable: boolean;
    is_discount: boolean;
    note: string | null;
  }[];
};

type ConvertedInvoiceHeader = Omit<TablesInsert<"invoices">, "invoice_number" | "line_itemized"> & {
  job_calculation_id?: string;
};

/**
 * THE one writer behind Convert to invoice, whatever is being converted. The
 * header goes in (numbered by the database), then the scopes and lines, then
 * the draft revision — so a converted invoice has its Versions from the start.
 */
async function writeConvertedInvoice(
  header: ConvertedInvoiceHeader,
  content: InvoiceContent,
): Promise<string> {
  const { data: inv, error: insErr } = await supabase
    .from("invoices")
    // `job_calculation_id` ships in 20261006161000 and is not in the
    // generated types until it is applied.
    .insert({ ...header, invoice_number: "", line_itemized: true } as never)
    .select("id")
    .single();
  if (insErr || !inv) throw insErr ?? new Error("Invoice not created");
  const invoiceId = (inv as { id: string }).id;

  await insertInvoiceContent(invoiceId, content);
  await syncDraftRevision("invoice", invoiceId).catch(() => null);
  return invoiceId;
}

/**
 * Reads an estimate's scopes and lines for conversion.
 *
 * Cost travels with the line only as far as the caller may see it.
 * `unit_cost` is not SELECT-granted (src/lib/line-costs.ts); a holder of
 * `job.view_costs` reads it through the RPC and copies it exactly. For anyone
 * else the field is omitted, and the fill trigger costs every catalog line
 * from the catalog server-side; a cost someone typed on an ad hoc estimate
 * line does not reach the invoice in that case, and the invoice editor shows
 * the holder a 0 to correct rather than silently guessing.
 */
async function readEstimateContent(estimateId: string): Promise<InvoiceContent> {
  const [{ data: scopes }, { data: publicLines }, costs] = await Promise.all([
    supabase
      .from("estimate_scopes")
      .select("id, name, room_name, notes, position")
      .eq("estimate_id", estimateId)
      .order("position"),
    supabase
      .from("estimate_lines")
      .select(ESTIMATE_LINE_SELECT)
      .eq("estimate_id", estimateId)
      .order("position"),
    fetchEstimateLineCosts(estimateId),
  ]);
  const lines = mergeLineCosts(publicLines ?? [], costs);
  return {
    scopes: (scopes ?? []).map((s) => ({
      key: s.id,
      name: s.name,
      room_name: s.room_name,
      notes: s.notes,
      position: s.position,
    })),
    lines: (lines ?? []).map((l) => ({
      key: l.id,
      scope_key: l.scope_id,
      catalog_item_id: l.catalog_item_id,
      position: l.position,
      code: l.code,
      name: l.name,
      description: l.description,
      uom: l.uom,
      quantity: l.quantity,
      unit_cost: l.unit_cost,
      unit_price: l.unit_price,
      taxable: l.taxable,
      is_discount: l.is_discount,
      note: l.note,
    })),
  };
}

/** Writes scopes then lines, remapping each line onto its new scope. */
async function insertInvoiceContent(invoiceId: string, content: InvoiceContent) {
  const { scopes, lines } = content;

  const scopeMap = new Map<string, string>();
  if (scopes.length) {
    const { data: newScopes, error } = await supabase
      .from("invoice_scopes")
      .insert(
        scopes.map((s) => ({
          invoice_id: invoiceId,
          name: s.name,
          room_name: s.room_name,
          notes: s.notes,
          position: s.position,
        })),
      )
      .select("id, name, position");
    if (error) throw error;
    // Insert order is preserved by PostgREST, so pair by index.
    scopes.forEach((s, i) => {
      const created = newScopes?.[i];
      if (created) scopeMap.set(s.key, created.id);
    });
  }

  if (lines.length) {
    /*
     * Every copied line gets a NEW id, so a discount that targets specific
     * lines would arrive on the invoice pointing at ids that no longer exist
     * and resolve to nothing. The work lines are inserted first to learn their
     * new ids, then the discounts are remapped onto them.
     */
    const work = lines.filter((l) => !l.is_discount);
    const discounts = lines.filter((l) => l.is_discount);
    const lineMap = new Map<string, string>();

    const shape = (l: (typeof lines)[number], desc: string | null) => ({
      invoice_id: invoiceId,
      scope_id: l.scope_key ? (scopeMap.get(l.scope_key) ?? null) : null,
      catalog_item_id: l.catalog_item_id,
      position: l.position,
      code: l.code,
      name: l.name,
      description: desc,
      uom: l.uom,
      quantity: l.quantity,
      // Hidden cost: leave the field to the database (default 0, then the
      // catalog fill), never write a 0 the caller made up.
      ...(l.unit_cost == null ? {} : { unit_cost: l.unit_cost }),
      unit_price: l.unit_price,
      taxable: l.taxable,
      is_discount: l.is_discount,
      note: l.note,
    });

    if (work.length) {
      const { data: made, error } = await supabase
        .from("invoice_lines")
        .insert(work.map((l) => shape(l, l.description)))
        .select("id, position, scope_id");
      if (error) throw error;
      // Position is unique within a scope, so it identifies the twin.
      const byKey = new Map((made ?? []).map((m) => [`${m.scope_id ?? ""}:${m.position}`, m.id]));
      for (const l of work) {
        const scope = l.scope_key ? (scopeMap.get(l.scope_key) ?? "") : "";
        const id = byKey.get(`${scope}:${l.position}`);
        if (id) lineMap.set(l.key, id);
      }
    }

    if (discounts.length) {
      const { error } = await supabase.from("invoice_lines").insert(
        discounts.map((l) => {
          const marks = /^LN:(.+)$/.exec((l.description ?? "").trim());
          if (!marks) return shape(l, l.description);
          const remapped = marks[1]!
            .split(",")
            .map((id) => lineMap.get(id.trim()))
            .filter(Boolean);
          // No surviving target means the discount was scoped to work that did
          // not come across; leave it untargeted rather than silently dead.
          return shape(l, remapped.length ? `LN:${remapped.join(",")}` : null);
        }),
      );
      if (error) throw error;
    }
  }
}

/** Billed minus the source estimate total. Positive = invoice bills more. */
export function invoiceVariance(
  billed: number | null | undefined,
  estimateTotal: number | null | undefined,
): number | null {
  if (estimateTotal == null) return null;
  const diff = Number(billed ?? 0) - Number(estimateTotal);
  return Math.abs(diff) < 0.005 ? 0 : diff;
}
