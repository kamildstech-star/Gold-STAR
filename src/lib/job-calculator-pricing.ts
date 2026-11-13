import { supabase } from "@/integrations/supabase/client";
import { CATALOG_ITEM_SELECT, num, round2, type CatalogItemPublic } from "@/lib/estimates";
import {
  EMPTY_PRICE_BOOK,
  NO_DOCUMENT_PRICING,
  PRICE_SCOPES,
  fetchDocumentPricing,
  resolvePrice,
  type PriceBook,
  type PriceContext,
  type PriceSource,
} from "@/lib/price-lists";
import { isMissingSchema } from "@/lib/schema-fallback";
import {
  EQUIPMENT_DEFINITIONS,
  JOB_CALCULATOR_TYPES,
  defaultCalculatorRates,
  type CalculatorRates,
  type EquipmentKey,
  type JobCalculatorType,
} from "@/lib/job-calculator";

/**
 * THE JOB CALCULATOR, PRICED OFF THE PRICE LISTS.
 *
 * The calculator shipped with its rates as module constants — $70 regular
 * labour, $105 after hours, $45 an air mover — transcribed from David's
 * workbook. So the price-list feature he asked for in the same conversation
 * reached the estimate and the invoice and stopped at the one screen he
 * actually quotes from: "when you select certain clients, those clients
 * override the default" was true everywhere except the calculator.
 *
 * NO SECOND RESOLVER. Everything here funnels into `resolvePrice` from
 * src/lib/price-lists.ts, with the same `PriceBook` the estimate line picker
 * uses. This module is only the mapping — calculator rate slot to catalog item
 * — plus the last fallback. If the precedence rule ever changes it changes in
 * `buildPriceBook`, once, and the calculator follows.
 *
 * FIVE LAYERS, and the last one is why the calculator cannot break:
 *
 *   1. the customer's agreement          (price list, scope "account")
 *   2. the branch list                   (price list, scope "location")
 *   3. the state rate                    (price list, scope "state")
 *   4. the catalog default               (estimate_catalog_items)
 *   5. the workbook constant             (JOB_CALCULATOR_RATES)
 *
 * 1-3 are `buildPriceBook`. 4 is `resolvePrice`'s own fallback. 5 is this
 * module's, and it is the one that matters operationally: the estimate catalog
 * is seeded by the office, not by a migration, so on the day this ships NO
 * catalog item carries any of the codes below and every rate resolves to the
 * workbook constant — exactly today's behaviour, to the cent. An office adopts
 * this by creating catalog items with these codes, at which point the
 * calculator starts answering to the catalog and to every price list above it.
 * The same fallback covers an unapplied migration, a dropped connection and a
 * catalog row somebody retires.
 *
 * WHY CODES AND NOT A NEW TABLE. `price_list_items.catalog_item_id` is a
 * foreign key into the catalog, so a price list can only ever name a catalog
 * item. Giving the calculator its own rate table would mean a second set of
 * prices to keep in step and a second resolver to keep honest. Instead the
 * calculator's rates ARE catalog items, identified by a reserved code prefix,
 * and a price list overrides them exactly as it overrides anything else.
 */

/** Reserved prefix, so an office can see at a glance what these rows are for. */
export const CALCULATOR_CODE_PREFIX = "GSC-";

/** The non-equipment rate slots the calculator can take from the catalog. */
export type CalculatorRateSlot =
  "regularLabor" | "afterHoursLabor" | "emergencyBonusPerWorker" | "truckCustomerPerDay";

export const CALCULATOR_RATE_CODES: Record<CalculatorRateSlot, string> = {
  regularLabor: "GSC-LABOR-REG",
  afterHoursLabor: "GSC-LABOR-AH",
  emergencyBonusPerWorker: "GSC-LABOR-EMG",
  truckCustomerPerDay: "GSC-TRUCK-DAY",
};

/** Supplies are a daily charge that differs by loss type, so one code each. */
export const CALCULATOR_SUPPLY_CODES: Record<JobCalculatorType, string> = {
  water: "GSC-SUPPLY-WATER",
  mold: "GSC-SUPPLY-MOLD",
  fire_smoke: "GSC-SUPPLY-FIRE",
};

