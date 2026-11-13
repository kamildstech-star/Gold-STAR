/**
 * The per-location labour BILL rate — what Gold Star charges an hour.
 *
 * David, 13 Oct: each location has two labour rates — the COST rate (what GSR
 * pays the crew, $45/hr) and the BILLABLE rate (what GSR charges, $65/hr). An
 * invoice's labour line is hours × the bill rate (64 h × $65 = $4,160); the
 * running cost stays on the cost rate.
 *
 * WHERE EACH LIVES, and why they are not one table:
 *  - Cost stays in `labour_rates` (src/lib/labour.ts). Only finance roles may
 *    read it, and every costing path already reads it.
 *  - The bill rate is a CHARGE, and charges live in price lists, which every
 *    signed-in user can read — an estimator who cannot see the rate cannot
 *    write the bill (see 20260910233000_customer_price_lists.sql). So the
 *    location's bill rate is the labour item (`GSC-LABOR-REG`) on that
 *    location's branch price list. That puts it in the one resolver the
 *    invoice already uses (job-calculator-pricing.ts), in the right place:
 *
 *      customer agreement  >  this location's bill rate  >  state list
 *      >  catalogue default  >  the built-in $70
 *
 *    so a customer with their own agreed rate still gets it, and "Pull from
 *    job" prices labour at the bill rate with no second rate table to keep in
 *    step.
 */
import { supabase } from "@/integrations/supabase/client";
import { CALCULATOR_RATE_CODES } from "@/lib/job-calculator-pricing";
import { defaultCalculatorRates } from "@/lib/job-calculator";
import {
  fetchPriceListAssignments,
  today,
  winningAssignments,
  type PriceListAssignmentRow,
} from "@/lib/price-lists";

/** The catalogue item the bill rate is a price of. */
export const LABOUR_BILL_CODE = CALCULATOR_RATE_CODES.regularLabor;

export type LocationBillRate = {
  /** What one hour is charged at for this location, before a customer agreement. */
  rate: number;
  /** Where that number came from. */
  source: "location" | "catalog" | "builtin";
  /** The branch list holding it, when there is one. */
  priceListId: string | null;
  priceListName: string | null;
};

/**
 * The branch list a location's bill rate is written to: the location's own
 * winning list if it has one (so the bill rate joins the branch prices the
 * office already keeps), else none — and the caller makes one.
 *
 * Writing to a NEW list when one already exists would be wrong: the newest
 * location assignment wins outright, so a fresh one-item list would shadow
 * every other branch price.
 */
export function branchListFor(
  assignments: readonly PriceListAssignmentRow[],
  locationId: string,
  onDate: string = today(),
): PriceListAssignmentRow | null {
  return winningAssignments(assignments, { accountId: null, locationId, stateCode: null, onDate })
    .location;
}

/** Hours × rate, to the cent — src/lib/money.ts's laborAmount (kept for old imports). */
export { laborAmount as labourAmount } from "@/lib/money";

type CatalogRow = { id: string; default_unit_price: number | string };

async function labourCatalogItem(): Promise<CatalogRow | null> {
  const { data, error } = await supabase
    .from("estimate_catalog_items")
    .select("id, default_unit_price")
    .eq("code", LABOUR_BILL_CODE)
    .maybeSingle();
  if (error) throw error;
  return (data as CatalogRow | null) ?? null;
}

/**
 * The bill rate a location charges today, and where it came from.
 *
 * Billing & Costs prompt 4: an office's labor charge is its Standard rate
 * (Client Agreements › Standard rates, office-aware), read through
 * regular_price_book. Before that migration it is the branch price list.
 */
