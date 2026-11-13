import { describe, expect, it } from "vitest";

import {
  DEFAULT_WALL_HEIGHT_FT,
  OPENING_KINDS,
  jobTakeoff,
  openingMeta,
  roomFloorSf,
  roomTakeoff,
  type RoomCabinet,
  type RoomOpening,
  type TakeoffRoomInput,
} from "./room-takeoff";
import { parseFeet } from "./tape-measure";

const room = (over: Partial<TakeoffRoomInput> = {}): TakeoffRoomInput => ({
  id: "r1",
  length_ft: null,
  width_ft: null,
  height_ft: null,
  extra_sf: 0,
  flooring: null,
  ...over,
});

let seq = 0;
const opening = (over: Partial<RoomOpening> = {}): RoomOpening => ({
  id: `o${++seq}`,
  job_id: "job",
  room_id: "r1",
  kind: "interior_door",
  width_in: 30,
  height_in: 80,
  qty: 1,
  ...over,
});
const cabinet = (over: Partial<RoomCabinet> = {}): RoomCabinet => ({
  id: `c${++seq}`,
  job_id: "job",
  room_id: "r1",
  kind: "base",
  length_ft: 10,
  ...over,
});

describe("floor area", () => {
  it("is the package's own check: 12'6\" × 10' is 125 SF", () => {
    const length = parseFeet(`12'6"`);
    const width = parseFeet(`10'`);
    expect(length).toBe(12.5);
    expect(width).toBe(10);
    expect(roomFloorSf(room({ length_ft: length, width_ft: width }))).toBe(125);
    expect(roomTakeoff(room({ length_ft: length, width_ft: width }), [], []).floorSf).toBe(125);
  });

  it("adds and takes off the +/- SF for L-shapes and bump-outs", () => {
    expect(roomFloorSf(room({ length_ft: 12, width_ft: 10, extra_sf: 24 }))).toBe(144);
    expect(roomFloorSf(room({ length_ft: 12, width_ft: 10, extra_sf: -20 }))).toBe(100);
  });

  it("never goes below zero", () => {
    expect(roomFloorSf(room({ length_ft: 5, width_ft: 5, extra_sf: -100 }))).toBe(0);
  });

  it("is nothing — not zero — until length and width are both in", () => {
    expect(roomFloorSf(room({ length_ft: 12 }))).toBeNull();
    expect(roomFloorSf(room({ width_ft: 10, extra_sf: 30 }))).toBeNull();
    expect(roomTakeoff(room({ length_ft: 12 }), [], []).measured).toBe(false);
  });

  it("rounds to a tenth", () => {
    expect(roomFloorSf(room({ length_ft: 12.5, width_ft: 10 + 4 / 12 }))).toBe(129.2);
  });

  it("tolerates a missing extra_sf (rooms read before the migration)", () => {
    expect(roomFloorSf({ length_ft: 10, width_ft: 10, height_ft: null })).toBe(100);
  });
});

describe("walls and baseboard", () => {
  it("takes walls as 8 ft when the ceiling was not measured, and says so", () => {
    const t = roomTakeoff(room({ length_ft: 12, width_ft: 10 }), [], []);
    expect(t.perimeterLf).toBe(44);
    expect(t.wallSf).toBe(44 * DEFAULT_WALL_HEIGHT_FT);
    expect(t.heightAssumed).toBe(true);
    expect(t.baseboardLf).toBe(44);
  });

  it("uses the measured ceiling when there is one", () => {
    const t = roomTakeoff(room({ length_ft: 12, width_ft: 10, height_ft: 9 }), [], []);
    expect(t.wallSf).toBe(396);
    expect(t.heightAssumed).toBe(false);
  });

  it("takes every opening off the wall, and doors and cased openings off the baseboard", () => {
    const t = roomTakeoff(
      room({ length_ft: 12, width_ft: 10 }),
      [
        opening({ kind: "interior_door", width_in: 30, height_in: 80 }),
        opening({ kind: "window", width_in: 36, height_in: 48 }),
        opening({ kind: "cased_opening", width_in: 36, height_in: 80 }),
      ],
      [],
    );
    // 352 − (30×80 + 36×48 + 36×80)/144 = 352 − 48.67
    expect(t.wallSf).toBe(303.3);
    // Baseboard runs under the window: 44 − 2.5 − 3
    expect(t.baseboardLf).toBe(38.5);
  });

  it("counts quantity on every figure", () => {
    const t = roomTakeoff(
      room({ length_ft: 20, width_ft: 20 }),
      [opening({ kind: "window", width_in: 36, height_in: 48, qty: 3 })],
      [],
    );
    expect(t.windows).toBe(3);
    expect(t.wallSf).toBe(round1(80 * 8 - 3 * ((36 * 48) / 144)));
  });

  it("has no walls or baseboard until the room is measured", () => {
    const t = roomTakeoff(room(), [opening()], []);
    expect(t.wallSf).toBe(0);
    expect(t.baseboardLf).toBe(0);
    expect(t.heightAssumed).toBe(false);
  });
});

