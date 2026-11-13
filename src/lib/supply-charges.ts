/**
 * What a supply is CHARGED to the customer (David, 23 Oct): "material and
 * supplies… we'll put in cost and the charges", in Settings › Cost rates, and
 * the job ledger reads it.
 *
 * No new table. The "From ledger" invoice already prices a supply from the
 * estimate catalogue item that matches it — same code (the supply's SKU)
 * first, else the same name (catalogItemForSupply) — through the customer's
 * and the office's price lists. So the charge set here IS that item's default
 * price: the invoice, the ledger's Supplies Charge and this screen read one
 * number. A supply with no matching item gets one made, carrying its code.
 */
import { supabase } from "@/integrations/supabase/client";
import { catalogItemForSupply } from "@/lib/invoice-ledger-pull";

type CatalogItem = {
  id: string;
  code: string;
  name: string;
  uom: string;
  default_unit_price: number;
};
type Supply = { id: string; name: string; sku: string | null; unit: string | null };

export type SupplyCharge = { price: number | null; catalogItemId: string | null };

async function readCatalog(): Promise<CatalogItem[]> {
  const { data, error } = await supabase
    .from("estimate_catalog_items")
    .select("id, code, name, uom, default_unit_price")
    .eq("is_active", true);
  if (error) throw error;
  return (data ?? []).map((c) => ({ ...c, default_unit_price: Number(c.default_unit_price) || 0 }));
}

async function readSupplies(): Promise<Supply[]> {
  const { data, error } = await supabase
    .from("supply_items")
    .select("id, name, sku, unit")
    .eq("is_active", true);
  if (error) throw error;
  return (data ?? []) as Supply[];
}

/** Each active supply's charge (by supply id), as the invoice would find it. */
export async function loadSupplyCharges(): Promise<Map<string, SupplyCharge>> {
  const [catalog, supplies] = await Promise.all([readCatalog(), readSupplies()]);
  return chargesFor(supplies, catalog);
}

/** Pure: supplies + catalogue → each supply's charge. */
export function chargesFor(
  supplies: readonly Supply[],
  catalog: readonly CatalogItem[],
): Map<string, SupplyCharge> {
  const out = new Map<string, SupplyCharge>();
  for (const s of supplies) {
    const item = catalogItemForSupply({ name: s.name, sku: s.sku }, catalog);
    out.set(
      s.id,
      item
        ? { price: item.default_unit_price, catalogItemId: item.id }
        : { price: null, catalogItemId: null },
    );
  }
  return out;
}

/** The code a new catalogue item for this supply is given: its SKU, else a stable one from its id. */
export function supplyChargeCode(s: Pick<Supply, "id" | "sku">): string {
  return s.sku?.trim() || `SUP-${s.id.replace(/-/g, "").slice(0, 10).toUpperCase()}`;
}

/** Set what one supply is charged. Makes its catalogue item the first time. */
export async function setSupplyCharge(supplyId: string, price: number): Promise<void> {
  if (!Number.isFinite(price) || price < 0) throw new Error("Enter a charge of $0 or more.");
  const [catalog, supplies] = await Promise.all([readCatalog(), readSupplies()]);
  const supply = supplies.find((s) => s.id === supplyId);
  if (!supply) throw new Error("That supply is no longer in the catalog.");
  const item = catalogItemForSupply({ name: supply.name, sku: supply.sku }, catalog);
  if (item) {
    const { error } = await supabase
      .from("estimate_catalog_items")
      .update({ default_unit_price: price })
      .eq("id", item.id);
    if (error) throw error;
    return;
  }
  const { error } = await supabase.from("estimate_catalog_items").insert({
    code: supplyChargeCode(supply),
    name: supply.name,
    uom: supply.unit?.trim().toUpperCase().slice(0, 8) || "EA",
    default_unit_price: price,
    taxable: true,
  });
  if (error) throw error;
}