export async function fetchLocationBillRate(locationId: string): Promise<LocationBillRate> {
  const builtin = defaultCalculatorRates().regularLabor;
  const standard = await supabase.rpc(
    "regular_price_book" as never,
    {
      _job_id: null,
      _account_id: null,
      _location_id: locationId,
      _state: null,
      _on: today(),
      _standard: true,
    } as never,
  );
  if (!standard.error) {
    const row = (
      (standard.data ?? []) as {
        code: string;
        unit_price: number | string | null;
        source: string;
      }[]
    ).find((r) => r.code.trim().toLowerCase() === LABOUR_BILL_CODE.toLowerCase());
    if (!row || row.unit_price == null)
      return { rate: builtin, source: "builtin", priceListId: null, priceListName: null };
    return {
      rate: Number(row.unit_price),
      source: row.source === "location" ? "location" : "catalog",
      priceListId: null,
      priceListName: row.source === "location" ? "Standard rates (this office)" : null,
    };
  }
  const item = await labourCatalogItem();
  if (!item) return { rate: builtin, source: "builtin", priceListId: null, priceListName: null };
  const fallback: LocationBillRate = {
    rate: Number(item.default_unit_price),
    source: "catalog",
    priceListId: null,
    priceListName: null,
  };
  const branch = branchListFor(await fetchPriceListAssignments(), locationId);
  if (!branch) return fallback;
  const [{ data: price, error }, { data: list }] = await Promise.all([
    supabase
      .from("price_list_items")
      .select("unit_price")
      .eq("price_list_id", branch.price_list_id)
      .eq("catalog_item_id", item.id)
      .maybeSingle(),
    supabase.from("price_lists").select("name").eq("id", branch.price_list_id).maybeSingle(),
  ]);
  if (error) throw error;
  if (!price)
    return { ...fallback, priceListId: branch.price_list_id, priceListName: list?.name ?? null };
  return {
    rate: Number(price.unit_price),
    source: "location",
    priceListId: branch.price_list_id,
    priceListName: list?.name ?? null,
  };
}

/**
 * Set a location's bill rate. Makes what is missing, once: the labour
 * catalogue item (at the built-in $70 default, so nothing else moves), and a
 * branch price list for the location if it has none.
 */
export async function setLocationBillRate(input: {
  locationId: string;
  locationName: string | null;
  rate: number;
  userId: string | null;
}): Promise<void> {
  if (!Number.isFinite(input.rate) || input.rate <= 0)
    throw new Error("Enter an hourly bill rate.");

  let item = await labourCatalogItem();
  if (!item) {
    const { data, error } = await supabase
      .from("estimate_catalog_items")
      .insert({
        code: LABOUR_BILL_CODE,
        name: "Labor — regular (per hour)",
        uom: "HR",
        default_unit_price: defaultCalculatorRates().regularLabor,
        taxable: true,
      })
      .select("id, default_unit_price")
      .single();
    if (error) throw error;
    item = data as CatalogRow;
  }

  let listId = branchListFor(await fetchPriceListAssignments(), input.locationId)?.price_list_id;
  if (!listId) {
    const { data: list, error: listErr } = await supabase
      .from("price_lists")
      .insert({
        name: `Branch rates — ${input.locationName?.trim() || "location"}`,
        description: "The location's own charge rates. Made from Settings › Labor rates.",
        created_by: input.userId,
      })
      .select("id")
      .single();
    if (listErr) throw listErr;
    const { error: asgErr } = await supabase.from("price_list_assignments").insert({
      price_list_id: list.id,
      location_id: input.locationId,
      effective_from: today(),
      created_by: input.userId,
    });
    if (asgErr) throw asgErr;
    listId = list.id;
  }

  const { error } = await supabase
    .from("price_list_items")
    .upsert(
      { price_list_id: listId, catalog_item_id: item.id, unit_price: input.rate },
      { onConflict: "price_list_id,catalog_item_id" },
    );
  if (error) throw error;
}

/**
 * A location's charge rate as the job ledger's Labor Charge row takes it — the
 * rate and, in words, where it came from. Mark, 22 Oct: the ledger gets the
 * labor charge from Settings › Labor rates.
 */
export function ledgerLaborCharge(
  bill: Pick<LocationBillRate, "rate" | "source"> | null | undefined,
): { rate: number; source: string } | null {
  if (!bill || !(bill.rate > 0)) return null;
  return {
    rate: bill.rate,
    source:
      bill.source === "location"
        ? "this office's charge rate"
        : bill.source === "catalog"
          ? "the catalog's default charge rate (none set for this office)"
          : "the standard charge rate (none set for this office)",
  };
}

/* ------------------------------------------------------------------ */
/* A client's own agreed rate                                          */
/* ------------------------------------------------------------------ */

/**
 * David, 23 Oct: "different rates for different locations AND clients." A
 * client's agreed hourly charge is their account price list's labour item —
 * the price-list system the invoices and the job ledger already honour, where
 * a client's agreement beats the office's rate. Set here from Settings › Cost
 * rates › Labor instead of building a price list by hand.
 */
export type ClientLaborRate = {
  accountId: string;
  accountName: string;
  rate: number;
  priceListId: string;
};

