import { supabase } from "@/integrations/supabase/client";
import { isMissingSchema } from "@/lib/schema-fallback";

/**
 * Restoration is organised room by room: scope per room, moisture readings per
 * room, equipment placed per room, photos per room. The room list is the spine
 * the rest of the mitigation record hangs off.
 *
 * In a multi-unit building — an apartment block, a nursing home, a managed
 * property — the room name alone does not identify anything. "Bedroom" is
 * meaningless when there are forty of them, so a room also carries the unit it
 * is in and every label the app prints leads with it.
 */

export interface JobRoom {
  id: string;
  job_id: string;
  /**
   * Which unit of the building this room is in — "4B", "Apt 2", "101".
   * Null on a single-family house and on every room recorded before units
   * existed, which is why nothing may depend on it being set.
   */
  unit: string | null;
  name: string;
  floor: string | null;
  length_ft: number | null;
  width_ft: number | null;
  height_ft: number | null;
  affected_materials: string[];
  notes: string | null;
  sort_order: number;
  /**
   * Floor covering as recorded on site. Null when not recorded, and on every
   * room read before migration 20261006140000 is applied.
   */
  flooring: string | null;
  /**
   * SF added to or taken off length × width for L-shapes and bump-outs.
   * 0 when there is none, and before the migration.
   */
  extra_sf: number;
}

export const AFFECTED_MATERIALS = [
  "Drywall",
  "Ceiling",
  "Carpet",
  "Pad",
  "Hardwood",
  "Tile",
  "Vinyl",
  "Baseboard",
  "Insulation",
  "Cabinetry",
  "Contents",
  "Subfloor",
];

const BASE_COLUMNS =
  "id, job_id, name, floor, length_ft, width_ft, height_ft, affected_materials, notes, sort_order";
const SELECT = `${BASE_COLUMNS}, unit`;
/** Field capture's room columns (migration 20261006140000). */
const CAPTURE_SELECT = `${SELECT}, flooring, extra_sf`;

/* ------------------------------------------------------------------ */
/* Labels                                                              */
/* ------------------------------------------------------------------ */

/**
 * Designators people already write out in full. "Unit Unit 4B" reads as a bug,
 * so a unit that already says what it is is left exactly as typed.
 */
const ALREADY_DESIGNATED = /^(unit|apt|apartment|suite|ste|rm|room|bldg|building|lot|space)\b/i;

/** "4B" -> "Unit 4B"; "Apt 2" and "#12" are left as written. Null stays null. */
export function unitLabel(unit: string | null | undefined): string | null {
  const text = (unit ?? "").trim();
  if (!text) return null;
  if (text.startsWith("#") || ALREADY_DESIGNATED.test(text)) return text;
  return `Unit ${text}`;
}

/**
 * The one room label the app prints — "Unit 4B · Bedroom", or just "Bedroom"
 * on a house. Every list, picker, chart series and folder name goes through
 * here: a room called "Bedroom" on one screen and "Unit 4B · Bedroom" on the
 * next is worse than either, because it reads as two different rooms.
 */
export function roomLabel(r: Pick<JobRoom, "unit" | "name">): string {
  const name = (r.name ?? "").trim() || "Unnamed room";
  const unit = unitLabel(r.unit);
  return unit ? `${unit} · ${name}` : name;
}

/**
 * Where a room's photo folder lives: `["Unit 4B", "Bedroom"]` in a multi-unit
 * building, `["Bedroom"]` on a house. The unit is a folder of its own with the
 * room inside it, which is the shape the multifamily folder template already
 * makes and the shape the Pictures tab is read in — "Unit 100 › Kitchen" —
 * so a room recorded on the Rooms tab and a folder made from a template land
 * in the same place instead of beside each other.
 *
 * Read only when a folder is *created* or is still empty. A folder that holds
 * photos has been linked, exported into a claim package and talked about by
 * name, and silently renaming or moving it strands everyone who knows it by
 * the old one — so it keeps its name and place even after its room changes.
 */
export function roomFolderPath(r: Pick<JobRoom, "unit" | "name">): string[] {
  const name = (r.name ?? "").trim() || "Unnamed room";
  const unit = unitLabel(r.unit);
  return unit ? [unit, name] : [name];
}

/** The folder's own name — the last step of {@link roomFolderPath}. */
export function roomFolderName(r: Pick<JobRoom, "unit" | "name">): string {
  const path = roomFolderPath(r);
  return path[path.length - 1]!;
}

/* ------------------------------------------------------------------ */
/* Ordering                                                            */
/* ------------------------------------------------------------------ */

