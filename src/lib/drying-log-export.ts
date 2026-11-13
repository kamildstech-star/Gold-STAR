/**
 * The drying log as a file an adjuster can be handed.
 *
 * Until this existed the readings never left the app: no PDF builder touched
 * `job_drying_readings`, nothing in the drying components used the exporter,
 * the job report had no drying section and the report engine only ever matched
 * the word "drying" in a job's status. So when a carrier disputed an equipment
 * charge, the evidence was a tab on somebody's screen.
 *
 * WHY A WORKBOOK AND NOT A SECTION OF THE JOB REPORT
 * The job report is a model-written narrative over a snapshot frozen at
 * generation time, behind a draft → approve loop, and its section ticks exist
 * to decide what the model is SHOWN. A drying log is the opposite kind of
 * document: every row is a figure somebody measured (or a model produced, and
 * says so), and its value is that nothing between the meter and the adjuster
 * paraphrased it. Narrating dew points would add a layer that can overstate the
 * evidence, which is the one thing this document must not do. An adjuster also
 * does with a drying log what the client does with every other export — sorts
 * it by point, filters it to one room, checks a day — so it goes through
 * src/lib/export-table.ts like every other list, as a real workbook with
 * numeric cells, and through the export gate like every other download.
 *
 * WHAT IT MUST NOT DO
 *  - Present a modelled outside figure as a measurement. Every such row says so
 *    by itself — Source "Modelled — Open-Meteo, not on site" and the short label
 *    "Modelled (Open-Meteo)" — because an adjuster is entitled to challenge a
 *    grid-model value and a row read on its own in a filtered sheet has to say
 *    it. Nor a weather station's measurement as one taken at the address: since
 *    2026-10-07 the nightly job can fill from the nearest NWS station, and
 *    those rows say "Measured — NWS weather station, not on site" and name the
 *    station and its distance ("NWS KEWR, 3.8 mi"). The full explanatory
 *    sentence (OUTSIDE_MODELLED_NOTE / outsideReadingNote) is said once, on the
 *    Summary sheet. Mark, 13 Oct, wanted the sentence off every row: the label
 *    keeps the provenance, the sentence was repetition.
 *  - Hide a gap. A day with no crew reading is a row in the readings sheet AND
 *    a row in the gaps sheet. An undocumented day is a day a carrier can refuse
 *    to pay equipment for; leaving it out would make the log look complete and
 *    lose the argument the first time somebody counts the days.
 *  - Drop a reading. The on-screen table shows one reading per place per day;
 *    this shows every one, because a second reading in the same room is
 *    evidence too.
 *
 * Crew notes on a reading are deliberately NOT exported. They are written for
 * the office, and this file goes to a carrier — the same reason the job report
 * starts empty.
 *
 * Pure: rows in, sheet specs out. The component hands them to
 * ExportExcelButton, which logs the export and builds the file.
 */
import { findBaselineSet } from "@/lib/drying-baseline";
import {
  DRYING_POINT_LABEL,
  buildDryingLog,
  todayLocal,
  type DryingReading,
  type DryingSeries,
} from "@/lib/drying-log";
import type { ExportColumn } from "@/lib/export-table";
import {
  OUTSIDE_BASELINE_LABEL,
  OUTSIDE_MODELLED_NOTE,
  isStationReading,
  outsideReadingLabel,
  outsideReadingNotes,
} from "@/lib/outside-conditions";

/**
 * How far back the file reaches. The screen caps its calendar at 180 days,
 * which is right for a glance and wrong for a document: a reading past the cap
 * would silently not be in the file. Ten years is "everything" for any real
 * drying job while still bounding a typo'd 1926 reading date.
 */
export const EXPORT_MAX_DAYS = 3660;

/** Said on every day with no crew reading. */
export const NO_CREW_READING = "No crew reading";
export const CREW_READING_ON_FILE = "Crew reading on file";

export const SOURCE_CREW = "Crew — meter on site";
export const SOURCE_MODELLED = "Modeled — Open-Meteo, not on site";
/**
 * A National Weather Service station's measurement, written by the nightly job
 * when Open-Meteo refuses the server. Measured, but at the station — the row's
 * note names it and its distance.
 */
