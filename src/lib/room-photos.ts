/**
 * Rooms and pictures, both ways (David, 27 Oct).
 *
 * A room's photos are the photos in its album folder (`photo_folders.room_id`,
 * made for every room by the Rooms tab). The Pictures tab already labels each
 * photo with its room; this is the other direction — a room shows its photos —
 * and the room + photo context the scope suggestion is written from.
 */
import { supabase } from "@/integrations/supabase/client";
import { scopeLines } from "@/lib/scope-of-work";

export type RoomPhotoThumb = {
  id: string;
  bucket: string;
  /** The thumb variant when one exists, else the original. */
  path: string;
  takenAt: string;
};

/** The newest few photos filed in one room's folder. */
export async function listRoomPhotoThumbs(folderId: string, limit = 6): Promise<RoomPhotoThumb[]> {
  const { data, error } = await supabase
    .from("photos")
    .select("id,storage_bucket,storage_path_original,captured_at,created_at")
    .eq("folder_id", folderId)
    .is("deleted_at", null)
    .order("captured_at", { ascending: false, nullsFirst: false })
    .limit(limit);
  if (error) throw error;
  const rows = data ?? [];
  if (!rows.length) return [];
  const { data: variants } = await supabase
    .from("photo_variants")
    .select("photo_id,variant,storage_path")
    .in(
      "photo_id",
      rows.map((r) => r.id),
    )
    .eq("variant", "thumb");
  const thumb = new Map((variants ?? []).map((v) => [v.photo_id, v.storage_path]));
  return rows.map((r) => ({
    id: r.id,
    bucket: r.storage_bucket,
    path: thumb.get(r.id) ?? r.storage_path_original,
    takenAt: r.captured_at ?? r.created_at,
  }));
}

/** What the scope writer is told about one room. Only recorded facts. */
export type RoomScopeContext = {
  room: string;
  floor: string | null;
  dimensions_ft: string | null;
  flooring: string | null;
  affected_materials: string[];
  existing_scope: string[];
  photos: { caption: string | null; tags: string[] }[];
  water_category: number | null;
  water_class: number | null;
};

export function roomScopeContext(input: {
  room: {
    name: string;
    unit?: string | null;
    floor: string | null;
    length_ft: number | null;
    width_ft: number | null;
    height_ft: number | null;
    flooring?: string | null;
    affected_materials: string[] | null;
    notes: string | null;
  };
  photos: { caption: string | null; tags: string[] }[];
  waterCategory?: number | null;
  waterClass?: number | null;
}): RoomScopeContext {
  const r = input.room;
  const dims = [r.length_ft, r.width_ft, r.height_ft];
  return {
    room: r.unit ? `Unit ${r.unit} · ${r.name}` : r.name,
    floor: r.floor ?? null,
    dimensions_ft: dims.every((d) => d == null)
      ? null
      : dims.map((d) => (d == null ? "?" : String(d))).join(" × "),
    flooring: r.flooring ?? null,
    affected_materials: r.affected_materials ?? [],
    existing_scope: scopeLines(r.notes),
    // Captions and tags carry what is in the picture; a photo with neither
    // still says the room was photographed.
    photos: input.photos.slice(0, 40).map((p) => ({
      caption: p.caption?.trim() || null,
      tags: p.tags,
    })),
    water_category: input.waterCategory ?? null,
    water_class: input.waterClass ?? null,
  };
}

export const ROOM_SCOPE_SYSTEM = [
  "You write the scope of work for ONE room of a water / fire / mold restoration job.",
  "Use only the room data and photo captions/tags given. Never invent damage that is not described.",
  'Return JSON: {"lines": ["..."]} — short imperative work items, one per line, e.g. ' +
    '"Flood cut drywall 2 ft", "Remove baseboards", "Set 1 dehumidifier and 3 air movers".',
  "Do not repeat anything already in existing_scope. At most 10 lines. No prices.",
].join("\n");

/** The model's reply as new scope lines: trimmed, de-bulleted, not already on the room. */
export function parseScopeSuggestions(reply: string, existing: readonly string[]): string[] {
  let raw: unknown;
  try {
    raw = JSON.parse(reply);
  } catch {
    const m = reply.match(/\{[\s\S]*\}/);
    try {
      raw = m ? JSON.parse(m[0]) : null;
    } catch {
      raw = null;
    }
  }
  const lines = Array.isArray((raw as { lines?: unknown })?.lines)
    ? ((raw as { lines: unknown[] }).lines.filter((l) => typeof l === "string") as string[])
    : [];
  const have = new Set(existing.map((l) => l.toLowerCase()));
  const out: string[] = [];
  for (const l of scopeLines(lines.join("\n"))) {
    const key = l.toLowerCase();
    if (have.has(key)) continue;
    have.add(key);
    out.push(l.slice(0, 160));
    if (out.length >= 10) break;
  }
  return out;
}
