/**
 * Write-ups (FE11, 28 Oct): completed work logged room by room.
 *
 * A field inspector adds line items — room, what was done, quantity and unit
 * — under a visit date. The lines live in `job_write_up_items` (migration
 * 20261028120000) and feed the job's Scope of work card, under each room.
 *
 * The table is new, so every read tolerates it being absent: the panel says
 * the database update is pending instead of failing the Rooms tab.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { supabase } from "@/integrations/supabase/client";
import { isMissingSchema } from "@/lib/schema-fallback";

const db = () => supabase as unknown as SupabaseClient;

export type WriteUpItem = {
  id: string;
  job_id: string;
  room_id: string | null;
  visit_date: string;
  description: string;
  quantity: number | null;
  unit: string | null;
  sort_order: number;
  created_by: string | null;
  created_at: string;
};

export type WriteUpList = { items: WriteUpItem[]; available: boolean };

const COLUMNS =
  "id, job_id, room_id, visit_date, description, quantity, unit, sort_order, created_by, created_at";

/**
 * Quick picks for the Work done line (6 Nov, David: the write-up should mimic
 * the paper sheet — "choose the materials, drywall, and then flood cuts or
 * full wall demo"). Two groups: what was done, and to what. A tap appends
 * the words to the line; the crew still types the rest (heights, sides).
 * The exact lists follow David's Write-up sheet once it is on hand; these
 * are the ones named on the call plus the cuts the sketch tool already knows.
 */
export const WRITE_UP_QUICK_PICKS: readonly { label: string; options: readonly string[] }[] = [
  {
    label: "Done",
    options: ["Flood cut", "Full wall demo", "Ceiling removal", "Removed", "Cleaned", "Extracted"],
  },
  {
    label: "Material",
    options: [
      "Drywall",
      "Insulation",
      "Baseboard",
      "Carpet & pad",
      "Flooring",
      "Cabinets",
      "Ceiling",
    ],
  },
];

/** "Flood cut" onto "" → "Flood cut"; "Drywall" onto "Flood cut" → "Flood cut drywall". */
export function appendWriteUpPick(line: string, pick: string): string {
  const base = line.trim();
  if (!base) return pick;
  if (base.toLowerCase().includes(pick.toLowerCase())) return base;
  return `${base} ${pick.charAt(0).toLowerCase()}${pick.slice(1)}`;
}

/** Units offered first on a phone; anything else can be typed. */
export const WRITE_UP_UNITS = ["SF", "LF", "EA", "HR", "SY", "CF"] as const;

export async function fetchWriteUps(jobId: string): Promise<WriteUpList> {
  const { data, error } = await db()
    .from("job_write_up_items")
    .select(COLUMNS)
    .eq("job_id", jobId)
    .order("visit_date", { ascending: false })
    .order("sort_order")
    .order("created_at");
  if (error) {
    if (isMissingSchema(error)) return { items: [], available: false };
    throw error;
  }
  return {
    items: ((data ?? []) as WriteUpItem[]).map((r) => ({
      ...r,
      quantity: r.quantity == null ? null : Number(r.quantity),
    })),
    available: true,
  };
}

export type NewWriteUp = {
  jobId: string;
  roomId: string | null;
  visitDate: string;
  description: string;
  quantity: number | null;
  unit: string | null;
  userId: string | null;
};

/** A line as typed, cleaned; null when there is nothing to save. */
export function cleanWriteUp(input: NewWriteUp): NewWriteUp | null {
  const description = input.description.trim();
  if (!description || !/^\d{4}-\d{2}-\d{2}$/.test(input.visitDate)) return null;
  const q = input.quantity;
  return {
    ...input,
    description,
    quantity: q != null && Number.isFinite(q) && q >= 0 ? Math.round(q * 100) / 100 : null,
    unit: input.unit?.trim() || null,
  };
}

export async function addWriteUp(input: NewWriteUp): Promise<void> {
  const line = cleanWriteUp(input);
  if (!line) throw new Error("A write-up line needs a date and a description.");
  const { error } = await db().from("job_write_up_items").insert({
    job_id: line.jobId,
    room_id: line.roomId,
    visit_date: line.visitDate,
    description: line.description,
    quantity: line.quantity,
    unit: line.unit,
    created_by: line.userId,
  });
  if (error) throw error;
}

export async function deleteWriteUp(id: string): Promise<void> {
  const { error } = await db().from("job_write_up_items").delete().eq("id", id);
  if (error) throw error;
}

/** "120 SF", "3 EA", "" — how a line's amount reads. */
export function writeUpAmount(i: Pick<WriteUpItem, "quantity" | "unit">): string {
  if (i.quantity == null) return i.unit ?? "";
  const n = Number.isInteger(i.quantity) ? String(i.quantity) : i.quantity.toFixed(2);
  return i.unit ? `${n} ${i.unit}` : n;
}

export type WriteUpRoomGroup = { roomId: string | null; items: WriteUpItem[] };

/**
 * One visit's lines, by room, in the job's room order; lines with no room
 * (or a room since deleted) come last under "General".
 */
export function writeUpsByRoom(
  items: readonly WriteUpItem[],
  roomOrder: readonly string[],
): WriteUpRoomGroup[] {
  const known = new Set(roomOrder);
  const by = new Map<string | null, WriteUpItem[]>();
  for (const i of items) {
    const key = i.room_id && known.has(i.room_id) ? i.room_id : null;
    by.set(key, [...(by.get(key) ?? []), i]);
  }
  const out: WriteUpRoomGroup[] = [];
  for (const id of roomOrder) if (by.has(id)) out.push({ roomId: id, items: by.get(id)! });
  if (by.has(null)) out.push({ roomId: null, items: by.get(null)! });
  return out;
}

/** The visit dates that have lines, newest first. */
export function writeUpDates(items: readonly WriteUpItem[]): string[] {
  return [...new Set(items.map((i) => i.visit_date))].sort((a, b) => b.localeCompare(a));
}
