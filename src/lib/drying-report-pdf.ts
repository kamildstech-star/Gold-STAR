/**
 * The drying report as a PDF, in the order of the MoistureMapper report Mark
 * sent (2026-10-06): cover, outside conditions, equipment applied, then each
 * area — its room, its moisture content, its inside conditions — then the
 * readings as tables.
 *
 * The data is decided in drying-report.ts, which builds it from the same
 * assembly as the adjuster workbook. Nothing here filters, re-picks or rounds
 * differently: this file only draws. Pure apart from pdf-lib, so the test
 * suite builds a real report from fixtures and reads it back.
 *
 * Audience is "customer": a drying report exists to be sent to a carrier.
 * Crew notes are not printed, for the reason the workbook gives — they are
 * written for the office.
 */
import { rgb, type PDFImage, type RGB } from "pdf-lib";

import type { DryingReportData, ReportArea } from "@/lib/drying-report";
import { equipmentByRoom, moisturePointName, schematicLayout } from "@/lib/drying-report";
import { MOISTURE_MATERIAL_LABEL, dryGoal } from "@/lib/drying-materials";
import {
  SOURCE_MODELLED,
  SOURCE_STATION,
  SOURCE_STATION_CUSTOMER,
  type DryingLogExportRow,
} from "@/lib/drying-log-export";
import { EQUIPMENT_TYPE_LABEL, equipmentDaysOnSite } from "@/lib/equipment";
import { outsideReadingLabel } from "@/lib/outside-conditions";

/** The label a modelled row carries, for the chart footnote when no row is to hand. */
const MODELLED_LABEL = outsideReadingLabel({ source: "weather", source_detail: null });
import {
  CONTENT_W,
  GOLD,
  GREEN,
  INK,
  LINE,
  MARGIN,
  MUTED,
  NAVY,
  PAGE_H,
  PAGE_W,
  Sheet,
  sanitize,
  shortDate,
  type Cell,
  type Col,
} from "@/lib/pdf-kit";
import {
  dayLabel,
  drawBarChart,
  drawChartPlaceholder,
  drawLineChart,
  formatValue,
  type LineSeries,
} from "@/lib/pdf-charts";

/* The sample's colours: temperature green, RH blue, GPP purple. */
const TEMP = rgb(0.0, 0.5, 0.0);
const RH = rgb(0.0, 0.2, 0.85);
const GPP = rgb(0.5, 0.0, 0.5);
const RED = rgb(0.82, 0.12, 0.12);
const AFFECTED_FILL = rgb(0.93, 0.33, 0.3);
const EQUIPMENT_COLOURS: Record<string, RGB> = {
  air_mover: rgb(0.0, 0.5, 0.0),
  dehumidifier: rgb(0.0, 0.2, 0.85),
  air_scrubber: rgb(0.55, 0.35, 0.05),
  hepa: rgb(0.4, 0.4, 0.4),
  heater: rgb(0.85, 0.4, 0.0),
};
const PALETTE: RGB[] = [
  rgb(0.0, 0.2, 0.85),
  rgb(0.85, 0.4, 0.0),
  rgb(0.0, 0.5, 0.0),
  rgb(0.5, 0.0, 0.5),
  rgb(0.75, 0.1, 0.1),
  rgb(0.0, 0.5, 0.55),
  rgb(0.45, 0.35, 0.1),
  rgb(0.35, 0.35, 0.35),
];
const equipmentColour = (t: string, i: number) =>
  EQUIPMENT_COLOURS[t] ?? PALETTE[(i + 3) % PALETTE.length]!;

export type DryingReportPdfInput = {
  data: DryingReportData;
  /** Header facts for the cover. Missing ones are left off, never printed blank. */
  job: {
    customerName?: string | null;
    carrier?: string | null;
    claimNumber?: string | null;
    lossDate?: string | null;
    lossType?: string | null;
    waterCategory?: number | null;
    waterClass?: number | null;
  };
  preparedBy?: string | null;
  /** When it was generated. Passed in, never read off the clock here. */
  generatedAt: Date;
  /** PNG bytes of the Gold Star logo; the cover prints the name in type without it. */
  logoPng?: Uint8Array | null;
};

