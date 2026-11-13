import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { buildDailyUpdate, type DailyUpdateTicket } from "@/lib/daily-update";
import {
  MOISTURE_MATERIAL_LABEL,
  type MoisturePoint,
  type MoistureReading,
} from "@/lib/drying-materials";
import type { DryingReading } from "@/lib/drying-log";
import {
  buildDryingReportData,
  windowDryingReport,
  type ReportPlacement,
} from "@/lib/drying-report";
import { roomLabel, type JobRoom } from "@/lib/job-rooms";
import { derive } from "@/lib/psychrometrics";

/**
 * A daily update built the way the Drying log tab builds it: the log cut to
 * end on the day, then the day's ticket. Set DAILY_UPDATE_SAMPLE=<path> to
 * keep the text.
 */

let seq = 0;
function reading(date: string, point: string, t: number, rh: number, room: string | null) {
  seq += 1;
  const { dewPointF, gpp } = derive(t, rh);
  return {
    id: `r${seq}`,
    job_id: "job-1",
    room_id: room,
    equipment_id: null,
    point,
    reading_date: date,
    label: null,
    source: "manual",
    source_detail: null,
    temperature_f: t,
    relative_humidity: rh,
    dew_point_f: dewPointF,
    grains_per_pound: gpp,
    notes: "crew-only note",
    captured_at: `${date}T15:00:00Z`,
    observed_at: null,
    created_by: null,
    created_at: `${date}T15:00:00Z`,
    updated_at: `${date}T15:00:00Z`,
    is_demo: false,
    is_baseline: false,
  } as DryingReading;
}

const ROOMS = (["Kitchen", "Living room"] as const).map((name, i) => ({
  id: name === "Kitchen" ? "kitchen" : "living",
  job_id: "job-1",
  unit: null,
  name,
  floor: null,
  length_ft: 12,
  width_ft: 10,
  height_ft: 9,
  affected_materials: [],
  notes: null,
  flooring: null,
  extra_sf: 0,
  sort_order: i,
})) as JobRoom[];

const ROWS: DryingReading[] = [
  reading("2026-11-09", "exterior", 58, 50, null),
  reading("2026-11-10", "exterior", 59, 48, null),
  reading("2026-11-09", "interior", 74, 62, "kitchen"),
  reading("2026-11-10", "interior", 75, 48, "kitchen"),
  reading("2026-11-10", "interior", 72, 50, "living"),
  reading("2026-11-11", "interior", 74, 40, "kitchen"),
];

const PLACEMENTS: ReportPlacement[] = [
  ...[0, 1, 2].map((i) => ({
    id: `am${i}`,
    room_id: "kitchen",
    placed_at: "2026-11-09T14:00:00Z",
    retrieved_at: null,
    equipment_type: "air_mover",
    asset_tag: `AM-${i}`,
  })),
  {
    id: "dh1",
    room_id: "kitchen",
    placed_at: "2026-11-09T14:00:00Z",
    retrieved_at: null,
    equipment_type: "dehumidifier",
    asset_tag: "DH-1",
  },
];

const POINTS: MoisturePoint[] = ["mp1", "mp2"].map((id) => ({
  id,
  job_id: "job-1",
  room_id: "kitchen",
  material: "drywall",
  location: null,
  dry_standard: 12,
  removed_at: null,
  created_at: "2026-11-09T14:00:00Z",
}));

const MREADINGS: MoistureReading[] = (
  [
    ["mp1", "2026-11-09", 40],
    ["mp1", "2026-11-10", 11],
    ["mp2", "2026-11-09", 45],
    ["mp2", "2026-11-10", 25],
  ] as const
).map(([p, d, v]) => ({
  id: `${p}-${d}`,
  point_id: p,
  job_id: "job-1",
  reading_date: d,
  moisture_pct: v,
  captured_at: `${d}T15:00:00Z`,
})) as MoistureReading[];

const TICKET: DailyUpdateTicket = {
  work_date: "2026-11-10",
  crew_chief_name: "Moshe",
  gsr_crew_size: 2,
  temp_crew_size: 1,
  scope_completed: ["extraction", "demo"],
  work_notes: "Removed 2 ft flood cut in the kitchen",
  job_completed: false,
  more_work_needed: true,
};

function updateFor(date: string, tickets: DailyUpdateTicket[] = [TICKET]) {
  const cut = windowDryingReport(
    {
      rows: ROWS,
      placements: PLACEMENTS,
      moisture: { points: POINTS, readings: MREADINGS },
      today: date,
    },
    null,
    date,
  );
  const drying = buildDryingReportData({
    rows: cut.rows,
    rooms: ROOMS,
    roomLabel,
    placements: cut.placements,
    moisture: cut.moisture,
    materialLabel: MOISTURE_MATERIAL_LABEL,
    jobNumber: "GS-1001",
    address: "12 Main St",
    today: date,
    timeZone: "America/New_York",
  });
  return buildDailyUpdate({
    date,
    address: "12 Main St",
    jobNumber: "GS-1001",
    tickets,
    drying,
  });
}

describe("daily update email (point 7, 11 Nov)", () => {
  const u = updateFor("2026-11-10");

  it("names the place and the day in the subject", () => {
    expect(u.subject).toBe("Daily update: 12 Main St, Tuesday, November 10");
    expect(u.hasContent).toBe(true);
  });

  it("says what the crew did that day, from the ticket", () => {
    expect(u.text).toContain("Work completed: extraction and demo.");
    expect(u.text).toContain("Our crew of 3 was on site led by Moshe.");
    expect(u.text).toContain("Removed 2 ft flood cut in the kitchen.");
  });

  it("gives outside and each room's inside conditions, with the trend", () => {
    expect(u.text).toContain("Outside: 59°F, 48% relative humidity.");
    expect(u.text).toMatch(/• Kitchen: 75°F, 48% relative humidity, drier than yesterday\./);
    expect(u.text).toMatch(/• Living room: 72°F, 50% relative humidity\./);
  });

  it("counts moisture points at their dry standard and equipment on site", () => {
    expect(u.text).toContain(
      "1 of 2 moisture points we monitor have reached their dry standard; the rest are still drying.",
    );
    expect(u.text).toContain("3 air movers and 1 dehumidifier.");
  });

  it("says the crew is coming back when the ticket says more work", () => {
    expect(u.text).toContain("More work is needed; our crew will be back to continue.");
  });

  it("keeps crew-only notes off the email and escapes the HTML", () => {
    expect(u.text).not.toContain("crew-only");
    expect(u.html).toContain("<ul><li>Kitchen:");
    expect(u.html).not.toContain("<script");
  });

  it("does not use a ticket from another day, and says so when a day is empty", () => {
    const later = updateFor("2026-11-11");
    expect(later.text).not.toContain("Moshe");
    const empty = buildDailyUpdate({
      date: "2026-11-12",
      address: "12 Main St",
      jobNumber: null,
      tickets: [TICKET],
      drying: null,
    });
    expect(empty.hasContent).toBe(false);
    expect(empty.text).toContain("Nothing was recorded on site for this day.");
  });

  it("writes a sample when asked", () => {
    const path = process.env.DAILY_UPDATE_SAMPLE;
    if (path) writeFileSync(path, `${u.subject}\n\n${u.text}\n`);
    expect(u.text.length).toBeGreaterThan(100);
  });
});
