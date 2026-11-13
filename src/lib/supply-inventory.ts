/**
 * What is on the shelf, and what it cost to put there.
 *
 * Two halves of David's 16 Sep ask that the supplies module had no home for:
 * delivered items entering inventory and being drawn down again, and the
 * purchaser's record of price and supplier that replaces his spreadsheet.
 *
 * Stock is kept as a ledger with a running total beside it rather than as a
 * number somebody edits. A count that cannot be explained is a count nobody
 * trusts, and "why does it say nine" is the first question anyone asks of an
 * inventory. Every movement says what caused it.
 *
 * Tables arrive in 20260918090000. Everything here tolerates their absence, so
 * the supplies page keeps working on a database that has not had the migration.
 */

import { supabase } from "@/integrations/supabase/client";
import { isMissingSchema } from "@/lib/schema-fallback";
import type { SupplyRequestFull } from "@/lib/supplies";
import { roundMoney } from "@/lib/money";

/** Why the stock moved. Text, not an enum — see the migration. */
export type StockMoveReason = "delivery" | "manual_adjust" | "used_on_job" | "scan";

export const STOCK_REASON_LABEL: Record<StockMoveReason, string> = {
  delivery: "Delivered",
  manual_adjust: "Adjusted by hand",
  used_on_job: "Used on a job",
  scan: "Scanned out",
};

export type StockRow = {
  item_id: string;
  item_name: string;
  unit: string;
  on_hand: number;
};

export type StockMove = {
  id: string;
  item_id: string;
  item_name: string | null;
  qty: number;
  reason: string;
  note: string | null;
  job_id: string | null;
  created_at: string;
};

/** False when the inventory migration has not been applied here. */
export async function inventoryAvailable(): Promise<boolean> {
  const { error } = await supabase
    .from("supply_stock" as never)
    .select("id")
    .limit(1);
  return !(error && isMissingSchema(error));
}

export async function listStock(locationId: string): Promise<StockRow[] | null> {
  const { data, error } = await supabase
    .from("supply_stock" as never)
    .select("item_id, on_hand, supply_items(name, unit)")
    .eq("location_id", locationId)
    .order("on_hand", { ascending: false });
  if (error) {
    if (isMissingSchema(error)) return null;
    throw error;
  }
  return (
    (data ?? []) as unknown as {
      item_id: string;
      on_hand: number | null;
      supply_items: { name: string; unit: string } | null;
    }[]
  ).map((r) => ({
    item_id: r.item_id,
    item_name: r.supply_items?.name ?? "Unknown item",
    unit: r.supply_items?.unit ?? "each",
    on_hand: Number(r.on_hand ?? 0),
  }));
}

export async function listStockMoves(locationId: string, limit = 50): Promise<StockMove[]> {
  const { data, error } = await supabase
    .from("supply_stock_moves" as never)
    .select("id, item_id, qty, reason, note, job_id, created_at, supply_items(name)")
    .eq("location_id", locationId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) {
    if (isMissingSchema(error)) return [];
    throw error;
  }
  return (
    (data ?? []) as unknown as {
      id: string;
      item_id: string;
      qty: number;
      reason: string;
      note: string | null;
      job_id: string | null;
      created_at: string;
      supply_items: { name: string } | null;
    }[]
  ).map((r) => ({ ...r, qty: Number(r.qty), item_name: r.supply_items?.name ?? null }));
}

/**
 * Apply one movement and carry the running total with it.
 *
 * Two statements rather than a trigger, because the trigger would have to live
 * in a migration this build cannot apply. The ledger is written first: if the
 * second statement fails, the movement is still on record and a recount can
 * put the total right, which is the safer way round of the two.
 */
