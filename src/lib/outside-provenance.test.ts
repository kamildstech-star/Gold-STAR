import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  buildDryingDayTiles,
  describeOutsideCell,
  type OutsideContext,
} from "@/lib/drying-day-grid";
import { buildDryingLog, describeOutsideReading, type DryingReading } from "@/lib/drying-log";
import { SOURCE_MODELLED, SOURCE_STATION, dryingLogWorkbook } from "@/lib/drying-log-export";
import { automaticOutsideNotes, buildDryingReportPdf } from "@/lib/drying-report-pdf";
import { buildDryingReportData } from "@/lib/drying-report";
import { MOISTURE_MATERIAL_LABEL } from "@/lib/drying-materials";
import { roomLabel } from "@/lib/job-rooms";
import {
  OUTSIDE_MODELLED_NOTE,
  OUTSIDE_SOURCE_DETAIL,
  isStationReading,
  nwsSourceDetail,
  outsideReadingLabel,
  outsideReadingNote,
  outsideReadingNotes,
  outsideReadingRow,
  parseOutsideSourceDetail,
} from "@/lib/outside-conditions";

/**
 * Since 2026-10-07 an automatic outside figure can be Open-Meteo's model or a
 * National Weather Service station's measurement. The two are different
 * evidence, and every surface that said "modelled" must now say which —
 * the drying log, the workbook and the drying report PDF. Rows written before
 * the change say "open-meteo 09:00 local" and must read exactly as before.
 */

const STATION_DETAIL = nwsSourceDetail({
  stationId: "KEWR",
  stationName: "Newark, Newark International Airport",
  distanceMi: 3.84,
  localTime: "08:51",
});

