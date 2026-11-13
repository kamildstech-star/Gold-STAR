/**
 * The job ledger, as a report — one row per job, David's spreadsheet columns.
 *
 * David, 13 Oct: a downloadable spreadsheet of the job ledger from Reports,
 * mirroring his own sheet. The ledger already exists per job (the strip on the
 * job page, src/lib/job-ledger.ts); this lays every job in the period side by
 * side with the SAME rows — `ledgerRowsWithOverrides`, typed cells included —
 * so a figure in the report is the figure on the job. The Reports screen's
 * CSV and Excel buttons export it like any other report.
 *
 * Money comes from `job_running_cost`, which answers only for someone who may
 * see finance; for anyone else the money columns are blank, never zero.
 */
import { reportTotalsRow } from "@/lib/report-totals";
import { fetchLedgerLaborCosts } from "@/lib/labour";
import { effortFromSignIns } from "@/lib/tm-bill";
import { normaliseSignIn } from "@/lib/tm-forms";
import { fetchLocationBillRate, ledgerLaborCharge } from "@/lib/labour-bill-rates";
import { supabase } from "@/integrations/supabase/client";
import { isTmJob } from "@/lib/field-forms-visibility";
import {
  dailySuppliesCharge,
  loadSupplyFeeSchedule,
  resolveLossTypeKeys,
} from "@/lib/supply-fee-schedule";
import {
  jobLedgerRows,
  ledgerRowsWithOverrides,
  type LedgerInput,
  type LedgerOverrides,
  type LedgerRow,
} from "@/lib/job-ledger";
import { ticketCrewSize, ticketHours } from "@/lib/field-ticket-costing";
import { jobRunningCost, type RunningCost } from "@/lib/running-cost";
import { isMissingSchema } from "@/lib/schema-fallback";
import type { Col, ReportCtx, ReportDef, ReportResult } from "@/lib/reports-engine";
import { roundMoneyLoose } from "@/lib/money";

export type LedgerJob = {
  id: string;
  job_number: string;
  customer_name: string | null;
  address: string | null;
  status: string;
  loss_date: string | null;
  location_id: string;
};

type Ticket = {
  job_id: string;
  work_date: string;
  gsr_crew_size: number | null;
  temp_crew_size: number | null;
  job_start_time: string | null;
  job_end_time: string | null;
};

/** Days, guys and hours from one job's tickets — the strip's own rule. */
export function effortFromTickets(tickets: readonly Ticket[]): LedgerInput["effort"] {
  if (tickets.length === 0) return { days: 0, crew: 0, personHours: 0 };
  const days = new Set(tickets.map((t) => t.work_date)).size;
  const crew = Math.max(...tickets.map((t) => ticketCrewSize(t)));
  const personHours = tickets.reduce(
    (sum, t) => sum + ticketHours(t.job_start_time, t.job_end_time) * ticketCrewSize(t),
    0,
  );
  return { days, crew, personHours: Math.round(personHours * 100) / 100 };
}

/**
 * The ledger's rows for one job, from what the report read. With no running
 * cost (not finance, or the read failed) only days, guys and hours are known.
 */
export function ledgerRowsForReport(input: {
  cost: RunningCost | null;
  effort: LedgerInput["effort"];
  billed: number | null;
  paid: number | null;
  overrides: LedgerOverrides;
  /** The job's office charge rate (Settings › Labor rates), for Labor Charge. */
  laborCharge?: { rate: number; source: string } | null;
  /** The office's crew cost rate, for Labor = field hours × it (23 Oct). */
  laborCost?: { rate: number; source: string } | null;
  /** The job's supplies at their charge (Settings › Cost rates). */
  suppliesCharge?: { amount: number; unpriced: number; source: string } | null;
}): LedgerRow[] {
  if (!input.cost) {
    return jobLedgerRows({
      cost: ZERO_COST,
      effort: input.effort,
      billed: null,
      paid: null,
      referral: null,
      commission: null,
    }).map((r) => (r.kind === "money" ? { ...r, value: null, tracked: false } : r));
  }
  return ledgerRowsWithOverrides(
    {
      cost: input.cost,
      effort: input.effort,
      billed: input.billed,
      paid: input.paid,
      // The SQL twins of the Commissions card's referrer and salesman lines.
      referral: input.cost.referrer_commission_cost ?? null,
      commission: input.cost.salesman_commission_cost ?? null,
      laborCharge: input.laborCharge ?? null,
      laborCost: input.laborCost ?? null,
      suppliesCharge: input.suppliesCharge ?? null,
    },
    input.overrides,
  );
}

