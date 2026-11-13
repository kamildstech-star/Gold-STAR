// Consumable supplies — gloves, bags, tape, masks. A crew member on site should
// be able to ask for a box of gloves in a few taps; the office manager answers
// from a phone. Same request -> decision -> fulfilment shape as expenses.

import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { notifyUsers } from "@/lib/notifications.functions";
import { isMissingSchema } from "@/lib/schema-fallback";
import { SUPPLY_ITEM_SELECT } from "@/lib/cost-columns";
import { TONE } from "@/lib/tone";

/**
 * A catalogue row as the browser may read it: every column but unit_cost,
 * which is withheld (20261027150000) — read it through supply_item_costs().
 */
export type SupplyItem = Omit<Database["public"]["Tables"]["supply_items"]["Row"], "unit_cost">;
export type SupplyRequest = Database["public"]["Tables"]["supply_requests"]["Row"];
export type SupplyLine = Database["public"]["Tables"]["supply_request_lines"]["Row"];
export type SupplyStatus = Database["public"]["Enums"]["supply_request_status"];

export type SupplyRequestFull = SupplyRequest & {
  supply_request_lines: (SupplyLine & {
    supply_items: { name: string; unit: string; size?: string | null } | null;
  })[];
  jobs: { id: string; job_number: string; address: string } | null;
};

export const SUPPLY_STATUSES: SupplyStatus[] = [
  "requested",
  "approved",
  "ordered",
  "delivered",
  "denied",
];

export const SUPPLY_STATUS_LABEL: Record<SupplyStatus, string> = {
  requested: "Requested",
  approved: "Approved",
  ordered: "Ordered",
  delivered: "Delivered",
  denied: "Denied",
};

export const SUPPLY_STATUS_TONE: Record<SupplyStatus, string> = {
  requested: TONE.warning,
  approved: TONE.success,
  ordered: TONE.brand,
  delivered: TONE.neutral,
  denied: TONE.danger,
};

/**
 * Who an item is normally bought from.
 *
 * `default_supplier` arrives with 20260918090000. The generated types lag an
 * unapplied migration, so it is read through a narrow cast rather than by
 * widening `SupplyItem` and having every consumer believe in a column that may
 * not be there yet. No column, no supplier — the form simply says less.
 */
export function catalogueSupplier(item: SupplyItem): string | null {
  const v = (item as { default_supplier?: string | null }).default_supplier;
  return v?.trim() || null;
}

/**
 * The size, exactly as David's sheet types it — `2"x60 Yard`, `21x19x2`, `10QT`.
 *
 * Read through the same narrow cast as the supplier for the same reason: `size`
 * arrives with 20260918130000 and the generated types lag an unapplied
 * migration. Never parsed, only shown; the person ordering knows what
 * `21x19x2` means and the app does not need to.
 */
export function catalogueSize(item: SupplyItem): string | null {
  const v = (item as { size?: string | null }).size;
  return v?.trim() || null;
}

/**
 * The one line under an item's name in the order form.
 *
 * Both halves of what David's sheet says about a thing — its size and the pack
 * it comes in — because a request for "2 Pleated Filter Merv 8" is unanswerable
 * without them, and he has five of those.
 */
export function catalogueDetailLine(item: SupplyItem): string {
  const parts = [catalogueSize(item), `per ${item.unit}`].filter(Boolean) as string[];
  const supplier = catalogueSupplier(item);
  if (supplier) parts.push(`usually ${supplier}`);
  return parts.join(" · ");
}

/** What a status change does to the record beyond the status itself. */
function stampFor(status: SupplyStatus, denialReason?: string | null) {
  const now = new Date().toISOString();
  return {
    status,
    denial_reason: status === "denied" ? (denialReason ?? null) : null,
    decided_at: status === "approved" || status === "denied" ? now : null,
    ordered_at: status === "ordered" ? now : null,
    delivered_at: status === "delivered" ? now : null,
  };
}

/**
 * The size has to come back with the line, or an approver cannot tell David's
 * five "Pleated Filter Merv 8" rows apart on the queue screen.
 *
 * Stepped down rather than assumed: `supply_items.size` arrives with
 * 20260918130000 and migrations are applied by hand after merge, so there is a
 * window where the column is in this query and not in the database. PostgREST
 * fails the WHOLE read on an unknown column, which would take the supplies page
 * down entirely for one label. The first read that hits that falls back for the
 * rest of the session.
 */
const fullSelect = (withSize: boolean) =>
  `*, supply_request_lines(*, supply_items(name, unit${withSize ? ", size" : ""})), jobs(id, job_number, address)`;

let itemsHaveSize = true;

async function readRequests(
  run: (select: string) => PromiseLike<{ data: unknown; error: unknown }>,
): Promise<SupplyRequestFull[]> {
  const first = await run(fullSelect(itemsHaveSize));
  if (!first.error) return (first.data ?? []) as SupplyRequestFull[];
  if (!itemsHaveSize || !isMissingSchema(first.error)) throw first.error;
  itemsHaveSize = false;
  const second = await run(fullSelect(false));
  if (second.error) throw second.error;
  return (second.data ?? []) as SupplyRequestFull[];
}