let seq = 0;
function reading(over: Partial<DryingReading> & { reading_date: string }): DryingReading {
  seq += 1;
  return {
    id: `p${seq}`,
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

const model = (date: string) =>
  reading({
    reading_date: date,
    point: "exterior",
    source: "weather",
    source_detail: OUTSIDE_SOURCE_DETAIL,
    observed_at: `${date}T13:00:00Z`,
    captured_at: `${date}T13:00:00Z`,
    temperature_f: 68,
    relative_humidity: 70,
    dew_point_f: 58,
  });

const measured = (date: string) =>
  reading({
    reading_date: date,
    point: "exterior",
    source: "weather",
    source_detail: STATION_DETAIL,
    observed_at: `${date}T12:51:00Z`,
    captured_at: `${date}T12:51:00Z`,
    temperature_f: 59,
    relative_humidity: 80,
    dew_point_f: 53,
  });

describe("source_detail says where the figure came from", () => {
  it("round-trips a station string", () => {
    expect(STATION_DETAIL).toBe(
      "nws KEWR 08:51 local · 3.8 mi · Newark, Newark International Airport",
    );
    expect(parseOutsideSourceDetail(STATION_DETAIL)).toEqual({
      kind: "station",
      stationId: "KEWR",
      stationName: "Newark, Newark International Airport",
      distanceMi: 3.8,
      localTime: "08:51",
    });
  });

  it("reads every existing row — and anything unknown — as the model, never as a measurement", () => {
    for (const detail of [OUTSIDE_SOURCE_DETAIL, null, undefined, "", "something-new 09:00"]) {
      expect(parseOutsideSourceDetail(detail)).toEqual({ kind: "model" });
      expect(outsideReadingNote({ source: "weather", source_detail: detail })).toBe(
        OUTSIDE_MODELLED_NOTE,
      );
    }
  });

  it("keeps writing the Open-Meteo string on the browser path", () => {
    const row = outsideReadingRow("job-1", {
      date: "2026-10-07",
      observedAt: "2026-10-07T13:00:00.000Z",
      tempF: 60,
      rh: 70,
    });
    expect(row["source_detail"]).toBe("open-meteo 09:00 local");
  });

  it("lists each distinct note once, the model's first", () => {
    const notes = outsideReadingNotes([
      measured("2026-10-06"),
      model("2026-10-05"),
      measured("2026-10-07"),
      reading({ reading_date: "2026-10-07" }),
    ]);
    expect(notes).toEqual([OUTSIDE_MODELLED_NOTE, outsideReadingNote(measured("x"))]);
    expect(outsideReadingNotes([reading({ reading_date: "2026-10-07" })])).toEqual([]);
  });

  it("quotes a station figure at the time the station reported", () => {
    expect(describeOutsideReading(measured("2026-10-07"))).toBe("59 °F / 80% at 08:51 local");
    expect(describeOutsideReading(model("2026-10-07"))).toBe("68 °F / 70% at 09:00 local");
  });
});

describe("the workbook", () => {
  const rows = [
    reading({ reading_date: "2026-10-05" }),
    model("2026-10-05"),
    measured("2026-10-06"),
    reading({ reading_date: "2026-10-07" }),
  ];
  const [summary, readings, gaps] = dryingLogWorkbook({
    audience: "internal",
    rows,
    today: "2026-10-07",
    timeZone: "America/New_York",
  });

  it("labels each automatic row by its own source, in a few words", () => {
    const modelRow = readings.rows.find(
      (r) => r.date === "2026-10-05" && r.source === SOURCE_MODELLED,
    );
    const stationRow = readings.rows.find(
      (r) => r.date === "2026-10-06" && r.source === SOURCE_STATION,
    );
    // Mark, 13 Oct: short labels on the rows, not the full sentences.
    expect(modelRow!.note).toBe("Modeled (Open-Meteo)");
    expect(stationRow!.note).toBe("NWS KEWR, 3.8 mi");
    expect(stationRow!.note).not.toMatch(/modelled/i);
    expect(stationRow!.source).toBe(SOURCE_STATION);
    expect(stationRow!.source).toMatch(/not on site/);
  });

  it("counts and explains both kinds in the summary", () => {
    const detail = (item: string) =>
      summary.rows.filter((r) => r.item === item).map((r) => r.detail);
    expect(detail("Modeled outside readings")).toEqual(["1"]);
    expect(detail("Weather-station outside readings")).toEqual(["1"]);
    expect(detail("Modeled outside figures")).toEqual([OUTSIDE_MODELLED_NOTE]);
    expect(detail("Weather-station outside figures")).toEqual([outsideReadingNote(measured("x"))]);
  });

  it("does not call a station figure modeled on the gaps sheet", () => {
    const gap = gaps!.rows.find((g) => g.date === "2026-10-06");
    expect(gap!.onFile).toBe("Weather-station outside figure only");
    expect(gap!.note).toBe("No crew reading.");
  });

  it("is unchanged for a log with no station rows", () => {
    const [s] = dryingLogWorkbook({
      rows: [model("2026-10-06")],
      today: "2026-10-07",
      audience: "internal",
    });
    expect(s.rows.some((r) => r.item.startsWith("Weather-station"))).toBe(false);
  });
});

describe("the drying report PDF", () => {
  async function pageText(bytes: Uint8Array): Promise<string> {
    const { PDFDocument, PDFRawStream, decodePDFRawStream } = await import("pdf-lib");
    const doc = await PDFDocument.load(bytes);
    let out = "";
    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
      if (!(obj instanceof PDFRawStream)) continue;
      try {
        out += new TextDecoder("latin1").decode(decodePDFRawStream(obj).decode());
      } catch {
        // an image stream
      }
    }
    return out.replace(/<([0-9A-Fa-f]+)>/g, (_m, hex: string) =>
      (hex.match(/../g) ?? []).map((b) => String.fromCharCode(parseInt(b, 16))).join(""),
    );
  }

  it("lists the model's label and the station's, once each, from the workbook's own rows", () => {
    const [, readings] = dryingLogWorkbook({
      audience: "internal",
      rows: [model("2026-10-05"), measured("2026-10-06"), measured("2026-10-07")],
      today: "2026-10-07",
    });
    expect(automaticOutsideNotes(readings.rows)).toEqual([
      outsideReadingLabel(model("x")),
      outsideReadingLabel(measured("x")),
    ]);
    expect(automaticOutsideNotes(readings.rows)).toEqual([
      "Modeled (Open-Meteo)",
      "NWS KEWR, 3.8 mi",
    ]);
  });

  it("prints a station row as measured off site, WITHOUT naming the station (customer copy)", async () => {
    const rows = [
      reading({
        reading_date: "2026-10-05",
        point: "exterior",
        temperature_f: 66,
        relative_humidity: 50,
      }),
      reading({
        reading_date: "2026-10-05",
        point: "affected",
        temperature_f: 72,
        relative_humidity: 70,
      }),
      measured("2026-10-06"),
      reading({
        reading_date: "2026-10-07",
        point: "affected",
        temperature_f: 72,
        relative_humidity: 50,
      }),
    ];
    const data = buildDryingReportData({
      rows,
      rooms: [],
      roomLabel,
      placements: [],
      moisture: null,
      materialLabel: MOISTURE_MATERIAL_LABEL,
      jobNumber: "GS-26-1007",
      address: "1 Test St, Newark, NJ",
      today: "2026-10-07",
      timeZone: "America/New_York",
    });
    const bytes = await buildDryingReportPdf({
      data,
      job: {
        customerName: "Test",
        carrier: null,
        claimNumber: null,
        lossDate: null,
        lossType: "Water",
        waterCategory: null,
        waterClass: null,
      },
      preparedBy: "Field crew",
      generatedAt: new Date("2026-10-07T20:00:00Z"),
      logoPng: null,
    });
    const text = await pageText(bytes);
    // David, 13 Oct: the report goes to the customer and the carrier, so the
    // station row says it came from a weather service — not which station or
    // how far away. The office still sees the station on screen.
    expect(text).not.toContain("KEWR");
    expect(text).not.toContain("3.8 mi");
    expect(text).toContain("Weather service");
    expect(text).not.toContain("National Weather Service station");
    expect(text).not.toContain("not a measurement taken on site");
  });
});

describe("the drying log on screen", () => {
  const CTX: OutsideContext = {
    hasLocation: true,
    writesRefused: false,
    interiorAvailable: true,
    hourOfDay: 14,
  };

  it("names the station in a square's accessible text instead of 'modelled'", () => {
    const log = buildDryingLog([measured("2026-10-07")], { today: "2026-10-07" });
    const tile = buildDryingDayTiles(log, "2026-10-07").find((t) => t.date === "2026-10-07")!;
    expect(tile.outsideModelled).toBe(true);
    expect(tile.outsideStation).toBe("KEWR");
    const long = describeOutsideCell(tile, CTX).long;
    expect(long).toContain("(NWS station KEWR, not on site)");
    expect(long).not.toContain("modelled");
  });

  it("prints each automatic figure's own note, never the model's sentence regardless", () => {
    const LOG = readFileSync("src/components/job-drying-log.tsx", "utf8").replace(/\r\n/g, "\n");
    const ariaLabels = LOG.match(/aria-label=\{[^}]*(?:Note|NOTE)[^}]*\}/g) ?? [];
    expect(ariaLabels.length).toBeGreaterThanOrEqual(2);
    for (const label of ariaLabels)
      expect(label).toMatch(/aria-label=\{outsideReadingNote\(\w+\)\}/);
    expect(LOG).toMatch(/<span>\{outsideReadingNote\(outside\.auto\)\}<\/span>/);
    expect(LOG).toMatch(
      /\{automaticNotes\.join\(" "\)\} Every other column was read off a meter on site\./,
    );
    expect(LOG).toMatch(/const notes = outsideReadingNotes\(readings\);/);
  });

  it("says so in the chart's tooltip too", () => {
    const CHART = readFileSync("src/components/drying-day-chart.tsx", "utf8").replace(
      /\r\n/g,
      "\n",
    );
    expect(CHART).toMatch(
      /row\.outsideStation\s*\?\s*`Outside figures were measured at NWS station \$\{row\.outsideStation\}, not on site\.`/,
    );
  });

  it("knows a station row from a model row", () => {
    expect(isStationReading(measured("2026-10-07"))).toBe(true);
    expect(isStationReading(model("2026-10-07"))).toBe(false);
    // A crew reading is never a station reading, whatever its detail says.
    expect(isStationReading({ source: "manual", source_detail: STATION_DETAIL })).toBe(false);
  });
});