/** One report row: the job, then one value per ledger column (null = not tracked). */
export function ledgerReportRow(job: LedgerJob, rows: readonly LedgerRow[]) {
  const out: Record<string, unknown> = {
    id: job.id,
    job: job.job_number,
    customer: job.customer_name ?? "",
    address: job.address ?? "",
    status: job.status,
    loss_date: job.loss_date ?? "",
  };
  for (const r of rows) out[r.key] = r.tracked ? r.value : null;
  return out;
}

/** The ledger's columns in David's order, typed for the spreadsheet. */
export function ledgerReportColumns(): Col[] {
  const sample = jobLedgerRows({
    cost: ZERO_COST,
    effort: null,
    billed: null,
    paid: null,
    referral: null,
    commission: null,
  });
  return [
    {
      key: "job",
      label: "Job",
      get: (r) => r.job,
      link: (r) => ({ to: "/jobs/$id", params: { id: String(r.id) } }),
    },
    { key: "customer", label: "Customer", get: (r) => r.customer },
    { key: "address", label: "Address", get: (r) => r.address },
    { key: "loss_date", label: "Loss date", get: (r) => r.loss_date },
    { key: "status", label: "Status", get: (r) => r.status },
    ...sample.map((s): Col => ({
      key: s.key,
      label: s.label,
      num: true,
      fmt: s.kind === "money" ? "usd" : s.kind === "count" ? "int" : undefined,
      get: (r) => r[s.key],
    })),
  ];
}

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

const dstr = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

async function ledgerJobs(ctx: ReportCtx): Promise<LedgerJob[]> {
  let q = supabase
    .from("jobs")
    .select(
      "id, job_number, customer_name, address, status, loss_date, location_id, loss_type, loss_type_id, job_type",
    )
    .gte("loss_date", dstr(ctx.range.from))
    .lte("loss_date", dstr(ctx.range.to))
    .order("loss_date", { ascending: true });
  if (ctx.locationIds) {
    q = q.in(
      "location_id",
      ctx.locationIds.length ? ctx.locationIds : ["00000000-0000-0000-0000-000000000000"],
    );
  }
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as LedgerJob[];
}

async function byJob<T extends { job_id: string }>(
  read: () => PromiseLike<{ data: unknown; error: unknown }>,
): Promise<Map<string, T[]>> {
  const { data, error } = await read();
  if (error) {
    if (isMissingSchema(error)) return new Map();
    throw error;
  }
  const out = new Map<string, T[]>();
  for (const r of (data ?? []) as T[]) out.set(r.job_id, [...(out.get(r.job_id) ?? []), r]);
  return out;
}