export const SOURCE_STATION = "Measured — NWS weather station, not on site";
/**
 * The same station row in a CUSTOMER file (David, 13 Oct): measured, not on
 * site — but without saying which station or how far away it is.
 */
export const SOURCE_STATION_CUSTOMER = "Measured — weather service, not on site";

/**
 * Who a drying export is for.
 *
 * David, 13 Oct: the customer and the carrier must not see that a reading was
 * entered on a later day, or which weather station an outside figure came
 * from — that is the office's bookkeeping. Every drying file that leaves the
 * building (the Excel log, the drying report PDF built from it, a share link)
 * is "customer", which is the default. "internal" keeps both, for the office.
 * Genuine notes — gaps, the baseline — are the same in both.
 */
export type DryingExportAudience = "customer" | "internal";

/** The note on a day where nothing at all was recorded. */
export const GAP_ROW_NOTE =
  "Nothing was recorded on this day — no crew reading and no automatic outside figure.";

/** One line of the readings sheet: one reading, or one day with none. */
export type DryingLogExportRow = {
  date: string;
  day: typeof CREW_READING_ON_FILE | typeof NO_CREW_READING;
  /** "Outside", "Inside", "Affected", "Dehu inlet" … */
  point: string | null;
  /** The place: "Inside — Kitchen", "Dehu inlet — DH-12", the modelled outside label. */
  location: string | null;
  source: string | null;
  /** ISO instant. The modelled hour for a weather row; when it was logged for a crew row. */
  observedAt: string | null;
  // `note` on an automatic row is its short source label, "Modelled (Open-Meteo)"
  // or "NWS KEWR, 3.8 mi"; on a late crew entry, that its time is the entry time.
  temperatureF: number | null;
  relativeHumidity: number | null;
  dewPointF: number | null;
  grainsPerPound: number | null;
  baseline: string | null;
  note: string | null;
};

/** Where a gap sits, because a gap before the crew arrived is not one mid-job. */
export type GapPosition =
  | "Before the first crew reading"
  | "Between crew readings"
  | "After the last crew reading"
  | "No crew reading on this job";

export type DryingLogGapRow = {
  date: string | null;
  onFile: string;
  position: GapPosition | null;
  note: string;
};

export type DryingLogSummaryRow = { item: string; detail: string };

export const READING_COLUMNS: readonly ExportColumn<DryingLogExportRow>[] = [
  { key: "date", label: "Date", type: "date", get: (r) => r.date },
  { key: "day", label: "Day", get: (r) => r.day },
  { key: "point", label: "Point", get: (r) => r.point },
  { key: "location", label: "Room / place", get: (r) => r.location },
  { key: "source", label: "Source", get: (r) => r.source },
  { key: "observed_at", label: "Observation time", type: "datetime", get: (r) => r.observedAt },
  { key: "temperature_f", label: "Temperature (°F)", type: "number", get: (r) => r.temperatureF },
  {
    key: "relative_humidity",
    label: "Relative humidity (%)",
    type: "number",
    get: (r) => r.relativeHumidity,
  },
  { key: "dew_point_f", label: "Dew point (°F)", type: "number", get: (r) => r.dewPointF },
  {
    key: "grains_per_pound",
    label: "Grains per pound",
    type: "number",
    get: (r) => r.grainsPerPound,
  },
  { key: "baseline", label: "Baseline set", get: (r) => r.baseline },
  { key: "note", label: "Note", get: (r) => r.note },
];

export const GAP_COLUMNS: readonly ExportColumn<DryingLogGapRow>[] = [
  { key: "date", label: "Date", type: "date", get: (r) => r.date },
  { key: "on_file", label: "On file that day", get: (r) => r.onFile },
  { key: "position", label: "Where in the log", get: (r) => r.position },
  { key: "note", label: "Note", get: (r) => r.note },
];

export const SUMMARY_COLUMNS: readonly ExportColumn<DryingLogSummaryRow>[] = [
  { key: "item", label: "Item", get: (r) => r.item },
  { key: "detail", label: "Detail", get: (r) => r.detail },
];

/**
 * The Gaps sheet ("Days with no crew reading") is internal only — David,
 * 27 Oct: it must never reach a client or carrier. The customer copy (the
 * default) is the first two sheets; only `audience: "internal"` adds it.
 */
