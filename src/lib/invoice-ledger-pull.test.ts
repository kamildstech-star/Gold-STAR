import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import {
  catalogItemForSupply,
  combinedEffort,
  loadLedgerEffort,
  planLedgerInvoice,
  type LedgerCatalogItem,
} from "@/lib/invoice-ledger-pull";
import type { PriceBook } from "@/lib/price-lists";

/**
 * David, 20 Oct: a third invoice button — the ledger's man-hours × the hourly
 * charge rate (his NJ $65/hr row), plus the supplies the ledger counted,
 * priced the same way. A draft to edit; nothing sent.
 */

const CATALOG: LedgerCatalogItem[] = [
  { id: "cat-labor", code: "GSC-LABOR-REG", name: "Labor", uom: "HR", default_unit_price: 70 },
  {
    id: "cat-poly",
    code: "POLY-6",
    name: "Poly sheeting 6 mil",
    uom: "EA",
    default_unit_price: 95,
  },
  { id: "cat-bags", code: "BAG-42", name: "Contractor bags", uom: "EA", default_unit_price: 40 },
];

/** The NJ state list: labour at $65, poly at $88. Bags are not on it. */
const NJ_BOOK: PriceBook = new Map([
  [
    "cat-labor",
    { unit_price: 65, source: "state" as const, price_list_id: "nj", assignment_id: "a1" },
  ],
  [
    "cat-poly",
    { unit_price: 88, source: "state" as const, price_list_id: "nj", assignment_id: "a1" },
  ],
]);

const EFFORT = { days: 4, crew: 4, personHours: 64 };

describe("the labor line", () => {
  it("is the ledger's hours × the hourly charge rate, and says so", () => {
    const plan = planLedgerInvoice({
      hours: { value: 64, typed: false, effort: EFFORT },
      labor: { rate: 65, source: "state price list" },
      supplies: [],
      catalog: CATALOG,
      book: NJ_BOOK,
    });
    expect(plan.lines).toHaveLength(1);
    expect(plan.lines[0]).toMatchObject({
      kind: "labor",
      name: "Labor",
      uom: "HR",
      quantity: 64,
      unit_price: 65,
    });
    expect(plan.lines[0]!.description).toBe(
      "64 man-hours from the job ledger (field tickets: 4 days, up to 4 crew) at $65.00/hr — state price list",
    );
    expect(plan.totals.amount).toBe(4160);
  });

  it("bills a figure typed on the ledger, and names it as typed", () => {
    const plan = planLedgerInvoice({
      hours: { value: 70.5, typed: true, effort: EFFORT },
      labor: { rate: 65, source: "branch price list" },
      supplies: [],
      catalog: CATALOG,
      book: NJ_BOOK,
    });
    expect(plan.lines[0]!.quantity).toBe(70.5);
    expect(plan.lines[0]!.description).toContain("(the figure typed on the ledger)");
  });

  it("makes no labor line when the ledger has no hours", () => {
    for (const value of [0, null]) {
      const plan = planLedgerInvoice({
        hours: { value, typed: false, effort: null },
        labor: { rate: 65, source: "x" },
        supplies: [],
        catalog: CATALOG,
        book: NJ_BOOK,
      });
      expect(plan.lines).toEqual([]);
    }
  });
});

