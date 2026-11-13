/**
 * The supply vendor list, and who each item and each order line is bought from.
 *
 * David, 22 Sep: "Could I have here another vendor dropdown — I'll have five,
 * 10 vendors in here. We'll select which vendor we generally purchase it from
 * or preset. And then we could obviously always in each order select a
 * vendor."
 *
 * Three layers, each overriding the one before it:
 *   1. an ORDER LINE's own vendor (`supply_request_lines.vendor_id`), chosen
 *      at order time;
 *   2. the ITEM's preset (`supply_items.default_vendor_id`);
 *   3. the item's old free-text `default_supplier`, matched by name onto the
 *      list — what every item carried before there was a list. The migration
 *      (20260925130000) maps these for good; this layer only covers a database
 *      that has not had it yet, or a name typed since.
 * With none of them, the line has no vendor and says so.
 *
 * The table is `supply_vendors` (20260918150000), the directory the vendor
 * email drafts already fill in. There is no second vendor list.
 *
 * The new columns are read through narrow casts: the generated types lag a
 * migration that is applied by hand after merge, and a missing column must
 * make this say less, never take the supplies page down.
 */

import { supabase } from "@/integrations/supabase/client";
import { isMissingSchema } from "@/lib/schema-fallback";

export type SupplyVendor = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  note: string | null;
};

export type VendorDraft = {
  name: string;
  email: string;
  phone: string;
  note: string;
};

export const BLANK_VENDOR_DRAFT: VendorDraft = { name: "", email: "", phone: "", note: "" };

/** Case- and space-insensitive, the same key the table's unique index uses. */
export const vendorKey = (name: string | null | undefined) =>
  (name ?? "").trim().replace(/\s+/g, " ").toLowerCase();

const VENDOR_COLUMNS = "id, name, email, phone, note";

export async function listSupplyVendors(): Promise<SupplyVendor[]> {
  const { data, error } = await supabase
    .from("supply_vendors" as never)
    .select(VENDOR_COLUMNS)
    .order("name");
  if (error) {
    if (isMissingSchema(error)) return [];
    throw error;
  }
  return (data ?? []) as unknown as SupplyVendor[];
}

/** Trimmed, blank-as-null, and refused without a name. */
export function prepareVendor(
  draft: VendorDraft,
): { ok: true; row: Omit<SupplyVendor, "id"> } | { ok: false; error: string } {
  const name = draft.name.trim().replace(/\s+/g, " ");
  if (!name) return { ok: false, error: "Name the vendor." };
  const email = draft.email.trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, error: "That email address does not look right." };
  }
  return {
    ok: true,
    row: {
      name,
      email: email || null,
      phone: draft.phone.trim() || null,
      note: draft.note.trim() || null,
    },
  };
}

/** The friendly half of a collision on `lower(name)`, or null for any other error. */
export function duplicateVendorName(err: unknown, name: string): string | null {
  const code = (err as { code?: string } | null)?.code;
  return code === "23505" ? `There is already a vendor called ${name.trim()}.` : null;
}

export async function saveSupplyVendor(
  draft: VendorDraft,
  opts: { id?: string; userId?: string | null } = {},
): Promise<void> {
  const prepared = prepareVendor(draft);
  if (!prepared.ok) throw new Error(prepared.error);
  const row = { ...prepared.row, updated_at: new Date().toISOString() };
  const { error } = opts.id
    ? await supabase
        .from("supply_vendors" as never)
        .update(row as never)
        .eq("id", opts.id)
    : await supabase
        .from("supply_vendors" as never)
        .insert({ ...row, created_by: opts.userId ?? null } as never);
  if (error) throw error;
}

/**
 * Removing a vendor. Items and order lines that pointed at it fall back to no
 * vendor (ON DELETE SET NULL) — nothing else is lost, and past purchases keep
 * the supplier name they were recorded with.
 */
export async function deleteSupplyVendor(id: string): Promise<void> {
  const { error } = await supabase
    .from("supply_vendors" as never)
    .delete()
    .eq("id", id);
  if (error) throw error;
}