/** `air_mover` -> `GSC-EQ-AIR-MOVER`. Derived, so a new unit needs no edit. */
export function equipmentCode(key: EquipmentKey): string {
  return `${CALCULATOR_CODE_PREFIX}EQ-${key.toUpperCase().replace(/_/g, "-")}`;
}

/** Every code the calculator looks for, for the one catalog read. */
export function calculatorCatalogCodes(): string[] {
  return [
    ...Object.values(CALCULATOR_RATE_CODES),
    ...Object.values(CALCULATOR_SUPPLY_CODES),
    ...EQUIPMENT_DEFINITIONS.map((item) => equipmentCode(item.key)),
  ];
}

/** Where one rate came from. `builtin` is the workbook constant. */
export type RateSource = PriceSource | "builtin";

export const RATE_SOURCE_LABEL: Record<RateSource, string> = {
  account: "Client agreement",
  location: "Standard (this office)",
  state: "State price list",
  default: "Standard",
  job: "This job's rates",
  custom: "Custom for this job",
  tm: "T&M rate",
  none: "No rate set",
  builtin: "Built-in rates",
};

/** Which layer answered each rate, so a screen can show the truth. */
export interface CalculatorRateSources {
  /** The narrowest layer that actually supplied any rate. */
  effective: RateSource;
  /** Name of the winning price list, when one was used. */
  listName: string | null;
  /** How many rate slots each layer answered. */
  counts: Record<RateSource, number>;
}

export interface ResolvedCalculatorRates {
  rates: CalculatorRates;
  sources: CalculatorRateSources;
  /**
   * Which layer answered each equipment rate. The T&M bill reads it: a
   * customer, branch or state price list still wins there; below that the
   * bill takes Billing & Costs › T&M Rates (prompt 2).
   */
  equipmentSources: Record<EquipmentKey, RateSource>;
}

/** The workbook constants, in the shape the calculator takes them in. */
export const builtinCalculatorRates = defaultCalculatorRates;

/** A catalog row reduced to what pricing needs, keyed by lowercased code. */
export type CalculatorCatalog = ReadonlyMap<string, { id: string; default_unit_price: number }>;

/**
 * Resolve every calculator rate through the price book.
 *
 * Pure: the catalog and the book are handed in, so the whole five-layer order
 * is testable without a database. A catalog item that does not exist is not an
 * error — it is layer 5, the workbook constant.
 */
