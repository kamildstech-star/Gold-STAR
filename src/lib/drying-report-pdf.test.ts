import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  MOISTURE_MATERIAL_LABEL,
  type MoisturePoint,
  type MoistureReading,
} from "@/lib/drying-materials";
import type { DryingReading } from "@/lib/drying-log";
import { derive } from "@/lib/psychrometrics";
import { HEADINGS, SCHEMATIC_NOTE, buildDryingReportPdf } from "@/lib/drying-report-pdf";
import { buildDryingReportData, type ReportPlacement } from "@/lib/drying-report";
import { roomLabel, type JobRoom } from "@/lib/job-rooms";

/**
 * A drying report built from a fixture job shaped like the MoistureMapper
 * sample Mark sent (5622 Delmare Blvd: outside readings 5/23–5/28, air movers
 * going from 4 to 12, one point drying from 100 to 18), then opened with a
 * parser and read back. "It compiled" and "a carrier can open it" are
 * different claims.
 *
 * Set DRYING_REPORT_SAMPLE=<path> to keep the file and look at it.
 */

async function pageText(bytes: Uint8Array): Promise<string> {
  const { PDFDocument, PDFRawStream, decodePDFRawStream } = await import("pdf-lib");
  const doc = await PDFDocument.load(bytes);
  let out = "";
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    try {
      out += new TextDecoder("latin1").decode(decodePDFRawStream(obj).decode());
    } catch {
      // An image stream.
    }
  }
  return out.replace(/<([0-9A-Fa-f]+)>/g, (_m, hex: string) =>
    (hex.match(/../g) ?? []).map((b) => String.fromCharCode(parseInt(b, 16))).join(""),
  );
}

let seq = 0;
function reading(
  date: string,
  point: string,
  t: number,
  rh: number,
  over: Partial<DryingReading> = {},
): DryingReading {
  seq += 1;
  const { dewPointF, gpp } = derive(t, rh);
  return {
    id: `r${seq}`,
    job_id: "job-1",
    room_id: null,
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
    notes: "crew-only note that must not print",
    captured_at: `${date}T15:00:00Z`,
    observed_at: null,
    created_by: null,
    created_at: `${date}T15:00:00Z`,
    updated_at: `${date}T15:00:00Z`,
    is_demo: false,
    is_baseline: false,
    ...over,
  } as DryingReading;
}

const ROOMS: JobRoom[] = [
  ["lobby", "Lobby Area", 17.9, 15],
  ["kitchen", "Kitchen", 16.5, 11],
  ["hall", "Hallway", 47.9, 5],
  ["janitor", "Janitor's Closet", 10.1, 6],
  ["rear", "Rear Bathroom", 8, 6],
  ["front", "Front Bathroom", 8, 6],
  ["gaming", "Gaming Area", 13.3, 12.7],
  ["file", "File Room", null, null],
].map(([id, name, l, w], i) => ({
  id: id as string,
  job_id: "job-1",
  unit: null,
  name: name as string,
  floor: null,
  length_ft: l as number | null,
  width_ft: w as number | null,
  height_ft: 9,
  affected_materials: id === "lobby" ? ["Drywall", "Carpet"] : [],
  notes: null,
  flooring: null,
  extra_sf: 0,
  sort_order: i,
}));

const OUTSIDE: [string, number, number][] = [
  ["2026-05-23", 65, 45],
  ["2026-05-26", 67, 47],
  ["2026-05-27", 64, 56],
  ["2026-05-28", 69, 63],
];

const ROWS: DryingReading[] = [
  ...OUTSIDE.map(([d, t, rh]) =>
    reading(d, "exterior", t, rh, { is_baseline: d === "2026-05-23" }),
  ),
  reading("2026-05-24", "exterior", 70, 60, {
    source: "weather",
    source_detail: "open-meteo 09:00 local",
    observed_at: "2026-05-24T13:00:00Z",
  }),
  ...(
    [
      ["2026-05-23", 71, 72],
      ["2026-05-26", 72, 55],
      ["2026-05-27", 73, 40],
      ["2026-05-28", 73, 33],
    ] as const
  ).map(([d, t, rh]) => reading(d, "affected", t, rh, { room_id: "lobby" })),
  ...(
    [
      ["2026-05-23", 70, 60],
      ["2026-05-28", 71, 45],
    ] as const
  ).map(([d, t, rh]) => reading(d, "interior", t, rh, { room_id: "kitchen" })),
];

