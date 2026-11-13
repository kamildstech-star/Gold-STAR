import { describe, expect, it } from "vitest";

import type { MoisturePoint, MoistureReading } from "@/lib/drying-materials";
import { MOISTURE_MATERIAL_LABEL } from "@/lib/drying-materials";
import { buildDryingLog, type DryingReading } from "@/lib/drying-log";
import { dryingLogWorkbook } from "@/lib/drying-log-export";
import {
  UNASSIGNED_AREA_KEY,
  buildDryingReportData,
  calendarDays,
  conditionsSeries,
  dryingReportFilename,
  equipmentByDay,
  equipmentByRoom,
  groupAreas,
  lastOfDay,
  moistureChart,
  outsideConditions,
  readingGpp,
  schematicLayout,
  type ReportPlacement,
} from "@/lib/drying-report";
import { summarizePoint } from "@/lib/drying-materials";
import { roomLabel, type JobRoom } from "@/lib/job-rooms";
import { grainsPerPound } from "@/lib/psychrometrics";

/**
 * Mark, 2026-10-06: "there needs to be a way to run a report that can make
 * something like this for each job" — a MoistureMapper drying report. These
 * pin the arithmetic under its charts: the grains, the gaps, the equipment
 * counts and which area a reading belongs to.
 */

let seq = 0;
function reading(over: Partial<DryingReading> & { reading_date: string }): DryingReading {
  seq += 1;
  return {
    id: `r${seq}`,
    job_id: "job-1",
    room_id: null,
    equipment_id: null,
    point: "affected",
    label: null,
    source: "manual",
    source_detail: null,
    temperature_f: 75,
    relative_humidity: 60,
    dew_point_f: 60,
    grains_per_pound: 78,
    notes: null,
    captured_at: `${over.reading_date}T15:00:00Z`,
    observed_at: null,
    created_by: null,
    created_at: `${over.reading_date}T15:00:00Z`,
    updated_at: `${over.reading_date}T15:00:00Z`,
    is_demo: false,
    is_baseline: false,
    ...over,
  } as DryingReading;
}

function room(id: string, name: string, over: Partial<JobRoom> = {}): JobRoom {
  return {
    id,
    job_id: "job-1",
    unit: null,
    name,
    floor: null,
    length_ft: null,
    width_ft: null,
    height_ft: null,
    affected_materials: [],
    notes: null,
    flooring: null,
    extra_sf: 0,
    sort_order: 0,
    ...over,
  };
}

function placement(over: Partial<ReportPlacement> & { placed_at: string }): ReportPlacement {
  seq += 1;
  return {
    id: `p${seq}`,
    room_id: null,
    retrieved_at: null,
    equipment_type: "air_mover",
    asset_tag: null,
    ...over,
  };
}

describe("grains per pound", () => {
  /*
   * Reference values. 70 °F / 50% is the textbook psychrometric-chart point
   * (~55 gr/lb). The other four are read off the MoistureMapper sample's own
   * Outside Conditions chart (5622 Delmare Blvd). Our figure lands within one
   * grain of every one of them; the sample sits ~0.3 gr higher throughout,
   * consistent with a slightly different vapour-pressure fit on their side.
   */
  it.each([
    [70, 50, 55],
    [65, 45, 41.32],
    [67, 47, 46.32],
    [64, 56, 49.75],
    [69, 63, 66.82],
    [71, 72, 82],
    [73, 33, 40],
  ])("%s F at %s%% RH is within 1 gr of %s", (t, rh, expected) => {
    expect(Math.abs(grainsPerPound(t, rh)! - expected)).toBeLessThanOrEqual(1);
  });

  it("uses the stored figure, and derives it only when the row has none", () => {
    expect(readingGpp({ grains_per_pound: 81.5, temperature_f: 0, relative_humidity: 1 })).toBe(
      81.5,
    );
    expect(
      readingGpp({ grains_per_pound: null, temperature_f: 70, relative_humidity: 50 }),
    ).toBeCloseTo(54.4, 1);
    expect(
      readingGpp({ grains_per_pound: null, temperature_f: null, relative_humidity: 50 }),
    ).toBeNull();
  });
});

