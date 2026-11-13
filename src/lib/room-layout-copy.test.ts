import { describe, expect, it } from "vitest";

import type { JobRoom } from "./job-rooms";
import { applyHeldOps } from "./room-capture-ops";
import { commonFloor, parseUnitList, planLayoutCopy, MAX_UNITS_PER_COPY } from "./room-layout-copy";
import { jobTakeoff, type RoomCabinet, type RoomOpening } from "./room-takeoff";
import { groupRoomsByUnit } from "./job-rooms";

const room = (id: string, unit: string | null, over: Partial<JobRoom> = {}): JobRoom => ({
  id,
  job_id: "job",
  unit,
  name: id,
  floor: "1",
  length_ft: null,
  width_ft: null,
  height_ft: null,
  affected_materials: [],
  notes: null,
  sort_order: 0,
  flooring: null,
  extra_sf: 0,
  ...over,
});

const kitchen = room("k101", "101", {
  name: "Kitchen",
  length_ft: 12.5,
  width_ft: 10,
  height_ft: 9,
  flooring: "LVP (wood-look)",
  extra_sf: 6,
  notes: "Water at the sink base",
  affected_materials: ["Drywall", "Cabinetry"],
  sort_order: 10,
});
const bed = room("b101", "101", { name: "Bedroom", length_ft: 11, width_ft: 10, sort_order: 20 });
const other = room("k201", "201", { name: "Kitchen", sort_order: 30 });
const rooms = [kitchen, bed, other];

const openings: RoomOpening[] = [
  {
    id: "o1",
    job_id: "job",
    room_id: "k101",
    kind: "interior_door",
    width_in: 30,
    height_in: 80,
    qty: 1,
  },
  {
    id: "o2",
    job_id: "job",
    room_id: "b101",
    kind: "closet_double",
    width_in: 48,
    height_in: 80,
    qty: 1,
  },
  { id: "o3", job_id: "job", room_id: "k201", kind: "window", width_in: 36, height_in: 48, qty: 2 },
];
const cabinets: RoomCabinet[] = [
  { id: "c1", job_id: "job", room_id: "k101", kind: "base", length_ft: 8.5 },
];

const ids = () => {
  let n = 0;
  return () => `new-${++n}`;
};

const plan = (targetUnit: string, over: Partial<Parameters<typeof planLayoutCopy>[0]> = {}) =>
  planLayoutCopy({
    jobId: "job",
    sourceUnit: "101",
    targetUnit,
    targetFloor: "1",
    rooms,
    openings,
    cabinets,
    newId: ids(),
    createdBy: "u1",
    include: { columns: true, parts: true },
    ...over,
  });

describe("parseUnitList", () => {
  it("reads a list, a run of numbers, or both", () => {
    expect(parseUnitList("102, 103,104").units).toEqual(["102", "103", "104"]);
    expect(parseUnitList("201-204").units).toEqual(["201", "202", "203", "204"]);
    expect(parseUnitList("102; 201–203\n4B").units).toEqual(["102", "201", "202", "203", "4B"]);
  });

  it("keeps the padding a building writes its units with", () => {
    expect(parseUnitList("08-11").units).toEqual(["08", "09", "10", "11"]);
  });

  it("leaves a unit actually called A-1 alone", () => {
    expect(parseUnitList("A-1, B-2").units).toEqual(["A-1", "B-2"]);
  });

  it("drops duplicates in any case and empty entries", () => {
    expect(parseUnitList("4b, 4B, , 5").units).toEqual(["4b", "5"]);
  });

  it(`stops at ${MAX_UNITS_PER_COPY} units and says so`, () => {
    const r = parseUnitList("1-100");
    expect(r.units).toHaveLength(MAX_UNITS_PER_COPY);
    expect(r.tooMany).toBe(true);
  });
});

describe("commonFloor", () => {
  it("offers the floor every room shares, and nothing when they differ", () => {
    expect(commonFloor([kitchen, bed])).toBe("1");
    expect(commonFloor([kitchen, room("x", "101", { floor: "2" })])).toBeNull();
    expect(commonFloor([room("x", "1", { floor: null })])).toBeNull();
  });
});

