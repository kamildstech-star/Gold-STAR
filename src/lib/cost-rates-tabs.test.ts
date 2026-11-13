import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { jobLedgerRows, suppliesChargeRow, type LedgerInput } from "@/lib/job-ledger";
import { suppliesAtCharge } from "@/lib/job-ledger-report";
import { catalogItemForSupply } from "@/lib/invoice-ledger-pull";
import { SETTINGS_PAGE_BY_PATH, SETTINGS_SECTION_LAYOUT } from "@/lib/admin-settings";
import { chargesFor, supplyChargeCode } from "@/lib/supply-charges";

/*
 * David, 23 Oct (voice note): "just cost rates over here on the side… when you
 * click on that, three different things": Labor (our cost and what we charge
 * the client), Materials & supplies (cost and charges), Equipment (as it is).
 * "The job ledger's gonna communicate with this section." The equipment
 * catalog "could be under the equipment area".
 */
const read = (f: string) => readFileSync(f, "utf8");

describe("Cost rates, retired into Billing & Costs (prompt 3)", () => {
  const supplies = read("src/components/billing-costs/supply-book.tsx");

  it("redirects every old address, and nothing it did is lost", () => {
    expect(read("src/routes/_authenticated/admin.equipment-rates.tsx")).toMatch(
      /throw redirect\(\{\s*to: "\/admin\/billing-costs"/,
    );
    expect(read("src/routes/_authenticated/admin.labour-rates.tsx")).toMatch(/tab: "cost"/);
    // Prompt 4: the office labor charge is a Standard rate (GSC-LABOR-REG per
    // office) and a client's own rate an agreement — Client Agreements.
    expect(read("src/components/billing-costs/billing-costs-page.tsx")).toMatch(
      /<ClientAgreementsTab \/>/,
    );
  });

  it("the Supplies book shows each supply's cost AND its charge", () => {
    expect(supplies).toMatch(/Unit cost \(\$\)/);
    expect(supplies).toMatch(/Charge \(\$\)/);
    expect(supplies).toMatch(/await setSupplyCharge\(s\.id, next\)/);
  });

  it("a unit's own day rate stays on its page in Equipment", () => {
    expect(read("src/routes/_authenticated/equipment.$equipmentId.tsx")).toMatch(
      /await setEquipmentRate\(unit\.id,/,
    );
  });

  it("is folded into Billing & Costs in the menu, and Labor rates is not listed", () => {
    expect(SETTINGS_PAGE_BY_PATH.get("/admin/equipment-rates")?.foldedInto).toBe(
      "/admin/billing-costs",
    );
    expect(SETTINGS_SECTION_LAYOUT.operations).not.toContain("/admin/labour-rates");
    expect(SETTINGS_SECTION_LAYOUT.operations).toContain("/admin/billing-costs");
  });
});

describe("a supply's charge", () => {
  const catalog = [
    { id: "c1", code: "GLV-01", name: "Nitrile gloves (box)", uom: "BX", default_unit_price: 24 },
    { id: "c2", code: "OTHER", name: "Antimicrobial (gal)", uom: "GAL", default_unit_price: 55 },
  ];

  it("is the catalog price of the item it matches — code first, then name", () => {
    const charges = chargesFor(
      [
        { id: "s1", name: "Gloves", sku: "glv-01", unit: "box" },
        { id: "s2", name: "Antimicrobial (gal)", sku: null, unit: "gal" },
        { id: "s3", name: "Tape", sku: null, unit: "roll" },
      ],
      catalog,
    );
    expect(charges.get("s1")).toEqual({ price: 24, catalogItemId: "c1" });
    expect(charges.get("s2")).toEqual({ price: 55, catalogItemId: "c2" });
    expect(charges.get("s3")).toEqual({ price: null, catalogItemId: null });
  });

  it("makes a new catalog item under the supply's own code, else a stable one", () => {
    expect(supplyChargeCode({ id: "x", sku: " TAPE-2 " })).toBe("TAPE-2");
    expect(supplyChargeCode({ id: "0d3f9a12-aaaa-bbbb", sku: null })).toBe("SUP-0D3F9A12AA");
  });

  it("prices a job's supplies, and counts the ones with no charge", () => {
    const r = suppliesAtCharge(
      [
        { name: "Gloves", sku: "GLV-01", quantity: 2 },
        { name: "Tape", sku: null, quantity: 3 },
        { name: "Unused", sku: null, quantity: 0 },
      ],
      catalog,
      catalogItemForSupply,
    );
    expect(r).toMatchObject({ amount: 48, unpriced: 1 });
    expect(suppliesAtCharge([], catalog, catalogItemForSupply)).toBeNull();
  });
});

describe("the job ledger's Supplies Charge", () => {
  const input = (charge: LedgerInput["suppliesCharge"]): LedgerInput =>
    ({
      cost: {
        total_cost: 500,
        revenue: 2000,
        materials_cost: 300,
        stock_used_cost: 0,
        commission_cost: 0,
      },
      effort: null,
      billed: null,
      paid: null,
      referral: null,
      commission: null,
      suppliesCharge: charge,
    }) as unknown as LedgerInput;

  it("sits after Supplies (the cost) and shows what they bill at", () => {
    const rows = jobLedgerRows(input({ amount: 480, unpriced: 0, source: "x" }));
    const keys = rows.map((r) => r.key);
    expect(keys.indexOf("supplies_charge")).toBe(keys.indexOf("supplies") + 1);
    expect(rows.find((r) => r.key === "supplies_charge")).toMatchObject({
      label: "Supplies Charge",
      value: 480,
      tracked: true,
    });
  });

  it("does not move Total Expenses or Profit", () => {
    const a = jobLedgerRows(input({ amount: 480, unpriced: 0, source: "x" }));
    const b = jobLedgerRows(input(null));
    for (const k of ["total_expenses", "profit"])
      expect(a.find((r) => r.key === k)!.value).toBe(b.find((r) => r.key === k)!.value);
  });

  it("says when supplies have no charge set", () => {
    expect(suppliesChargeRow({ amount: 10, unpriced: 2, source: "x" }).note).toMatch(
      /2 supplies have no charge set/,
    );
    expect(suppliesChargeRow(null)).toMatchObject({ value: null, tracked: false });
  });

  it("is priced on the job page exactly as the From ledger invoice prices it", () => {
    const panel = read("src/components/job-ledger-panel.tsx");
    expect(panel).toMatch(/ledgerCharges\(supabase as never, data as never\)/);
    expect(read("src/lib/invoice-ledger-pull.ts")).toMatch(
      /export async function ledgerCharges\([\s\S]*loadLedgerInvoicePlan\(client,/,
    );
  });
});