/* Catalog ------------------------------------------------------------------ */

export async function listItems(opts: { includeInactive?: boolean } = {}): Promise<SupplyItem[]> {
  // Never select("*"): unit_cost is withheld and would fail the whole read.
  let q = supabase
    .from("supply_items")
    .select(SUPPLY_ITEM_SELECT)
    .order("sort_order")
    .order("name");
  if (!opts.includeInactive) q = q.eq("is_active", true);
  const { data, error } = await q;
  if (error) throw error;
  return data ?? [];
}

export async function saveItem(input: {
  id?: string;
  name: string;
  unit: string;
  category: string | null;
  /** Omit entirely on a database that has not had 20260918130000 yet. */
  size?: string | null;
  isActive?: boolean;
  sortOrder?: number;
}) {
  const row = {
    ...(input.id ? { id: input.id } : {}),
    name: input.name.trim(),
    unit: input.unit.trim() || "each",
    category: input.category?.trim() || null,
    // Only sent when the caller actually has a size to save. A column that may
    // not exist yet must not appear in every insert, or adding a plain item
    // would fail on a database still waiting for the migration.
    ...(input.size?.trim() ? { size: input.size.trim() } : {}),
    is_active: input.isActive ?? true,
    ...(input.sortOrder != null ? { sort_order: input.sortOrder } : {}),
  };
  const { error } = await supabase.from("supply_items").upsert(row as never);
  if (error) throw error;
}

/**
 * Set (or clear) the scan code on one item.
 *
 * `sku` is the column — it already existed, is already nullable, and already
 * carries UNIQUE (lower(sku)) WHERE sku IS NOT NULL from 20260918090000, so a
 * duplicate code across two items is refused by the DATABASE rather than merely
 * discouraged by a form. Nothing new was needed to make a bin label work.
 *
 * Empty clears it: an item whose label has been peeled off should stop
 * answering to that code rather than keep a stale one.
 */
export async function setItemCode(id: string, code: string | null) {
  const value = code?.trim() || null;
  const { error } = await supabase
    .from("supply_items")
    .update({ sku: value } as never)
    .eq("id", id);
  if (error) throw error;
}

export async function setItemActive(id: string, isActive: boolean) {
  const { error } = await supabase
    .from("supply_items")
    .update({ is_active: isActive })
    .eq("id", id);
  if (error) throw error;
}

/* Requests ----------------------------------------------------------------- */

export async function listMyRequests(userId: string): Promise<SupplyRequestFull[]> {
  return readRequests((select) =>
    supabase
      .from("supply_requests")
      .select(select)
      .eq("requester_id", userId)
      .order("created_at", { ascending: false })
      .limit(200),
  );
}

/** The manager queue. RLS already limits this to offices the user manages. */
export async function listQueue(opts: {
  statuses?: SupplyStatus[];
  locationId?: string | null;
}): Promise<SupplyRequestFull[]> {
  return readRequests((select) => {
    let q = supabase
      .from("supply_requests")
      .select(select)
      .order("created_at", { ascending: false })
      .limit(300);
    if (opts.statuses?.length) q = q.in("status", opts.statuses);
    if (opts.locationId) q = q.eq("location_id", opts.locationId);
    return q;
  });
}

/** Pending count for the sidebar badge — cheap head query, RLS-scoped. */
export async function pendingQueueCount(userId: string): Promise<number> {
  const { count, error } = await supabase
    .from("supply_requests")
    .select("id", { count: "exact", head: true })
    .eq("status", "requested")
    .neq("requester_id", userId);
  if (error) return 0;
  return count ?? 0;
}

export type DraftLine = {
  itemId: string | null;
  /** Free text when the item is not in the catalog. */
  otherLabel?: string | null;
  quantity: number;
  unit?: string | null;
};

export async function createRequest(input: {
  requesterId: string;
  locationId: string;
  jobId?: string | null;
  note?: string | null;
  neededBy?: string | null;
  /** Ship-to from the form (20260925133000). */
  deliveryAddress?: string | null;
  lines: DraftLine[];
}) {
  const lines = input.lines.filter(
    (l) => (l.itemId || (l.otherLabel ?? "").trim()) && l.quantity > 0,
  );
  if (lines.length === 0) throw new Error("Add at least one item.");

  const base = {
    requester_id: input.requesterId,
    location_id: input.locationId,
    job_id: input.jobId ?? null,
    note: input.note?.trim() || null,
    needed_by: input.neededBy || null,
  };
  const address = input.deliveryAddress?.trim() || null;
  let { data: req, error } = await supabase
    .from("supply_requests")
    .insert({ ...base, ...(address ? { delivery_address: address } : {}) } as never)
    .select("id")
    .single();
  /*
   * Before 20260925133000 is applied the column does not exist. The order
   * still goes in, and the address rides in the note so a typed ship-to is
   * never silently lost.
   */
  if (error && address && isMissingSchema(error)) {
    ({ data: req, error } = await supabase
      .from("supply_requests")
      .insert({ ...base, note: [base.note, `Deliver to: ${address}`].filter(Boolean).join("\n") })
      .select("id")
      .single());
  }
  if (error || !req) throw error ?? new Error("The request could not be saved.");

  const { error: lineErr } = await supabase.from("supply_request_lines").insert(
    lines.map((l) => ({
      request_id: req.id,
      item_id: l.itemId,
      other_label: l.itemId ? null : (l.otherLabel ?? "").trim(),
      quantity: l.quantity,
      unit: l.unit ?? null,
    })),
  );
  if (lineErr) throw lineErr;

  // Best effort: the request stands whether or not the ping lands.
  try {
    const { data: managers } = await supabase
      .from("location_members")
      .select("user_id")
      .eq("location_id", input.locationId)
      .eq("role", "manager");
    const userIds = (managers ?? []).map((m) => m.user_id).filter((id) => id !== input.requesterId);
    if (userIds.length > 0) {
      await notifyUsers({
        data: {
          userIds,
          type: "supply_request",
          title: "Supply request awaiting approval",
          body: `${lines.length} item${lines.length === 1 ? "" : "s"} requested.`,
          entityType: "supply_request",
          entityId: req.id,
          href: "/supplies",
        },
      });
    }
  } catch (err) {
    console.error("[supplies] manager notification failed", err);
  }

  return req.id;
}

