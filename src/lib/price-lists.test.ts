import { describe, expect, it } from "vitest";

import {
  assignmentApplies,
  buildPriceBook,
  catalogCodeIndex,
  compareAssignments,
  detectPriceColumns,
  EMPTY_PRICE_BOOK,
  parsePriceCell,
  parsePriceListCsv,
  resolveCatalogPrice,
  resolvePrice,
  winningAssignments,
  type PriceContext,
  type PriceListAssignmentRow,
  type PriceListItemRow,
} from "@/lib/price-lists";

/**
 * The resolution order David described — "There's a default across the board.
 * But when you select certain clients, those clients override the default" —
 * is the one thing in this feature that must not be ambiguous. Two people
 * looking at the same estimate have to see the same price, so every rule the
 * resolver relies on is pinned here: the order itself, per-item fall-through,
 * date boundaries, and the tie-break between overlapping agreements.
 */

const FALCON = "acct-falcon";
const NJ = "loc-nj";

/** The daily rate off the call: $95 default, $80 for Falcon. */
const DAILY = "item-daily";
const LABOR = "item-labor";
const TRAVEL = "item-travel";

function assignment(over: Partial<PriceListAssignmentRow> = {}): PriceListAssignmentRow {
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

function item(
  price_list_id: string,
  catalog_item_id: string,
  unit_price: number | string,
): PriceListItemRow {
  return {
    id: `${price_list_id}:${catalog_item_id}`,
    price_list_id,
    catalog_item_id,
    unit_price: unit_price as number,
  };
}

const ctx = (over: Partial<PriceContext> = {}): PriceContext => ({
  accountId: FALCON,
  locationId: NJ,
  stateCode: null,
  onDate: "2026-06-01",
  ...over,
});

describe("assignmentApplies", () => {
  it("includes both ends of the date range", () => {
    const a = assignment({ effective_from: "2026-06-01", effective_to: "2026-06-30" });
    expect(assignmentApplies(a, "2026-06-01")).toBe(true);
    expect(assignmentApplies(a, "2026-06-30")).toBe(true);
  });

  it("excludes the day before it starts and the day after it ends", () => {
    const a = assignment({ effective_from: "2026-06-01", effective_to: "2026-06-30" });
    expect(assignmentApplies(a, "2026-05-31")).toBe(false);
    expect(assignmentApplies(a, "2026-07-01")).toBe(false);
  });

  it("treats a null end date as still in force", () => {
    const a = assignment({ effective_from: "2020-01-01", effective_to: null });
    expect(assignmentApplies(a, "2099-12-31")).toBe(true);
  });

  it("compares dates as strings, so no timezone can move a boundary", () => {
    // A Date-based implementation parses "2026-06-01" as UTC midnight and, run
    // in New York, decides the agreement started the previous evening.
    const a = assignment({ effective_from: "2026-06-01" });
    expect(assignmentApplies(a, "2026-05-31")).toBe(false);
  });
});

describe("compareAssignments", () => {
  it("prefers the agreement that starts later", () => {
    const older = assignment({ id: "z", effective_from: "2026-01-01" });
    const newer = assignment({ id: "a", effective_from: "2026-05-01" });
    expect(compareAssignments(newer, older)).toBeGreaterThan(0);
    expect(compareAssignments(older, newer)).toBeLessThan(0);
  });

  it("falls back to the row written later when both start the same day", () => {
    const first = assignment({ id: "z", created_at: "2026-05-01T09:00:00Z" });
    const second = assignment({ id: "a", created_at: "2026-05-01T17:00:00Z" });
    expect(compareAssignments(second, first)).toBeGreaterThan(0);
  });

  it("falls back to the id when start and creation are identical", () => {
    const a = assignment({ id: "aaa" });
    const b = assignment({ id: "bbb" });
    expect(compareAssignments(b, a)).toBeGreaterThan(0);
    expect(compareAssignments(a, b)).toBeLessThan(0);
  });

  it("is a total order: no two distinct rows compare equal", () => {
    const rows = [
      assignment({ id: "a", effective_from: "2026-01-01" }),
      assignment({ id: "b", effective_from: "2026-01-01" }),
      assignment({ id: "c", effective_from: "2026-02-01" }),
    ];
    for (const x of rows)
      for (const y of rows) {
        if (x.id === y.id) expect(compareAssignments(x, y)).toBe(0);
        else expect(compareAssignments(x, y)).not.toBe(0);
      }
  });

  it("does not depend on the order the rows arrived in", () => {
    const rows = [
      assignment({ id: "a", price_list_id: "old", effective_from: "2026-01-01" }),
      assignment({ id: "b", price_list_id: "new", effective_from: "2026-05-01" }),
    ].map((r) => ({ ...r, account_id: FALCON }));
    const forwards = winningAssignments(rows, ctx());
    const backwards = winningAssignments([...rows].reverse(), ctx());
    expect(forwards.account?.id).toBe("b");
    expect(backwards.account?.id).toBe("b");
  });
});

describe("winningAssignments", () => {
  it("ignores rows for another customer or another branch", () => {
    const rows = [
      assignment({ id: "other-acct", account_id: "acct-someone-else" }),
      assignment({ id: "other-loc", location_id: "loc-ny" }),
    ];
    const w = winningAssignments(rows, ctx());
    expect(w.account).toBeNull();
    expect(w.location).toBeNull();
  });

  it("ignores an assignment that has expired or has not started", () => {
    const rows = [
      assignment({ id: "expired", account_id: FALCON, effective_to: "2026-05-31" }),
      assignment({ id: "future", account_id: FALCON, effective_from: "2026-07-01" }),
    ];
    expect(winningAssignments(rows, ctx()).account).toBeNull();
  });

  it("finds one winner per scope, independently", () => {
    const rows = [
      assignment({ id: "acct", account_id: FALCON, price_list_id: "falcon" }),
      assignment({ id: "loc", location_id: NJ, price_list_id: "nj" }),
    ];
    const w = winningAssignments(rows, ctx());
    expect(w.account?.price_list_id).toBe("falcon");
    expect(w.location?.price_list_id).toBe("nj");
  });

  it("finds nothing when the document has no customer, branch or state", () => {
    const rows = [assignment({ account_id: FALCON }), assignment({ location_id: NJ })];
    const w = winningAssignments(rows, ctx({ accountId: null, locationId: null, stateCode: null }));
    expect(w).toEqual({ account: null, location: null, state: null });
  });

  it("does not let a null context match a null column", () => {
    // An account-scoped row has location_id null. A naive equality check would
    // match it against a document with no location and price off the wrong list.
    const rows = [assignment({ id: "acct", account_id: FALCON })];
    const w = winningAssignments(rows, ctx({ accountId: null }));
    expect(w.account).toBeNull();
    expect(w.location).toBeNull();
  });

  it("ignores a row that names neither an account nor a location", () => {
    expect(winningAssignments([assignment({ id: "orphan" })], ctx()).account).toBeNull();
  });
});

describe("buildPriceBook — customer, then location, then default", () => {
  const rows = [
    assignment({ id: "acct", account_id: FALCON, price_list_id: "falcon" }),
    assignment({ id: "loc", location_id: NJ, price_list_id: "nj" }),
  ];
  const items = [
    item("falcon", DAILY, 80),
    item("nj", DAILY, 90),
    item("nj", LABOR, 65),
    // TRAVEL is on neither list.
  ];

  it("gives the customer agreement over the branch list", () => {
    const book = buildPriceBook(rows, items, ctx());
    expect(resolvePrice(DAILY, 95, book)).toMatchObject({
      unit_price: 80,
      source: "account",
      price_list_id: "falcon",
      assignment_id: "acct",
    });
  });

  it("falls through PER ITEM to the branch list, not per list", () => {
    // Falcon's agreement says nothing about labor, so New Jersey's $65 stands
    // rather than the whole location list being discarded.
    const book = buildPriceBook(rows, items, ctx());
    expect(resolvePrice(LABOR, 70, book)).toMatchObject({ unit_price: 65, source: "location" });
  });

  it("falls through to the catalog default for an item on neither list", () => {
    const book = buildPriceBook(rows, items, ctx());
    expect(resolvePrice(TRAVEL, 125, book)).toEqual({
      unit_price: 125,
      source: "default",
      price_list_id: null,
      assignment_id: null,
    });
  });

  it("uses the branch list when the customer has no agreement", () => {
    const book = buildPriceBook(rows, items, ctx({ accountId: "acct-walk-in" }));
    expect(resolvePrice(DAILY, 95, book)).toMatchObject({ unit_price: 90, source: "location" });
  });

  it("uses the catalog default when neither scope has a list", () => {
    const book = buildPriceBook([], [], ctx());
    expect(resolvePrice(DAILY, 95, book).unit_price).toBe(95);
    expect(book.size).toBe(0);
  });

  it("prices an agreement that is more expensive, not only cheaper", () => {
    // "Sometimes it's going to be better pricing. Sometimes it's going to be
    // more expensive pricing because we're able to charge them."
    const book = buildPriceBook(rows, [item("falcon", DAILY, 140)], ctx());
    expect(resolvePrice(DAILY, 95, book).unit_price).toBe(140);
  });

  it("treats a negotiated zero as a price, not as a missing entry", () => {
    const book = buildPriceBook(rows, [item("falcon", TRAVEL, 0)], ctx());
    expect(resolvePrice(TRAVEL, 125, book)).toMatchObject({ unit_price: 0, source: "account" });
  });

  it("reads a numeric that PostgREST serialised as a string", () => {
    const book = buildPriceBook(rows, [item("falcon", DAILY, "80.5")], ctx());
    expect(resolvePrice(DAILY, 95, book).unit_price).toBe(80.5);
  });

  it("rounds to the cents a price column stores", () => {
    const book = buildPriceBook(rows, [item("falcon", DAILY, 80.005)], ctx());
    expect(resolvePrice(DAILY, 95, book).unit_price).toBe(80.01);
  });

  it("ignores item rows belonging to a list nobody is assigned", () => {
    const book = buildPriceBook(rows, [...items, item("some-other-list", TRAVEL, 1)], ctx());
    expect(resolvePrice(TRAVEL, 125, book).source).toBe("default");
  });

  it("prices off the agreement in force on the document's date, not today", () => {
    const dated = [
      assignment({
        id: "old",
        account_id: FALCON,
        price_list_id: "falcon-2025",
        effective_from: "2025-01-01",
        effective_to: "2025-12-31",
      }),
      assignment({
        id: "new",
        account_id: FALCON,
        price_list_id: "falcon",
        effective_from: "2026-01-01",
      }),
    ];
    const priced = [item("falcon-2025", DAILY, 75), item("falcon", DAILY, 80)];
    expect(resolvePrice(DAILY, 95, buildPriceBook(dated, priced, ctx())).unit_price).toBe(80);
    expect(
      resolvePrice(DAILY, 95, buildPriceBook(dated, priced, ctx({ onDate: "2025-06-01" })))
        .unit_price,
    ).toBe(75);
  });

  it("breaks an overlap the same way whichever order the rows arrive in", () => {
    const overlapping = [
      assignment({
        id: "a",
        account_id: FALCON,
        price_list_id: "old",
        effective_from: "2026-01-01",
      }),
      assignment({
        id: "b",
        account_id: FALCON,
        price_list_id: "new",
        effective_from: "2026-05-01",
      }),
    ];
    const priced = [item("old", DAILY, 88), item("new", DAILY, 80)];
    for (const order of [overlapping, [...overlapping].reverse()]) {
      expect(resolvePrice(DAILY, 95, buildPriceBook(order, priced, ctx())).unit_price).toBe(80);
    }
  });

  it("does not let a location list leak onto a document from another branch", () => {
    const book = buildPriceBook(rows, items, ctx({ accountId: null, locationId: "loc-ny" }));
    expect(resolvePrice(LABOR, 70, book).source).toBe("default");
  });
});

describe("resolvePrice fallbacks", () => {
  it("answers from the catalog when handed no book at all", () => {
    expect(resolvePrice(DAILY, 95).unit_price).toBe(95);
    expect(resolvePrice(DAILY, 95, EMPTY_PRICE_BOOK).source).toBe("default");
  });

  it("treats a null or absent catalog price as zero rather than NaN", () => {
    expect(resolvePrice(DAILY, null).unit_price).toBe(0);
    expect(resolvePrice(DAILY, undefined).unit_price).toBe(0);
  });

  it("reads a catalog row straight off the picker", () => {
    const book = buildPriceBook(
      [assignment({ id: "acct", account_id: FALCON, price_list_id: "falcon" })],
      [item("falcon", DAILY, 80)],
      ctx(),
    );
    expect(resolveCatalogPrice({ id: DAILY, default_unit_price: 95 }, book).unit_price).toBe(80);
    expect(resolveCatalogPrice({ id: TRAVEL, default_unit_price: 125 }, book).unit_price).toBe(125);
  });
});

/* ------------------------------------------------------------------ import */

describe("parsePriceCell", () => {
  it("reads money the way people type it", () => {
    expect(parsePriceCell("95")).toBe(95);
    expect(parsePriceCell("$95.00")).toBe(95);
    expect(parsePriceCell("$1,250.50")).toBe(1250.5);
    expect(parsePriceCell(" 80 ")).toBe(80);
    expect(parsePriceCell(".5")).toBe(0.5);
  });

  it("refuses anything that is not a price, rather than importing a zero", () => {
    for (const bad of ["", "  ", "n/a", "call", "80-90", "1.2.3", "-80", "(80)", "80%"]) {
      expect(parsePriceCell(bad), bad).toBeNull();
    }
  });

  it("accepts an explicit zero", () => {
    expect(parsePriceCell("0")).toBe(0);
    expect(parsePriceCell("$0.00")).toBe(0);
  });
});

describe("parsePriceListCsv", () => {
  const catalog = catalogCodeIndex([
    { id: DAILY, code: "DEHU-DAY" },
    { id: LABOR, code: "LAB-TECH" },
    { id: TRAVEL, code: "TRV" },
  ]);

  it("imports code and price, skipping a header row", () => {
    const { rows, problems } = parsePriceListCsv(
      "Code,Price\nDEHU-DAY,80\nLAB-TECH,$65.00\n",
      catalog,
    );
    expect(problems).toEqual([]);
    expect(rows.map((r) => [r.catalog_item_id, r.unit_price])).toEqual([
      [DAILY, 80],
      [LABOR, 65],
    ]);
  });

  it("keeps a first row that is data, not a header", () => {
    const { rows } = parsePriceListCsv("DEHU-DAY,80", catalog);
    expect(rows).toHaveLength(1);
  });

  it("matches codes case-insensitively and ignores surrounding space", () => {
    const { rows, problems } = parsePriceListCsv(" dehu-day , 80 ", catalog);
    expect(problems).toEqual([]);
    expect(rows[0].catalog_item_id).toBe(DAILY);
  });

  it("reports an unknown code instead of dropping it in silence", () => {
    const { rows, problems } = parsePriceListCsv("Code,Price\nNOPE,80\nTRV,25", catalog);
    expect(rows).toHaveLength(1);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ line: 2, reason: expect.stringContaining("NOPE") });
  });

  it("reports a row whose price is not a number", () => {
    const { rows, problems } = parsePriceListCsv("Code,Price\nDEHU-DAY,call us", catalog);
    expect(rows).toEqual([]);
    expect(problems[0].reason).toContain("call us");
  });

  it("reports a row with no code at all", () => {
    const { problems } = parsePriceListCsv("Code,Price\n,80", catalog);
    expect(problems[0].reason).toContain("No item code");
  });

  it("keeps the last of a repeated code and says which line won", () => {
    const { rows, problems } = parsePriceListCsv("Code,Price\nDEHU-DAY,80\nDEHU-DAY,85", catalog);
    expect(rows).toHaveLength(1);
    expect(rows[0].unit_price).toBe(85);
    expect(problems[0].reason).toContain("line 3");
  });

  it("survives the line endings and blank lines a real export has", () => {
    const { rows, problems } = parsePriceListCsv(
      "Code,Price\r\nDEHU-DAY,80\r\n\r\nLAB-TECH,65\r\n",
      catalog,
    );
    expect(problems).toEqual([]);
    expect(rows).toHaveLength(2);
  });

  it("reads quoted fields and tab-separated paste from a spreadsheet", () => {
    const quoted = parsePriceListCsv('Code,Price\n"DEHU-DAY","$1,250.00"', catalog);
    expect(quoted.rows[0].unit_price).toBe(1250);
    const tabbed = parsePriceListCsv("Code\tPrice\nDEHU-DAY\t80", catalog);
    expect(tabbed.rows[0].unit_price).toBe(80);
  });

  it("ignores extra columns people leave in the sheet", () => {
    const { rows, problems } = parsePriceListCsv(
      "Code,Price,Notes\nDEHU-DAY,80,agreed 2026",
      catalog,
    );
    expect(problems).toEqual([]);
    expect(rows[0].unit_price).toBe(80);
  });

  it("returns nothing at all for an empty paste", () => {
    expect(parsePriceListCsv("", catalog)).toEqual({ rows: [], problems: [], columns: null });
    expect(parsePriceListCsv("   \n\n", catalog)).toEqual({
      rows: [],
      problems: [],
      columns: null,
    });
  });

  /* A vendor's own sheet, which is rarely two tidy columns. */

  it("reads code and price from the columns a vendor header names, in any order", () => {
    const result = parsePriceListCsv(
      "Description,Unit,Price,Item Code\nDehu daily,DA,80,DEHU-DAY\nTech hour,HR,$65.00,LAB-TECH",
      catalog,
    );
    expect(result.problems).toEqual([]);
    expect(result.columns).toEqual({ code: "Item Code", price: "Price" });
    expect(result.rows.map((r) => [r.catalog_item_id, r.unit_price])).toEqual([
      [DAILY, 80],
      [LABOR, 65],
    ]);
  });

  it("takes the agreed price over a list price beside it", () => {
    const result = parsePriceListCsv("Code,List price,Contract price\nDEHU-DAY,95,80", catalog);
    expect(result.columns?.price).toBe("Contract price");
    expect(result.rows[0].unit_price).toBe(80);
  });

  it("names the header column when a cell under it is empty", () => {
    const { problems } = parsePriceListCsv("Description,Code,Rate\nDehu daily,DEHU-DAY,", catalog);
    expect(problems[0].reason).toBe('No price under "Rate"');
  });

  it("still reads a sheet with no header as code then price", () => {
    const result = parsePriceListCsv("DEHU-DAY,80\nTRV,25", catalog);
    expect(result.columns).toBeNull();
    expect(result.rows).toHaveLength(2);
  });

  it("numbers problems from the sheet row the text started on", () => {
    // A workbook whose header is on row 4 hands over the text from row 4.
    const { problems } = parsePriceListCsv("Code,Price\nDEHU-DAY,80\nNOPE,12", catalog, {
      firstLine: 4,
    });
    expect(problems[0]).toMatchObject({ line: 6, reason: expect.stringContaining("NOPE") });
  });
});

