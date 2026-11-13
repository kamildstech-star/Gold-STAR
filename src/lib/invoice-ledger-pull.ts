/**
 * "From the ledger": an invoice written from the job ledger's own numbers.
 *
 * David, 20 Oct — a third invoice button beside Quick invoice and Pull from
 * job: the ledger shows 64 man-hours on site, so one line of 64 × the hourly
 * charge rate from the price list (his NJ $65/hr row), plus the supplies the
 * ledger captured for the job, priced the same way. One press, a draft
 * invoice, every line editable, nothing sent. His full T&M bill format is
 * still coming from Mosha; this is deliberately simple.
 *
 * WHAT IT READS — exactly what the ledger strip shows, so the two cannot
 * disagree:
 *   - Hours: the ledger's Hours cell. A figure typed into the strip wins;
 *     otherwise person-hours off the field tickets (`loadLedgerEffort`, the
 *     strip's own read). This is where it parts from Pull from job, which
 *     bills APPROVED hours day by day from the labour rollup — here the
 *     ledger wins, and the line says it came from the ledger.
 *   - Supplies: the ledger's Supplies sources, item by item — supply requests
 *     that were not denied, plus stock taken off the shelf for the job
 *     (job_running_cost's `sup` and `stock`).
 *
 * PRICED AT CHARGE RATES through the same machinery as Pull from job: the
 * labour rate is the calculator's regular labour slot (`GSC-LABOR-REG` — the
 * location's bill rate, a state list, a customer agreement), and a supply is
 * priced by the catalog item it matches (SKU = code, else the same name)
 * through the same price book. A supply with no catalog item goes in at $0
 * and says so, never at a guess and never at its cost.
 *
 * The lines go in through `insertInvoicePull`, in a scope of their own.
 */
import { effortFromSignIns } from "@/lib/tm-bill";
import { normaliseSignIn, normaliseSupplyList } from "@/lib/tm-forms";
import { loadTmRateCodes } from "@/lib/tm-rate-codes";
import { supplyListKind } from "@/lib/job-supply-list";
import type { SupabaseClient } from "@supabase/supabase-js";

import { ticketCrewSize, ticketHours } from "@/lib/field-ticket-costing";
import type { PullInvoice } from "@/lib/invoice-pull-run";
import type { PullLine } from "@/lib/invoice-pull";
import { resolvePrice, type PriceBook, type ResolvedPrice } from "@/lib/price-lists";
import { isMissingSchema } from "@/lib/schema-fallback";
import { roundMoney, sumMoney } from "@/lib/money";

/** Days, guys and person-hours off the field tickets — the ledger's effort rows. */
export type LedgerEffort = { days: number; crew: number; personHours: number };

/**
 * The ledger strip's effort read, shared so the strip and this button add the
 * job up the same way. Null when the field tickets are not on this database.
 */
export async function loadLedgerEffort(
  client: SupabaseClient,
  jobId: string,
): Promise<LedgerEffort | null> {
  const { data, error } = await client
    .from("field_work_tickets")
    .select("work_date, gsr_crew_size, temp_crew_size, job_start_time, job_end_time")
    .eq("job_id", jobId);
  if (error) {
    if (isMissingSchema(error)) return null;
    throw error;
  }
  const rows = (data ?? []) as TicketEffortRow[];
  const sheets = await jobSignIns(client, jobId);
  return combinedEffort(rows, sheets);
}

type TicketEffortRow = {
  work_date: string;
  gsr_crew_size: number | null;
  temp_crew_size: number | null;
  job_start_time: string | null;
  job_end_time: string | null;
};

/**
 * Days, guys and hours from both kinds of daily form, one day at a time —
 * the T&M bill's rule (TM5): a day with a signed sign-in sheet counts from
 * the sheet, any other day from its field forms. A job with only one kind
 * reads exactly as before.
 */
export function combinedEffort(
  tickets: readonly TicketEffortRow[],
  sheets: readonly { date: string; payload: ReturnType<typeof normaliseSignIn> }[],
): LedgerEffort {
  const sheetEffortByDay = new Map<string, ReturnType<typeof effortFromSignIns>>();
  for (const sheet of sheets) {
    const e = effortFromSignIns([sheet]);
    if (e.days > 0) sheetEffortByDay.set(sheet.date, e);
  }
  const days = new Set<string>(sheetEffortByDay.keys());
  let crew = 0;
  let personHours = 0;
  for (const e of sheetEffortByDay.values()) {
    crew = Math.max(crew, e.crew);
    personHours += e.personHours;
  }
  for (const r of tickets) {
    if (sheetEffortByDay.has(r.work_date)) continue;
    days.add(r.work_date);
    // The LARGEST crew on any one day, not the sum: a two-man crew across
    // three days is two guys on his sheet, not six.
    crew = Math.max(crew, ticketCrewSize(r));
    personHours += ticketHours(r.job_start_time, r.job_end_time) * ticketCrewSize(r);
  }
  return { days: days.size, crew, personHours: Math.round(personHours * 100) / 100 };
}