export const jobLedgerReport: ReportDef = {
  id: "job-ledger",
  num: 20,
  title: "Job ledger",
  question:
    "Every job in the period on one sheet — days, guys, hours, each cost, billed, paid, referral, commission and profit.",
  populatedBy:
    "The job ledger on each job page (David's spreadsheet columns): costs from the running cost, days/guys/hours from field tickets, billed and paid from invoices, and any figure typed into the ledger strip.",
  group: "analysis",
  async run(ctx: ReportCtx): Promise<ReportResult> {
    const jobs = await ledgerJobs(ctx);
    const columns = ledgerReportColumns();
    if (jobs.length === 0) {
      return {
        kpis: [],
        chart: null,
        columns,
        rows: [],
        empty: "No jobs with a loss date in this period.",
      };
    }
    const ids = jobs.map((j) => j.id);
    const [tickets, invoices, overrides, signIns] = await Promise.all([
      byJob<Ticket>(() =>
        supabase
          .from("field_work_tickets")
          .select("job_id, work_date, gsr_crew_size, temp_crew_size, job_start_time, job_end_time")
          .in("job_id", ids),
      ),
      byJob<{ job_id: string; billed_amount: number | null; collected_amount: number | null }>(() =>
        supabase
          .from("invoices")
          .select("job_id, billed_amount, collected_amount")
          .in("job_id", ids),
      ),
      byJob<{ job_id: string; cell_key: string; value: unknown }>(() =>
        (supabase as unknown as import("@supabase/supabase-js").SupabaseClient)
          .from("job_ledger_overrides")
          .select("job_id, cell_key, value")
          .in("job_id", ids),
      ),
      // T&M jobs: the daily sign-in sheets stand in for field tickets.
      byJob<{ job_id: string; form_date: string; payload: unknown }>(() =>
        (supabase as unknown as import("@supabase/supabase-js").SupabaseClient)
          .from("job_tm_forms")
          .select("job_id, form_date, payload")
          .eq("kind", "sign_in")
          .in("job_id", ids),
      ),
    ]);

    // The running cost one job at a time, a few at once — the commissions
    // report's pattern. Null (not finance) leaves the money columns blank.
    const costs = new Map<string, RunningCost | null>();
    // Supplies at their charge: the catalogue read once, each job's supplies
    // with its running cost (the same pairs of reads, a few jobs at a time).
    const { loadLedgerSupplies, catalogItemForSupply } = await import("@/lib/invoice-ledger-pull");
    const { data: catalogRows } = await supabase
      .from("estimate_catalog_items")
      .select("id, code, name, uom, default_unit_price")
      .eq("is_active", true);
    const catalog = (catalogRows ?? []).map((c) => ({
      ...c,
      default_unit_price: Number(c.default_unit_price) || 0,
    }));
    const feeSchedule = await loadSupplyFeeSchedule(supabase as never);
    const lossKeyOf = await resolveLossTypeKeys(
      supabase as never,
      jobs as (LedgerJob & { loss_type?: string | null; loss_type_id?: string | null })[],
    );
    const suppliesBy = new Map<
      string,
      { amount: number; unpriced: number; source: string } | null
    >();
    for (let i = 0; i < jobs.length; i += 8) {
      await Promise.all(
        jobs.slice(i, i + 8).map(async (j) => {
          costs.set(j.id, await jobRunningCost(j.id).catch(() => null));
          const supplies = await loadLedgerSupplies(supabase as never, j.id).catch(() => null);
          suppliesBy.set(
            j.id,
            supplies ? suppliesAtCharge(supplies, catalog, catalogItemForSupply) : null,
          );
        }),
      );
    }

    // Each office's labor charge rate, read once per office (Labor Charge).
    const chargeBy = new Map<string, { rate: number; source: string } | null>();
    await Promise.all(
      [...new Set(jobs.map((j) => j.location_id))].map(async (loc) => {
        const bill = await fetchLocationBillRate(loc).catch(() => null);
        chargeBy.set(loc, ledgerLaborCharge(bill));
      }),
    );

    // Each office's crew cost rate, for Labor = field hours × it (23 Oct).
    const costBy = await fetchLedgerLaborCosts([...new Set(jobs.map((j) => j.location_id))]).catch(
      () => new Map<string, { rate: number; source: string } | null>(),
    );

    const rows = jobs.map((j) => {
      const inv = invoices.get(j.id) ?? [];
      const typed: LedgerOverrides = {};
      for (const o of overrides.get(j.id) ?? []) {
        const v = Number(o.value);
        if (Number.isFinite(v)) typed[o.cell_key] = { value: v };
      }
      const effort = (tickets.get(j.id) ?? []).length
        ? effortFromTickets(tickets.get(j.id) ?? [])
        : effortFromSignIns(
            (signIns.get(j.id) ?? []).map((r) => ({
              date: r.form_date,
              payload: normaliseSignIn(r.payload),
            })),
          );
      // 6 Nov (David): a regular job's supplies bill as the fee schedule's
      // daily rate for its kind of work × its days on site; T&M jobs keep
      // each supply × its charge (the T&M supply list).
      const jr = j as LedgerJob & { job_type?: string | null };
      const dailyFee = isTmJob(jr.job_type)
        ? null
        : dailySuppliesCharge(lossKeyOf.get(j.id), effort?.days, feeSchedule);
      const ledger = ledgerRowsForReport({
        cost: costs.get(j.id) ?? null,
        effort,
        billed: inv.length ? inv.reduce((s, x) => s + (x.billed_amount ?? 0), 0) : null,
        paid: inv.length ? inv.reduce((s, x) => s + (x.collected_amount ?? 0), 0) : null,
        overrides: typed,
        laborCharge: chargeBy.get(j.location_id) ?? null,
        laborCost: costBy.get(j.location_id) ?? null,
        suppliesCharge: dailyFee ?? suppliesBy.get(j.id) ?? null,
      });
      return ledgerReportRow(j, ledger);
    });

    const sum = (key: string) =>
      rows.reduce((s, r) => s + (typeof r[key] === "number" ? (r[key] as number) : 0), 0);
    return {
      kpis: [
        { label: "Jobs", value: rows.length, prev: null, fmt: "int" },
        { label: "Total expenses", value: sum("total_expenses"), prev: null, fmt: "usd0" },
        { label: "Billed", value: sum("billed"), prev: null, fmt: "usd0" },
        { label: "Paid", value: sum("paid"), prev: null, fmt: "usd0" },
        { label: "Total profit", value: sum("profit"), prev: null, fmt: "usd0" },
      ],
      chart: null,
      columns,
      rows,
      // Every dollar column summed, shown above the jobs (David, 21 Oct).
      totals: reportTotalsRow(columns, rows, `Totals (${rows.length} jobs)`),
      empty: null,
    };
  },
};

