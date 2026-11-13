import { describe, expect, it } from "vitest";

import {
  dryGoal,
  materialStatus,
  materialsByDay,
  parseMoisturePct,
  progressToDry,
  summarizePoint,
  type MoisturePoint,
  type MoistureReading,
} from "./drying-materials";

describe("the dry standard", () => {
  it("allows 10% over the unaffected reference", () => {
    expect(dryGoal(15)).toBe(16.5);
    expect(dryGoal(40)).toBe(44);
  });

  it("never allows less than one point, because the meter's last digit is noise", () => {
    expect(dryGoal(5)).toBe(6);
    expect(dryGoal(0)).toBe(1);
  });

  it("has no goal without a standard", () => {
    expect(dryGoal(null)).toBeNull();
    expect(dryGoal(undefined)).toBeNull();
    expect(dryGoal(-1)).toBeNull();
  });

  it("calls a reading at or under the goal dry, and anything over it wet", () => {
    expect(materialStatus(16.5, 15)).toBe("dry");
    expect(materialStatus(12, 15)).toBe("dry");
    expect(materialStatus(16.6, 15)).toBe("wet");
  });

  it("is never dry without a standard — it is 'no standard yet'", () => {
    expect(materialStatus(2, null)).toBe("no_standard");
    expect(materialStatus(null, 15)).toBe("no_reading");
  });
});

describe("progress toward dry", () => {
  it("measures from the first reading to the goal", () => {
    // goal 16.5; first 36.5 → latest 26.5 is half way.
    expect(progressToDry(36.5, 26.5, 15)).toBe(0.5);
    expect(progressToDry(36.5, 16, 15)).toBe(1);
  });

  it("reads a material that got wetter as no progress, not negative", () => {
    expect(progressToDry(30, 34, 15)).toBe(0);
  });

  it("has nothing to say without a standard or a reading", () => {
    expect(progressToDry(30, 20, null)).toBeNull();
    expect(progressToDry(null, 20, 15)).toBeNull();
  });
});

const point = (over: Partial<MoisturePoint> = {}): MoisturePoint => ({
  id: "p1",
  job_id: "j",
  room_id: null,
  material: "drywall",
  location: "N wall 12in",
  dry_standard: 12,
  removed_at: null,
  created_at: "2026-09-10T15:00:00",
  ...over,
});

const reading = (
  date: string,
  pct: number,
  over: Partial<MoistureReading> = {},
): MoistureReading => ({
  id: `${date}-${pct}`,
  point_id: "p1",
  job_id: "j",
  reading_date: date,
  moisture_pct: pct,
  captured_at: `${date}T15:00:00Z`,
  ...over,
});

describe("one point over the days", () => {
  it("keeps the latest reading per day and records the day the standard was met", () => {
    const s = summarizePoint(point(), [
      reading("2026-09-10", 40),
      reading("2026-09-11", 25, { captured_at: "2026-09-11T09:00:00Z" }),
      reading("2026-09-11", 24, { captured_at: "2026-09-11T17:00:00Z" }),
      reading("2026-09-12", 13),
    ]);
    expect(s.history.map((r) => r.moisture_pct)).toEqual([40, 24, 13]);
    expect(s.status).toBe("dry");
    expect(s.metOn).toBe("2026-09-12");
    expect(s.progress).toBe(1);
  });
});

describe("the timeline line", () => {
  it("counts points in play and how many were dry by each day", () => {
    const points = [point(), point({ id: "p2", dry_standard: 10 })];
    const readings = [
      reading("2026-09-10", 40),
      reading("2026-09-10", 30, { point_id: "p2" }),
      reading("2026-09-12", 12),
    ];
    const days = materialsByDay(points, readings, ["2026-09-10", "2026-09-11", "2026-09-12"]);
    expect(days.get("2026-09-10")).toEqual({ total: 2, dry: 0, read: 2 });
    // Nobody read on the 11th: still two in play, none dry, none read.
    expect(days.get("2026-09-11")).toEqual({ total: 2, dry: 0, read: 0 });
    expect(days.get("2026-09-12")).toEqual({ total: 2, dry: 1, read: 1 });
  });

  it("drops a point from the day its material was removed", () => {
    const days = materialsByDay(
      [point({ removed_at: "2026-09-11T12:00:00" })],
      [reading("2026-09-10", 40)],
      ["2026-09-10", "2026-09-11"],
    );
    expect(days.get("2026-09-10")?.total).toBe(1);
    expect(days.has("2026-09-11")).toBe(false);
  });

  it("leaves a day before any point existed off the line", () => {
    const days = materialsByDay([point()], [], ["2026-09-09", "2026-09-10"]);
    expect(days.has("2026-09-09")).toBe(false);
    expect(days.get("2026-09-10")).toEqual({ total: 1, dry: 0, read: 0 });
  });
});

describe("typing a meter reading", () => {
  it("takes a number and refuses the rest", () => {
    expect(parseMoisturePct(" 17.5 ")).toBe(17.5);
    expect(parseMoisturePct("")).toBeNull();
    expect(parseMoisturePct("-3")).toBeNull();
    expect(parseMoisturePct("wet")).toBeNull();
  });
});