describe("days into chart series", () => {
  const rows = [
    reading({ reading_date: "2026-05-23", room_id: "k", temperature_f: 80, relative_humidity: 70 }),
    reading({ reading_date: "2026-05-26", room_id: "k", temperature_f: 76, relative_humidity: 50 }),
    reading({ reading_date: "2026-05-27", room_id: "k", temperature_f: 74, relative_humidity: 40 }),
  ];
  const log = buildDryingLog(rows, { today: "2026-05-30" });
  const key = log.series[0]!.key;

  it("keeps a day nobody logged as a gap — null, never zero", () => {
    const c = conditionsSeries(log.days, [key]);
    expect(c.dates).toEqual(["2026-05-23", "2026-05-24", "2026-05-25", "2026-05-26", "2026-05-27"]);
    expect(c.temperatureF).toEqual([80, null, null, 76, 74]);
    expect(c.relativeHumidity).toEqual([70, null, null, 50, 40]);
    expect(c.gpp[1]).toBeNull();
    expect(c.temperatureF).not.toContain(0);
  });

  it("trims the empty days after the last reading, which the log runs on to today", () => {
    expect(log.days.map((d) => d.date)).toContain("2026-05-30");
    expect(conditionsSeries(log.days, [key]).dates.at(-1)).toBe("2026-05-27");
  });

  it("judges a day on its last reading", () => {
    const a = reading({
      reading_date: "2026-05-23",
      captured_at: "2026-05-23T20:00:00Z",
      temperature_f: 71,
    });
    const b = reading({
      reading_date: "2026-05-23",
      captured_at: "2026-05-23T13:00:00Z",
      temperature_f: 90,
    });
    expect(lastOfDay([b, a])?.temperature_f).toBe(71);
    expect(lastOfDay([])).toBeNull();
  });

  it("puts a crew's outside reading over the model's, and flags the model's days", () => {
    const outside = buildDryingLog(
      [
        reading({
          reading_date: "2026-05-23",
          point: "exterior",
          source: "weather",
          temperature_f: 60,
          observed_at: "2026-05-23T13:00:00Z",
        }),
        reading({ reading_date: "2026-05-23", point: "exterior", temperature_f: 65 }),
        reading({
          reading_date: "2026-05-24",
          point: "exterior",
          source: "weather",
          temperature_f: 62,
          observed_at: "2026-05-24T13:00:00Z",
        }),
      ],
      { today: "2026-05-24" },
    );
    const c = outsideConditions(outside);
    expect(c.temperatureF).toEqual([65, 62]);
    expect(c.modelled).toEqual([false, true]);
  });

  it("has no dates at all when nothing was measured", () => {
    expect(outsideConditions(buildDryingLog([], { today: "2026-05-24" })).dates).toEqual([]);
  });

  it("walks calendar days across a DST change", () => {
    expect(calendarDays("2026-03-07", "2026-03-10")).toEqual([
      "2026-03-07",
      "2026-03-08",
      "2026-03-09",
      "2026-03-10",
    ]);
  });
});

describe("equipment on site per day", () => {
  it("counts each unit from drop-off to pickup, both days inclusive, in Eastern time", () => {
    const eq = equipmentByDay(
      [
        // 9pm Eastern on the 23rd is still the 23rd, though it is the 24th in UTC.
        placement({ placed_at: "2026-05-24T01:00:00Z", retrieved_at: "2026-05-25T15:00:00Z" }),
        placement({ placed_at: "2026-05-23T14:00:00Z", equipment_type: "dehumidifier" }),
        placement({ placed_at: "2026-05-24T14:00:00Z" }),
      ],
      "2026-05-26",
    );
    expect(eq.dates).toEqual(["2026-05-23", "2026-05-24", "2026-05-25", "2026-05-26"]);
    expect(eq.types).toEqual(["air_mover", "dehumidifier"]);
    expect(eq.counts.air_mover).toEqual([1, 2, 2, 1]);
    expect(eq.counts.dehumidifier).toEqual([1, 1, 1, 1]);
    expect(eq.labels.air_mover).toBe("Air mover");
  });

  it("ends at the last pickup once everything is back, not at today", () => {
    const eq = equipmentByDay(
      [placement({ placed_at: "2026-05-23T14:00:00Z", retrieved_at: "2026-05-24T14:00:00Z" })],
      "2026-06-30",
    );
    expect(eq.dates).toEqual(["2026-05-23", "2026-05-24"]);
  });

  it("keeps a unit with no type as Other, and ignores a placement with no date", () => {
    const eq = equipmentByDay(
      [
        placement({ placed_at: "2026-05-23T14:00:00Z", equipment_type: null }),
        placement({ placed_at: "" }),
      ],
      "2026-05-23",
    );
    expect(eq.types).toEqual(["other"]);
    expect(eq.counts.other).toEqual([1]);
  });

  it("is empty with no placements", () => {
    expect(equipmentByDay([], "2026-05-23")).toEqual({
      dates: [],
      types: [],
      labels: {},
      counts: {},
    });
  });

  it("counts what went into each room", () => {
    const m = equipmentByRoom([
      placement({ placed_at: "2026-05-23T14:00:00Z", room_id: "k" }),
      placement({ placed_at: "2026-05-23T14:00:00Z", room_id: "k" }),
      placement({
        placed_at: "2026-05-23T14:00:00Z",
        room_id: "k",
        equipment_type: "dehumidifier",
      }),
      placement({ placed_at: "2026-05-23T14:00:00Z" }),
    ]);
    expect([...m.get("k")!]).toEqual([
      ["air_mover", 2],
      ["dehumidifier", 1],
    ]);
    expect(m.size).toBe(1);
  });
});