const PLACEMENTS: ReportPlacement[] = [
  ...Array.from({ length: 4 }, (_, i) => ({
    id: `am${i}`,
    room_id: "lobby",
    placed_at: "2026-05-23T14:00:00Z",
    retrieved_at: null,
    equipment_type: "air_mover",
    asset_tag: `AM-${100 + i}`,
  })),
  ...Array.from({ length: 8 }, (_, i) => ({
    id: `am2${i}`,
    room_id: i < 3 ? "kitchen" : "hall",
    placed_at: "2026-05-26T14:00:00Z",
    retrieved_at: null,
    equipment_type: "air_mover",
    asset_tag: `AM-${200 + i}`,
  })),
  ...Array.from({ length: 2 }, (_, i) => ({
    id: `dh${i}`,
    room_id: "lobby",
    placed_at: "2026-05-23T14:00:00Z",
    retrieved_at: null,
    equipment_type: "dehumidifier",
    asset_tag: `DH-${i + 1}`,
    hour_meter_start: 1000,
    hour_meter_end: 1120,
  })),
];

const POINTS: MoisturePoint[] = [
  {
    id: "mp1",
    job_id: "job-1",
    room_id: "lobby",
    material: "drywall",
    location: "Point 1, east wall",
    dry_standard: 10,
    removed_at: null,
    created_at: "2026-05-23T14:00:00Z",
  },
  {
    id: "mp2",
    job_id: "job-1",
    room_id: "lobby",
    material: "baseboard",
    location: null,
    dry_standard: null,
    removed_at: null,
    created_at: "2026-05-23T14:00:00Z",
  },
];

const MREADINGS: MoistureReading[] = [
  ["mp1", "2026-05-23", 100],
  ["mp1", "2026-05-26", 42.5],
  ["mp1", "2026-05-27", 28.2],
  ["mp1", "2026-05-28", 9.5],
  ["mp2", "2026-05-23", 35],
  ["mp2", "2026-05-27", 22],
].map(([p, d, v]) => ({
  id: `${p}-${d}`,
  point_id: p as string,
  job_id: "job-1",
  reading_date: d as string,
  moisture_pct: v as number,
  captured_at: `${d}T15:00:00Z`,
}));

function data(
  over: { moisture?: { points: MoisturePoint[]; readings: MoistureReading[] } | null } = {},
) {
  return buildDryingReportData({
    rows: ROWS,
    rooms: ROOMS,
    roomLabel,
    placements: PLACEMENTS,
    moisture: over.moisture === undefined ? { points: POINTS, readings: MREADINGS } : over.moisture,
    materialLabel: MOISTURE_MATERIAL_LABEL,
    jobNumber: "GS-26-0523",
    address: "5622 Delmare Blvd, St. Louis, MO 63112",
    today: "2026-05-28",
    timeZone: "America/New_York",
  });
}

const GENERATED = new Date("2026-05-28T20:00:00Z");
const LOGO = new Uint8Array(readFileSync("public/gold-star-logo.png"));

