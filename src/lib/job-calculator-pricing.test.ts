import { describe, expect, it } from "vitest";

import {
  CALCULATOR_RATE_CODES,
  CALCULATOR_SUPPLY_CODES,
  builtinCalculatorRates,
  calculatorCatalogCodes,
  equipmentCode,
  resolveCalculatorRates,
  type CalculatorCatalog,
} from "./job-calculator-pricing";
import {
  EQUIPMENT_DEFINITIONS,
  JOB_CALCULATOR_RATES,
  calculateCustomerPricing,
  emptyEquipment,
  type JobCalculationInput,
} from "./job-calculator";
import { buildPriceBook, type PriceContext, type PriceListAssignmentRow } from "./price-lists";

/**
 * The Job Calculator, priced off the price lists.
 *
 * David asked for one rule — "when you select certain clients, those clients
 * override the default" — and it reached the estimate and the invoice but not
 * the calculator, which kept its workbook constants. These pin the whole
 * order, INCLUDING every way it can fall through, because the fallback is what
 * makes it safe to ship: no catalog item carries these codes on day one, so
 * the last layer is the one that runs in production until an office opts in.
 *
 *   1 customer agreement  2 branch list  3 state rate
 *   4 catalog default     5 workbook constant
 */

const FALCON = "acct-falcon";
const NEWARK = "loc-newark";

const LABOR_ITEM = "cat-labor-reg";
const AIR_MOVER_ITEM = "cat-air-mover";

/** A catalog that carries the two codes these tests care about. */
function catalog(
  entries: Array<[string, string, number]> = [
    [CALCULATOR_RATE_CODES.regularLabor, LABOR_ITEM, 90],
    [equipmentCode("air_mover"), AIR_MOVER_ITEM, 60],
  ],
): CalculatorCatalog {
  return new Map(
    entries.map(([code, id, price]) => [code.toLowerCase(), { id, default_unit_price: price }]),
  );
}