describe("areas", () => {
  const rooms = [room("k", "Kitchen"), room("b", "Bedroom"), room("h", "Hall")];
  const point = (id: string, roomId: string | null, standard: number | null): MoisturePoint => ({
    id,
    job_id: "job-1",
    room_id: roomId,
    material: "drywall",
    location: "north wall",
    dry_standard: standard,
    removed_at: null,
    created_at: "2026-05-23T14:00:00Z",
  });
  const mr = (pointId: string, date: string, pct: number): MoistureReading => ({
    id: `${pointId}-${date}`,
    point_id: pointId,
    job_id: "job-1",
    reading_date: date,
    moisture_pct: pct,
    captured_at: `${date}T15:00:00Z`,
  });

  const log = buildDryingLog(
    [
      reading({ reading_date: "2026-05-23", room_id: "b", point: "interior" }),
      reading({ reading_date: "2026-05-23", point: "affected", label: "Basement" }),
      reading({ reading_date: "2026-05-23", room_id: "gone", point: "affected" }),
      reading({ reading_date: "2026-05-23", point: "exterior" }),
      reading({
        reading_date: "2026-05-23",
        point: "dehu_inlet",
        label: "DH-1",
        equipment_id: "e1",
      }),
    ],
    { today: "2026-05-23", roomNames: new Map(rooms.map((r) => [r.id, r.name])) },
  );

  const areas = groupAreas({
    log,
    rooms,
    placements: [placement({ placed_at: "2026-05-23T14:00:00Z", room_id: "k" })],
    moisture: {
      points: [point("m1", "b", 10), point("m2", null, null)],
      readings: [mr("m1", "2026-05-23", 30), mr("m1", "2026-05-25", 12)],
    },
    materialLabel: MOISTURE_MATERIAL_LABEL,
    roomLabel,
  });

  it("walks rooms in the Rooms tab's order, and only rooms where something happened", () => {
    expect(areas.map((a) => a.key)).toEqual(["k", "b", UNASSIGNED_AREA_KEY]);
  });

  it("gives a room its series, moisture points and equipment", () => {
    const bedroom = areas.find((a) => a.key === "b")!;
    expect(bedroom.series.map((s) => s.series.label)).toEqual(["Inside — Bedroom"]);
    expect(bedroom.moisture.map((m) => m.point.id)).toEqual(["m1"]);
    expect(areas.find((a) => a.key === "k")!.placements).toHaveLength(1);
  });

  it("keeps readings with no room — or a deleted one — rather than dropping them", () => {
    const rest = areas.find((a) => a.key === UNASSIGNED_AREA_KEY)!;
    expect(rest.series.map((s) => s.series.point)).toEqual(["affected", "affected"]);
    expect(rest.moisture.map((m) => m.point.id)).toEqual(["m2"]);
  });

  it("leaves the outside and the dehumidifier pair out of the areas", () => {
    const points = areas.flatMap((a) => a.series.map((s) => s.series.point));
    expect(points).not.toContain("exterior");
    expect(points).not.toContain("dehu_inlet");
  });

  it("charts a moisture point across its days with its dry goal, gaps as gaps", () => {
    const chart = areas.find((a) => a.key === "b")!.moistureChart!;
    expect(chart.dates).toEqual(["2026-05-23", "2026-05-24", "2026-05-25"]);
    expect(chart.lines[0]).toMatchObject({
      name: "Drywall, north wall",
      values: [30, null, 12],
      goal: 11,
    });
  });

  it("draws no moisture chart for points nobody has read yet", () => {
    expect(areas.find((a) => a.key === UNASSIGNED_AREA_KEY)!.moistureChart).toBeNull();
    expect(
      moistureChart([summarizePoint(point("x", null, 10), [])], MOISTURE_MATERIAL_LABEL),
    ).toBeNull();
  });
});