describe("the drying report PDF", () => {
  it("builds from a fixture job, opens, and says what it is on every page", async () => {
    const bytes = await buildDryingReportPdf({
      data: data(),
      job: {
        customerName: "Delmare Holdings",
        carrier: "Example Mutual",
        claimNumber: "CLM-1",
        lossDate: "2026-05-22",
        lossType: "Water",
        waterCategory: 2,
        waterClass: 3,
      },
      preparedBy: "Field crew",
      generatedAt: GENERATED,
      logoPng: LOGO,
    });
    if (process.env.DRYING_REPORT_SAMPLE) writeFileSync(process.env.DRYING_REPORT_SAMPLE, bytes);

    const { PDFDocument } = await import("pdf-lib");
    const doc = await PDFDocument.load(bytes);
    // Cover, conditions, two areas (lobby, kitchen) + hall (equipment only), readings, moisture, equipment.
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(8);

    const text = await pageText(bytes);
    for (const h of [
      HEADINGS.title,
      HEADINGS.outside,
      HEADINGS.equipment,
      HEADINGS.schematic,
      HEADINGS.moisture,
      HEADINGS.inside,
      HEADINGS.readings,
      HEADINGS.moistureTable,
      HEADINGS.equipmentLog,
    ]) {
      expect(text.includes(h), h).toBe(true);
    }
    // Internal only (David, 27 Oct): the client PDF never lists undocumented days.
    expect(text.toLowerCase()).not.toContain("days with no crew reading");
    expect(text.includes("GS-26-0523"), "GS-26-0523").toBe(true);
    expect(
      text.includes(`Page 1 of ${doc.getPageCount()}`),
      `Page 1 of ${doc.getPageCount()}`,
    ).toBe(true);
    expect(
      text.includes(`Page ${doc.getPageCount()} of ${doc.getPageCount()}`),
      `Page ${doc.getPageCount()} of ${doc.getPageCount()}`,
    ).toBe(true);
    expect(text.includes("Lobby Area"), "Lobby Area").toBe(true);
    expect(text.includes("Dry goal 11%"), "Dry goal 11%").toBe(true);
    expect(text.includes(SCHEMATIC_NOTE.slice(0, 40)), SCHEMATIC_NOTE.slice(0, 40)).toBe(true);
    // The day with nothing logged is in the tables, said in words.
    expect(text.includes("No crew reading"), "No crew reading").toBe(true);
  });

  it("prints no crew notes — they are written for the office, not a carrier", async () => {
    const bytes = await buildDryingReportPdf({ data: data(), job: {}, generatedAt: GENERATED });
    const text = await pageText(bytes);
    expect(text.includes(HEADINGS.readings), HEADINGS.readings).toBe(true); // control: the text read works
    expect(text.includes("crew-only note"), "crew-only note").toBe(false);
  });

  it("leaves the moisture sections out when no point was recorded, and says so on the cover", async () => {
    const bytes = await buildDryingReportPdf({
      data: data({ moisture: { points: [], readings: [] } }),
      job: {},
      generatedAt: GENERATED,
    });
    const text = await pageText(bytes);
    expect(text.includes(HEADINGS.moisture), HEADINGS.moisture).toBe(false);
    expect(text.includes(HEADINGS.moistureTable), HEADINGS.moistureTable).toBe(false);
    expect(text.includes("None recorded on this job"), "None recorded on this job").toBe(true);
  });

  it("says the moisture tables are not set up rather than implying none were taken", async () => {
    const bytes = await buildDryingReportPdf({
      data: data({ moisture: null }),
      job: {},
      generatedAt: GENERATED,
    });
    expect(
      (await pageText(bytes)).includes("not set up in this database yet"),
      "not set up in this database yet",
    ).toBe(true);
  });

  it("builds for a job with nothing on it", async () => {
    const empty = buildDryingReportData({
      rows: [],
      rooms: [],
      roomLabel,
      placements: [],
      moisture: null,
      materialLabel: MOISTURE_MATERIAL_LABEL,
      today: "2026-05-28",
      timeZone: "America/New_York",
    });
    const bytes = await buildDryingReportPdf({ data: empty, job: {}, generatedAt: GENERATED });
    const text = await pageText(bytes);
    expect(text.includes("No outside readings on file"), "No outside readings on file").toBe(true);
    expect(
      text.includes("No equipment placements recorded"),
      "No equipment placements recorded",
    ).toBe(true);
  });
});

/*
 * Mark, 13 Oct: drop the long explanatory sentences from the report — the
 * per-reading late-entry note, the methodology paragraph over the readings
 * table, and "No crew reading. The modelled outside figure is not evidence
 * that anybody was at the property." The report goes to carriers, so what
 * stays is a SHORT source label on every automatic outside row.
 */
describe("the drying report keeps source labels and drops the long notes", () => {
  async function build() {
    const late = reading("2026-05-27", "affected", 72, 50, {
      room_id: "lobby",
      captured_at: "2026-05-28T15:00:00Z",
    });
    const d = buildDryingReportData({
      rows: [...ROWS, late],
      rooms: ROOMS,
      roomLabel,
      placements: PLACEMENTS,
      moisture: { points: POINTS, readings: MREADINGS },
      materialLabel: MOISTURE_MATERIAL_LABEL,
      jobNumber: "GS-26-0523",
      address: "5622 Delmare Blvd, St. Louis, MO 63112",
      today: "2026-05-28",
      timeZone: "America/New_York",
    });
    const bytes = await buildDryingReportPdf({ data: d, job: {}, generatedAt: GENERATED });
    return pageText(bytes);
  }

  it("no longer prints the methodology paragraph or the long sentences", async () => {
    const text = await build();
    expect(text.includes(HEADINGS.readings), "control: the text read works").toBe(true);
    for (const gone of [
      "Every reading on file",
      "the same rows as the drying log workbook",
      "after the day it records",
      "not when the meter was read",
      "not evidence that anybody",
      "grid square",
      "not a measurement taken on site",
    ]) {
      expect(text.includes(gone), gone).toBe(false);
    }
  });

  it("still labels the modeled outside row by its source, and says the time zone", async () => {
    const text = await build();
    expect(text.includes("Modeled (Open-Meteo)"), "Modeled (Open-Meteo)").toBe(true);
    expect(text.includes("Times in America/New_York."), "time zone line").toBe(true);
    // David, 13 Oct: the report is customer-facing, so a late crew entry no
    // longer says when it was entered — its time is simply left blank.
    expect(text.includes("Entered"), "no late-entry label").toBe(false);
  });
});
