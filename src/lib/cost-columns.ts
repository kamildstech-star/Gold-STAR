import { supabase } from "@/integrations/supabase/client";

/**
 * Internal cost on the supply catalogue and the equipment register, and who
 * may read it (TM8, 20261027150000_cost_columns_withheld.sql).
 *
 * Three columns are what something costs Gold Star, never what a customer is
 * charged:
 *
 *  - `supply_items.unit_cost` — what one unit of a consumable costs. The
 *    CHARGE for a supply is the matching estimate catalogue item's price
 *    (src/lib/supply-charges.ts), not this column.
 *  - `equipment.daily_rate_cents` — what a unit costs per day on a job. The
 *    running-cost engine multiplies it by days on site and 20260918131000
 *    seeds it as "THESE ARE COSTS — what GSR pays per day — NOT charge rates".
 *    Billing never reads it: the T&M bill and the invoice "Pull from job"
 *    price equipment from the T&M rate codes and the price lists.
 *  - `equipment.purchase_cost_cents` — what the unit cost to buy.
 *
 * Since that migration neither table has a table-level SELECT grant for
 * `authenticated`; every other column is granted one by one, as on
 * `estimate_catalog_items` and the document lines (src/lib/line-costs.ts).
 * So, for every reader in the browser:
 *
 *  - `select("*")`, or naming a cost column — including inside an embed such
 *    as `equipment:equipment_id(...)` — fails for EVERYONE with "permission
 *    denied for table …". Select `SUPPLY_ITEM_SELECT` / `EQUIPMENT_SELECT`
 *    or a subset of the public columns.
 *  - Cost is read through `supply_item_costs()` / `equipment_costs(_ids)`,
 *    SECURITY DEFINER functions that answer only for holders of
 *    `job.view_costs` (at the unit's office, for equipment) and return an
 *    empty set for anyone else, sellers included.
 *  - A unit whose cost the viewer cannot read carries `null`, never a
 *    fabricated 0: hidden and free are different facts.
 *
 * Writing cost is unchanged — the Cost rates screen still updates
 * `unit_cost` / `daily_rate_cents`, and the register still records a
 * purchase cost; the row policies decide who may write.
 *
 * Server code using the service-role client is not affected.
 */

/** Columns of `supply_items` every signed-in user may read (all but unit_cost). */
export const SUPPLY_ITEM_PUBLIC_COLUMNS = [
  "id",
  "name",
  "unit",
  "category",
  "is_active",
  "sort_order",
  "created_by",
  "created_at",
  "updated_at",
  "sku",
  "default_supplier",
  "size",
  "default_vendor_id",
] as const;

/** Columns of `equipment` every signed-in user who can see the unit may read. */
export const EQUIPMENT_PUBLIC_COLUMNS = [
  "id",
  "asset_tag",
  "equipment_type",
  "make",
  "model",
  "serial_number",
  "purchase_date",
  "location_id",
  "status",
  "external_tracker_id",
  "notes",
  "created_by",
  "created_at",
  "updated_at",
  "is_demo",
  "equipment_type_detail",
  "tracker_provider",
  "last_lat",
  "last_lon",
  "last_seen_at",
  "tracker_battery_pct",
  "tracker_heartbeat_status",
  "tracker_location_status",
  "tracker_location_name",
  "tracker_address",
  "tracker_synced_at",
  "created_via",
  "created_job_id",
] as const;

/** The withheld columns, by table. A test pins these against the migration. */
export const SUPPLY_ITEM_COST_COLUMNS = ["unit_cost"] as const;
export const EQUIPMENT_COST_COLUMNS = ["daily_rate_cents", "purchase_cost_cents"] as const;

/*
 * The same lists as PostgREST column strings. Literals (not a `join`) so
 * supabase-js can still infer the row type; a test pins each pair together.
 */
export const SUPPLY_ITEM_SELECT =
  "id, name, unit, category, is_active, sort_order, created_by, created_at, updated_at, sku, default_supplier, size, default_vendor_id";

export const EQUIPMENT_SELECT =
  "id, asset_tag, equipment_type, make, model, serial_number, purchase_date, location_id, status, external_tracker_id, notes, created_by, created_at, updated_at, is_demo, equipment_type_detail, tracker_provider, last_lat, last_lon, last_seen_at, tracker_battery_pct, tracker_heartbeat_status, tracker_location_status, tracker_location_name, tracker_address, tracker_synced_at, created_via, created_job_id";

/** One row of `equipment_costs()`. */
export interface EquipmentCostRow {
  id: string;
  daily_rate_cents: number | null;
  purchase_cost_cents: number | null;
}

/** One row of `supply_item_costs()`. */
export interface SupplyItemCostRow {
  id: string;
  unit_cost: number | null;
}

/**
 * Cost per equipment unit, by id; empty for viewers without `job.view_costs`
 * at the unit's office. `ids` omitted = every unit the viewer can see.
 */
export async function fetchEquipmentCosts(
  ids?: readonly string[] | null,
): Promise<Map<string, EquipmentCostRow>> {
  const out = new Map<string, EquipmentCostRow>();
  if (ids && ids.length === 0) return out;
  const { data, error } = await supabase.rpc(
    "equipment_costs" as never,
    { _ids: ids ? [...ids] : null } as never,
  );
  if (error) throw error;
  for (const r of (data ?? []) as EquipmentCostRow[]) {
    out.set(r.id, {
      id: r.id,
      daily_rate_cents: r.daily_rate_cents == null ? null : Number(r.daily_rate_cents),
      purchase_cost_cents: r.purchase_cost_cents == null ? null : Number(r.purchase_cost_cents),
    });
  }
  return out;
}

/** Unit cost per supply item, by id; empty for viewers without `job.view_costs`. */
export async function fetchSupplyItemCosts(): Promise<Map<string, number | null>> {
  const { data, error } = await supabase.rpc("supply_item_costs" as never);
  if (error) throw error;
  const out = new Map<string, number | null>();
  for (const r of (data ?? []) as SupplyItemCostRow[]) {
    out.set(r.id, r.unit_cost == null ? null : Number(r.unit_cost));
  }
  return out;
}

/**
 * Attach equipment costs to public rows. A unit without a cost row (no
 * privilege, not asked for) gets nulls rather than a fabricated zero.
 */
export function mergeEquipmentCosts<T extends { id: string }>(
  rows: readonly T[],
  costs: ReadonlyMap<string, EquipmentCostRow> | null | undefined,
): (T & { daily_rate_cents: number | null; purchase_cost_cents: number | null })[] {
  return rows.map((r) => {
    const c = costs?.get(r.id);
    return {
      ...r,
      daily_rate_cents: c?.daily_rate_cents ?? null,
      purchase_cost_cents: c?.purchase_cost_cents ?? null,
    };
  });
}