/** The job's T&M daily sign-in sheets ([] before job_tm_forms exists). */
async function jobSignIns(client: SupabaseClient, jobId: string) {
  const { data, error } = await client
    .from("job_tm_forms")
    .select("form_date, payload")
    .eq("job_id", jobId)
    .eq("kind", "sign_in");
  if (error) {
    if (isMissingSchema(error)) return [];
    throw error;
  }
  return ((data ?? []) as { form_date: string; payload: unknown }[]).map((r) => ({
    date: r.form_date,
    payload: normaliseSignIn(r.payload),
  }));
}

/** One supply the ledger counted: a request line or stock off the shelf. */
export type LedgerSupply = {
  itemId: string | null;
  name: string;
  sku: string | null;
  unit: string | null;
  quantity: number;
};

export type LedgerCatalogItem = {
  id: string;
  code: string;
  name: string;
  uom: string;
  default_unit_price: number;
};

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();
const round2 = roundMoney;
const usd = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });

/** The catalog item a supply is billed as: SKU = code first, then the same name. */
export function catalogItemForSupply(
  supply: Pick<LedgerSupply, "name" | "sku">,
  catalog: readonly LedgerCatalogItem[],
): LedgerCatalogItem | null {
  const sku = norm(supply.sku);
  if (sku) {
    const byCode = catalog.find((c) => norm(c.code) === sku);
    if (byCode) return byCode;
  }
  const name = norm(supply.name);
  return name ? (catalog.find((c) => norm(c.name) === name) ?? null) : null;
}

/** Where a price came from, in the words the calculator's readout uses. */
const PRICE_SOURCE_WORDS: Record<ResolvedPrice["source"], string> = {
  account: "client agreement",
  location: "Standard rate for this office",
  state: "state price list",
  default: "Standard rate",
  job: "this job's frozen rate",
  custom: "this job's custom rate",
  tm: "this T&M job's T&M rate",
  none: "no rate set — enter one",
};

function sourceLabel(p: Pick<ResolvedPrice, "source">): string {
  return PRICE_SOURCE_WORDS[p.source];
}

