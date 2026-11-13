import { describe, expect, it } from "vitest";

import {
  ADD_ROOM,
  NO_ROOM,
  UNIT_ANY,
  UNIT_NONE,
  chooseAddedRoom,
  chooseRoom,
  chooseUnit,
  readRoomPick,
  unitTextFor,
  roomOptionLabel,
  roomsForUnit,
  unitOfRoom,
  unitOptions,
} from "@/lib/drying-room-picker";
import type { JobRoom } from "@/lib/job-rooms";

/**
 * Mark, 2026-09-07: "for the drying log add a section for unit numbers". The
 * unit is a way of finding the room, never a field of its own — so these tests
 * are about navigation: what the picker offers, and what one choice does to
 * the other.
 */

let seq = 0;
function room(name: string, unit: string | null = null): JobRoom {
  seq += 1;
  return {
    id: `room-${seq}`,
    job_id: "job-1",
    unit,
    name,
    floor: null,
    length_ft: null,
    width_ft: null,
    height_ft: null,
    affected_materials: [],
    notes: null,
    sort_order: seq,
    flooring: null,
    extra_sf: 0,
  };
}

const lobby = room("Lobby");
const bed4b = room("Bedroom", "4B");
const bath4b = room("Bathroom", "4b");
const bed10 = room("Bedroom", "10");
const bed2 = room("Bedroom", "2");
const block = [lobby, bed4b, bath4b, bed10, bed2];

describe("the unit options", () => {
  it("are empty on a job with no units, so the control can disappear", () => {
    expect(unitOptions([room("Kitchen"), room("Basement")])).toEqual([]);
    expect(unitOptions([])).toEqual([]);
  });

  it("list each unit once, in the order a building counts, with the unitless rooms first", () => {
    expect(unitOptions(block)).toEqual([
      { key: UNIT_NONE, label: "No unit" },
      { key: "u:2", label: "Unit 2" },
      { key: "u:4b", label: "Unit 4B" },
      { key: "u:10", label: "Unit 10" },
    ]);
  });

  it("treats 4b and 4B as the same unit", () => {
    expect(unitOptions([bed4b, bath4b]).map((u) => u.key)).toEqual(["u:4b"]);
  });
});

describe("the rooms offered", () => {
  it("are every room while no unit is chosen, with the unit in each label", () => {
    const offered = roomsForUnit(block, UNIT_ANY);
    expect(offered).toHaveLength(5);
    expect(roomOptionLabel(bed4b, UNIT_ANY)).toBe("Unit 4B · Bedroom");
    expect(roomOptionLabel(lobby, UNIT_ANY)).toBe("Lobby");
  });

  it("narrow to the unit once one is chosen, and stop repeating it", () => {
    const offered = roomsForUnit(block, "u:4b");
    expect(offered.map((r) => r.id)).toEqual([bed4b.id, bath4b.id]);
    expect(roomOptionLabel(bed4b, "u:4b")).toBe("Bedroom");
  });

  it("keep the unitless rooms reachable under No unit", () => {
    expect(roomsForUnit(block, UNIT_NONE).map((r) => r.id)).toEqual([lobby.id]);
  });
});

describe("one choice against the other", () => {
  it("picking a room off the full list settles the unit too", () => {
    expect(chooseRoom(block, { unit: UNIT_ANY, roomId: "" }, bed10.id)).toEqual({
      unit: "u:10",
      roomId: bed10.id,
    });
    expect(unitOfRoom(block, lobby.id)).toBe(UNIT_NONE);
  });

  it("clearing the room keeps the unit the technician is in", () => {
    expect(chooseRoom(block, { unit: "u:4b", roomId: bed4b.id }, "")).toEqual({
      unit: "u:4b",
      roomId: "",
    });
  });

  it("changing to another unit drops a room that is not in it", () => {
    expect(chooseUnit(block, { unit: "u:4b", roomId: bed4b.id }, "u:10")).toEqual({
      unit: "u:10",
      roomId: "",
    });
  });

  it("changing to the room's own unit, or back to any, keeps the room", () => {
    expect(chooseUnit(block, { unit: UNIT_ANY, roomId: bed4b.id }, "u:4b").roomId).toBe(bed4b.id);
    expect(chooseUnit(block, { unit: "u:4b", roomId: bed4b.id }, UNIT_ANY).roomId).toBe(bed4b.id);
  });

  it("a room that is no longer on the list reads as no unit rather than throwing", () => {
    expect(unitOfRoom(block, "gone")).toBe(UNIT_ANY);
  });
});

describe("+ Add room at the foot of the list", () => {
  // Mark, 7 Oct 2026, on the Inside card: "add a way to add a room from here too."
  const current = { unit: "u:4b", roomId: bed4b.id };

  it("opens the form and changes nothing, so a canceled form costs nothing", () => {
    expect(readRoomPick(block, current, ADD_ROOM)).toEqual({ kind: "add" });
  });

  it("still reads a room or No room as a choice", () => {
    expect(readRoomPick(block, current, NO_ROOM)).toEqual({
      kind: "choose",
      choice: { unit: "u:4b", roomId: "" },
    });
    expect(readRoomPick(block, current, bed10.id)).toEqual({
      kind: "choose",
      choice: { unit: "u:10", roomId: bed10.id },
    });
  });

  it("picks the room just added, before the refetch has brought it into the list", () => {
    const closet = room("Closet", "4B");
    expect(chooseAddedRoom(block, { unit: UNIT_ANY, roomId: "" }, closet)).toEqual({
      unit: "u:4b",
      roomId: closet.id,
    });
  });

  it("picks it the same way once the refetch has", () => {
    const closet = room("Closet", "10");
    expect(chooseAddedRoom([...block, closet], current, closet)).toEqual({
      unit: "u:10",
      roomId: closet.id,
    });
  });

  it("starts the form in the unit the picker is narrowed to, spelled as the room has it", () => {
    expect(unitTextFor(block, "u:4b")).toBe("4B");
    expect(unitTextFor(block, UNIT_ANY)).toBe("");
    expect(unitTextFor(block, UNIT_NONE)).toBe("");
  });
});