const CHART_H = 270;

/** The report's headings, exported so the tests check the same words that print. */
export const HEADINGS = {
  title: "Drying Report",
  outside: "Outside Conditions",
  equipment: "Equipment Applied",
  schematic: "Room schematic",
  moisture: "Moisture Content Graph",
  inside: "Inside Conditions",
  readings: "Atmospheric readings",
  moistureTable: "Material moisture readings",
  equipmentLog: "Equipment log",
  equipmentDaily: "Equipment on site by day",
} as const;

export const SCHEMATIC_NOTE =
  "Rooms are drawn to their recorded length and width. Their position in the building is not recorded, " +
  "so they are set side by side; this is not a floor plan.";

/**
 * Every distinct source label carried by the automatic outside rows, the
 * model's first: "Modelled (Open-Meteo)", then one per NWS station that filled
 * in when Open-Meteo refused the nightly job ("NWS KEWR, 3.8 mi"). Printed
 * under the outside chart, and each row's own label sits in its Source cell.
 * Read off the workbook's own rows, so the PDF cannot word a row differently
 * from the file the same carrier is handed.
 *
 * These used to be full sentences, repeated above the readings table; Mark
 * (13 Oct) wanted the sentences gone. The labels keep every automatic figure
 * identifiable as not measured on site, which a carrier is entitled to know.
 */
export function automaticOutsideNotes(rows: readonly DryingLogExportRow[]): string[] {
  const model: string[] = [];
  const station: string[] = [];
  for (const r of rows) {
    if (!r.note) continue;
    const bucket =
      r.source === SOURCE_MODELLED
        ? model
        : r.source === SOURCE_STATION || r.source === SOURCE_STATION_CUSTOMER
          ? station
          : null;
    if (bucket && !bucket.includes(r.note)) bucket.push(r.note);
  }
  return [...model, ...station];
}

export async function buildDryingReportPdf(input: DryingReportPdfInput): Promise<Uint8Array> {
  const { data } = input;
  const s = await Sheet.create("customer");
  s.footerH = 30;
  const logo = input.logoPng ? await s.doc.embedPng(input.logoPng).catch(() => null) : null;

  cover(s, input, logo);

  // Outside conditions and equipment share a page, as on the sample.
  s.addPage();
  heading(s, "Conditions and equipment");
  const outsideBox = { x: MARGIN, y: s.y - CHART_H, w: CONTENT_W, h: CHART_H };
  if (data.outside.dates.length === 0) {
    drawChartPlaceholder(
      s,
      outsideBox,
      HEADINGS.outside,
      "No outside readings on file for this job.",
    );
  } else {
    drawLineChart(s, outsideBox, {
      title: HEADINGS.outside,
      categories: data.outside.dates.map(dayLabel),
      series: conditionLines(
        data.outside.temperatureF,
        data.outside.relativeHumidity,
        data.outside.gpp,
        data.outside.modelled,
      ),
    });
  }
  s.y -= CHART_H + 4;
  if (data.outside.modelled.some(Boolean)) {
    const labels = automaticOutsideNotes(data.sheets[1].rows);
    s.para(
      `Hollow markers: outside figures not taken on site - ${(labels.length > 0 ? labels : [MODELLED_LABEL]).join("; ")}.`,
      { size: 7, color: MUTED },
    );
  }
  s.gap(10);
  s.ensure(CHART_H);
  const eqBox = { x: MARGIN, y: s.y - CHART_H, w: CONTENT_W, h: CHART_H };
  if (data.equipment.dates.length === 0) {
    drawChartPlaceholder(
      s,
      eqBox,
      HEADINGS.equipment,
      "No equipment placements recorded on this job.",
    );
  } else {
    drawBarChart(s, eqBox, {
      title: HEADINGS.equipment,
      categories: data.equipment.dates.map(dayLabel),
      series: data.equipment.types.map((t, i) => ({
        name: data.equipment.labels[t] ?? t,
        color: equipmentColour(t, i),
        values: data.equipment.counts[t] ?? [],
      })),
    });
  }
  s.y -= CHART_H;

  for (const area of data.areas) areaPages(s, data, area);

  tables(s, input);

  footer(s, data);
  return s.save();
}