export type DryingLogSheets =
  | [
      { name: string; rows: DryingLogSummaryRow[]; columns: typeof SUMMARY_COLUMNS },
      { name: string; rows: DryingLogExportRow[]; columns: typeof READING_COLUMNS },
    ]
  | [
      { name: string; rows: DryingLogSummaryRow[]; columns: typeof SUMMARY_COLUMNS },
      { name: string; rows: DryingLogExportRow[]; columns: typeof READING_COLUMNS },
      { name: string; rows: DryingLogGapRow[]; columns: typeof GAP_COLUMNS },
    ];

/** Filled in by the weather job — model or station — rather than read by a crew. */
const isModelled = (r: DryingReading) => r.source === "weather";

/** The instant a row is stamped with: the modelled hour, else when it was logged. */
function observationTime(r: DryingReading): string | null {
  return (r as { observed_at?: string | null }).observed_at ?? r.captured_at ?? null;
}

/**
 * A crew row logged on a later day than the one it records — a reading typed
 * up back at the office, or drained from the offline queue. Its time column is
 * when it was ENTERED, and printing that bare beside an earlier date would
 * read as a meter being consulted two days late. So it says which it is — in
 * a few words (Mark, 13 Oct, wanted the old sentence gone), not a paragraph.
 */
export function lateEntryLabel(entered: string): string {
  return `Entered ${entered}; time shown is entry time`;
}

function lateEntryNote(r: DryingReading): string | null {
  if (isModelled(r) || !r.captured_at) return null;
  const at = new Date(r.captured_at);
  if (!Number.isFinite(at.getTime())) return null;
  const entered = todayLocal(at);
  if (entered <= r.reading_date) return null;
  return lateEntryLabel(entered);
}

function readingRow(
  r: DryingReading,
  series: DryingSeries | undefined,
  day: DryingLogExportRow["day"],
  baselineMark: string | null,
  audience: DryingExportAudience = "internal",
): DryingLogExportRow {
  if (audience === "customer") {
    const station = isStationReading(r);
    return {
      date: r.reading_date,
      day,
      point: DRYING_POINT_LABEL[r.point] ?? r.point,
      location: series?.label ?? DRYING_POINT_LABEL[r.point] ?? r.point,
      source: !isModelled(r) ? SOURCE_CREW : station ? SOURCE_STATION_CUSTOMER : SOURCE_MODELLED,
      // A crew reading typed in on a later day carries the ENTRY time, not
      // when it was read; printed beside its date it would say a meter was
      // read at that hour. The date stays — the time is left blank.
      observedAt: lateEntryNote(r) ? null : observationTime(r),
      temperatureF: r.temperature_f,
      relativeHumidity: r.relative_humidity,
      dewPointF: r.dew_point_f,
      grainsPerPound: r.grains_per_pound,
      baseline: baselineMark,
      // No station name or distance, and no "entered on" note.
      note: isModelled(r) && !station ? outsideReadingLabel(r) : null,
    };
  }
  return {
    date: r.reading_date,
    day,
    point: DRYING_POINT_LABEL[r.point] ?? r.point,
    location: series?.label ?? DRYING_POINT_LABEL[r.point] ?? r.point,
    source: !isModelled(r) ? SOURCE_CREW : isStationReading(r) ? SOURCE_STATION : SOURCE_MODELLED,
    observedAt: observationTime(r),
    temperatureF: r.temperature_f,
    relativeHumidity: r.relative_humidity,
    dewPointF: r.dew_point_f,
    grainsPerPound: r.grains_per_pound,
    baseline: baselineMark,
    note: isModelled(r) ? outsideReadingLabel(r) : lateEntryNote(r),
  };
}

function gapPosition(date: string, firstCrew: string | null, lastCrew: string | null): GapPosition {
  if (!firstCrew || !lastCrew) return "No crew reading on this job";
  if (date < firstCrew) return "Before the first crew reading";
  if (date > lastCrew) return "After the last crew reading";
  return "Between crew readings";
}