describe("detectPriceColumns", () => {
  it("recognizes the headers vendor lists actually use", () => {
    expect(detectPriceColumns(["Item #", "Description", "Unit Price"])).toEqual({
      code: 0,
      price: 2,
    });
    expect(detectPriceColumns(["SKU", "Net Price"])).toEqual({ code: 0, price: 1 });
    expect(detectPriceColumns(["Selector", "Rate ($)"])).toEqual({ code: 0, price: 1 });
  });

  it("prefers a column that says code over an Item column holding descriptions", () => {
    expect(detectPriceColumns(["Item", "Code", "Price"])).toEqual({ code: 1, price: 2 });
  });

  it("is not fooled by a title row, or a header naming only one of the two", () => {
    expect(detectPriceColumns(["Acme Restoration Supply — 2026 price list"])).toBeNull();
    expect(detectPriceColumns(["Code", "Description"])).toBeNull();
    expect(detectPriceColumns(["Description", "Price"])).toBeNull();
    expect(detectPriceColumns(["DEHU-DAY", "80"])).toBeNull();
  });
});

describe("catalogCodeIndex", () => {
  it("keys on the trimmed lowercase code", () => {
    const idx = catalogCodeIndex([{ id: "x", code: " Dehu-Day " }]);
    expect(idx.get("dehu-day")).toBe("x");
  });
});