/* ------------------------------------------------------------------ */
/* Cover                                                               */
/* ------------------------------------------------------------------ */

function cover(s: Sheet, input: DryingReportPdfInput, logo: PDFImage | null) {
  const { data } = input;
  let y = PAGE_H - MARGIN - 10;
  if (logo) {
    const w = 250;
    const h = (logo.height / logo.width) * w;
    s.page.drawImage(logo, { x: (PAGE_W - w) / 2, y: y - h, width: w, height: h });
    y -= h + 14;
  } else {
    s.text("GOLD STAR RESTORATION", MARGIN, y - 24, {
      size: 24,
      bold: true,
      color: GOLD,
      align: "center",
      width: CONTENT_W,
    });
    y -= 56;
  }
  s.text(HEADINGS.title, MARGIN, y - 22, {
    size: 26,
    bold: true,
    color: NAVY,
    align: "center",
    width: CONTENT_W,
  });
  y -= 40;
  if (data.address) {
    s.text(data.address, MARGIN, y - 12, {
      size: 13,
      color: INK,
      align: "center",
      width: CONTENT_W,
    });
    y -= 22;
  }
  s.page.drawLine({
    start: { x: MARGIN + 80, y: y - 6 },
    end: { x: PAGE_W - MARGIN - 80, y: y - 6 },
    thickness: 1.2,
    color: GOLD,
  });
  s.y = y - 20;

  const j = input.job;
  const facts: [string, string | null | undefined][] = [
    ["Job", data.jobNumber],
    ["Customer", j.customerName],
    ["Insurance carrier", j.carrier],
    ["Claim number", j.claimNumber],
    ["Date of loss", j.lossDate ? shortDate(j.lossDate) : null],
    ["Type of loss", j.lossType],
    ["Water category", j.waterCategory ? `Category ${j.waterCategory}` : null],
    ["Water class", j.waterClass ? `Class ${j.waterClass}` : null],
    [
      "Prepared by",
      input.preparedBy ? `${input.preparedBy}, Gold Star Restoration` : "Gold Star Restoration",
    ],
    ["Generated", shortDate(data.today)],
  ];
  keyValues(
    s,
    facts.filter((f): f is [string, string] => !!f[1]),
  );

  s.gap(8);
  s.sectionLabel("Drying log summary");
  // The workbook's own summary, minus the lines the facts above already say.
  // The time zone heads the readings table instead. The methodology sentences
  // (how dew point is derived; what a modelled or station figure is) are left
  // out of the report — Mark, 13 Oct — because every automatic figure already
  // carries its short source label ("Modelled (Open-Meteo)", "NWS KEWR, 3.8 mi")
  // in its row and under the chart. The workbook keeps them on its Summary sheet.
  const skip = new Set([
    "Document",
    "Job",
    "Property",
    "Exported",
    "Times",
    "Dew point and grains per pound",
    "Modeled outside figures",
    "Weather-station outside figures",
  ]);
  keyValues(
    s,
    data.sheets[0].rows
      .filter((r) => !skip.has(r.item))
      .map((r) => [r.item, r.detail] as [string, string]),
  );
  keyValues(s, [["Material moisture points", moistureSummary(data)]]);

  s.gap(6);
  s.sectionLabel("In this report");
  const areas = data.areas.map((a) => a.title);
  s.para(
    [
      "Outside conditions and equipment applied by day.",
      areas.length
        ? `Areas: ${areas.join(", ")} - for each, a room schematic, material moisture content where fixed points were read, and inside conditions.`
        : "No room-level readings, moisture points or equipment placements are on file, so there are no area pages.",
      "Every reading as a table, and the equipment log.",
    ].join(" "),
    { size: 8.5 },
  );
}

