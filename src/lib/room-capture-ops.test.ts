import { describe, expect, it } from "vitest";

import type { JobRoom } from "./job-rooms";
import { applyHeldOps, roomCaptureOpLabel, type CaptureState } from "./room-capture-ops";
import type { RoomOpening } from "./room-takeoff";

const room = (id: string, over: Partial<JobRoom> = {}): JobRoom => ({
  id,
  job_id: "job",
  unit: null,
  name: id,
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

const door: RoomOpening = {
  id: "d1",
  job_id: "job",
  room_id: "kitchen",
  kind: "interior_door",
  width_in: 30,
  height_in: 80,
  qty: 1,
};

const base: CaptureState = {
  rooms: [room("kitchen"), room("bath")],
  openings: [door],
  cabinets: [],
};

describe("held capture ops laid over the server's copy", () => {
  it("shows a measurement made with no signal on the room it was made on", () => {
    const out = applyHeldOps(base, [
      { op: "measure", roomId: "kitchen", patch: { length_ft: 12.5, width_ft: 10 } },
    ]);
    expect(out.rooms.find((r) => r.id === "kitchen")).toMatchObject({
      length_ft: 12.5,
      width_ft: 10,
    });
    expect(out.rooms.find((r) => r.id === "bath")!.length_ft).toBeNull();
  });

  it("adds, edits and removes doors in the order they were made", () => {
    const out = applyHeldOps(base, [
      {
        op: "opening_add",
        row: { ...door, id: "d2", kind: "window", created_by: "u1" },
      },
      { op: "opening_patch", id: "d2", patch: { width_in: 40 } },
      { op: "opening_delete", id: "d1" },
    ]);
    expect(out.openings).toEqual([{ ...door, id: "d2", kind: "window", width_in: 40 }]);
  });

  it("is harmless to apply after the server already has the change", () => {
    const added = {
      op: "opening_add" as const,
      row: { ...door, created_by: "u1" },
    };
    // d1 is already on the server: the overlay must not list it twice.
    expect(applyHeldOps(base, [added]).openings).toHaveLength(1);
    expect(applyHeldOps(base, [{ op: "opening_delete", id: "gone" }]).openings).toEqual([door]);
  });

  it("does the same for cabinet runs", () => {
    const out = applyHeldOps(base, [
      {
        op: "cabinet_add",
        row: {
          id: "c1",
          job_id: "job",
          room_id: "kitchen",
          kind: "base",
          length_ft: null,
          created_by: null,
        },
      },
      { op: "cabinet_patch", id: "c1", patch: { length_ft: 8.5 } },
    ]);
    expect(out.cabinets).toEqual([
      { id: "c1", job_id: "job", room_id: "kitchen", kind: "base", length_ft: 8.5 },
    ]);
    expect(applyHeldOps(out, [{ op: "cabinet_delete", id: "c1" }]).cabinets).toEqual([]);
  });

  it("leaves the server's copy alone", () => {
    applyHeldOps(base, [{ op: "measure", roomId: "kitchen", patch: { length_ft: 3 } }]);
    expect(base.rooms[0]!.length_ft).toBeNull();
  });

  it("names each op for the pending-work list", () => {
    expect(roomCaptureOpLabel({ op: "measure", roomId: "k", patch: {} }, "Unit 4B · Kitchen")).toBe(
      "Room measurements · Unit 4B · Kitchen",
    );
    expect(roomCaptureOpLabel({ op: "cabinet_delete", id: "c" })).toBe("Cabinet run");
  });
});
