/**
 * The writes field capture makes, as plain data.
 *
 * Every change a crew makes on a room — a length, a door, a cabinet run — is
 * one of these ops. The op is what the offline queue holds on the device and
 * replays when a signal comes back (`applyRoomCaptureOp` in room-capture.ts),
 * and it is also what the Rooms tab lays over the server's copy while the op
 * is still waiting (`applyHeldOps` below), so a door added in a basement shows
 * up in the room and in the takeoffs at once instead of after the drive home.
 *
 * Pure: no React, no Supabase.
 */
import type { JobRoom } from "@/lib/job-rooms";
import type { RoomCabinet, RoomOpening } from "@/lib/room-takeoff";
import type { CopyLayoutOp } from "@/lib/room-layout-copy";

/** The room columns field capture edits. Never the name or unit — those move photo folders. */
export type RoomMeasurePatch = Partial<
  Pick<JobRoom, "length_ft" | "width_ft" | "height_ft" | "flooring" | "extra_sf">
>;

export type OpeningPatch = Partial<Pick<RoomOpening, "kind" | "width_in" | "height_in" | "qty">>;
export type CabinetPatch = Partial<Pick<RoomCabinet, "kind" | "length_ft">>;

/** A new row carries who made it; the RLS insert check does not pin it, but the record should say. */
export type RoomOpeningRow = RoomOpening & { created_by: string | null };
export type RoomCabinetRow = RoomCabinet & { created_by: string | null };

export type RoomCaptureOp =
  | { op: "measure"; roomId: string; patch: RoomMeasurePatch }
  | { op: "opening_add"; row: RoomOpeningRow }
  | { op: "opening_patch"; id: string; patch: OpeningPatch }
  | { op: "opening_delete"; id: string }
  | { op: "cabinet_add"; row: RoomCabinetRow }
  | { op: "cabinet_patch"; id: string; patch: CabinetPatch }
  | { op: "cabinet_delete"; id: string }
  | CopyLayoutOp;

/** What the pending-work list calls each op, so a held item can be named. */
export function roomCaptureOpLabel(op: RoomCaptureOp, roomName?: string): string {
  const where = roomName ? ` · ${roomName}` : "";
  switch (op.op) {
    case "measure":
      return `Room measurements${where}`;
    case "opening_add":
    case "opening_patch":
    case "opening_delete":
      return `Door or window${where}`;
    case "cabinet_add":
    case "cabinet_patch":
    case "cabinet_delete":
      return `Cabinet run${where}`;
    case "copy_layout":
      return `Layout copy → ${op.targetUnit}`;
  }
}

export type CaptureState = {
  rooms: JobRoom[];
  openings: RoomOpening[];
  cabinets: RoomCabinet[];
};

/**
 * The server's copy with the ops still waiting on this device laid over it,
 * in the order they were made. An op the server already has is harmless to
 * apply twice — every op is an upsert, a patch or a delete by id — which is
 * what lets the overlay be dropped lazily, after the next read lands, rather
 * than in a race with it.
 */
export function applyHeldOps(base: CaptureState, ops: readonly RoomCaptureOp[]): CaptureState {
  let { rooms, openings, cabinets } = base;
  for (const op of ops) {
    switch (op.op) {
      case "measure":
        rooms = rooms.map((r) => (r.id === op.roomId ? { ...r, ...op.patch } : r));
        break;
      case "opening_add": {
        const { created_by: _by, ...row } = op.row;
        openings = [...openings.filter((o) => o.id !== row.id), row];
        break;
      }
      case "opening_patch":
        openings = openings.map((o) => (o.id === op.id ? { ...o, ...op.patch } : o));
        break;
      case "opening_delete":
        openings = openings.filter((o) => o.id !== op.id);
        break;
      case "cabinet_add": {
        const { created_by: _by, ...row } = op.row;
        cabinets = [...cabinets.filter((c) => c.id !== row.id), row];
        break;
      }
      case "cabinet_patch":
        cabinets = cabinets.map((c) => (c.id === op.id ? { ...c, ...op.patch } : c));
        break;
      case "cabinet_delete":
        cabinets = cabinets.filter((c) => c.id !== op.id);
        break;
      case "copy_layout": {
        // The copied unit shows at once, rooms and all, while the copy is
        // held — the crew moves on to measuring the next unit.
        const ids = new Set(op.rooms.map((r) => r.id));
        rooms = [
          ...rooms.filter((r) => !ids.has(r.id)),
          ...op.rooms.map((r): JobRoom => ({
            ...r,
            affected_materials: [],
            notes: null,
            flooring: r.flooring ?? null,
            extra_sf: r.extra_sf ?? 0,
          })),
        ];
        const strip = <T extends { created_by: string | null }>({ created_by: _by, ...rest }: T) =>
          rest;
        const oIds = new Set(op.openings.map((o) => o.id));
        openings = [...openings.filter((o) => !oIds.has(o.id)), ...op.openings.map(strip)];
        const cIds = new Set(op.cabinets.map((c) => c.id));
        cabinets = [...cabinets.filter((c) => !cIds.has(c.id)), ...op.cabinets.map(strip)];
        break;
      }
    }
  }
  return { rooms, openings, cabinets };
}