function moistureSummary(data: DryingReportData): string {
  if (data.moisturePoints == null)
    return "Not available - the moisture-point tables are not set up in this database yet.";
  if (data.moisturePoints.length === 0)
    return "None recorded on this job. Moisture content is charted only where a crew established a fixed test point.";
  const dry = data.moisturePoints.filter((p) => p.status === "dry").length;
  return `${data.moisturePoints.length} fixed point${data.moisturePoints.length === 1 ? "" : "s"}; ${dry} at or under the dry goal at the last reading.`;
}

function keyValues(s: Sheet, rows: [string, string][]) {
  const labelW = 150;
  for (const [k, v] of rows) {
    const lines = s.wrap(v, 9, CONTENT_W - labelW);
    s.ensure(lines.length * 12 + 2);
    s.y -= 12;
    s.text(k, MARGIN, s.y, { size: 8.5, bold: true, color: MUTED });
    lines.forEach((line, i) => s.text(line, MARGIN + labelW, s.y - i * 12, { size: 9 }));
    s.y -= (lines.length - 1) * 12 + 2;
  }
}

function heading(s: Sheet, text: string) {
  s.ensure(30);
  s.y -= 18;
  s.text(text, MARGIN, s.y, { size: 14, bold: true, color: NAVY });
  s.y -= 6;
  s.page.drawLine({
    start: { x: MARGIN, y: s.y },
    end: { x: PAGE_W - MARGIN, y: s.y },
    thickness: 1.2,
    color: GOLD,
  });
  s.y -= 8;
}

function conditionLines(
  t: (number | null)[],
  rh: (number | null)[],
  gpp: (number | null)[],
  modelled?: boolean[],
): LineSeries[] {
  return [
    { name: "Temp. F", color: TEMP, values: t, hollow: modelled },
    { name: "%RH", color: RH, values: rh, hollow: modelled },
    {
      name: "GPP",
      color: GPP,
      values: gpp.map((v) => (v == null ? null : Math.round(v))),
      hollow: modelled,
    },
  ];
}

/* ------------------------------------------------------------------ */
/* Areas                                                               */
/* ------------------------------------------------------------------ */

