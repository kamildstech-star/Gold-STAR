import { describe, expect, it } from "vitest";

import {
  compareUnits,
  folderPhotoCounts,
  groupRoomsByUnit,
  planRoomFolders,
  roomFolderName,
  roomFolderPath,
  roomLabel,
  sortRooms,
  unitLabel,
  type JobRoom,
  type RoomFolderRow,
} from "./job-rooms";

const room = (over: Partial<JobRoom> & { name: string }): JobRoom => ({
  id: over.id ?? over.name,
  job_id: "job",
  unit: null,
  floor: null,
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

describe("unit labels", () => {
  it("writes the designator in front of a bare unit", () => {
    expect(unitLabel("4B")).toBe("Unit 4B");
    expect(unitLabel("101")).toBe("Unit 101");
  });

  it("leaves a unit that already says what it is alone", () => {
    expect(unitLabel("Apt 2")).toBe("Apt 2");
    expect(unitLabel("Suite 300")).toBe("Suite 300");
    expect(unitLabel("Unit 4B")).toBe("Unit 4B");
    expect(unitLabel("#12")).toBe("#12");
  });

  it("treats blank and whitespace as no unit at all", () => {
    expect(unitLabel(null)).toBeNull();
    expect(unitLabel(undefined)).toBeNull();
    expect(unitLabel("   ")).toBeNull();
  });

  it("trims what the technician typed", () => {
    expect(unitLabel("  4B ")).toBe("Unit 4B");
  });
});

describe("room labels", () => {
  it("leads with the unit, because that is what disambiguates the room", () => {
    expect(roomLabel({ unit: "4B", name: "Bedroom" })).toBe("Unit 4B · Bedroom");
  });

  it("prints a house room exactly as it always did", () => {
    expect(roomLabel({ unit: null, name: "Bedroom" })).toBe("Bedroom");
    expect(roomLabel({ unit: "", name: "Bedroom" })).toBe("Bedroom");
  });

  it("never renders an empty label", () => {
    expect(roomLabel({ unit: null, name: "  " })).toBe("Unnamed room");
  });

  it("files a room's photo folder inside its unit's folder", () => {
    expect(roomFolderPath({ unit: "12", name: "Kitchen" })).toEqual(["Unit 12", "Kitchen"]);
    expect(roomFolderPath({ unit: "Apt 2", name: "Kitchen" })).toEqual(["Apt 2", "Kitchen"]);
    expect(roomFolderPath({ unit: null, name: "Kitchen" })).toEqual(["Kitchen"]);
    expect(roomFolderName({ unit: "12", name: "Kitchen" })).toBe("Kitchen");
    expect(roomFolderName({ unit: null, name: " Kitchen " })).toBe("Kitchen");
  });
});

describe("unit ordering", () => {
  it("counts the way a building does — 2 before 10", () => {
    const units = ["10", "2", "1", "100", "11"];
    expect([...units].sort(compareUnits)).toEqual(["1", "2", "10", "11", "100"]);
  });

  it("orders letter-and-number stacks naturally", () => {
    const units = ["A10", "A2", "B1", "A1"];
    expect([...units].sort(compareUnits)).toEqual(["A1", "A2", "A10", "B1"]);
  });

  it("keeps zero-padded and bare designators apart deterministically", () => {
    expect(compareUnits("01", "1")).toBeGreaterThan(0);
    expect(compareUnits("1", "01")).toBeLessThan(0);
  });

  it("puts rooms with no unit first", () => {
    expect(compareUnits(null, "2")).toBeLessThan(0);
    expect(compareUnits("2", null)).toBeGreaterThan(0);
    expect(compareUnits(null, null)).toBe(0);
    expect(compareUnits("  ", "")).toBe(0);
  });
});

describe("sorting rooms", () => {
  it("leaves a job with no units exactly as it was", () => {
    const rooms = [room({ name: "Kitchen" }), room({ name: "Bedroom" }), room({ name: "Attic" })];
    expect(sortRooms(rooms).map((r) => r.name)).toEqual(["Kitchen", "Bedroom", "Attic"]);
  });

  it("gathers a unit's rooms together and orders the units naturally", () => {
    const rooms = [
      room({ id: "a", unit: "10", name: "Kitchen" }),
      room({ id: "b", unit: "2", name: "Kitchen" }),
      room({ id: "c", unit: "10", name: "Bath" }),
      room({ id: "d", unit: "2", name: "Bath" }),
    ];
    expect(sortRooms(rooms).map((r) => r.id)).toEqual(["b", "d", "a", "c"]);
  });

  it("keeps the existing order inside a unit rather than sorting by name", () => {
    const rooms = [
      room({ id: "a", unit: "3", name: "Zed" }),
      room({ id: "b", unit: "3", name: "Alpha" }),
    ];
    expect(sortRooms(rooms).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("floats un-unitted rooms above the units", () => {
    const rooms = [
      room({ id: "a", unit: "2", name: "Kitchen" }),
      room({ id: "b", name: "Common hallway" }),
    ];
    expect(sortRooms(rooms).map((r) => r.id)).toEqual(["b", "a"]);
  });
});

describe("grouping rooms by unit", () => {
  it("returns one unlabelled group for a house", () => {
    const groups = groupRoomsByUnit([room({ name: "Kitchen" }), room({ name: "Bath" })]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.unit).toBeNull();
    expect(groups[0]!.label).toBeNull();
    expect(groups[0]!.rooms.map((r) => r.name)).toEqual(["Kitchen", "Bath"]);
  });

  it("splits a building into one block per unit, in natural order", () => {
    const groups = groupRoomsByUnit([
      room({ id: "a", unit: "10", name: "Kitchen" }),
      room({ id: "b", unit: "2", name: "Kitchen" }),
      room({ id: "c", unit: "2", name: "Bath" }),
    ]);
    expect(groups.map((g) => g.label)).toEqual(["Unit 2", "Unit 10"]);
    expect(groups[0]!.rooms.map((r) => r.id)).toEqual(["b", "c"]);
  });

  it("treats 4b and 4B as the same unit", () => {
    const groups = groupRoomsByUnit([
      room({ id: "a", unit: "4B", name: "Kitchen" }),
      room({ id: "b", unit: "4b", name: "Bath" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.label).toBe("Unit 4B");
  });

  it("keeps the un-unitted rooms in their own leading block", () => {
    const groups = groupRoomsByUnit([
      room({ id: "a", unit: "1", name: "Kitchen" }),
      room({ id: "b", name: "Lobby" }),
    ]);
    expect(groups.map((g) => g.label)).toEqual([null, "Unit 1"]);
  });
});

describe("planRoomFolders", () => {
  const folder = (over: Partial<RoomFolderRow> & { id: string; name: string }): RoomFolderRow => ({
    room_id: null,
    parent_folder_id: null,
    sort_order: 0,
    ...over,
  });

  it("creates a root folder for a room on a house", () => {
    const plan = planRoomFolders([room({ id: "r1", name: "Kitchen" })], [], {});
    expect(plan.unitsToCreate).toEqual([]);
    expect(plan.actions).toEqual([
      {
        kind: "create",
        room: expect.objectContaining({ id: "r1" }),
        unit: null,
        parentFolderId: null,
      },
    ]);
  });

  it("asks for the unit folder once and files each room under it", () => {
    const plan = planRoomFolders(
      [
        room({ id: "a", unit: "100", name: "Kitchen" }),
        room({ id: "b", unit: "100", name: "Bath" }),
      ],
      [],
      {},
    );
    expect(plan.unitsToCreate).toEqual(["Unit 100"]);
    expect(plan.actions.map((a) => a.kind)).toEqual(["create", "create"]);
    expect(plan.actions.every((a) => a.kind === "create" && a.unit === "Unit 100")).toBe(true);
  });

  it("adopts a folder a template already made at the room's path", () => {
    const folders = [
      folder({ id: "u", name: "Unit 100" }),
      folder({ id: "k", name: "kitchen", parent_folder_id: "u" }),
    ];
    const plan = planRoomFolders([room({ id: "r1", unit: "100", name: "Kitchen" })], folders, {});
    expect(plan.unitsToCreate).toEqual([]);
    expect(plan.actions).toEqual([{ kind: "adopt", room: expect.anything(), folderId: "k" }]);
  });

  it("finds the unit folder by the bare unit as typed", () => {
    const folders = [folder({ id: "u", name: "100" })];
    const plan = planRoomFolders([room({ id: "r1", unit: "100", name: "Kitchen" })], folders, {});
    expect(plan.unitsToCreate).toEqual([]);
    expect(plan.actions).toEqual([
      { kind: "create", room: expect.anything(), unit: "Unit 100", parentFolderId: "u" },
    ]);
  });

  it("leaves a folder that is already right alone", () => {
    const folders = [folder({ id: "k", name: "Kitchen", room_id: "r1" })];
    const plan = planRoomFolders([room({ id: "r1", name: "Kitchen" })], folders, {});
    expect(plan.actions).toEqual([
      { kind: "keep", room: expect.anything(), folderId: "k", reason: "current" },
    ]);
  });

  it("renames an empty folder to follow its room", () => {
    const folders = [folder({ id: "k", name: "Kitchen", room_id: "r1" })];
    const plan = planRoomFolders([room({ id: "r1", name: "Kitchenette" })], folders, {});
    expect(plan.actions).toEqual([
      {
        kind: "update",
        room: expect.anything(),
        folderId: "k",
        name: "Kitchenette",
        unit: null,
        parentFolderId: null,
      },
    ]);
  });

  it("moves an empty folder under the unit its room was given", () => {
    const folders = [folder({ id: "k", name: "Kitchen", room_id: "r1" })];
    const plan = planRoomFolders([room({ id: "r1", unit: "4B", name: "Kitchen" })], folders, {});
    expect(plan.unitsToCreate).toEqual(["Unit 4B"]);
    expect(plan.actions).toEqual([
      {
        kind: "update",
        room: expect.anything(),
        folderId: "k",
        name: "Kitchen",
        unit: "Unit 4B",
        parentFolderId: null,
      },
    ]);
  });

  it("never renames or moves a folder that holds photos", () => {
    const folders = [folder({ id: "k", name: "Kitchen", room_id: "r1" })];
    const plan = planRoomFolders([room({ id: "r1", unit: "4B", name: "Kitchenette" })], folders, {
      k: 3,
    });
    expect(plan.unitsToCreate).toEqual([]);
    expect(plan.actions).toEqual([
      { kind: "keep", room: expect.anything(), folderId: "k", reason: "has_photos" },
    ]);
  });

  it("does not hand one folder to two rooms", () => {
    const folders = [folder({ id: "k", name: "Kitchen", room_id: "r1" })];
    const plan = planRoomFolders(
      [room({ id: "r1", name: "Kitchen" }), room({ id: "r2", name: "kitchen" })],
      folders,
      {},
    );
    expect(plan.actions.map((a) => a.kind)).toEqual(["keep", "skip"]);
  });

  it("does not create two folders of one name in one unit", () => {
    const plan = planRoomFolders(
      [room({ id: "r1", unit: "1", name: "Bath" }), room({ id: "r2", unit: "1", name: "bath" })],
      [],
      {},
    );
    expect(plan.actions.map((a) => a.kind)).toEqual(["create", "skip"]);
    expect(plan.unitsToCreate).toEqual(["Unit 1"]);
  });

  it("keeps rooms of two units apart even when they share a name", () => {
    const plan = planRoomFolders(
      [room({ id: "r1", unit: "1", name: "Bath" }), room({ id: "r2", unit: "2", name: "Bath" })],
      [],
      {},
    );
    expect(plan.actions.map((a) => a.kind)).toEqual(["create", "create"]);
    expect(plan.unitsToCreate).toEqual(["Unit 1", "Unit 2"]);
  });

  it("never plans a delete", () => {
    const folders = [folder({ id: "old", name: "Garage", room_id: "gone" })];
    const plan = planRoomFolders([room({ id: "r1", name: "Kitchen" })], folders, {});
    expect(plan.actions.map((a) => a.kind)).toEqual(["create"]);
  });
});

describe("folderPhotoCounts", () => {
  it("counts a photo for its folder and every folder above it", () => {
    const folders: RoomFolderRow[] = [
      { id: "u", name: "Unit 1", room_id: null, parent_folder_id: null, sort_order: 0 },
      { id: "k", name: "Kitchen", room_id: "r", parent_folder_id: "u", sort_order: 0 },
      { id: "b", name: "Before", room_id: null, parent_folder_id: "k", sort_order: 0 },
    ];
    expect(folderPhotoCounts(folders, ["b", "b", "u", null])).toEqual({ b: 2, k: 2, u: 3 });
  });
});