describe("the supply lines", () => {
  const plan = () =>
    planLedgerInvoice({
      hours: { value: 0, typed: false, effort: null },
      labor: { rate: 65, source: "x" },
      supplies: [
        // A request line and stock off the shelf of the same item: one line.
        { itemId: "s-poly", name: "Poly sheeting 6 mil", sku: "poly-6", unit: "roll", quantity: 2 },
        { itemId: "s-poly", name: "Poly sheeting 6 mil", sku: "poly-6", unit: "roll", quantity: 1 },
        { itemId: "s-bags", name: "Contractor bags", sku: null, unit: "box", quantity: 3 },
        { itemId: null, name: "Zip poles", sku: null, unit: null, quantity: 4 },
      ],
      catalog: CATALOG,
      book: NJ_BOOK,
    });

  it("prices each through the price book: the state list first, else the catalog", () => {
    const lines = plan().lines;
    const poly = lines.find((l) => l.name === "Poly sheeting 6 mil")!;
    expect(poly).toMatchObject({
      kind: "supply",
      quantity: 3,
      unit_price: 88,
      catalog_item_id: "cat-poly",
      code: "POLY-6",
    });
    expect(poly.description).toBe("3 roll from the job ledger (supplies) — state price list");
    const bags = lines.find((l) => l.name === "Contractor bags")!;
    expect(bags).toMatchObject({ unit_price: 40, catalog_item_id: "cat-bags" });
    expect(bags.description).toContain("Standard rate");
  });

  it("puts a supply with no catalog item in at $0 and says to price it", () => {
    const p = plan();
    const zip = p.lines.find((l) => l.name === "Zip poles")!;
    expect(zip).toMatchObject({ unit_price: 0, unpriced: true });
    expect(zip.description).toContain("no charge rate on file, enter a price");
    expect(p.totals.unpriced).toBe(1);
    expect(p.totals.amount).toBe(3 * 88 + 3 * 40);
  });

  it("matches on SKU = code first, then the same name, ignoring case", () => {
    expect(catalogItemForSupply({ name: "whatever", sku: "BAG-42" }, CATALOG)?.id).toBe("cat-bags");
    expect(catalogItemForSupply({ name: "  contractor BAGS ", sku: null }, CATALOG)?.id).toBe(
      "cat-bags",
    );
    expect(catalogItemForSupply({ name: "Nothing like it", sku: "nope" }, CATALOG)).toBeNull();
  });
});

describe("one read of the hours, shared with the ledger strip", () => {
  it("adds up person-hours the strip's way: hours on site × crew, largest crew", async () => {
    const rows = [
      {
        work_date: "2026-10-01",
        gsr_crew_size: 3,
        temp_crew_size: 1,
        job_start_time: "08:00",
        job_end_time: "16:00",
      },
      {
        work_date: "2026-10-02",
        gsr_crew_size: 2,
        temp_crew_size: 0,
        job_start_time: "08:00",
        job_end_time: "16:00",
      },
    ];
    // field_work_tickets answers after one .eq; job_tm_forms (no sheets) after two.
    const client = {
      from: (table: string) => ({
        select: () => ({
          eq: () =>
            table === "field_work_tickets"
              ? Promise.resolve({ data: rows, error: null })
              : { eq: async () => ({ data: [], error: null }) },
        }),
      }),
    };
    expect(await loadLedgerEffort(client as never, "job-1")).toEqual({
      days: 2,
      crew: 4,
      personHours: 48,
    });
  });

  it("counts a day from its signed sign-in sheet and every other day from its field form (TM5)", () => {
    const tickets = [
      {
        work_date: "2026-10-01",
        gsr_crew_size: 3,
        temp_crew_size: 0,
        job_start_time: "08:00",
        job_end_time: "16:00",
      },
      {
        work_date: "2026-10-02",
        gsr_crew_size: 2,
        temp_crew_size: 0,
        job_start_time: "08:00",
        job_end_time: "12:00",
      },
    ];
    const sheet = {
      date: "2026-10-01",
      payload: {
        rows: [
          {
            employee: "A",
            rateCode: "SCL",
            timeIn: "08:00",
            timeOut: "17:00",
            lunchStart: "",
            lunchEnd: "",
            lodging: false,
            signature: "sig",
          },
        ],
      } as never,
    };
    // 10/01 from the sheet: 1 × 9 h, not the ticket's 3 × 8; 10/02 from the ticket: 2 × 4.
    expect(combinedEffort(tickets, [sheet])).toEqual({ days: 2, crew: 2, personHours: 17 });
  });

  it("the strip reads it through the same function", () => {
    const panel = readFileSync("src/components/job-ledger-panel.tsx", "utf8");
    expect(panel).toContain("queryFn: () => loadLedgerEffort(supabase as never, jobId)");
  });

  it("the Invoices card no longer offers From ledger (removed 29 Oct)", () => {
    const panel = readFileSync("src/components/job-billing-panel.tsx", "utf8");
    expect(panel).not.toContain("From ledger");
    expect(panel).not.toContain("ledgerIntoInvoice");
  });
});