function areaPages(s: Sheet, data: DryingReportData, area: ReportArea) {
  s.addPage();
  heading(s, area.title);
  if (area.room) {
    const r = area.room;
    const bits = [
      r.floor ? `Floor: ${r.floor}` : null,
      r.length_ft != null && r.width_ft != null
        ? `${formatValue(r.length_ft, 1)} ft x ${formatValue(r.width_ft, 1)} ft (${Math.round(r.length_ft * r.width_ft)} sq ft)`
        : "Size not recorded",
      r.height_ft != null ? `ceiling ${formatValue(r.height_ft, 1)} ft` : null,
      r.affected_materials?.length ? `Affected: ${r.affected_materials.join(", ")}` : null,
    ].filter(Boolean);
    s.para(bits.join("   |   "), { size: 8.5, color: INK });
    s.gap(6);
    schematic(s, data, area.room.id);
  }

  if (area.moistureChart) {
    s.gap(8);
    s.ensure(CHART_H);
    const chart = area.moistureChart;
    const series: LineSeries[] = chart.lines.map((l, i) => ({
      name: l.name,
      color: PALETTE[i % PALETTE.length]!,
      values: l.values,
      decimals: 1,
    }));
    drawLineChart(
      s,
      { x: MARGIN, y: s.y - CHART_H, w: CONTENT_W, h: CHART_H },
      {
        title: `${HEADINGS.moisture} - ${area.title}`,
        categories: chart.dates.map(dayLabel),
        series,
        refLines: chart.lines
          .map((l, i) =>
            l.goal == null
              ? null
              : {
                  value: l.goal,
                  color: PALETTE[i % PALETTE.length]!,
                  label: `Dry goal ${formatValue(l.goal, 1)}%`,
                },
          )
          .filter((r): r is NonNullable<typeof r> => r != null),
      },
    );
    s.y -= CHART_H + 2;
    const noStandard = chart.lines.filter((l) => l.goal == null).map((l) => l.name);
    if (noStandard.length) {
      s.para(
        `No dry standard recorded yet for: ${noStandard.join("; ")}. These points have no goal line and are never shown as dry.`,
        { size: 7, color: MUTED },
      );
    }
  }

  for (const { series, conditions } of area.series) {
    if (conditions.dates.length === 0) continue;
    s.gap(8);
    s.ensure(CHART_H);
    drawLineChart(
      s,
      { x: MARGIN, y: s.y - CHART_H, w: CONTENT_W, h: CHART_H },
      {
        title: `${HEADINGS.inside} - ${series.label}`,
        categories: conditions.dates.map(dayLabel),
        series: conditionLines(
          conditions.temperatureF,
          conditions.relativeHumidity,
          conditions.gpp,
        ),
      },
    );
    s.y -= CHART_H;
  }
}

/** The whole job's rooms, this area's shaded red, equipment marked in each. */
function schematic(s: Sheet, data: DryingReportData, highlight: string) {
  const boxW = CONTENT_W - 20;
  const boxH = 230;
  const layout = schematicLayout(data.rooms, { width: boxW, height: boxH }, (r) =>
    data.roomLabel(r as never),
  );
  const drawnH = Math.max(
    40,
    ...layout.rects.map((r) => r.y + r.h),
    ...layout.floors.map((f) => f.y + 12),
  );
  const total = drawnH + 34;
  s.ensure(total + 16);
  s.text(HEADINGS.schematic, MARGIN, s.y - 10, { size: 10, bold: true });
  s.y -= 16;
  const top = s.y;
  const x0 = MARGIN + 10;
  s.box(MARGIN, top - drawnH - 14, CONTENT_W, drawnH + 14, undefined, LINE);
  const eq = equipmentByRoom(data.placements);
  for (const f of layout.floors) {
    s.text(f.label, x0, top - 6 - f.y - 8, { size: 7.5, bold: true, color: MUTED });
  }
  for (const r of layout.rects) {
    const x = x0 + r.x;
    const y = top - 7 - r.y - r.h;
    const isArea = r.roomId === highlight;
    s.page.drawRectangle({
      x,
      y,
      width: r.w,
      height: r.h,
      color: isArea ? AFFECTED_FILL : rgb(1, 1, 1),
      borderColor: INK,
      borderWidth: isArea ? 1.4 : 0.8,
      borderDashArray: r.dims ? undefined : [3, 2],
    });
    const ink = isArea ? rgb(1, 1, 1) : INK;
    const label = fit(s, r.label, 7, r.w - 4);
    s.text(label, x + 2, y + r.h - 9, {
      size: 7,
      bold: true,
      color: ink,
      align: "center",
      width: r.w - 4,
    });
    s.text(r.dims ?? "size not recorded", x + 2, y + r.h - 18, {
      size: 6,
      color: isArea ? ink : MUTED,
      align: "center",
      width: r.w - 4,
    });
    // Equipment: a triangle for air movers, a square for dehumidifiers, a dot otherwise, with the count.
    const counts = eq.get(r.roomId);
    if (counts && r.h >= 30) {
      let gx = x + 4;
      for (const [type, n] of counts) {
        const c = equipmentColour(type, 0);
        glyph(s, type, gx + 3, y + 6, c);
        s.text(String(n), gx + 8, y + 3.5, { size: 6.5, bold: true, color: ink });
        gx += 8 + s.widthOf(String(n), 6.5, true) + 4;
        if (gx > x + r.w - 10) break;
      }
    }
  }
  s.y = top - drawnH - 14;
  // Legend and the honesty line.
  s.y -= 10;
  let lx = MARGIN;
  for (const [type, label] of [
    ["air_mover", "Air mover"],
    ["dehumidifier", "Dehumidifier"],
    ["other", "Other equipment"],
  ] as const) {
    glyph(s, type, lx + 3, s.y + 2.5, equipmentColour(type, 0));
    s.text(label, lx + 9, s.y, { size: 7, color: MUTED });
    lx += 14 + s.widthOf(label, 7) + 10;
  }
  s.box(lx, s.y - 1, 9, 7, AFFECTED_FILL, INK);
  s.text("This area", lx + 12, s.y, { size: 7, color: MUTED });
  s.para(SCHEMATIC_NOTE, { size: 7, color: MUTED });
}