function assignment(over: Partial<PriceListAssignmentRow>): PriceListAssignmentRow {
  return {
    id: "a1",
    price_list_id: "list-1",
    account_id: null,
    location_id: null,
    state_code: null,
    effective_from: "2026-01-01",
    effective_to: null,
    created_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

const ctx = (over: Partial<PriceContext> = {}): PriceContext => ({
  accountId: FALCON,
  locationId: NEWARK,
  stateCode: "NJ",
  onDate: "2026-06-01",
  ...over,
});

/** A book built the real way — through `buildPriceBook`, never hand-made. */
function bookFor(
  assignments: PriceListAssignmentRow[],
  items: Array<{ price_list_id: string; catalog_item_id: string; unit_price: number }>,
  context: PriceContext = ctx(),
) {
  return buildPriceBook(
    assignments,
    items.map((i, n) => ({ id: `i${n}`, ...i })),
    context,
  );
}

describe("the codes the calculator looks for", () => {
  it("covers every rate slot, every loss type and every equipment key", () => {
    const codes = calculatorCatalogCodes();
    expect(codes).toContain(CALCULATOR_RATE_CODES.regularLabor);
    expect(codes).toContain(CALCULATOR_SUPPLY_CODES.fire_smoke);
    for (const item of EQUIPMENT_DEFINITIONS) {
      expect(codes, item.key).toContain(equipmentCode(item.key));
    }
    // No duplicates: two slots sharing a code would silently price the same.
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("derives an equipment code from its key", () => {
    expect(equipmentCode("air_mover")).toBe("GSC-EQ-AIR-MOVER");
    expect(equipmentCode("scrubber_xl_filter")).toBe("GSC-EQ-SCRUBBER-XL-FILTER");
  });
});

describe("resolution order, layer by layer", () => {
  it("5 — falls back to the workbook constant when the catalog has no such item", () => {
    // This is the state of production on the day this ships.
    const { rates, sources } = resolveCalculatorRates({ catalog: new Map() });
    expect(rates.regularLabor).toBe(JOB_CALCULATOR_RATES.regularLabor);
    expect(rates.afterHoursLabor).toBe(JOB_CALCULATOR_RATES.afterHoursLabor);
    expect(rates.equipment.air_mover).toBe(
      EQUIPMENT_DEFINITIONS.find((e) => e.key === "air_mover")!.customerRate,
    );
    expect(sources.effective).toBe("builtin");
    expect(sources.listName).toBeNull();
  });

  it("4 — takes the catalog default once the item exists and no list applies", () => {
    const { rates, sources } = resolveCalculatorRates({ catalog: catalog() });
    expect(rates.regularLabor).toBe(90);
    expect(rates.equipment.air_mover).toBe(60);
    expect(sources.effective).toBe("default");
    // The slots with no catalog row are still on the constants.
    expect(rates.afterHoursLabor).toBe(JOB_CALCULATOR_RATES.afterHoursLabor);
    expect(sources.counts.default).toBe(2);
    expect(sources.counts.builtin).toBeGreaterThan(0);
  });

  it("3 — a state list beats the catalog default", () => {
    const book = bookFor(
      [assignment({ id: "st", price_list_id: "nj-list", state_code: "NJ" })],
      [{ price_list_id: "nj-list", catalog_item_id: LABOR_ITEM, unit_price: 65 }],
    );
    const { rates, sources } = resolveCalculatorRates({ catalog: catalog(), book });
    expect(rates.regularLabor).toBe(65);
    expect(sources.effective).toBe("state");
  });

  it("2 — a branch list beats the state list", () => {
    const book = bookFor(
      [
        assignment({ id: "st", price_list_id: "nj-list", state_code: "NJ" }),
        assignment({ id: "br", price_list_id: "newark-list", location_id: NEWARK }),
      ],
      [
        { price_list_id: "nj-list", catalog_item_id: LABOR_ITEM, unit_price: 65 },
        { price_list_id: "newark-list", catalog_item_id: LABOR_ITEM, unit_price: 72 },
      ],
    );
    const { rates, sources } = resolveCalculatorRates({ catalog: catalog(), book });
    expect(rates.regularLabor).toBe(72);
    expect(sources.effective).toBe("location");
  });

  it("1 — the customer agreement beats everything", () => {
    const book = bookFor(
      [
        assignment({ id: "st", price_list_id: "nj-list", state_code: "NJ" }),
        assignment({ id: "br", price_list_id: "newark-list", location_id: NEWARK }),
        assignment({ id: "ac", price_list_id: "falcon-list", account_id: FALCON }),
      ],
      [
        { price_list_id: "nj-list", catalog_item_id: LABOR_ITEM, unit_price: 65 },
        { price_list_id: "newark-list", catalog_item_id: LABOR_ITEM, unit_price: 72 },
        { price_list_id: "falcon-list", catalog_item_id: LABOR_ITEM, unit_price: 80 },
      ],
    );
    const { rates, sources } = resolveCalculatorRates({
      catalog: catalog(),
      book,
      listNameOf: new Map([["falcon-list", "Falcon 2026"]]),
    });
    expect(rates.regularLabor).toBe(80);
    expect(sources.effective).toBe("account");
    expect(sources.listName).toBe("Falcon 2026");
  });

  /* The rule that makes a list worth keeping current. */
  it("falls through PER ITEM, not per list", () => {
    const book = bookFor(
      [
        assignment({ id: "st", price_list_id: "nj-list", state_code: "NJ" }),
        assignment({ id: "ac", price_list_id: "falcon-list", account_id: FALCON }),
      ],
      [
        // Falcon negotiated labour only. The air mover is not on their sheet.
        { price_list_id: "falcon-list", catalog_item_id: LABOR_ITEM, unit_price: 80 },
        { price_list_id: "nj-list", catalog_item_id: AIR_MOVER_ITEM, unit_price: 50 },
      ],
    );
    const { rates } = resolveCalculatorRates({ catalog: catalog(), book });
    expect(rates.regularLabor).toBe(80); // customer
    expect(rates.equipment.air_mover).toBe(50); // state, underneath
    expect(rates.afterHoursLabor).toBe(JOB_CALCULATOR_RATES.afterHoursLabor); // constant
  });

  it("names the narrowest layer that answered, not the commonest", () => {
    // One rate off the customer's agreement and eighteen off the constants
    // still means this quote is on Falcon's agreement.
    const book = bookFor(
      [assignment({ id: "ac", price_list_id: "falcon-list", account_id: FALCON })],
      [{ price_list_id: "falcon-list", catalog_item_id: LABOR_ITEM, unit_price: 80 }],
    );
    const { sources } = resolveCalculatorRates({ catalog: catalog(), book });
    expect(sources.counts.account).toBe(1);
    expect(sources.counts.builtin).toBeGreaterThan(sources.counts.account);
    expect(sources.effective).toBe("account");
  });

  it("skips the state layer when the job has no state", () => {
    const book = bookFor(
      [assignment({ id: "st", price_list_id: "nj-list", state_code: "NJ" })],
      [{ price_list_id: "nj-list", catalog_item_id: LABOR_ITEM, unit_price: 65 }],
      ctx({ accountId: null, locationId: null, stateCode: null }),
    );
    const { rates, sources } = resolveCalculatorRates({ catalog: catalog(), book });
    expect(rates.regularLabor).toBe(90); // the catalog default
    expect(sources.effective).toBe("default");
  });

  it("matches a state written out in full against a list keyed on the code", () => {
    // `accounts.state` is free text, so the fallback source may say "New Jersey".
    const book = bookFor(
      [assignment({ id: "st", price_list_id: "nj-list", state_code: "NJ" })],
      [{ price_list_id: "nj-list", catalog_item_id: LABOR_ITEM, unit_price: 65 }],
      ctx({ accountId: null, locationId: null, stateCode: "New Jersey" }),
    );
    expect(resolveCalculatorRates({ catalog: catalog(), book }).rates.regularLabor).toBe(65);
  });

  it("does not price a New York job off the New Jersey list", () => {
    const book = bookFor(
      [assignment({ id: "st", price_list_id: "nj-list", state_code: "NJ" })],
      [{ price_list_id: "nj-list", catalog_item_id: LABOR_ITEM, unit_price: 65 }],
      ctx({ accountId: null, locationId: null, stateCode: "NY" }),
    );
    expect(resolveCalculatorRates({ catalog: catalog(), book }).rates.regularLabor).toBe(90);
  });

  it("honors a price of zero, which is a price somebody typed", () => {
    const book = bookFor(
      [assignment({ id: "ac", price_list_id: "falcon-list", account_id: FALCON })],
      [{ price_list_id: "falcon-list", catalog_item_id: AIR_MOVER_ITEM, unit_price: 0 }],
    );
    const { rates } = resolveCalculatorRates({ catalog: catalog(), book });
    expect(rates.equipment.air_mover).toBe(0);
  });

  it("ignores an agreement that has expired", () => {
    const book = bookFor(
      [
        assignment({
          id: "ac",
          price_list_id: "falcon-list",
          account_id: FALCON,
          effective_to: "2026-03-31",
        }),
      ],
      [{ price_list_id: "falcon-list", catalog_item_id: LABOR_ITEM, unit_price: 80 }],
    );
    expect(resolveCalculatorRates({ catalog: catalog(), book }).rates.regularLabor).toBe(90);
  });
});

describe("the quote the customer is shown", () => {
  const INPUT: JobCalculationInput = {
    jobDate: "2026-06-01",
    jobType: "water",
    note: "",
    customerName: "Falcon",
    contactNumber: "",
    email: "",
    address: "",
    addressLine2: "",
    locality: "",
    region: "NJ",
    postalCode: "",
    days: 2,
    workers: 2,
    regularHours: 4,
    afterHours: 0,
    emergency: false,
    garbageFee: 0,
    miscellaneousFee: 0,
    customLines: [],
    equipment: { ...emptyEquipment(), air_mover: 3 },
  };

  it("prices off the workbook constants when nothing is configured", () => {
    const withDefaults = calculateCustomerPricing(INPUT);
    const withBuiltins = calculateCustomerPricing(INPUT, builtinCalculatorRates());
    expect(withBuiltins).toEqual(withDefaults);
    // 2 days x 2 workers x 4 hours x $70.
    expect(withDefaults.regularLaborPrice).toBe(1120);
  });

  it("moves the whole quote onto the customer's agreement", () => {
    const book = bookFor(
      [assignment({ id: "ac", price_list_id: "falcon-list", account_id: FALCON })],
      [
        { price_list_id: "falcon-list", catalog_item_id: LABOR_ITEM, unit_price: 80 },
        { price_list_id: "falcon-list", catalog_item_id: AIR_MOVER_ITEM, unit_price: 30 },
      ],
    );
    const { rates } = resolveCalculatorRates({ catalog: catalog(), book });
    const priced = calculateCustomerPricing(INPUT, rates);

    expect(priced.regularLaborPrice).toBe(1280); // 2 x 2 x 4 x $80
    const airMover = priced.equipment.find((e) => e.key === "air_mover")!;
    expect(airMover.customerRate).toBe(30);
    expect(airMover.customerTotal).toBe(90); // 3 x $30
    // And the total moves with them rather than being computed twice.
    expect(priced.customerPrice).toBeGreaterThan(0);
    expect(priced.customerPrice).toBe(
      priced.laborCustomerPrice +
        priced.equipmentCustomerPrice +
        priced.supplyCost +
        priced.truckCustomerPrice,
    );
  });

  it("leaves the internal cost basis alone — a price list carries no cost", () => {
    // The customer rate moves; `internalRate` is not in CalculatorRates at all,
    // so no office admin can change the margin through Admin -> Price lists.
    const book = bookFor(
      [assignment({ id: "ac", price_list_id: "falcon-list", account_id: FALCON })],
      [{ price_list_id: "falcon-list", catalog_item_id: AIR_MOVER_ITEM, unit_price: 30 }],
    );
    const { rates } = resolveCalculatorRates({ catalog: catalog(), book });
    expect(Object.keys(rates)).not.toContain("laborInternalFactor");
    expect(Object.keys(rates)).not.toContain("truckInternalPerDay");
    expect(JOB_CALCULATOR_RATES.laborInternalFactor).toBe(0.642858);
  });
});