describe("doors", () => {
  it("counts a bifold or slider pair as two slabs and one opening", () => {
    const t = roomTakeoff(room(), [opening({ kind: "closet_double", width_in: 48 })], []);
    expect(t.doorOpenings).toBe(1);
    expect(t.doorSlabs).toBe(2);
  });

  it("tracks cased openings and windows without counting them as doors", () => {
    const t = roomTakeoff(
      room(),
      [opening({ kind: "cased_opening" }), opening({ kind: "window" })],
      [],
    );
    expect(t.doorOpenings).toBe(0);
    expect(t.doorSlabs).toBe(0);
    expect(t.casedOpenings).toBe(1);
    expect(t.windows).toBe(1);
  });

  it('adds a 30" door as one slab', () => {
    const t = roomTakeoff(room({ length_ft: 12.5, width_ft: 10 }), [opening()], []);
    expect(t.doorSlabs).toBe(1);
    expect(t.baseboardLf).toBe(42.5);
  });

  it("knows every kind the database allows", () => {
    expect(OPENING_KINDS.map((k) => k.value).sort()).toEqual(
      [
        "cased_opening",
        "closet_double",
        "closet_single",
        "entry_door",
        "interior_door",
        "patio_door",
        "pocket_door",
        "window",
      ].sort(),
    );
    expect(openingMeta("closet_double").slabs).toBe(2);
    expect(OPENING_KINDS.filter((k) => !k.isDoor).map((k) => k.value)).toEqual([
      "cased_opening",
      "window",
    ]);
  });
});

describe("cabinets", () => {
  it("adds runs up by kind, in linear feet", () => {
    const t = roomTakeoff(
      room(),
      [],
      [
        cabinet({ kind: "base", length_ft: 8.5 }),
        cabinet({ kind: "base", length_ft: 4 }),
        cabinet({ kind: "upper", length_ft: 6 }),
        cabinet({ kind: "vanity", length_ft: null }),
      ],
    );
    expect(t.cabinetLf).toEqual({ base: 12.5, upper: 6, tall: 0, vanity: 0 });
    expect(t.cabinetLfTotal).toBe(18.5);
  });
});

describe("per unit and per job", () => {
  const r101k = room({ id: "101k", length_ft: 12.5, width_ft: 10, flooring: "LVP (wood-look)" });
  const r101b = room({ id: "101b", length_ft: 10, width_ft: 10, flooring: "Carpet" });
  const r102k = room({ id: "102k", length_ft: 12.5, width_ft: 10, flooring: "LVP (wood-look)" });
  const r102x = room({ id: "102x" });

  const result = jobTakeoff(
    [
      { unit: "101", label: "Unit 101", rooms: [r101k, r101b] },
      { unit: "102", label: "Unit 102", rooms: [r102k, r102x] },
    ],
    [
      opening({ room_id: "101k", kind: "closet_double" }),
      opening({ room_id: "101b" }),
      opening({ room_id: "102k" }),
    ],
    [cabinet({ room_id: "101k", length_ft: 12 }), cabinet({ room_id: "102k", length_ft: 12 })],
  );

  it("adds rooms into their unit, in the order the tab shows the units", () => {
    expect(result.units.map((u) => u.label)).toEqual(["Unit 101", "Unit 102"]);
    expect(result.units[0]!.floorSf).toBe(225);
    expect(result.units[0]!.doorSlabs).toBe(3);
    expect(result.units[1]!.floorSf).toBe(125);
    expect(result.units[1]!.cabinetLfTotal).toBe(12);
  });

  it("adds every unit into the job", () => {
    expect(result.total.floorSf).toBe(350);
    expect(result.total.doorSlabs).toBe(4);
    expect(result.total.cabinetLf.base).toBe(24);
    expect(result.total.rooms).toBe(4);
  });

  it("says how many rooms are not measured yet instead of hiding them in the total", () => {
    expect(result.units[1]!.unmeasured).toBe(1);
    expect(result.total.unmeasured).toBe(1);
  });

  it("breaks the floor area down by covering", () => {
    expect(result.total.flooringSf).toEqual({ "LVP (wood-look)": 250, Carpet: 100 });
  });

  it("files each room's takeoff with its unit", () => {
    const k = result.rooms.find((x) => x.room.id === "102k")!;
    expect(k.unitLabel).toBe("Unit 102");
    expect(k.takeoff.floorSf).toBe(125);
  });
});

function round1(v: number) {
  return Math.round(v * 10) / 10;
}