function glyph(s: Sheet, type: string, cx: number, cy: number, color: RGB) {
  if (type === "air_mover") {
    s.page.drawSvgPath("M 0 -3.5 L 3.5 3 L -3.5 3 Z", {
      x: cx,
      y: cy,
      color,
      borderColor: color,
      borderWidth: 0.3,
    });
  } else if (type === "dehumidifier") {
    s.page.drawRectangle({ x: cx - 3, y: cy - 3, width: 6, height: 6, color });
  } else {
    s.page.drawCircle({ x: cx, y: cy, size: 3, color: EQUIPMENT_COLOURS[type] ?? MUTED });
  }
}

function fit(s: Sheet, text: string, size: number, width: number): string {
  let t = sanitize(text);
  if (s.widthOf(t, size, true) <= width) return t;
  while (t.length > 3 && s.widthOf(`${t}...`, size, true) > width) t = t.slice(0, -1);
  return `${t}...`;
}

/* ------------------------------------------------------------------ */
/* Tables                                                              */
/* ------------------------------------------------------------------ */

/** Draw rows, repeating the header whenever a row starts a new page. */
function table(s: Sheet, cols: Col[], rows: Record<string, Cell | undefined>[]) {
  s.tableHeader(cols);
  rows.forEach((row, i) => {
    if (s.y - 30 < MARGIN + s.footerH) {
      s.addPage();
      s.tableHeader(cols);
    }
    s.tableRow(cols, row, MARGIN, { zebra: i % 2 === 1 });
  });
}

function timeIn(iso: string | null, timeZone: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}

/** "2026-05-23" → "05/23/2026": a table column that never wraps. */
function numericDate(d: string): string {
  const [y, m, day] = d.split("-");
  return y && m && day ? `${m}/${day}/${y}` : d;
}

const num = (v: number | null | undefined, decimals = 0) =>
  v == null ? "" : formatValue(Number(v), decimals);