export async function moveStock(input: {
  locationId: string;
  itemId: string;
  qty: number;
  reason: StockMoveReason;
  requestId?: string | null;
  jobId?: string | null;
  note?: string | null;
  userId: string | null;
}): Promise<void> {
  if (!input.qty) return;

  const { error: moveErr } = await supabase.from("supply_stock_moves" as never).insert({
    location_id: input.locationId,
    item_id: input.itemId,
    qty: input.qty,
    reason: input.reason,
    request_id: input.requestId ?? null,
    job_id: input.jobId ?? null,
    note: input.note ?? null,
    created_by: input.userId,
  } as never);
  if (moveErr) {
    // A delivery already recorded for this request and item. The unique index
    // is what stops a second press of "Mark delivered" stocking the shelf
    // twice; hitting it means the work is already done, not that it failed.
    if ((moveErr as { code?: string }).code === "23505") return;
    throw moveErr;
  }

  const current = await supabase
    .from("supply_stock" as never)
    .select("id, on_hand")
    .eq("location_id", input.locationId)
    .eq("item_id", input.itemId)
    .maybeSingle();

  const existing = current.data as { id: string; on_hand: number | null } | null;
  if (existing) {
    const next = Number(existing.on_hand ?? 0) + input.qty;
    const { error } = await supabase
      .from("supply_stock" as never)
      .update({ on_hand: next, updated_at: new Date().toISOString() } as never)
      .eq("id", existing.id);
    if (error) throw error;
    return;
  }

  const { error } = await supabase.from("supply_stock" as never).insert({
    location_id: input.locationId,
    item_id: input.itemId,
    on_hand: input.qty,
  } as never);
  if (error) throw error;
}

/**
 * Put a delivered order's items on the shelf.
 *
 * Called when an order is marked delivered. Lines with no catalogue item — the
 * "Other" free text a request may carry — are skipped: there is nothing to
 * count them against, and inventing a catalogue row from a typed phrase would
 * fill the catalogue with one-offs.
 */
export async function stockDeliveredRequest(
  request: SupplyRequestFull,
  userId: string | null,
): Promise<{ stocked: number; skipped: number }> {
  let stocked = 0;
  let skipped = 0;
  for (const line of request.supply_request_lines ?? []) {
    if (!line.item_id) {
      skipped += 1;
      continue;
    }
    await moveStock({
      locationId: request.location_id,
      itemId: line.item_id,
      qty: Number(line.quantity ?? 0),
      reason: "delivery",
      requestId: request.id,
      userId,
    });
    stocked += 1;
  }
  return { stocked, skipped };
}

/**
 * Record what actually arrived, line by line.
 *
 * David, 17 Sep: "we should have a place where we can put in exactly what was
 * delivered — meaning if I ordered five rolls and they only delivered four
 * rolls, it's still gonna show as one is pending."
 *
 * Replaces `stockDeliveredRequest`'s all-or-nothing pass. Three things happen
 * per line and the order matters:
 *
 *   1. the DELTA moves to the shelf — the difference between what had already
 *      arrived and what the office just typed, so re-submitting the same
 *      numbers moves nothing and a correction downward takes stock back off;
 *   2. the line's running `delivered_quantity` is written;
 *   3. nothing touches the request's status. Whether the order is complete is
 *      `deliveryProgress`'s answer and the caller's decision.
 *
 * A line with no catalogue item — the free-text "Other" — is recorded but not
 * stocked: there is no shelf to count it against, which is the same rule the
 * old pass used.
 */
export async function recordDelivery(input: {
  request: SupplyRequestFull;
  entries: readonly { lineId: string; itemId: string | null; delivered: number; delta: number }[];
  userId: string | null;
}): Promise<{ stocked: number; skipped: number }> {
  let stocked = 0;
  let skipped = 0;

  for (const e of input.entries) {
    if (e.delta !== 0) {
      if (e.itemId) {
        await moveStock({
          locationId: input.request.location_id,
          itemId: e.itemId,
          qty: e.delta,
          reason: "delivery",
          requestId: input.request.id,
          userId: input.userId,
        });
        stocked += 1;
      } else {
        skipped += 1;
      }
    }

    const { error } = await supabase
      .from("supply_request_lines")
      .update({ delivered_quantity: e.delivered } as never)
      .eq("id", e.lineId);
    // The stock has already moved. A failure to write the running total must
    // not be retried by moving it again, so it is reported, not thrown.
    if (error && !isMissingSchema(error)) throw error;
  }

  return { stocked, skipped };
}

