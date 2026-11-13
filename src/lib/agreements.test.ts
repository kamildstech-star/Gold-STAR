import { describe, expect, it, vi } from "vitest";

const inserted = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[] }));
vi.mock("@/integrations/supabase/client", () => {
  const chain = (result: unknown) => {
    const c: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "order", "limit"]) c[m] = () => c;
    c.maybeSingle = async () => result;
    c.single = async () => result;
    return c;
  };
  return {
    supabase: {
      from: (table: string) =>
        table === "invoices"
          ? {
              insert: (row: Record<string, unknown>) => {
                inserted.rows.push(row);
                return chain({ data: { id: "inv-1", ...row }, error: null });
              },
            }
          : chain({ data: { name: "Lakewood" }, error: null }),
      rpc: async () => ({ data: null, error: null }),
    },
  };
});
vi.mock("@/lib/estimates", async (orig) => ({
  ...(await orig<typeof import("@/lib/estimates")>()),
  fetchDefaultTaxRate: async () => 0.06625,
}));

import {
  agreementDraftToChanges,
  groupByClient,
  keyRates,
  mostlyTm,
  overrideSummary,
  standardDraftToChanges,
  standardPrice,
  standardProblems,
  type Agreement,
} from "@/lib/agreements";
import { createInvoiceFromJob } from "@/lib/invoices";
import type { MoneyValueRow } from "@/lib/office-values";
import {
  buildPriceBook,
  chainToPricing,
  resolveCatalogPrice,
  resolvePrice,
  type PriceListAssignmentRow,
} from "@/lib/price-lists";

/*
 * Billing & Costs prompt 4. The chain itself (job → agreement → office →
 * state → company Standard → none) is proven to the cent in
 * supabase/tests/billing-costs-agreements.pglite.mjs; here, what the screen
 * and the pickers do with it.
 */
const ITEMS = [
  {
    id: "lab",
    code: "GSC-LABOR-REG",
    name: "Labor - regular",
    uom: "HR",
    active: true,
    sort_order: 10,
  },
  {
    id: "am",
    code: "GSC-EQ-AIR-MOVER",
    name: "Air mover",
    uom: "DAY",
    active: true,
    sort_order: 20,
  },
  {
    id: "mold",
    code: "GSC-MOLD-INSP",
    name: "Mold inspection",
    uom: "EA",
    active: true,
    sort_order: 30,
  },
];
const std = (
  code: string,
  office: string | null,
  from: string,
  value: number | null,
): MoneyValueRow => ({
  book: "client_agreements",
  item_key: code,
  measure: "unit_price",
  office_id: office,
  effective_from: from,
  value,
});
const STANDARD = [
  std("GSC-LABOR-REG", null, "2000-01-01", 65),
  std("GSC-LABOR-REG", "nj", "2026-01-01", 70),
  std("GSC-EQ-AIR-MOVER", null, "2000-01-01", 45),
  std("GSC-EQ-AIR-MOVER", null, "2026-11-01", 47),
];
const agreement = (over: Partial<Agreement> = {}): Agreement => ({
  id: "falcon",
  name: "Falcon",
  kind: "agreement",
  effectiveFrom: "2026-02-01",
  archived: false,
  fullCopy: false,
  lines: new Map([["GSC-LABOR-REG", 60]]),
  clients: [
    {
      assignmentId: "a1",
      accountId: "acc-falcon",
      accountName: "Falcon",
      effectiveFrom: "2026-02-01",
      effectiveTo: null,
      primary: true,
    },
  ],
  scopes: [],
  ...over,
});

describe("an agreement is exceptions over Standard", () => {
  it("says how many items it overrides, and shows the first few", () => {
    expect(overrideSummary(agreement(), ITEMS)).toBe(
      "1 item overridden · all others follow Standard",
    );
    expect(keyRates(agreement(), ITEMS)).toEqual([
      { code: "GSC-LABOR-REG", name: "Labor - regular", uom: "HR", price: 60 },
    ]);
  });

  it("an office's own Standard wins there; the company Standard moves on its date", () => {
    expect(standardPrice(STANDARD, "GSC-LABOR-REG", "nj", "2026-10-30")).toEqual({
      value: 70,
      source: "office",
    });
    expect(standardPrice(STANDARD, "GSC-LABOR-REG", "ny", "2026-10-30")).toEqual({
      value: 65,
      source: "default",
    });
    // An inherited line follows the company change on its day: 45.00 → 47.00.
    expect(standardPrice(STANDARD, "GSC-EQ-AIR-MOVER", "ny", "2026-10-31")?.value).toBe(45);
    expect(standardPrice(STANDARD, "GSC-EQ-AIR-MOVER", "ny", "2026-11-01")?.value).toBe(47);
  });

  it("groups by client, unlinked last, and flags a mostly-T&M client", () => {
    const groups = groupByClient(
      [agreement(), agreement({ id: "spare", name: "Spare sheet", clients: [] })],
      "2026-10-30",
    );
    expect(groups.map((g) => [g.client, g.agreements.map((a) => a.name)])).toEqual([
      ["Falcon", ["Falcon"]],
      ["Not linked to a client yet", ["Spare sheet"]],
    ]);
    expect(mostlyTm({ jobs: 10, tm_jobs: 7 })).toBe(true);
    expect(mostlyTm({ jobs: 10, tm_jobs: 5 })).toBe(false);
    expect(mostlyTm(undefined)).toBe(false);
  });
});