function tables(s: Sheet, input: DryingReportPdfInput) {
  const { data } = input;
  const [, readingsSheet] = data.sheets;

  s.addPage();
  heading(s, HEADINGS.readings);
  /*
   * One short line where a methodology paragraph used to be (Mark, 13 Oct:
   * drop it). The zone stays because the Time column means nothing without
   * it; where each outside figure came from is in its own Source cell.
   */
  s.para(`Times in ${data.timeZone}.`, { size: 7.5, color: MUTED });
  s.gap(4);
  const cols: Col[] = [
    { key: "date", label: "Date", width: 60 },
    { key: "place", label: "Point / room", width: 118 },
    { key: "source", label: "Source", width: 84, small: true, clamp: 2 },
    { key: "time", label: "Time", width: 36 },
    { key: "t", label: "Temp F", width: 40, align: "right" },
    { key: "rh", label: "%RH", width: 34, align: "right" },
    { key: "dp", label: "Dew pt", width: 40, align: "right" },
    { key: "gpp", label: "GPP", width: 36, align: "right" },
    { key: "note", label: "Note", width: 84, small: true, clamp: 3 },
  ];
  table(
    s,
    cols,
    readingsSheet.rows.map((r) => {
      const modelled = r.source === SOURCE_MODELLED;
      const station = r.source === SOURCE_STATION || r.source === SOURCE_STATION_CUSTOMER;
      const automatic = modelled || station;
      const notes = [
        r.baseline ? `Baseline set${r.baseline.includes("inferred") ? " (inferred)" : ""}` : null,
        // An automatic row's note is its source label, printed under Source.
        !automatic && r.note ? r.note : null,
      ].filter(Boolean);
      return {
        date: numericDate(r.date),
        place: r.location ?? { text: "No crew reading", color: RED },
        // Never blank for an automatic row: it must not read as a crew reading.
        source:
          r.source == null
            ? ""
            : automatic
              ? (r.note ?? (modelled ? MODELLED_LABEL : "Weather service"))
              : "Crew",
        time: timeIn(r.observedAt, data.timeZone),
        t: num(r.temperatureF, 1),
        rh: num(r.relativeHumidity, 1),
        dp: num(r.dewPointF, 1),
        gpp: num(r.grainsPerPound, 1),
        note: notes.join(". "),
      };
    }),
  );

  /*
   * No "Days with no crew reading" page: this report is the customer copy
   * (Sheet.create("customer") above), and that list is internal only —
   * David, 27 Oct. The workbook's customer copy does not even build it.
   */

  moistureTable(s, data);
  equipmentTables(s, input);
}

function moistureTable(s: Sheet, data: DryingReportData) {
  const points = data.moisturePoints ?? [];
  const read = points.filter((p) => p.history.length > 0);
  if (read.length === 0) return;
  s.addPage();
  heading(s, HEADINGS.moistureTable);
  s.para(
    "Each fixed point's meter reading by day, in the meter's own scale (%). The dry goal is the dry standard " +
      "(the same material read in an unaffected area) plus 10%, never less than one point. Red is above the goal; green is at or under it.",
    { size: 7.5, color: MUTED },
  );
  s.gap(4);
  const dates = [...new Set(read.flatMap((p) => p.history.map((h) => h.reading_date)))].sort();
  const roomName = new Map(data.rooms.map((r) => [r.id, data.roomLabel(r)]));
  const perBlock = 8;
  for (let b = 0; b < dates.length; b += perBlock) {
    const block = dates.slice(b, b + perBlock);
    const fixed = 160 + 44;
    const dayW = Math.floor((CONTENT_W - fixed) / perBlock);
    const cols: Col[] = [
      { key: "point", label: "Point", width: 160, small: true, clamp: 3 },
      { key: "goal", label: "Dry goal", width: 44, align: "right" },
      ...block.map((d) => ({ key: d, label: dayLabel(d), width: dayW, align: "right" as const })),
    ];
    s.ensure(60);
    table(
      s,
      cols,
      read.map((p) => {
        const goal = dryGoal(p.point.dry_standard);
        const byDay = new Map(p.history.map((h) => [h.reading_date, h.moisture_pct]));
        const row: Record<string, Cell> = {
          point: `${p.point.room_id ? (roomName.get(p.point.room_id) ?? "Room removed") : "No room"} - ${moisturePointName(p.point, MOISTURE_MATERIAL_LABEL)}${p.removed ? " (removed)" : ""}`,
          goal: goal == null ? "none" : `${formatValue(goal, 1)}%`,
        };
        for (const d of block) {
          const v = byDay.get(d);
          row[d] =
            v == null
              ? ""
              : {
                  text: formatValue(v, 1),
                  bold: true,
                  color: goal == null ? INK : v <= goal ? GREEN : RED,
                };
        }
        return row;
      }),
    );
    s.gap(8);
  }
}