/* ------------------------------------------------------------------ */
/* Depletion                                                           */
/* ------------------------------------------------------------------ */

/**
 * Take stock off the shelf by hand.
 *
 * DEFAULT, and the client's open question: depletion is manual. Somebody says
 * "we used four of those" and the count goes down. Scanning was the
 * alternative and is not built — it needs hardware decisions and a label on
 * every box that does not exist yet.
 *
 * The seam for it is `StockMoveReason`, which already carries "scan", and this
 * function, which a scanner would call with the same arguments and a different
 * reason. Nothing else in the module would change.
 */
export async function depleteStock(input: {
  locationId: string;
  itemId: string;
  /** Positive. How many came off the shelf. */
  quantity: number;
  jobId?: string | null;
  note?: string | null;
  userId: string | null;
  reason?: Extract<StockMoveReason, "manual_adjust" | "used_on_job" | "scan">;
}): Promise<void> {
  const qty = Math.abs(Number(input.quantity) || 0);
  if (qty <= 0) return;
  await moveStock({
    locationId: input.locationId,
    itemId: input.itemId,
    qty: -qty,
    reason: input.reason ?? (input.jobId ? "used_on_job" : "manual_adjust"),
    jobId: input.jobId ?? null,
    note: input.note ?? null,
    userId: input.userId,
  });
}

/* ------------------------------------------------------------------ */
/* Purchases                                                           */
/* ------------------------------------------------------------------ */

export type SupplyPurchase = {
  id: string;
  item_id: string | null;
  item_label: string | null;
  item_name: string | null;
  supplier_name: string;
  quantity: number;
  unit_price: number;
  total_cost: number;
  purchased_on: string;
  note: string | null;
  /** Which office bought it (6 Nov: purchase history per location). */
  location_id?: string | null;
  location_name?: string | null;
};

export async function recordPurchase(input: {
  locationId: string;
  itemId: string | null;
  itemLabel?: string | null;
  supplierName: string;
  quantity: number;
  unitPrice: number;
  /** Defaults to quantity × unit price; passed when a line carries delivery. */
  totalCost?: number | null;
  purchasedOn: string;
  requestId?: string | null;
  note?: string | null;
  userId: string | null;
}): Promise<void> {
  const quantity = Number(input.quantity) || 0;
  const unitPrice = Number(input.unitPrice) || 0;
  const { error } = await supabase.from("supply_purchases" as never).insert({
    location_id: input.locationId,
    item_id: input.itemId,
    item_label: input.itemLabel ?? null,
    supplier_name: input.supplierName.trim(),
    quantity,
    unit_price: unitPrice,
    total_cost: input.totalCost ?? roundMoney(quantity * unitPrice),
    purchased_on: input.purchasedOn,
    request_id: input.requestId ?? null,
    note: input.note ?? null,
    created_by: input.userId,
  } as never);
  if (error) throw error;
}

export async function listPurchases(input: {
  locationId: string | null;
  from: string;
  to: string;
}): Promise<SupplyPurchase[]> {
  let q = supabase
    .from("supply_purchases" as never)
    .select(
      "id, item_id, item_label, supplier_name, quantity, unit_price, total_cost, purchased_on, note, location_id, supply_items(name), locations(name)",
    )
    .gte("purchased_on", input.from)
    .lte("purchased_on", input.to)
    .order("purchased_on", { ascending: false })
    .limit(2000);
  if (input.locationId) q = q.eq("location_id", input.locationId);
  const { data, error } = await q;
  if (error) {
    if (isMissingSchema(error)) return [];
    throw error;
  }
  return (
    (data ?? []) as unknown as (Omit<SupplyPurchase, "item_name" | "location_name"> & {
      supply_items: { name: string } | null;
      locations: { name: string } | null;
    })[]
  ).map(({ supply_items, locations, ...r }) => ({
    ...r,
    quantity: Number(r.quantity),
    unit_price: Number(r.unit_price),
    total_cost: Number(r.total_cost),
    item_name: supply_items?.name ?? null,
    location_name: locations?.name ?? null,
  }));
}