/**
 * Record an email against a vendor name, creating the vendor if it is new.
 *
 * This is what makes the list fill itself from vendor-order drafts. It used to
 * upsert `onConflict: "name"`, which Postgres refuses outright — the unique
 * index is on `lower(name)`, not on `name` — so the "remembered for next time"
 * never happened. Now it looks the name up and updates or inserts.
 */
export async function rememberVendor(
  name: string,
  fields: { email?: string | null },
  userId: string | null,
): Promise<void> {
  const clean = name.trim().replace(/\s+/g, " ");
  if (!clean) return;
  const vendors = await listSupplyVendors();
  const existing = vendors.find((v) => vendorKey(v.name) === vendorKey(clean));
  const email = fields.email?.trim() || null;
  if (existing) {
    if (!email || existing.email === email) return;
    const { error } = await supabase
      .from("supply_vendors" as never)
      .update({ email, updated_at: new Date().toISOString() } as never)
      .eq("id", existing.id);
    if (error && !isMissingSchema(error)) throw error;
    return;
  }
  const { error } = await supabase
    .from("supply_vendors" as never)
    .insert({ name: clean, email, created_by: userId } as never);
  if (error && !isMissingSchema(error) && (error as { code?: string }).code !== "23505") {
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* Items and lines                                                     */
/* ------------------------------------------------------------------ */

type WithPreset = { default_vendor_id?: string | null; default_supplier?: string | null };
type WithLineVendor = { vendor_id?: string | null };

/** The item's preset vendor id, if the column exists and is set. */
export function itemVendorId(item: object | null | undefined): string | null {
  return (item as WithPreset | null)?.default_vendor_id ?? null;
}

/** The line's own vendor id, if one was chosen for this order. */
export function lineVendorId(line: object | null | undefined): string | null {
  return (line as WithLineVendor | null)?.vendor_id ?? null;
}

export type VendorSource = "line" | "preset" | "text";

export type ResolvedVendor = { vendor: SupplyVendor; source: VendorSource } | null;

/** The item's usual vendor: its preset, else its old free text matched onto the list. */
export function presetVendor(
  item: object | null | undefined,
  vendors: readonly SupplyVendor[],
): ResolvedVendor {
  if (!item) return null;
  const id = itemVendorId(item);
  if (id) {
    const v = vendors.find((x) => x.id === id);
    if (v) return { vendor: v, source: "preset" };
  }
  const text = (item as WithPreset).default_supplier;
  if (text?.trim()) {
    const v = vendors.find((x) => vendorKey(x.name) === vendorKey(text));
    if (v) return { vendor: v, source: "text" };
  }
  return null;
}

/** Who this order line is bought from: its own choice, else the item's preset. */
export function resolveLineVendor(
  line: object,
  item: object | null | undefined,
  vendors: readonly SupplyVendor[],
): ResolvedVendor {
  const own = lineVendorId(line);
  if (own) {
    const v = vendors.find((x) => x.id === own);
    if (v) return { vendor: v, source: "line" };
  }
  return presetVendor(item, vendors);
}

/**
 * Set an item's preset. The free-text `default_supplier` is written alongside
 * as a mirror of the vendor's name, so everything that still reads the text
 * (the order form's "usually …" line, the running cost) says the same thing.
 */
export async function setItemVendor(itemId: string, vendor: SupplyVendor | null): Promise<void> {
  const { data, error } = await supabase
    .from("supply_items")
    .update({
      default_vendor_id: vendor?.id ?? null,
      default_supplier: vendor?.name ?? null,
    } as never)
    .eq("id", itemId)
    .select("id");
  if (error) throw error;
  // RLS refuses an update by matching no row, not by erroring. Say so.
  if ((data ?? []).length === 0) throw new Error("Only an admin can set an item's vendor.");
}

/** Choose this order line's vendor; `null` goes back to the item's preset. */
export async function setLineVendor(lineId: string, vendorId: string | null): Promise<void> {
  const { data, error } = await supabase
    .from("supply_request_lines")
    .update({ vendor_id: vendorId } as never)
    .eq("id", lineId)
    .select("id");
  if (error) throw error;
  if ((data ?? []).length === 0) {
    throw new Error("Only a manager of this order's office can change its vendor.");
  }
}