describe("room schematic", () => {
  const label = (r: { unit: string | null; name: string }) => roomLabel(r);

  it("draws sized rooms to scale, longer side across, and keeps unsized ones", () => {
    const l = schematicLayout(
      [
        room("a", "Living", { length_ft: 10, width_ft: 20 }),
        room("b", "Closet", { length_ft: 5, width_ft: 4 }),
        room("c", "Hall"),
      ],
      { width: 500, height: 200 },
      label,
    );
    const a = l.rects.find((r) => r.roomId === "a")!;
    expect(a.w / a.h).toBeCloseTo(2, 1);
    expect(a.dims).toBe("10' x 20'");
    expect(l.rects.find((r) => r.roomId === "c")!.dims).toBeNull();
    expect(l.scale).not.toBeNull();
    for (const r of l.rects) {
      expect(r.x + r.w).toBeLessThanOrEqual(500 + 0.001);
      expect(r.y + r.h).toBeLessThanOrEqual(200 + 0.001);
    }
  });

  it("bands rooms by floor when floors are recorded", () => {
    const l = schematicLayout(
      [room("a", "Kitchen", { floor: "1st" }), room("b", "Bedroom", { floor: "2nd" })],
      { width: 400, height: 200 },
      label,
    );
    expect(l.floors.map((f) => f.label)).toEqual(["1st", "2nd"]);
    expect(l.rects[1]!.y).toBeGreaterThan(l.rects[0]!.y);
  });

  it("never drops a room, even when they cannot all fit", () => {
    const many = Array.from({ length: 80 }, (_, i) => room(`r${i}`, `Room ${i}`));
    expect(schematicLayout(many, { width: 300, height: 60 }, label).rects).toHaveLength(80);
  });

  it("prints feet and inches", () => {
    const l = schematicLayout(
      [room("a", "A", { length_ft: 12.5, width_ft: 10 })],
      { width: 300, height: 100 },
      label,
    );
    expect(l.rects[0]!.dims).toBe(`12' 6" x 10'`);
  });
});

describe("the whole report", () => {
  it("carries the workbook's sheets verbatim, so the two files cannot disagree", () => {
    const rows = [
      reading({ reading_date: "2026-05-23", point: "exterior" }),
      reading({ reading_date: "2026-05-25", room_id: "k", point: "interior" }),
    ];
    const rooms = [room("k", "Kitchen")];
    const input = {
      rows,
      rooms,
      roomLabel,
      placements: [],
      moisture: null,
      materialLabel: MOISTURE_MATERIAL_LABEL,
      jobNumber: "GS-1",
      address: "5622 Delmare Blvd",
      today: "2026-05-26",
      timeZone: "America/New_York",
    };
    const data = buildDryingReportData(input);
    expect(data.sheets).toEqual(
      dryingLogWorkbook({
        rows,
        roomNames: new Map([["k", "Kitchen"]]),
        jobNumber: "GS-1",
        address: "5622 Delmare Blvd",
        today: "2026-05-26",
        timeZone: "America/New_York",
      }),
    );
    expect(data.log.gaps).toEqual(["2026-05-24", "2026-05-26"]);
    expect(data.moisturePoints).toBeNull();
  });

  it("names the file after the job and the day", () => {
    expect(dryingReportFilename("GS 24/0912", "2026-05-28")).toBe(
      "drying-report-GS-24-0912-2026-05-28.pdf",
    );
    expect(dryingReportFilename(null, "2026-05-28")).toBe("drying-report-2026-05-28.pdf");
  });
});