describe("the saves", () => {
  it("Standard: one change per item and scope; an office reset is null", () => {
    const d = {
      "GSC-LABOR-REG|default": { value: "66" },
      "GSC-LABOR-REG|nj": { reset: true as const },
    };
    expect(standardProblems(d).size).toBe(0);
    expect(standardDraftToChanges(d)).toEqual([
      { code: "GSC-LABOR-REG", office_id: null, value: 66 },
      { code: "GSC-LABOR-REG", office_id: "nj", value: null },
    ]);
    expect(standardProblems({ "X|default": { value: "" } }).get("X|default")).toMatch(
      /needs a price/,
    );
  });

  it("an agreement: lines (blank = back to Standard), links, ends, a rename", () => {
    expect(
      agreementDraftToChanges("falcon", {
        lines: { "GSC-MOLD-INSP": "300", "GSC-LABOR-REG": "" },
        link: [{ accountId: "acc-acme", primary: true }],
        unlink: ["a1"],
        rename: "Falcon 2026",
      }),
    ).toEqual([
      { op: "rename", agreement_id: "falcon", name: "Falcon 2026" },
      { op: "line", agreement_id: "falcon", code: "GSC-LABOR-REG", value: null },
      { op: "line", agreement_id: "falcon", code: "GSC-MOLD-INSP", value: 300 },
      { op: "link", agreement_id: "falcon", account_id: "acc-acme", primary: true },
      { op: "unlink", assignment_id: "a1" },
    ]);
  });
});

describe("the pickers read the chain", () => {
  it("an item nothing prices goes in at $0 and says 'none'", () => {
    const { book, labels } = chainToPricing(
      [
        { catalog_item_id: "lab", unit_price: "60", source: "account", price_list_id: "falcon" },
        { catalog_item_id: "am", unit_price: 45, source: "default", price_list_id: null },
        { catalog_item_id: "mold", unit_price: null, source: "none", price_list_id: null },
      ],
      new Map([["falcon", "Falcon"]]),
    );
    expect(labels).toEqual(["Falcon"]);
    expect(resolvePrice("lab", 65, book)).toMatchObject({ unit_price: 60, source: "account" });
    expect(resolvePrice("mold", 350, book)).toMatchObject({ unit_price: 0, source: "none" });
  });

  it("estimate pricing parity: the chain prices a sample exactly as the old lists did", () => {
    // Old world: Falcon's list (labor 60) over the catalog defaults.
    const assignments: PriceListAssignmentRow[] = [
      {
        id: "a1",
        price_list_id: "falcon",
        account_id: "acc-falcon",
        location_id: null,
        state_code: null,
        effective_from: "2026-02-01",
        effective_to: null,
        created_at: "2026-02-01T00:00:00Z",
      },
    ];
    const old = buildPriceBook(
      assignments,
      [{ id: "i1", price_list_id: "falcon", catalog_item_id: "lab", unit_price: 60 }],
      { accountId: "acc-falcon", locationId: "ny", stateCode: null, onDate: "2026-10-30" },
    );
    // The chain for the same document (what regular_price_book returns).
    const { book } = chainToPricing(
      [
        { catalog_item_id: "lab", unit_price: 60, source: "account", price_list_id: "falcon" },
        { catalog_item_id: "am", unit_price: 45, source: "default", price_list_id: null },
        { catalog_item_id: "mold", unit_price: 350, source: "default", price_list_id: null },
      ],
      new Map(),
    );
    const catalog = [
      { id: "lab", default_unit_price: 65 },
      { id: "am", default_unit_price: 45 },
      { id: "mold", default_unit_price: 350 },
    ];
    // 3 lines: 8 h labor, 4 air-mover days, 1 inspection = 480 + 180 + 350 = 1,010.00
    const qty = { lab: 8, am: 4, mold: 1 } as Record<string, number>;
    const total = (b: typeof book) =>
      catalog.reduce((s, c) => s + qty[c.id]! * resolveCatalogPrice(c, b).unit_price, 0);
    expect(total(old)).toBe(1010);
    expect(total(book)).toBe(1010);
  });
});

describe("simple-mode invoice", () => {
  it("is a description, an amount and a due date — no lines, no tax switch", async () => {
    await createInvoiceFromJob(
      { id: "job-1", location_id: "nj", account_id: "acc-falcon" } as never,
      "user-1",
      {
        quick: true,
        billedAmount: 1250.5,
        dueDate: "2026-11-30",
        title: "Water mitigation, 3 days",
      },
    );
    expect(inserted.rows[0]).toMatchObject({
      job_id: "job-1",
      line_itemized: false,
      billed_amount: 1250.5,
      due_date: "2026-11-30",
      title: "Water mitigation, 3 days",
    });
  });
});