describe("planLayoutCopy", () => {
  it("copies rooms, sizes, flooring and +/- SF into the new unit", () => {
    const p = plan("102");
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.label).toBe("Unit 102");
    expect(p.op.rooms.map((r) => [r.unit, r.name, r.length_ft, r.width_ft, r.height_ft])).toEqual([
      ["102", "Kitchen", 12.5, 10, 9],
      ["102", "Bedroom", 11, 10, null],
    ]);
    expect(p.op.rooms[0]).toMatchObject({ flooring: "LVP (wood-look)", extra_sf: 6, floor: "1" });
  });

  it("does not copy notes, affected materials or photos — those happened in the other unit", () => {
    const p = plan("102");
    if (!p.ok) throw new Error(p.reason);
    for (const r of p.op.rooms) {
      expect(r).not.toHaveProperty("notes");
      expect(r).not.toHaveProperty("affected_materials");
    }
  });

  it("copies the doors and cabinet runs onto the new rooms, with new ids", () => {
    const p = plan("102");
    if (!p.ok) throw new Error(p.reason);
    const [newKitchen, newBed] = p.op.rooms;
    expect(p.op.openings.map((o) => [o.room_id, o.kind, o.width_in])).toEqual([
      [newKitchen!.id, "interior_door", 30],
      [newBed!.id, "closet_double", 48],
    ]);
    expect(p.op.cabinets.map((c) => [c.room_id, c.kind, c.length_ft])).toEqual([
      [newKitchen!.id, "base", 8.5],
    ]);
    const allIds = [...p.op.rooms, ...p.op.openings, ...p.op.cabinets].map((x) => x.id);
    expect(new Set(allIds).size).toBe(allIds.length);
    expect(allIds.some((id) => ["k101", "b101", "o1", "o2", "c1"].includes(id))).toBe(false);
  });

  it("gives every copied unit the same takeoff as the one it was copied from", () => {
    const p = plan("102");
    if (!p.ok) throw new Error(p.reason);
    const after = applyHeldOps({ rooms, openings, cabinets }, [p.op]);
    const t = jobTakeoff(groupRoomsByUnit(after.rooms), after.openings, after.cabinets);
    const u101 = t.units.find((u) => u.unit === "101")!;
    const u102 = t.units.find((u) => u.unit === "102")!;
    expect(u102.floorSf).toBe(u101.floorSf);
    expect(u102.doorSlabs).toBe(u101.doorSlabs);
    expect(u102.cabinetLfTotal).toBe(u101.cabinetLfTotal);
  });

  it("puts the copy after every room already on the job", () => {
    const p = plan("102");
    if (!p.ok) throw new Error(p.reason);
    expect(p.op.rooms.map((r) => r.sort_order)).toEqual([40, 50]);
  });

  it("uses the floor given for the new unit", () => {
    const p = plan("301", { targetFloor: "3" });
    if (!p.ok) throw new Error(p.reason);
    expect(p.op.rooms.every((r) => r.floor === "3")).toBe(true);
    const blank = plan("301", { targetFloor: "  " });
    if (!blank.ok) throw new Error(blank.reason);
    expect(blank.op.rooms.every((r) => r.floor === null)).toBe(true);
  });

  it("refuses a unit that already has rooms rather than doubling them", () => {
    const p = plan("201");
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.reason).toMatch(/Unit 201 already has rooms/);
    // Case and spaces do not make it a different unit.
    expect(plan(" 201 ").ok).toBe(false);
  });

  it("refuses copying a unit onto itself, a blank name, and an empty source", () => {
    expect(plan("101").ok).toBe(false);
    expect(plan("   ").ok).toBe(false);
    expect(plan("102", { sourceUnit: "999" }).ok).toBe(false);
  });

  it("leaves out what this database cannot hold yet", () => {
    const p = plan("102", { include: { columns: false, parts: false } });
    if (!p.ok) throw new Error(p.reason);
    expect(p.op.rooms[0]).not.toHaveProperty("flooring");
    expect(p.op.rooms[0]).not.toHaveProperty("extra_sf");
    expect(p.op.openings).toEqual([]);
    expect(p.op.cabinets).toEqual([]);
  });
});
