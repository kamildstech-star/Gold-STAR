/**
 * "Copy layout" — one unit's rooms, sizes, flooring, doors, windows and
 * cabinet runs, stamped into another unit.
 *
 * An apartment building repeats its floor plan: measure 101 once, and 102
 * through 140 are the same kitchen, the same two bedrooms, the same 30" doors.
 * The standalone Field Capture package had this as "Copy layout from…" on an
 * empty unit. Here units are not records of their own — a unit is the
 * `unit` text on its rooms (`job_rooms.unit`) — so an "empty unit" is simply
 * a unit name no room has yet, and the copy goes FROM a unit that has rooms
 * TO one or more names that do not.
 *
 * What is copied is the layout: room names, sizes, flooring, +/- SF, doors,
 * windows and cabinet runs. What is not: photos, notes and affected
 * materials. Those are what happened in that unit, not what it looks like.
 *
 * Pure: the plan is built here with ids already chosen, so the whole copy is
 * one offline-queue item that lands the same rows however many times it is
 * replayed.
 */
import { sortRooms, unitLabel, type JobRoom } from "@/lib/job-rooms";
import type { RoomCabinet, RoomOpening } from "@/lib/room-takeoff";
import type { RoomCabinetRow, RoomOpeningRow } from "@/lib/room-capture-ops";

/** A job_rooms row as the copy inserts it. */
export type RoomCopyRow = {
  id: string;
  job_id: string;
  unit: string;
  name: string;
  floor: string | null;
  length_ft: number | null;
  width_ft: number | null;
  height_ft: number | null;
  sort_order: number;
  created_by: string | null;
  /** Only when the column exists (migration 20261006140000). */
  flooring?: string | null;
  extra_sf?: number;
};

export type CopyLayoutOp = {
  op: "copy_layout";
  /** The unit as typed, for the pending-work list. */
  targetUnit: string;
  rooms: RoomCopyRow[];
  openings: RoomOpeningRow[];
  cabinets: RoomCabinetRow[];
};

/** Room ranges get out of hand fast; a 60-unit copy is already a building. */
export const MAX_UNITS_PER_COPY = 60;

const fold = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

/**
 * "102, 103, 104", one per line, or a run of numbers: "201-210". A range is
 * read only when both ends are plain numbers, so a unit actually called
 * "A-1" stays "A-1". Duplicates (in any case) are dropped, order is kept.
 */
export function parseUnitList(text: string): { units: string[]; tooMany: boolean } {
  const out: string[] = [];
  const seen = new Set<string>();
  let tooMany = false;
  const push = (u: string) => {
    const key = fold(u);
    if (!key || seen.has(key)) return;
    if (out.length >= MAX_UNITS_PER_COPY) {
      tooMany = true;
      return;
    }
    seen.add(key);
    out.push(u.trim());
  };
  for (const part of text.split(/[,\n;]+/)) {
    const piece = part.trim();
    if (!piece) continue;
    const range = /^(\d+)\s*[-–]\s*(\d+)$/.exec(piece);
    if (range) {
      const [from, to] = [Number(range[1]), Number(range[2])];
      const width = range[1]!.length === range[2]!.length ? range[1]!.length : 0;
      if (to >= from && to - from < MAX_UNITS_PER_COPY * 2) {
        for (let n = from; n <= to; n += 1)
          push(width ? String(n).padStart(width, "0") : String(n));
        continue;
      }
    }
    push(piece);
  }
  return { units: out, tooMany };
}

/** The floor the source unit's rooms share, offered as the copy's floor; null when they differ. */
export function commonFloor(rooms: readonly JobRoom[]): string | null {
  const floors = new Set(rooms.map((r) => (r.floor ?? "").trim()));
  if (floors.size !== 1) return null;
  const only = [...floors][0]!;
  return only || null;
}

export type CopyPlan =
  | { ok: true; targetUnit: string; label: string; op: CopyLayoutOp }
  | { ok: false; targetUnit: string; label: string; reason: string };

/**
 * One target unit's copy, or why it cannot be made. A unit that already has
 * rooms is refused rather than merged: copying a kitchen into a unit that
 * has one gives it two, and nobody notices until the estimate.
 */
export function planLayoutCopy(input: {
  jobId: string;
  sourceUnit: string;
  targetUnit: string;
  /** Floor for every copied room — a unit's rooms are on its floor, not the source's. */
  targetFloor: string | null;
  rooms: readonly JobRoom[];
  openings: readonly RoomOpening[];
  cabinets: readonly RoomCabinet[];
  newId: () => string;
  createdBy: string | null;
  /** Whether flooring / +/- SF exist, and whether doors and cabinets do. */
  include: { columns: boolean; parts: boolean };
}): CopyPlan {
  const targetUnit = input.targetUnit.trim();
  const label = unitLabel(targetUnit) ?? targetUnit;
  if (!targetUnit) return { ok: false, targetUnit, label, reason: "Give the unit a name." };
  if (fold(targetUnit) === fold(input.sourceUnit)) {
    return { ok: false, targetUnit, label, reason: "That is the unit being copied." };
  }
  if (input.rooms.some((r) => fold(r.unit) === fold(targetUnit))) {
    return {
      ok: false,
      targetUnit,
      label,
      reason: `${label} already has rooms — copy into an empty unit so nothing is doubled.`,
    };
  }
  const source = sortRooms(input.rooms.filter((r) => fold(r.unit) === fold(input.sourceUnit)));
  if (!source.length) {
    return { ok: false, targetUnit, label, reason: "The unit being copied has no rooms." };
  }

  // After every room already on the job, so a copied unit never interleaves
  // with an existing one when two share a sort position.
  const base = Math.max(0, ...input.rooms.map((r) => r.sort_order ?? 0)) + 10;
  const idFor = new Map<string, string>();
  const rooms: RoomCopyRow[] = source.map((r, i) => {
    const id = input.newId();
    idFor.set(r.id, id);
    const row: RoomCopyRow = {
      id,
      job_id: input.jobId,
      unit: targetUnit,
      name: r.name,
      floor: input.targetFloor?.trim() || null,
      length_ft: r.length_ft,
      width_ft: r.width_ft,
      height_ft: r.height_ft,
      sort_order: base + i * 10,
      created_by: input.createdBy,
    };
    if (input.include.columns) {
      row.flooring = r.flooring;
      row.extra_sf = r.extra_sf ?? 0;
    }
    return row;
  });

  const openings: RoomOpeningRow[] = [];
  const cabinets: RoomCabinetRow[] = [];
  if (input.include.parts) {
    for (const o of input.openings) {
      const room_id = idFor.get(o.room_id);
      if (!room_id) continue;
      openings.push({
        id: input.newId(),
        job_id: input.jobId,
        room_id,
        kind: o.kind,
        width_in: o.width_in,
        height_in: o.height_in,
        qty: o.qty,
        created_by: input.createdBy,
      });
    }
    for (const c of input.cabinets) {
      const room_id = idFor.get(c.room_id);
      if (!room_id) continue;
      cabinets.push({
        id: input.newId(),
        job_id: input.jobId,
        room_id,
        kind: c.kind,
        length_ft: c.length_ft,
        created_by: input.createdBy,
      });
    }
  }

  return {
    ok: true,
    targetUnit,
    label,
    op: { op: "copy_layout", targetUnit, rooms, openings, cabinets },
  };
}