export function dryingLogWorkbook(input: {
  rows: DryingReading[];
  roomNames?: Map<string, string>;
  jobNumber?: string | null;
  address?: string | null;
  /** Local `YYYY-MM-DD`; the log's window runs to here. Defaults to today. */
  today?: string;
  /**
   * The zone the observation times are written in. A spreadsheet cell holds a
   * wall-clock time with no zone attached, and the exporter writes the
   * browser's own, so the file has to say which — otherwise a modelled 09:00
   * at a New Jersey site exported from a laptop in California reads 06:00, and
   * an adjuster comparing it with the crew's 09:15 is comparing nothing.
   */
  timeZone?: string;
  /** Customer (the default) leaves out entry dates and weather-station details. */
  audience?: DryingExportAudience;
  /** The day all equipment came off (equipmentPickupDate); the log stops there. */
  endDate?: string | null;
}): DryingLogSheets {
  const audience: DryingExportAudience = input.audience ?? "customer";
  const forCustomer = audience === "customer";
  const today = input.today ?? todayLocal();
  const timeZone = input.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  // Automatic readings after pickup do not belong to the job (see endDate).
  const rows = input.endDate
    ? input.rows.filter((r) => !isModelled(r) || r.reading_date <= input.endDate!)
    : input.rows;
  const log = buildDryingLog(rows, {
    today,
    roomNames: input.roomNames,
    maxDays: EXPORT_MAX_DAYS,
    endDate: input.endDate,
  });
  const seriesByKey = new Map(log.series.map((s) => [s.key, s]));
  const seriesRank = new Map(log.series.map((s, i) => [s.key, i]));

  const baseline = findBaselineSet(rows);
  const baselineMark = baseline ? (baseline.declared ? "Yes" : "Yes (inferred)") : null;

  const crewDates = rows
    .filter((r) => !isModelled(r))
    .map((r) => r.reading_date)
    .sort();
  const firstCrew = crewDates[0] ?? null;
  const lastCrew = crewDates[crewDates.length - 1] ?? null;

  // Oldest first: on paper a log is read forwards, and the screen's
  // newest-first order is for a technician looking for today.
  const days = [...log.days].reverse();

  const readings: DryingLogExportRow[] = [];
  const gaps: DryingLogGapRow[] = [];
  for (const d of days) {
    const status = d.missing ? NO_CREW_READING : CREW_READING_ON_FILE;
    const entries = Object.entries(d.bySeries).sort(
      ([a], [b]) => (seriesRank.get(a) ?? 0) - (seriesRank.get(b) ?? 0),
    );
    if (entries.length === 0) {
      readings.push({
        date: d.date,
        day: status,
        point: null,
        location: null,
        source: null,
        observedAt: null,
        temperatureF: null,
        relativeHumidity: null,
        dewPointF: null,
        grainsPerPound: null,
        baseline: null,
        note: GAP_ROW_NOTE,
      });
    }
    for (const [key, taken] of entries) {
      const ordered = [...taken].sort((a, b) =>
        (observationTime(a) ?? "").localeCompare(observationTime(b) ?? ""),
      );
      for (const r of ordered) {
        readings.push(
          readingRow(
            r,
            seriesByKey.get(key),
            status,
            baseline && r.reading_date === baseline.date ? baselineMark : null,
            audience,
          ),
        );
      }
    }
    if (d.missing) {
      const automaticOnly = entries.length > 0;
      // Said as what it is: a station measurement is not "modelled", and is
      // no more evidence that anybody was at the property than the model is.
      const figure = forCustomer
        ? "automatic outside figure"
        : entries.some(([, rs]) => rs.some(isStationReading))
          ? "weather-station outside figure"
          : "modeled outside figure";
      gaps.push({
        date: d.date,
        onFile: automaticOnly ? `${figure[0]!.toUpperCase()}${figure.slice(1)} only` : "Nothing",
        position: gapPosition(d.date, firstCrew, lastCrew),
        // "On file that day" already names the automatic figure; the note
        // used to add a sentence saying it is not evidence of a visit, which
        // Mark (13 Oct) wanted gone. The row still reads as a gap.
        note: automaticOnly ? "No crew reading." : "No crew reading and nothing else recorded.",
      });
    }
  }

  if (gaps.length === 0) {
    // An empty sheet would read as "not checked". Say what was checked.
    gaps.push({
      date: null,
      onFile: "",
      position: null,
      note:
        days.length > 0
          ? `No gaps: a crew reading is on file for every day from ${days[0]!.date} to ${days[days.length - 1]!.date}.`
          : "No readings on file for this job.",
    });
  }

  const crewCount = rows.filter((r) => !isModelled(r)).length;
  const stationCount = rows.filter(isStationReading).length;
  const modelledCount = rows.length - crewCount - stationCount;
  const documented = days.length - log.gaps.length;

  const summary: DryingLogSummaryRow[] = [
    {
      item: "Document",
      detail: "Drying log — psychrometric readings by day and measurement point",
    },
  ];
  if (input.jobNumber) summary.push({ item: "Job", detail: input.jobNumber });
  if (input.address) summary.push({ item: "Property", detail: input.address });
  summary.push(
    {
      item: "Period",
      detail:
        days.length > 0
          ? `${days[0]!.date} to ${days[days.length - 1]!.date} (${days.length} day${days.length === 1 ? "" : "s"}). ` +
            "Runs from the first reading to the day this log was exported; every day in between has a row, logged or not."
          : "No readings on file.",
    },
    {
      item: "Times",
      detail:
        `Observation times are in ${timeZone}, the time zone of the computer this log was ` +
        `exported from. A modeled outside figure is the ${OUTSIDE_BASELINE_LABEL} hour at the property.` +
        (stationCount > 0 && !forCustomer
          ? ` A weather-station figure is the station's report nearest ${OUTSIDE_BASELINE_LABEL}, at the time shown.`
          : "") +
        (forCustomer
          ? " A crew reading entered after the day it records shows its date with no time."
          : ""),
    },
    { item: "Days with a crew reading", detail: `${documented} of ${days.length}` },
  );
  // Internal only: a customer copy never counts or lists the undocumented days.
  if (!forCustomer) {
    summary.push({
      item: "Days with no crew reading",
      detail:
        log.gaps.length > 0
          ? `${log.gaps.length} — each one is listed on the Gaps sheet.`
          : "None.",
    });
  }
  summary.push({ item: "Crew readings", detail: String(crewCount) });
  if (forCustomer) {
    // One count, no station: the customer copy says the figure is automatic
    // and not on site, never where it came from.
    summary.push({
      item: "Automatic outside readings",
      detail: String(modelledCount + stationCount),
    });
  } else {
    summary.push({ item: "Modeled outside readings", detail: String(modelledCount) });
    if (stationCount > 0) {
      summary.push({ item: "Weather-station outside readings", detail: String(stationCount) });
    }
  }
  if (modelledCount > 0) {
    summary.push({ item: "Modeled outside figures", detail: OUTSIDE_MODELLED_NOTE });
  }
  // One line per station: each names its own distance — office copy only.
  if (!forCustomer) {
    for (const note of outsideReadingNotes(rows.filter(isStationReading))) {
      summary.push({ item: "Weather-station outside figures", detail: note });
    }
  }
  summary.push(
    {
      item: "Baseline",
      detail: !baseline
        ? "None — no crew reading on file."
        : baseline.declared
          ? `${baseline.date} — flagged by the crew as the baseline set.`
          : `${baseline.date} — inferred as the first day with a crew reading; the crew did not flag a baseline set.`,
    },
    {
      item: "Dew point and grains per pound",
      detail:
        "Calculated from each reading's temperature and relative humidity when it was logged — not read off the meter.",
    },
    { item: "Exported", detail: today },
  );

  const summarySheet = { name: "Summary", rows: summary, columns: SUMMARY_COLUMNS };
  const readingsSheet = { name: "Readings", rows: readings, columns: READING_COLUMNS };
  if (forCustomer) return [summarySheet, readingsSheet];
  return [summarySheet, readingsSheet, { name: "Gaps", rows: gaps, columns: GAP_COLUMNS }];
}

/** The filename stem: `drying-log-<job>-<yyyy-mm-dd>.xlsx` once exportFilename has it. */
export function dryingLogReportName(jobNumber?: string | null): string {
  return jobNumber ? `Drying log ${jobNumber}` : "Drying log";
}