/** Same item, same unit: one line. Request lines and stock moves add up. */
function combineSupplies(supplies: readonly LedgerSupply[]): LedgerSupply[] {
  const by = new Map<string, LedgerSupply>();
  for (const s of supplies) {
    if (!(s.quantity > 0)) continue;
    const key = `${s.itemId ?? `label:${norm(s.name)}`}|${norm(s.unit)}`;
    const held = by.get(key);
    if (held) held.quantity = round2(held.quantity + s.quantity);
    else by.set(key, { ...s, quantity: round2(s.quantity) });
  }
  return [...by.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export type LedgerInvoicePlan = {
  lines: PullLine[];
  totals: { hours: number; supplies: number; unpriced: number; amount: number };
  /** The labour charge rate the plan priced at, and where it came from. */
  labor?: { rate: number; source: string };
};

/**
 * Pure: the ledger's figures and the charge rates in, invoice lines out.
 * `labor.source` names where the rate came from, for the line.
 */
export function planLedgerInvoice(input: {
  hours: { value: number | null; typed: boolean; effort: LedgerEffort | null };
  labor: { rate: number; source: string };
  supplies: readonly LedgerSupply[];
  catalog: readonly LedgerCatalogItem[];
  book: PriceBook;
}): LedgerInvoicePlan {
  const lines: PullLine[] = [];

  const hours = round2(Math.max(0, input.hours.value ?? 0));
  if (hours > 0) {
    const e = input.hours.effort;
    const basis = input.hours.typed
      ? "the figure typed on the ledger"
      : e
        ? `field tickets: ${e.days} day${e.days === 1 ? "" : "s"}, up to ${e.crew} crew`
        : "field tickets";
    lines.push({
      kind: "labor",
      name: "Labor",
      description: `${hours} man-hours from the job ledger (${basis}) at ${usd(input.labor.rate)}/hr — ${input.labor.source}`,
      uom: "HR",
      quantity: hours,
      unit_price: input.labor.rate,
    });
  }

  let unpriced = 0;
  const supplies = combineSupplies(input.supplies);
  for (const s of supplies) {
    const item = catalogItemForSupply(s, input.catalog);
    const unit = s.unit?.trim() || "each";
    if (!item) {
      unpriced += 1;
      lines.push({
        kind: "supply",
        name: s.name,
        description: `${s.quantity} ${unit} from the job ledger (supplies) — no charge rate on file, enter a price`,
        uom: "EA",
        quantity: s.quantity,
        unit_price: 0,
        unpriced: true,
      });
      continue;
    }
    const price = resolvePrice(item.id, item.default_unit_price, input.book);
    lines.push({
      kind: "supply",
      name: s.name,
      description: `${s.quantity} ${unit} from the job ledger (supplies) — ${sourceLabel(price)}`,
      uom: "EA",
      quantity: s.quantity,
      unit_price: round2(price.unit_price),
      catalog_item_id: item.id,
      code: item.code,
    });
  }

  return {
    lines,
    totals: {
      hours,
      supplies: supplies.length,
      unpriced,
      // The total is the sum of the printed lines, each to the cent (P5).
      amount: sumMoney(lines.map((l) => roundMoney(l.quantity * l.unit_price))),
    },
  };
}

/* ------------------------------------------------------------------ I/O */

type SupplyItemJoin = { name: string; sku: string | null; unit: string | null } | null;

/** The ledger's two supply sources, as the running cost reads them. */
export async function loadLedgerSupplies(
  client: SupabaseClient,
  jobId: string,
): Promise<LedgerSupply[]> {
  const [requests, stock] = await Promise.all([
    client
      .from("supply_requests")
      .select(
        "status, supply_request_lines(item_id, other_label, quantity, unit, item:item_id(name, sku, unit))",
      )
      .eq("job_id", jobId)
      .neq("status", "denied"),
    client
      .from("supply_stock_moves")
      .select("item_id, qty, item:item_id(name, sku, unit)")
      .eq("job_id", jobId)
      .lt("qty", 0),
  ]);
  if (requests.error) throw requests.error;
  // The stock ledger arrived later than requests; without it there is no stock to count.
  if (stock.error && !isMissingSchema(stock.error)) throw stock.error;

  const out: LedgerSupply[] = [];
  for (const r of (requests.data ?? []) as unknown as {
    supply_request_lines:
      | {
          item_id: string | null;
          other_label: string | null;
          quantity: number;
          unit: string | null;
          item: SupplyItemJoin;
        }[]
      | null;
  }[]) {
    for (const l of r.supply_request_lines ?? []) {
      out.push({
        itemId: l.item_id,
        name: l.item?.name ?? l.other_label?.trim() ?? "Supplies",
        sku: l.item?.sku ?? null,
        unit: l.unit ?? l.item?.unit ?? null,
        quantity: Number(l.quantity) || 0,
      });
    }
  }
  for (const m of (stock.data ?? []) as unknown as {
    item_id: string;
    qty: number;
    item: SupplyItemJoin;
  }[]) {
    out.push({
      itemId: m.item_id,
      name: m.item?.name ?? "Supplies",
      sku: m.item?.sku ?? null,
      unit: m.item?.unit ?? null,
      quantity: -Number(m.qty) || 0,
    });
  }
  out.push(...(await condensedSupplyListLines(client, jobId)));
  return out;
}

/**
 * FE10: a regular (non-T&M) job's daily supply lists — the condensed ten —
 * counted with its other supplies, each line as its rate code (the SKU the
 * catalog charge is matched on) and label. A T&M job's supply lists are
 * billed on the T&M bill instead, so they are never counted here. Before
 * job_tm_forms exists there is nothing to add.
 */
async function condensedSupplyListLines(
  client: SupabaseClient,
  jobId: string,
): Promise<LedgerSupply[]> {
  const { data: job, error: jobErr } = await client
    .from("jobs")
    .select("job_type")
    .eq("id", jobId)
    .maybeSingle();
  if (jobErr) throw jobErr;
  if (supplyListKind((job as { job_type: string | null } | null)?.job_type) !== "condensed") {
    return [];
  }
  const { data, error } = await client
    .from("job_tm_forms")
    .select("payload")
    .eq("job_id", jobId)
    .eq("kind", "supply_list");
  if (error) {
    if (isMissingSchema(error)) return [];
    throw error;
  }
  const sheets = ((data ?? []) as { payload: unknown }[]).map((r) =>
    normaliseSupplyList(r.payload),
  );
  if (!sheets.some((s) => s.lines.length)) return [];
  const catalogue = await loadTmRateCodes(client);
  const byCode = new Map(catalogue.rows.map((r) => [r.code, r]));
  return sheets.flatMap((s) =>
    s.lines.map((l) => {
      const code = byCode.get(l.code);
      return {
        itemId: null,
        name: code?.label ?? l.code,
        sku: l.code,
        unit: code?.unit_note ?? null,
        quantity: l.qty,
      };
    }),
  );
}

/** Everything the button reads, then the plan. Throws on a failed read — never a silent empty. */
export async function loadLedgerInvoicePlan(
  client: SupabaseClient,
  invoice: Pick<PullInvoice, "job_id" | "account_id" | "location_id" | "region" | "issue_date">,
): Promise<LedgerInvoicePlan> {
  const jobId = invoice.job_id;
  if (!jobId) throw new Error("This invoice is not on a job, so there is no ledger to read.");
  const [
    { fetchCalculatorRates, CALCULATOR_RATE_CODES, RATE_SOURCE_LABEL },
    { normalizeStateCode },
  ] = await Promise.all([import("@/lib/job-calculator-pricing"), import("@/lib/us-states")]);
  const { fetchLedgerOverrides } = await import("@/lib/job-ledger-overrides");
  const { CATALOG_ITEM_SELECT } = await import("@/lib/estimates");

  const [effort, overrides, supplies, catalogRes, priced] = await Promise.all([
    loadLedgerEffort(client, jobId),
    fetchLedgerOverrides(jobId),
    loadLedgerSupplies(client, jobId),
    client.from("estimate_catalog_items").select(CATALOG_ITEM_SELECT).eq("is_active", true),
    // CHARGE rates for this customer, office and state on the invoice's date —
    // the resolver Pull from job and the Quick Estimate use.
    fetchCalculatorRates({
      jobId,
      accountId: invoice.account_id,
      locationId: invoice.location_id,
      stateCode: normalizeStateCode(invoice.region),
      onDate: invoice.issue_date,
    }),
  ]);
  if (catalogRes.error && !isMissingSchema(catalogRes.error)) throw catalogRes.error;
  const catalog = ((catalogRes.data ?? []) as unknown as LedgerCatalogItem[]).map((c) => ({
    ...c,
    default_unit_price: Number(c.default_unit_price) || 0,
  }));

  // Where the labour rate came from, for the line: the labour item through
  // the same book, or the calculator's standard rate when there is no item.
  const laborItem = catalog.find((c) => norm(c.code) === norm(CALCULATOR_RATE_CODES.regularLabor));
  const laborSource = laborItem
    ? sourceLabel(resolvePrice(laborItem.id, laborItem.default_unit_price, priced.book))
    : RATE_SOURCE_LABEL.builtin.toLowerCase();

  const typed = overrides.values.hours;
  const plan = planLedgerInvoice({
    hours: {
      value: typed ? typed.value : (effort?.personHours ?? null),
      typed: !!typed,
      effort,
    },
    labor: { rate: priced.rates.regularLabor, source: laborSource },
    supplies,
    catalog,
    book: priced.book,
  });
  return { ...plan, labor: { rate: priced.rates.regularLabor, source: laborSource } };
}

/**
 * The job ledger's Labor Charge and Supplies Charge (David, 23 Oct): priced
 * EXACTLY as the "From ledger" invoice would price them today — the office's
 * charge rate from Settings › Cost rates, a customer's own agreed price where
 * they have one — so the ledger and the invoice can never disagree.
 */
export async function ledgerCharges(
  client: SupabaseClient,
  job: { id: string; account_id: string | null; location_id: string; region: string | null },
): Promise<{
  laborCharge: { rate: number; source: string } | null;
  suppliesCharge: { amount: number; unpriced: number; source: string } | null;
}> {
  const plan = await loadLedgerInvoicePlan(client, {
    job_id: job.id,
    account_id: job.account_id,
    location_id: job.location_id,
    region: job.region,
    issue_date: new Date().toISOString().slice(0, 10),
  } as never);
  const supplyLines = plan.lines.filter((l) => l.kind === "supply");
  return {
    laborCharge: plan.labor && plan.labor.rate > 0 ? plan.labor : null,
    suppliesCharge: supplyLines.length
      ? {
          amount: round2(supplyLines.reduce((s, l) => s + l.quantity * l.unit_price, 0)),
          unpriced: plan.totals.unpriced,
          source:
            "each supply's charge (Billing & Costs › Cost › Supplies book, or the customer's price list)",
        }
      : null,
  };
}

/** The one-press path: plan from the ledger, insert as ordinary editable lines. Sends nothing. */
export async function ledgerIntoInvoice(
  client: SupabaseClient,
  invoice: PullInvoice,
): Promise<{ lines: number; amount: number; unpriced: number }> {
  const plan = await loadLedgerInvoicePlan(client, invoice);
  if (plan.lines.length === 0) return { lines: 0, amount: 0, unpriced: 0 };
  const { insertInvoicePull } = await import("@/lib/invoice-pull-run");
  const lines = await insertInvoicePull(client, {
    invoiceId: invoice.id,
    scopeCount: 0,
    lines: plan.lines,
    scopeName: "From the job ledger",
  });
  return { lines, amount: plan.totals.amount, unpriced: plan.totals.unpriced };
}