const CHUNKS = /\d+|\D+/g;

/**
 * "2" before "10", not after it. A building numbers its units the way people
 * count, and a lexicographic list — 1, 10, 100, 11, 2 — is unreadable at forty
 * units, which is exactly the size of job this field exists for.
 */
function naturalCompare(a: string, b: string): number {
  const ax = a.toLowerCase().match(CHUNKS) ?? [];
  const bx = b.toLowerCase().match(CHUNKS) ?? [];
  const len = Math.max(ax.length, bx.length);
  for (let i = 0; i < len; i += 1) {
    const x = ax[i];
    const y = bx[i];
    if (x == null) return -1;
    if (y == null) return 1;
    const bothNumeric = /^\d/.test(x) && /^\d/.test(y);
    if (bothNumeric) {
      const diff = Number(x) - Number(y);
      if (diff !== 0) return diff < 0 ? -1 : 1;
      // "01" and "1" are numerically equal; keep a deterministic tie-break so
      // a padded stack and an unpadded one never swap places between renders.
      if (x.length !== y.length) return x.length - y.length;
      continue;
    }
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Rooms with no unit sort first, in the order they were already in. A
 * single-family job — and every job recorded before units existed — is
 * entirely that group, so its list does not move at all.
 */
export function compareUnits(a: string | null | undefined, b: string | null | undefined): number {
  const ta = (a ?? "").trim();
  const tb = (b ?? "").trim();
  if (!ta && !tb) return 0;
  if (!ta) return -1;
  if (!tb) return 1;
  return naturalCompare(ta, tb);
}

/**
 * Rooms in the same unit together, units in a natural order, and within a unit
 * the order the job already had (sort_order, then when it was added). Stable
 * on the incoming order, so this never reshuffles a list it has nothing to say
 * about.
 */
export function sortRooms(rooms: JobRoom[]): JobRoom[] {
  return rooms
    .map((room, index) => ({ room, index }))
    .sort((a, b) => compareUnits(a.room.unit, b.room.unit) || a.index - b.index)
    .map((entry) => entry.room);
}

export type RoomGroup = {
  /** The unit as typed on its first room, or null for the un-unitted group. */
  unit: string | null;
  /** "Unit 4B", or null when there is no unit to print. */
  label: string | null;
  rooms: JobRoom[];
};

/**
 * The room list as it is read on site: one block per unit. A job with no units
 * comes back as a single group with a null label, which is the same flat list
 * it has always been.
 */
export function groupRoomsByUnit(rooms: JobRoom[]): RoomGroup[] {
  const groups: RoomGroup[] = [];
  for (const room of sortRooms(rooms)) {
    const unit = (room.unit ?? "").trim() || null;
    const last = groups[groups.length - 1];
    // "4b" and "4B" are the same unit to everyone standing in it.
    if (last && (last.unit ?? "").toLowerCase() === (unit ?? "").toLowerCase()) {
      last.rooms.push(room);
      continue;
    }
    groups.push({ unit, label: unitLabel(unit), rooms: [room] });
  }
  return groups;
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

export type JobRoomList = {
  rooms: JobRoom[];
  /**
   * False when `job_rooms.unit` is not in this database yet. The migration is
   * written but applied by hand, so the unit field is hidden and said to be
   * pending rather than offered and silently dropped.
   */
  unitAvailable: boolean;
  /**
   * False when field capture's room columns (`flooring`, `extra_sf`) are not
   * in this database yet. Same bargain as the unit: the fields are hidden and
   * said to be pending, and the rest of the tab works as it always has.
   */
  captureColumnsAvailable: boolean;
};

/**
 * numeric comes back from PostgREST as a string on some drivers, and the
 * takeoffs add these up — "12.5" + "10" is not a floor area.
 */
const toNum = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function normalizeRoom(raw: Record<string, unknown>): JobRoom {
  const r = raw as unknown as JobRoom;
  return {
    ...r,
    unit: r.unit ?? null,
    length_ft: toNum(r.length_ft),
    width_ft: toNum(r.width_ft),
    height_ft: toNum(r.height_ft),
    flooring: r.flooring ?? null,
    extra_sf: toNum(r.extra_sf) ?? 0,
  };
}

export async function fetchJobRooms(jobId: string): Promise<JobRoomList> {
  const query = (columns: string) =>
    supabase
      .from("job_rooms")
      .select(columns)
      .eq("job_id", jobId)
      .order("sort_order")
      .order("created_at");

  const done = (data: unknown, unitAvailable: boolean, captureColumnsAvailable: boolean) => ({
    rooms: sortRooms(((data ?? []) as Record<string, unknown>[]).map(normalizeRoom)),
    unitAvailable,
    captureColumnsAvailable,
  });

  // Newest schema first, then each step back. One unshipped column must not
  // take down the room list — without rooms there are no photo folders, no
  // equipment placements and no readings.
  const full = await query(CAPTURE_SELECT);
  if (!full.error) return done(full.data, true, true);
  if (!isMissingSchema(full.error)) throw full.error;

  const withUnit = await query(SELECT);
  if (!withUnit.error) return done(withUnit.data, true, false);
  if (!isMissingSchema(withUnit.error)) throw withUnit.error;

  const plain = await query(BASE_COLUMNS);
  if (plain.error) throw plain.error;
  return done(plain.data, false, false);
}

export function roomDimsLabel(r: JobRoom): string | null {
  const parts = [r.length_ft, r.width_ft, r.height_ft].filter((n) => n != null);
  if (parts.length < 2) return null;
  return parts.join(" × ") + " ft";
}

/* ------------------------------------------------------------------ */
/* Writes                                                              */
/* ------------------------------------------------------------------ */

export type NewJobRoom = {
  jobId: string;
  unit: string | null;
  name: string;
  floor: string | null;
  lengthFt: number | null;
  widthFt: number | null;
  heightFt: number | null;
  createdBy: string | null;
  sortOrder: number;
};

/**
 * `unitDropped` says the room was saved without its unit because the column is
 * not in this database yet. The room still goes in: refusing to record an
 * affected room over a column that only labels it would cost the job its scope,
 * its folders and its readings, and the caller says plainly what was lost.
 */
export async function createJobRoom(
  input: NewJobRoom,
): Promise<{ id: string; unitDropped: boolean }> {
  // Minted here rather than by the table's default so a caller can select the
  // room it just made (the drying log's "+ Add room") without reading it back,
  // and so the no-unit retry below writes the same room, not a second one.
  const id = crypto.randomUUID();
  const base = {
    id,
    job_id: input.jobId,
    name: input.name,
    floor: input.floor,
    length_ft: input.lengthFt,
    width_ft: input.widthFt,
    height_ft: input.heightFt,
    created_by: input.createdBy,
    sort_order: input.sortOrder,
  };
  const row = input.unit ? { ...base, unit: input.unit } : base;
  const { error } = await supabase.from("job_rooms").insert(row as never);
  if (!error) return { id, unitDropped: false };
  if (!input.unit || !isMissingSchema(error)) throw error;

  const { error: retry } = await supabase.from("job_rooms").insert(base as never);
  if (retry) throw retry;
  return { id, unitDropped: true };
}

/** The same bargain on an edit: everything the old schema understands is kept. */
export async function patchJobRoom(
  id: string,
  values: Partial<JobRoom>,
): Promise<{ unitDropped: boolean }> {
  const { error } = await supabase
    .from("job_rooms")
    .update(values as never)
    .eq("id", id);
  if (!error) return { unitDropped: false };
  if (!("unit" in values) || !isMissingSchema(error)) throw error;

  const rest = { ...values };
  delete rest.unit;
  if (!Object.keys(rest).length) return { unitDropped: true };
  const { error: retry } = await supabase
    .from("job_rooms")
    .update(rest as never)
    .eq("id", id);
  if (retry) throw retry;
  return { unitDropped: true };
}

export async function deleteJobRoom(id: string): Promise<void> {
  const { error } = await supabase.from("job_rooms").delete().eq("id", id);
  if (error) throw error;
}

/* ------------------------------------------------------------------ */
/* Photo folders                                                       */
/* ------------------------------------------------------------------ */

/** The columns of a photo folder the planner needs to reason about. */
export type RoomFolderRow = {
  id: string;
  room_id: string | null;
  name: string;
  parent_folder_id: string | null;
  sort_order: number;
};

export type RoomFolderAction =
  /** No folder for this room anywhere: make one, under its unit's folder —
   *  `parentFolderId` when that folder exists, else the one made for `unit`. */
  | { kind: "create"; room: JobRoom; unit: string | null; parentFolderId: string | null }
  /** A folder already sits where this room's would — a template made it, or
   *  someone did by hand. It becomes the room's folder as it stands. */
  | { kind: "adopt"; room: JobRoom; folderId: string }
  /** The room's folder is empty and its room moved or was renamed: follow it. */
  | {
      kind: "update";
      room: JobRoom;
      folderId: string;
      name: string;
      unit: string | null;
      parentFolderId: string | null;
    }
  /** The room's folder is already right, or holds photos and no longer
   *  matches its room and is left exactly where it is — see
   *  {@link roomFolderPath}. */
  | { kind: "keep"; room: JobRoom; folderId: string; reason: "current" | "has_photos" }
  /** Where this room's folder would go, another room's folder already is. */
  | { kind: "skip"; room: JobRoom; reason: "name_taken" };

export type RoomFolderPlan = {
  actions: RoomFolderAction[];
  /** Unit folders that have to exist at the album root before creates run. */
  unitsToCreate: string[];
};

const fold = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

/**
 * Photos inside a folder or anything beneath it. A room folder someone has
 * already split into "Before" and "After" is as spoken-for as one with the
 * photos directly in it.
 */
export function folderPhotoCounts(
  folders: RoomFolderRow[],
  photoFolderIds: (string | null)[],
): Record<string, number> {
  const parent = new Map(folders.map((f) => [f.id, f.parent_folder_id]));
  const out: Record<string, number> = {};
  for (const id of photoFolderIds) {
    let cur: string | null | undefined = id;
    let guard = 0;
    while (cur && guard++ < 20) {
      out[cur] = (out[cur] ?? 0) + 1;
      cur = parent.get(cur);
    }
  }
  return out;
}

/**
 * Decides, without touching the database, what each room's folder needs.
 * Pure so the rule can be tested and so the sync only writes what the plan
 * says — which is what makes it safe to run after every room save.
 *
 * Matching runs in this order: the folder already linked to the room; else a
 * folder at the room's path whose name matches ignoring case and that belongs
 * to no other room; else nothing, and a folder is created. A unit folder is
 * found by its label ("Unit 100") or by the bare unit as typed ("100").
 */
export function planRoomFolders(
  rooms: JobRoom[],
  folders: RoomFolderRow[],
  photoCounts: Record<string, number>,
): RoomFolderPlan {
  const byRoom = new Map<string, RoomFolderRow>();
  for (const f of folders) if (f.room_id) byRoom.set(f.room_id, f);

  const roots = folders.filter((f) => f.parent_folder_id == null);
  const unitFolderFor = (unit: string | null): RoomFolderRow | null => {
    const label = unitLabel(unit);
    if (!label) return null;
    const wanted = new Set([fold(label), fold(unit)]);
    return roots.find((f) => wanted.has(fold(f.name)) && f.room_id == null) ?? null;
  };

  // Names claimed at each location, so two rooms named alike in one unit do
  // not both adopt or create the same folder. Seeded from what exists.
  const claimed = new Set(folders.map((f) => `${f.parent_folder_id ?? "root"}:${fold(f.name)}`));
  const claim = (parentKey: string, name: string) => {
    const k = `${parentKey}:${fold(name)}`;
    if (claimed.has(k)) return false;
    claimed.add(k);
    return true;
  };

  const unitsToCreate: string[] = [];
  const needUnit = (unit: string | null, existing: RoomFolderRow | null) => {
    if (!unit || existing) return;
    if (!unitsToCreate.some((u) => fold(u) === fold(unit))) unitsToCreate.push(unit);
  };

  const actions: RoomFolderAction[] = [];
  for (const room of sortRooms(rooms)) {
    const path = roomFolderPath(room);
    const unit = path.length === 2 ? path[0]! : null;
    const name = path[path.length - 1]!;
    const unitFolder = unitFolderFor(room.unit);
    // The key a room's folder is filed under: an existing unit folder's id, a
    // unit folder yet to be made, or the album root.
    const parentKey = unit ? (unitFolder?.id ?? `unit:${fold(unit)}`) : "root";

    const linked = byRoom.get(room.id);
    if (linked) {
      const parentOk = unit
        ? unitFolder != null && linked.parent_folder_id === unitFolder.id
        : linked.parent_folder_id == null;
      if (parentOk && fold(linked.name) === fold(name)) {
        actions.push({ kind: "keep", room, folderId: linked.id, reason: "current" });
        continue;
      }
      if (photoCounts[linked.id]) {
        actions.push({ kind: "keep", room, folderId: linked.id, reason: "has_photos" });
        continue;
      }
      if (!claim(parentKey, name)) {
        actions.push({ kind: "skip", room, reason: "name_taken" });
        continue;
      }
      needUnit(unit, unitFolder);
      actions.push({
        kind: "update",
        room,
        folderId: linked.id,
        name,
        unit,
        parentFolderId: unitFolder?.id ?? null,
      });
      continue;
    }

    const parentId = unit ? (unitFolder?.id ?? null) : null;
    const atPath =
      unit && !unitFolder
        ? null
        : (folders.find((f) => f.parent_folder_id === parentId && fold(f.name) === fold(name)) ??
          null);
    if (atPath) {
      if (atPath.room_id && atPath.room_id !== room.id) {
        actions.push({ kind: "skip", room, reason: "name_taken" });
        continue;
      }
      actions.push({ kind: "adopt", room, folderId: atPath.id });
      continue;
    }
    if (!claim(parentKey, name)) {
      actions.push({ kind: "skip", room, reason: "name_taken" });
      continue;
    }
    needUnit(unit, unitFolder);
    actions.push({ kind: "create", room, unit, parentFolderId: unitFolder?.id ?? null });
  }
  return { actions, unitsToCreate };
}

export type RoomFolderSyncResult = {
  created: number;
  adopted: number;
  updated: number;
  /** Folders left alone because they hold photos and no longer match. */
  heldBack: number;
  /** Rooms with no folder because another room's folder has that name. */
  skipped: number;
};

/**
 * Makes the album's folders match the room list, and is what runs after every
 * room is added, renamed or moved to another unit — so nobody presses a
 * button to get a folder for a room. Idempotent, so it is also the repair
 * action on the Rooms tab for jobs recorded before this ran on its own.
 *
 * What it never does: delete a folder, or rename or move one that holds
 * photos. Photos are claim evidence and a folder they sit in is known by name.
 */
export async function syncRoomFolders(
  projectId: string,
  rooms: JobRoom[],
  userId: string | null = null,
): Promise<RoomFolderSyncResult> {
  const [folderRes, photoRes] = await Promise.all([
    supabase
      .from("photo_folders")
      .select("id, room_id, name, parent_folder_id, sort_order")
      .eq("project_id", projectId),
    supabase
      .from("photos")
      .select("folder_id")
      .eq("project_id", projectId)
      .not("folder_id", "is", null)
      .is("deleted_at", null),
  ]);
  if (folderRes.error) throw folderRes.error;
  if (photoRes.error) throw photoRes.error;
  const folders = (folderRes.data ?? []) as RoomFolderRow[];
  const counts = folderPhotoCounts(
    folders,
    (photoRes.data ?? []).map((p) => p.folder_id),
  );

  const plan = planRoomFolders(rooms, folders, counts);
  const result: RoomFolderSyncResult = {
    created: 0,
    adopted: 0,
    updated: 0,
    heldBack: plan.actions.filter((a) => a.kind === "keep" && a.reason === "has_photos").length,
    skipped: plan.actions.filter((a) => a.kind === "skip").length,
  };

  // Unit folders first, so room folders have something to go under.
  const unitIds = new Map<string, string>();
  const rootCount = folders.filter((f) => f.parent_folder_id == null).length;
  const newUnits = [...plan.unitsToCreate].sort(compareUnits);
  for (const [i, unit] of newUnits.entries()) {
    const { data, error } = await supabase
      .from("photo_folders")
      .insert({
        project_id: projectId,
        name: unit,
        parent_folder_id: null,
        created_by: userId,
        sort_order: rootCount + i,
      })
      .select("id")
      .single();
    if (error) throw error;
    unitIds.set(fold(unit), data.id);
  }
  // The plan names the unit folder it found; only a folder made just now is
  // looked up by name.
  const parentFor = (a: { unit: string | null; parentFolderId: string | null }): string | null => {
    if (a.parentFolderId) return a.parentFolderId;
    if (!a.unit) return null;
    const id = unitIds.get(fold(a.unit));
    if (!id) throw new Error(`No folder for ${a.unit}`);
    return id;
  };

  const creates = plan.actions.filter((a) => a.kind === "create");
  if (creates.length) {
    const { error } = await supabase.from("photo_folders").insert(
      creates.map((a, i) => ({
        project_id: projectId,
        room_id: a.room.id,
        name: roomFolderName(a.room),
        parent_folder_id: parentFor(a),
        created_by: userId,
        sort_order: a.room.sort_order || i,
      })),
    );
    if (error) throw error;
    result.created = creates.length;
  }
  for (const a of plan.actions) {
    if (a.kind === "adopt") {
      const { error } = await supabase
        .from("photo_folders")
        .update({ room_id: a.room.id })
        .eq("id", a.folderId);
      if (error) throw error;
      result.adopted += 1;
    } else if (a.kind === "update") {
      const { error } = await supabase
        .from("photo_folders")
        .update({ name: a.name, parent_folder_id: parentFor(a) })
        .eq("id", a.folderId);
      if (error) throw error;
      result.updated += 1;
    }
  }
  return result;
}