/** All zero, for laying out the columns and for effort-only rows. */
const ZERO_COST = {
  equipment_cost: 0,
  equipment_days: 0,
  equipment_units: 0,
  equipment_unpriced_units: 0,
  labour_cost: 0,
  labour_minutes: 0,
  labour_uncosted_minutes: 0,
  field_ticket_cost: 0,
  field_ticket_labour_cost: 0,
  field_ticket_equipment_cost: 0,
  materials_cost: 0,
  stock_used_cost: 0,
  manual_cost: 0,
  subcontractor_cost: 0,
  expenses_cost: 0,
  expenses_count: 0,
  referral_cost: 0,
  total_cost: 0,
  revenue: 0,
} as unknown as RunningCost;

/**
 * A job's supplies priced at their standard charge (Settings › Cost rates ›
 * Materials & supplies). The report reads the catalogue once rather than each
 * job's full price book, so a customer's own price list is not applied here —
 * the job page's ledger and the invoice do apply it, and the source says so.
 */
export function suppliesAtCharge<
  S extends { name: string; sku: string | null; quantity: number },
  C extends { default_unit_price: number },
>(
  supplies: readonly S[],
  catalog: readonly C[],
  match: (s: S, catalog: readonly C[]) => C | null,
): { amount: number; unpriced: number; source: string } | null {
  const used = supplies.filter((s) => s.quantity > 0);
  if (!used.length) return null;
  let amount = 0;
  let unpriced = 0;
  for (const s of used) {
    const item = match(s, catalog);
    if (!item || !(item.default_unit_price > 0)) unpriced += 1;
    else amount += s.quantity * item.default_unit_price;
  }
  return {
    amount: roundMoneyLoose(amount),
    unpriced,
    source: "each supply's standard charge (customer price lists apply on the invoice)",
  };
}