/**
 * A manager adjusting what was asked for on one line. David, 22 Sep: "You
 * should also have a line item edit or adjust." Checked against what has
 * already arrived; written under the manager policy of 20260925130000, and
 * RLS that refuses says so rather than looking like a save.
 */
export async function adjustLineQuantity(input: {
  lineId: string;
  quantity: number;
  delivered: number;
}): Promise<void> {
  const { adjustedQuantityProblem } = await import("@/lib/supply-order-card");
  const problem = adjustedQuantityProblem(input.quantity, input.delivered);
  if (problem) throw new Error(problem);
  const { data, error } = await supabase
    .from("supply_request_lines")
    .update({ quantity: input.quantity })
    .eq("id", input.lineId)
    .select("id");
  if (error) throw error;
  if ((data ?? []).length === 0) {
    throw new Error("Only a manager of this order's office can adjust its lines.");
  }
}

export async function cancelRequest(id: string) {
  const { error } = await supabase.from("supply_requests").delete().eq("id", id);
  if (error) throw error;
}

/** Move a request along the line. The requester always hears about it. */
export async function setStatus(input: {
  request: SupplyRequest;
  status: SupplyStatus;
  denialReason?: string | null;
  deciderId: string;
}) {
  const patch = stampFor(input.status, input.denialReason);
  const { error } = await supabase
    .from("supply_requests")
    .update({
      ...patch,
      ...(input.status === "approved" || input.status === "denied"
        ? { decided_by: input.deciderId }
        : {}),
    })
    .eq("id", input.request.id);
  if (error) throw error;

  if (input.request.requester_id === input.deciderId) return;
  try {
    await notifyUsers({
      data: {
        userIds: [input.request.requester_id],
        type: "supply_status",
        title: `Supply request ${SUPPLY_STATUS_LABEL[input.status].toLowerCase()}`,
        body: input.status === "denied" ? (input.denialReason ?? "No reason given.") : null,
        entityType: "supply_request",
        entityId: input.request.id,
        href: "/supplies",
        priority: input.status === "denied" ? "high" : "normal",
      },
    });
  } catch (err) {
    console.error("[supplies] requester notification failed", err);
  }
}

/** One-line description of what was asked for. */
export function describeLines(r: SupplyRequestFull): string {
  return r.supply_request_lines
    .map((l) => {
      // The size rides along with the name: David lists five Pleated Filter
      // Merv 8 rows, so "2 12 case Pleated Filter Merv 8" is not an answerable
      // request without it.
      const size = l.supply_items?.size?.trim();
      const name = l.supply_items?.name ?? l.other_label ?? "Item";
      const unit = l.unit ?? l.supply_items?.unit ?? "";
      const qty = Number(l.quantity);
      return `${qty % 1 === 0 ? qty : qty.toFixed(2)} ${unit} ${name}${size ? ` (${size})` : ""}`
        .replace(/\s+/g, " ")
        .trim();
    })
    .join(" · ");
}

/**
 * Tell the requester their order arrived short.
 *
 * David: "potentially they should let me know somehow that there's still
 * something pending." Only on a PARTIAL delivery — a complete one is already
 * announced by the status change, and two notifications for one event is how
 * people learn to ignore them.
 *
 * Best effort, like every other notification here: the stock has already moved
 * and the delivery is recorded whether or not the ping lands.
 */
export async function notifyPartialDelivery(input: {
  request: SupplyRequest;
  summary: string;
  actorId: string;
}): Promise<void> {
  if (input.request.requester_id === input.actorId) return;
  try {
    await notifyUsers({
      data: {
        userIds: [input.request.requester_id],
        type: "supply_status",
        title: "Part of your supply order has arrived",
        body: input.summary,
        entityType: "supply_request",
        entityId: input.request.id,
        href: "/supplies",
      },
    });
  } catch (err) {
    console.error("[supplies] partial-delivery notification failed", err);
  }
}
