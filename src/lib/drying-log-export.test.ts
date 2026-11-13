import { describe, expect, it } from "vitest";

import type { DryingReading } from "@/lib/drying-log";
import {
  CREW_READING_ON_FILE,
  GAP_ROW_NOTE,
  NO_CREW_READING,
  READING_COLUMNS,
  SOURCE_CREW,
  SOURCE_MODELLED,
  dryingLogReportName,
  dryingLogWorkbook,
} from "@/lib/drying-log-export";
import { buildCsv, buildXlsx, sheetFromColumns } from "@/lib/export-table";
import { OUTSIDE_MODELLED_NOTE } from "@/lib/outside-conditions";

/**
 * The file a carrier is handed when it disputes an equipment charge. Two
 * things make it worth sending: it never passes a modelled figure off as a
 * measurement, and it never hides a day nobody logged.
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

function weather(date: string, over: Partial<DryingReading> = {}): DryingReading {
  return reading({
    reading_date: date,
    point: "exterior",
    source: "weather",
    source_detail: "open-meteo 09:00 local",
    observed_at: `${date}T13:00:00Z`,
    captured_at: `${date}T13:00:00Z`,
    temperature_f: 68,
    relative_humidity: 70,
    dew_point_f: 58,
    grains_per_pound: 72,
    ...over,
  });
}

function book(rows: DryingReading[], today: string, extra: Record<string, unknown> = {}) {
  // The office copy: these tests pin what the office sees. The customer copy
  // (the default since 13 Oct) is pinned in drying-export-audience.test.ts.
  const [summary, readings, gaps] = dryingLogWorkbook({
    rows,
    today,
    audience: "internal",
    ...extra,
  });
  return { summary: summary.rows, readings: readings.rows, gaps: gaps!.rows };
}

describe("the readings sheet", () => {
  it("carries every figure the adjuster needs, per day and per point", () => {
    const { readings } = book(
      [
        reading({
          reading_date: "2026-09-01",
          point: "interior",
          room_id: "room-k",
          temperature_f: 74.2,
          relative_humidity: 63,
          dew_point_f: 60.5,
          grains_per_pound: 80.1,
        }),
      ],
      "2026-09-01",
      { roomNames: new Map([["room-k", "Kitchen"]]) },
    );
    expect(readings).toEqual([
      {
        date: "2026-09-01",
        day: CREW_READING_ON_FILE,
        point: "Inside",
        location: "Inside — Kitchen",
        source: SOURCE_CREW,
        observedAt: "2026-09-01T15:00:00Z",
        temperatureF: 74.2,
        relativeHumidity: 63,
        dewPointF: 60.5,
        grainsPerPound: 80.1,
        baseline: "Yes (inferred)",
        note: null,
      },
    ]);
  });

  it("labels every modeled outside row with its source, in a few words", () => {
    const { readings } = book(
      [weather("2026-09-01"), reading({ reading_date: "2026-09-01" }), weather("2026-09-02")],
      "2026-09-02",
    );
    const modelled = readings.filter((r) => r.source === SOURCE_MODELLED);
    expect(modelled).toHaveLength(2);
    for (const r of modelled) {
      // Mark, 13 Oct: the full sentence is gone from every row; the source is not.
      expect(r.note).toBe("Modeled (Open-Meteo)");
      expect(r.note).not.toBe(OUTSIDE_MODELLED_NOTE);
      expect(r.source).toBe("Modeled — Open-Meteo, not on site");
      expect(r.location).toBe("Outside (automatic 09:00 local)");
    }
    // And never on a crew row: the label is a caveat, not decoration.
    for (const r of readings.filter((r) => r.source === SOURCE_CREW)) {
      expect(r.note ?? "").not.toMatch(/modelled|open-meteo/i);
    }
  });

  it("stamps a modeled row with the modeled hour, not when the fetch ran", () => {
    const { readings } = book(
      [weather("2026-09-01", { captured_at: "2026-09-02T03:00:00Z" })],
      "2026-09-01",
    );
    expect(readings[0]!.observedAt).toBe("2026-09-01T13:00:00Z");
  });

  it("shows a day nobody logged as a row, in date order", () => {
    const { readings } = book(
      [reading({ reading_date: "2026-09-01" }), reading({ reading_date: "2026-09-03" })],
      "2026-09-03",
    );
    expect(readings.map((r) => [r.date, r.day])).toEqual([
      ["2026-09-01", CREW_READING_ON_FILE],
      ["2026-09-02", NO_CREW_READING],
      ["2026-09-03", CREW_READING_ON_FILE],
    ]);
    const gap = readings[1]!;
    expect(gap.note).toBe(GAP_ROW_NOTE);
    expect(gap.temperatureF).toBeNull();
    expect(gap.source).toBeNull();
  });

  it("marks a day with only the modeled figure as having no crew reading", () => {
    const { readings } = book(
      [reading({ reading_date: "2026-09-01" }), weather("2026-09-02")],
      "2026-09-02",
    );
    const second = readings.filter((r) => r.date === "2026-09-02");
    expect(second).toHaveLength(1);
    expect(second[0]!.day).toBe(NO_CREW_READING);
    expect(second[0]!.note).toBe("Modeled (Open-Meteo)");
  });

  it("exports every reading, not the one per place the screen shows", () => {
    const rows = [
      reading({ reading_date: "2026-09-01", captured_at: "2026-09-01T18:00:00Z" }),
      reading({ reading_date: "2026-09-01", captured_at: "2026-09-01T14:00:00Z" }),
      reading({ reading_date: "2026-09-01", point: "exterior" }),
    ];
    const { readings } = book(rows, "2026-09-01");
    expect(readings).toHaveLength(3);
    // Point order (outside first), then the time each was taken.
    expect(readings.map((r) => [r.point, r.observedAt])).toEqual([
      ["Outside", "2026-09-01T15:00:00Z"],
      ["Affected", "2026-09-01T14:00:00Z"],
      ["Affected", "2026-09-01T18:00:00Z"],
    ]);
  });

  it("does not lose readings past the screen's 180-day calendar", () => {
    const rows = [reading({ reading_date: "2026-01-01" }), reading({ reading_date: "2026-09-01" })];
    const { readings } = book(rows, "2026-09-01");
    expect(readings.filter((r) => r.source === SOURCE_CREW)).toHaveLength(2);
  });

  it("names a dehumidifier by its tag", () => {
    const { readings } = book(
      [reading({ reading_date: "2026-09-01", point: "dehu_outlet", label: "DH-12" })],
      "2026-09-01",
    );
    expect(readings[0]!.location).toBe("Dehu outlet — DH-12");
  });

  it("says when a crew reading was entered after the day it records", () => {
    const { readings } = book(
      [reading({ reading_date: "2026-09-01", captured_at: "2026-09-03T15:00:00Z" })],
      "2026-09-03",
    );
    // A few words, not the old sentence — and still accurate about the time.
    expect(readings[0]!.note).toBe("Entered 2026-09-03; time shown is entry time");
    expect(readings[0]!.note).not.toMatch(/after the day it records/);
  });

  it("marks the baseline day as declared when the crew flagged it", () => {
    const { readings } = book(
      [
        reading({ reading_date: "2026-09-01" }),
        reading({ reading_date: "2026-09-02", is_baseline: true }),
      ],
      "2026-09-02",
    );
    expect(readings.map((r) => [r.date, r.baseline])).toEqual([
      ["2026-09-01", null],
      ["2026-09-02", "Yes"],
    ]);
  });

  it("does not export crew notes to a carrier", () => {
    const { readings } = book(
      [reading({ reading_date: "2026-09-01", notes: "homeowner unplugged the dehu again" })],
      "2026-09-01",
    );
    expect(JSON.stringify(readings)).not.toContain("homeowner");
  });
});

describe("the gaps sheet", () => {
  it("lists every day with no crew reading and where it sits", () => {
    const { gaps } = book(
      [
        weather("2026-08-30"),
        reading({ reading_date: "2026-09-01" }),
        reading({ reading_date: "2026-09-03" }),
      ],
      "2026-09-04",
    );
    expect(gaps.map((g) => [g.date, g.onFile, g.position])).toEqual([
      ["2026-08-30", "Modeled outside figure only", "Before the first crew reading"],
      ["2026-08-31", "Nothing", "Before the first crew reading"],
      ["2026-09-02", "Nothing", "Between crew readings"],
      ["2026-09-04", "Nothing", "After the last crew reading"],
    ]);
    // The "not evidence that anybody was at the property" sentence is gone;
    // "On file that day" still names the modelled figure.
    expect(gaps[0]!.note).toBe("No crew reading.");
    expect(gaps.map((g) => g.note).join(" ")).not.toMatch(/not evidence/);
  });

  it("is exactly DryingLog.gaps", () => {
    const rows = [reading({ reading_date: "2026-09-01" }), weather("2026-09-03")];
    const { gaps } = book(rows, "2026-09-05");
    expect(gaps.map((g) => g.date)).toEqual([
      "2026-09-02",
      "2026-09-03",
      "2026-09-04",
      "2026-09-05",
    ]);
  });

  it("says there are none rather than being empty", () => {
    const { gaps } = book([reading({ reading_date: "2026-09-01" })], "2026-09-01");
    expect(gaps).toEqual([
      {
        date: null,
        onFile: "",
        position: null,
        note: "No gaps: a crew reading is on file for every day from 2026-09-01 to 2026-09-01.",
      },
    ]);
  });

  it("calls a job with only modeled figures what it is", () => {
    const { gaps } = book([weather("2026-09-01")], "2026-09-01");
    expect(gaps[0]!.position).toBe("No crew reading on this job");
  });
});

describe("the summary sheet", () => {
  const detail = (rows: { item: string; detail: string }[], item: string) =>
    rows.find((r) => r.item === item)?.detail;

  it("names the job, counts the days, and repeats the modeled note", () => {
    const { summary } = book(
      [weather("2026-09-01"), reading({ reading_date: "2026-09-01" })],
      "2026-09-03",
      { jobNumber: "J-1042", address: "12 Elm St, Lakewood NJ" },
    );
    expect(detail(summary, "Job")).toBe("J-1042");
    expect(detail(summary, "Property")).toBe("12 Elm St, Lakewood NJ");
    expect(detail(summary, "Days with a crew reading")).toBe("1 of 3");
    expect(detail(summary, "Days with no crew reading")).toMatch(/^2 — /);
    expect(detail(summary, "Modeled outside figures")).toBe(OUTSIDE_MODELLED_NOTE);
  });

  it("says which time zone the observation times are in", () => {
    const { summary } = book([weather("2026-09-01")], "2026-09-01", {
      timeZone: "America/New_York",
    });
    expect(detail(summary, "Times")).toBe(
      "Observation times are in America/New_York, the time zone of the computer this log was " +
        "exported from. A modeled outside figure is the 09:00 local hour at the property.",
    );
  });

  it("does not mention modeled figures when there are none", () => {
    const { summary } = book([reading({ reading_date: "2026-09-01" })], "2026-09-01");
    expect(detail(summary, "Modeled outside figures")).toBeUndefined();
  });

  it("says an inferred baseline was inferred", () => {
    const { summary } = book([reading({ reading_date: "2026-09-01" })], "2026-09-01");
    expect(detail(summary, "Baseline")).toMatch(/inferred/);
  });

  it("says when there is nothing on file", () => {
    const { summary, readings } = book([], "2026-09-01");
    expect(readings).toEqual([]);
    expect(detail(summary, "Period")).toBe("No readings on file.");
  });
});

describe("through the exporter", () => {
  it("writes numbers as numbers and the note as text", () => {
    const [, sheet] = dryingLogWorkbook({
      rows: [weather("2026-09-01"), reading({ reading_date: "2026-09-01" })],
      today: "2026-09-01",
    });
    const built = sheetFromColumns(sheet.name, sheet.rows, sheet.columns);
    expect(built.headers).toEqual(READING_COLUMNS.map((c) => c.label));
    const csv = buildCsv(built);
    expect(csv).toContain("Modeled (Open-Meteo)");
    // A valid workbook comes out the other end.
    expect(buildXlsx([built]).byteLength).toBeGreaterThan(0);
  });

  it("names the file after the job", () => {
    expect(dryingLogReportName("J-1042")).toBe("Drying log J-1042");
    expect(dryingLogReportName(null)).toBe("Drying log");
  });
});

describe("Days with no crew reading is internal only (David, 27 Oct)", () => {
  const rows = [
    {
      id: "a",
      reading_date: "2026-10-01",
      point: "inside",
      source: "crew",
      temperature_f: 70,
      relative_humidity: 50,
      dew_point_f: 50,
      grains_per_pound: 55,
    },
    {
      id: "b",
      reading_date: "2026-10-04",
      point: "inside",
      source: "crew",
      temperature_f: 70,
      relative_humidity: 45,
      dew_point_f: 48,
      grains_per_pound: 50,
    },
  ] as unknown as Parameters<typeof dryingLogWorkbook>[0]["rows"];

  it("leaves the gaps sheet and its count off the customer copy", () => {
    const sheets = dryingLogWorkbook({ rows, today: "2026-10-04" });
    expect(sheets.map((s) => s.name)).toEqual(["Summary", "Readings"]);
    expect(sheets[0].rows.map((r) => r.item)).not.toContain("Days with no crew reading");
  });

  it("keeps both on the internal copy", () => {
    const sheets = dryingLogWorkbook({ rows, today: "2026-10-04", audience: "internal" });
    expect(sheets.map((s) => s.name)).toEqual(["Summary", "Readings", "Gaps"]);
    expect(sheets[0].rows.map((r) => r.item)).toContain("Days with no crew reading");
  });
});