async function ensureLabourItem(): Promise<CatalogRow> {
  const found = await labourCatalogItem();
  if (found) return found;
  const { data, error } = await supabase
    .from("estimate_catalog_items")
    .insert({
      code: LABOUR_BILL_CODE,
      name: "Labor — regular (per hour)",
      uom: "HR",
      default_unit_price: defaultCalculatorRates().regularLabor,
      taxable: true,
    })
    .select("id, default_unit_price")
    .single();
  if (error) throw error;
  return data as CatalogRow;
}

/** The client's winning price list today, if they have one. */
export function clientListFor(
  assignments: readonly PriceListAssignmentRow[],
  accountId: string,
  onDate: string = today(),
): PriceListAssignmentRow | null {
  return winningAssignments(assignments, { accountId, locationId: null, stateCode: null, onDate })
    .account;
}

/** Every client with their own agreed labour charge, by name. */
export async function listClientLaborRates(): Promise<ClientLaborRate[]> {
  const item = await labourCatalogItem();
  if (!item) return [];
  const assignments = await fetchPriceListAssignments();
  const accountIds = [...new Set(assignments.map((a) => a.account_id).filter(Boolean))] as string[];
  const winners = accountIds
    .map((id) => ({ id, list: clientListFor(assignments, id) }))
    .filter((w): w is { id: string; list: PriceListAssignmentRow } => !!w.list);
  if (!winners.length) return [];
  const [{ data: prices, error }, { data: accounts }] = await Promise.all([
    supabase
      .from("price_list_items")
      .select("price_list_id, unit_price")
      .eq("catalog_item_id", item.id)
      .in(
        "price_list_id",
        winners.map((w) => w.list.price_list_id),
      ),
    supabase
      .from("accounts")
      .select("id, name")
      .in(
        "id",
        winners.map((w) => w.id),
      ),
  ]);
  if (error) throw error;
  const priceBy = new Map((prices ?? []).map((p) => [p.price_list_id, Number(p.unit_price)]));
  const nameBy = new Map((accounts ?? []).map((a) => [a.id, a.name as string]));
  return winners
    .filter((w) => priceBy.has(w.list.price_list_id))
    .map((w) => ({
      accountId: w.id,
      accountName: nameBy.get(w.id) ?? "Client",
      rate: priceBy.get(w.list.price_list_id)!,
      priceListId: w.list.price_list_id,
    }))
    .sort((a, b) => a.accountName.localeCompare(b.accountName));
}

/**
 * Set a client's agreed hourly charge. Writes into the client's own price
 * list when they have one (so it sits with the rest of their agreement), and
 * makes one — assigned to the client from today — when they do not.
 */
export async function setClientLaborRate(input: {
  accountId: string;
  accountName: string | null;
  rate: number;
  userId: string | null;
}): Promise<void> {
  if (!Number.isFinite(input.rate) || input.rate <= 0)
    throw new Error("Enter an hourly charge rate.");
  const item = await ensureLabourItem();
  let listId = clientListFor(await fetchPriceListAssignments(), input.accountId)?.price_list_id;
  if (!listId) {
    const { data: list, error: listErr } = await supabase
      .from("price_lists")
      .insert({
        name: `Client rates — ${input.accountName?.trim() || "client"}`,
        description:
          "This client's agreed charge rates. Made from Billing & Costs › General Rates.",
        created_by: input.userId,
      })
      .select("id")
      .single();
    if (listErr) throw listErr;
    const { error: asgErr } = await supabase.from("price_list_assignments").insert({
      price_list_id: list.id,
      account_id: input.accountId,
      effective_from: today(),
      created_by: input.userId,
    });
    if (asgErr) throw asgErr;
    listId = list.id;
  }
  const { error } = await supabase
    .from("price_list_items")
    .upsert(
      { price_list_id: listId, catalog_item_id: item.id, unit_price: input.rate },
      { onConflict: "price_list_id,catalog_item_id" },
    );
  if (error) throw error;
}

/** Back to the office's rate: the labour line leaves the client's list; the list stays. */
export async function removeClientLaborRate(priceListId: string): Promise<void> {
  const item = await labourCatalogItem();
  if (!item) return;
  const { error } = await supabase
    .from("price_list_items")
    .delete()
    .eq("price_list_id", priceListId)
    .eq("catalog_item_id", item.id);
  if (error) throw error;
}
