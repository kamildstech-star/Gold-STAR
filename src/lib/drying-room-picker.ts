/**
 * Choosing WHERE a drying reading was taken: the unit first, then a room in it.
 *
 * Mark, 2026-09-07: "for the drying log add a section for unit numbers". There
 * is no separate unit field on a reading and none is invented here — a room
 * already carries its unit (src/lib/job-rooms.ts), so the unit is only a way
 * of finding the room. A forty-unit building has a hundred and sixty rooms; a
 * picker that lists them flat is unusable on a phone in a stairwell, and one
 * that narrows to the unit the technician is standing in is not.
 *
 * Everything here is pure and reads the job's own room list. A job with no
 * units — a house, or a job recorded before units existed — produces no unit
 * options at all, and the caller hides the unit control rather than showing an
 * empty one.
 */
import { groupRoomsByUnit, roomLabel, sortRooms, type JobRoom } from "./job-rooms";

/** No unit chosen: every room on the job is offered, with its full label. */
export const UNIT_ANY = "any";
/** The rooms that carry no unit, on a job where other rooms do. */
export const UNIT_NONE = "none";

export type UnitOption = { key: string; label: string };

/** A room's place in the unit picker. Prefixed so a unit literally called "any" cannot collide. */
function keyOfUnit(unit: string | null | undefined): string {
  const text = (unit ?? "").trim().toLowerCase();
  return text ? `u:${text}` : UNIT_NONE;
}

/**
 * One option per unit, in the natural order the room list already uses. Empty
 * when no room has a unit, which is the signal to show no unit control at all.
 * Rooms with no unit on a job that has some appear as their own "No unit"
 * group, so a lobby or a corridor stays reachable.
 */
export function unitOptions(rooms: JobRoom[]): UnitOption[] {
  const groups = groupRoomsByUnit(rooms);
  if (!groups.some((g) => g.unit != null)) return [];
  return groups.map((g) => ({ key: keyOfUnit(g.unit), label: g.label ?? "No unit" }));
}

/** The rooms offered once a unit is chosen — or all of them while none is. */
export function roomsForUnit(rooms: JobRoom[], unit: string): JobRoom[] {
  const sorted = sortRooms(rooms);
  if (unit === UNIT_ANY) return sorted;
  return sorted.filter((r) => keyOfUnit(r.unit) === unit);
}

/** The unit key a room sits in, or UNIT_ANY for a room that is not on the list. */
export function unitOfRoom(rooms: JobRoom[], roomId: string): string {
  const room = rooms.find((r) => r.id === roomId);
  return room ? keyOfUnit(room.unit) : UNIT_ANY;
}

export type RoomChoice = { unit: string; roomId: string };

/**
 * The technician picked a unit. A room already chosen in a different unit is
 * dropped — the point of picking the unit was to say the room is in it — but
 * a room in the same unit, or any room when the choice is widened back to
 * "any", is kept.
 */
export function chooseUnit(rooms: JobRoom[], current: RoomChoice, unit: string): RoomChoice {
  if (!current.roomId || unit === UNIT_ANY) return { unit, roomId: current.roomId };
  return unitOfRoom(rooms, current.roomId) === unit
    ? { unit, roomId: current.roomId }
    : { unit, roomId: "" };
}

/**
 * The technician picked a room. The unit follows the room, so choosing
 * "Unit 4B · Bedroom" straight off the full list also narrows the picker to
 * 4B for the next reading. Clearing the room keeps the unit they were in.
 */
export function chooseRoom(rooms: JobRoom[], current: RoomChoice, roomId: string): RoomChoice {
  if (!roomId) return { unit: current.unit, roomId: "" };
  return { unit: unitOfRoom(rooms, roomId), roomId };
}

/**
 * How a room reads in the picker. With a unit chosen the unit is already said,
 * so "Bedroom" rather than "Unit 4B · Bedroom" forty times over; with none, the
 * full label, because a bare "Bedroom" in a block of flats names nothing.
 */
export function roomOptionLabel(room: JobRoom, unit: string): string {
  return unit === UNIT_ANY ? roomLabel(room) : (room.name ?? "").trim() || "Unnamed room";
}

/*
 * "+ Add room" at the foot of the room list. Mark, 7 Oct 2026, on the Inside
 * card: "add a way to add a room from here too."
 */

/** The add entry's value in the room select. Not a uuid, so never a room id. */
export const ADD_ROOM = "__add_room__";
/** "No room" — the reading counts for the whole property. */
export const NO_ROOM = "none";

export type RoomPick = { kind: "add" } | { kind: "choose"; choice: RoomChoice };

/**
 * What a value picked from the room select means. "+ Add room" is not a
 * choice: it opens the form and leaves the selection exactly as it was, so a
 * form cancelled — or refused by the database — costs the technician nothing.
 */
export function readRoomPick(rooms: JobRoom[], current: RoomChoice, value: string): RoomPick {
  if (value === ADD_ROOM) return { kind: "add" };
  return { kind: "choose", choice: chooseRoom(rooms, current, value === NO_ROOM ? "" : value) };
}

/**
 * The room just added becomes the reading's room. It is laid over the list
 * in case the refetch has not landed (or could not), so the unit still
 * follows it: added as "4B · Closet" from "Any unit", the picker narrows to 4B
 * as it would for any room picked off the list.
 */
export function chooseAddedRoom(rooms: JobRoom[], current: RoomChoice, added: JobRoom): RoomChoice {
  const list = rooms.some((r) => r.id === added.id) ? rooms : [...rooms, added];
  return chooseRoom(list, current, added.id);
}

/**
 * The unit to start the add form with: the one the picker is narrowed to, as
 * the Rooms tab spells it ("4B", not the picker's lower-cased key). Empty
 * with no unit chosen, or on the "No unit" group.
 */
export function unitTextFor(rooms: JobRoom[], unit: string): string {
  if (unit === UNIT_ANY || unit === UNIT_NONE) return "";
  return roomsForUnit(rooms, unit)[0]?.unit?.trim() ?? "";
}