function equipmentTables(s: Sheet, input: DryingReportPdfInput) {
  const { data } = input;
  if (data.placements.length === 0) return;
  s.addPage();
  heading(s, HEADINGS.equipmentLog);
  s.para(
    "Days on site count the drop-off day as day 1 and the pickup day as the last, in Eastern time - the rule the equipment is billed by.",
    { size: 7.5, color: MUTED },
  );
  s.gap(4);
  const roomName = new Map(data.rooms.map((r) => [r.id, data.roomLabel(r)]));
  const fmtDay = (iso: string | null) => (iso ? shortDate(iso) : "");
  table(
    s,
    [
      { key: "type", label: "Type", width: 82 },
      { key: "tag", label: "Asset tag", width: 70 },
      { key: "room", label: "Room", width: 130 },
      { key: "placed", label: "Placed", width: 70 },
      { key: "retrieved", label: "Retrieved", width: 70 },
      { key: "days", label: "Days", width: 40, align: "right" },
      { key: "hours", label: "Hours", width: 70, align: "right" },
    ],
    data.placements.map((p) => {
      const hours =
        p.hour_meter_start != null && p.hour_meter_end != null
          ? p.hour_meter_end - p.hour_meter_start
          : null;
      return {
        type: EQUIPMENT_TYPE_LABEL[p.equipment_type ?? "other"] ?? p.equipment_type ?? "Other",
        tag: p.asset_tag ?? "",
        room: p.room_id ? (roomName.get(p.room_id) ?? "Room removed") : "No room recorded",
        placed: fmtDay(p.placed_at),
        retrieved: p.retrieved_at ? fmtDay(p.retrieved_at) : { text: "On site", bold: true },
        days: String(equipmentDaysOnSite(p.placed_at, p.retrieved_at, input.generatedAt) ?? ""),
        hours: hours == null ? "" : formatValue(hours, 1),
      };
    }),
  );

  const eq = data.equipment;
  if (eq.dates.length === 0) return;
  s.gap(10);
  s.sectionLabel(HEADINGS.equipmentDaily);
  const typeW = Math.min(90, Math.floor((CONTENT_W - 80) / Math.max(1, eq.types.length)));
  table(
    s,
    [
      { key: "date", label: "Date", width: 80 },
      ...eq.types.map((t) => ({
        key: t,
        label: eq.labels[t] ?? t,
        width: typeW,
        align: "right" as const,
      })),
    ],
    eq.dates.map((d, i) => ({
      date: shortDate(d),
      ...Object.fromEntries(eq.types.map((t) => [t, String(eq.counts[t]?.[i] ?? 0)])),
    })),
  );
}

/* ------------------------------------------------------------------ */
/* Footer                                                              */
/* ------------------------------------------------------------------ */

function footer(s: Sheet, data: DryingReportData) {
  const pages = s.doc.getPages();
  const left = sanitize(
    ["Drying report", data.jobNumber ? `Job ${data.jobNumber}` : null, data.address]
      .filter(Boolean)
      .join("  |  "),
  );
  pages.forEach((p, i) => {
    const y = MARGIN - 8;
    p.drawLine({
      start: { x: MARGIN, y: y + 11 },
      end: { x: PAGE_W - MARGIN, y: y + 11 },
      thickness: 0.6,
      color: LINE,
    });
    const label = `Page ${i + 1} of ${pages.length}`;
    const lw = s.font.widthOfTextAtSize(label, 7.5);
    let text = left;
    while (text.length > 10 && s.font.widthOfTextAtSize(text, 7.5) > CONTENT_W - lw - 20)
      text = text.slice(0, -1);
    p.drawText(text, { x: MARGIN, y, size: 7.5, font: s.font, color: MUTED });
    p.drawText(label, { x: PAGE_W - MARGIN - lw, y, size: 7.5, font: s.font, color: MUTED });
  });
}