export function resolveCalculatorRates(input: {
  catalog: CalculatorCatalog;
  book?: PriceBook;
  listNameOf?: ReadonlyMap<string, string>;
}): ResolvedCalculatorRates {
  const { catalog, book = EMPTY_PRICE_BOOK, listNameOf } = input;
  const builtin = builtinCalculatorRates();
  const counts: Record<RateSource, number> = {
    job: 0,
    custom: 0,
    tm: 0,
    account: 0,
    location: 0,
    state: 0,
    default: 0,
    none: 0,
    builtin: 0,
  };
  let winningListId: string | null = null;

  const equipmentSources = {} as Record<EquipmentKey, RateSource>;
  /** One rate slot: catalog item if we have one, else the constant. */
  const rateFor = (code: string, fallback: number, equipmentKey?: EquipmentKey): number => {
    const item = catalog.get(code.toLowerCase());
    if (!item) {
      counts.builtin += 1;
      if (equipmentKey) equipmentSources[equipmentKey] = "builtin";
      return fallback;
    }
    const resolved = resolvePrice(item.id, item.default_unit_price, book);
    // Nothing prices the item (a new one with no Standard rate): the
    // workbook constant, as for an item that does not exist.
    if (resolved.source === "none") {
      counts.builtin += 1;
      if (equipmentKey) equipmentSources[equipmentKey] = "builtin";
      return fallback;
    }
    counts[resolved.source] += 1;
    if (equipmentKey) equipmentSources[equipmentKey] = resolved.source;
    if (resolved.price_list_id && !winningListId) winningListId = resolved.price_list_id;
    return round2(num(resolved.unit_price));
  };

  const rates: CalculatorRates = {
    regularLabor: rateFor(CALCULATOR_RATE_CODES.regularLabor, builtin.regularLabor),
    afterHoursLabor: rateFor(CALCULATOR_RATE_CODES.afterHoursLabor, builtin.afterHoursLabor),
    emergencyBonusPerWorker: rateFor(
      CALCULATOR_RATE_CODES.emergencyBonusPerWorker,
      builtin.emergencyBonusPerWorker,
    ),
    truckCustomerPerDay: rateFor(
      CALCULATOR_RATE_CODES.truckCustomerPerDay,
      builtin.truckCustomerPerDay,
    ),
    suppliesPerDay: Object.fromEntries(
      JOB_CALCULATOR_TYPES.map((type) => [
        type,
        rateFor(CALCULATOR_SUPPLY_CODES[type], builtin.suppliesPerDay[type]),
      ]),
    ) as Record<JobCalculatorType, number>,
    equipment: Object.fromEntries(
      EQUIPMENT_DEFINITIONS.map((item) => [
        item.key,
        rateFor(equipmentCode(item.key), builtin.equipment[item.key], item.key),
      ]),
    ) as Record<EquipmentKey, number>,
  };

  // The narrowest layer that actually answered something. `PRICE_SCOPES` is
  // narrowest-first, so the first non-zero count is the honest headline: a
  // customer list that overrode one rate out of twenty still means this quote
  // is on the customer's agreement, and saying "Default catalogue" there
  // would be a lie of exactly the kind this readout exists to prevent.
  const effective: RateSource =
    (["tm", "custom", "job"] as const).find((s) => counts[s] > 0) ??
    PRICE_SCOPES.find((scope) => counts[scope] > 0) ??
    (counts.default > 0 ? "default" : "builtin");

  return {
    rates,
    equipmentSources,
    sources: {
      effective,
      listName: winningListId ? (listNameOf?.get(winningListId) ?? null) : null,
      counts,
    },
  };
}

/**
 * Read the calculator's catalog rows. Only the reserved codes, so this is one
 * small query however large the catalog grows.
 *
 * `default_cost` is never selected — `CATALOG_ITEM_SELECT` exists precisely
 * because naming that column fails the read for everyone (20260909090000).
 */
export async function fetchCalculatorCatalog(): Promise<CalculatorCatalog> {
  const codes = calculatorCatalogCodes();
  const { data, error } = await supabase
    .from("estimate_catalog_items")
    .select(CATALOG_ITEM_SELECT)
    .in("code", codes)
    .eq("is_active", true);
  if (error) {
    // A catalog the schema has not caught up with is layer 5, not an outage.
    if (isMissingSchema(error)) return new Map();
    throw error;
  }
  const map = new Map<string, { id: string; default_unit_price: number }>();
  for (const row of (data ?? []) as CatalogItemPublic[]) {
    map.set(row.code.trim().toLowerCase(), {
      id: row.id,
      default_unit_price: num(row.default_unit_price),
    });
  }
  return map;
}

/**
 * Everything the calculator needs to price a quote for one customer, in one
 * call. Never throws for a missing schema: the caller gets the workbook
 * constants and the screen says so.
 */
export async function fetchCalculatorRates(
  ctx: PriceContext,
): Promise<ResolvedCalculatorRates & { book: PriceBook }> {
  const [catalog, pricing] = await Promise.all([
    fetchCalculatorCatalog().catch((e) => {
      if (isMissingSchema(e)) return new Map() as CalculatorCatalog;
      throw e;
    }),
    fetchDocumentPricing(ctx).catch((e) => {
      // The price-list tables arrive with 20260910233000 / 20260913110000;
      // until both are applied the calculator prices off the catalog alone.
      if (isMissingSchema(e)) return NO_DOCUMENT_PRICING;
      throw e;
    }),
  ]);

  // The book too, so a caller pricing other catalog items (the ledger
  // invoice's supplies) uses the same read rather than a second one.
  return {
    ...resolveCalculatorRates({
      catalog,
      book: pricing.book,
      listNameOf: pricing.nameOfList,
    }),
    book: pricing.book,
  };
}
