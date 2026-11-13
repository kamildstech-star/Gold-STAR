import type { DryingLog, DryingReading } from "./drying-log";
import { parseOutsideSourceDetail } from "./outside-conditions";

/**
 * The drying log as a calendar of small squares — one per day, oldest first,
 * the way a wall calendar reads. Each square carries only what a glance
 * needs: was the day logged at all, and where did the worst room stand.
 *
 * Three states, kept apart on purpose. "Entered" means a crew reading exists.
 * "Weather only" means the nightly job filled the outside baseline and nobody
 * visited — which is a gap as far as a carrier is concerned, so it must never
 * look like a logged day. "Empty" is a day nothing has touched yet.
 *
 * Since 2026-09-04 a square carries the outside and inside figures as a PAIR.
 * Melly Chein asked for the two together — outside filled automatically at
 * nine, inside typed by a technician with a photo of the meter — and read
 * side by side they are the whole story of a drying day: a property whose
 * inside dew point is falling towards the outside one is drying. The tile did
 * not grow to fit them; the unaffected control moved off the square (it is
 * still on the chart, in the table and in the tile's own hover text), because
 * it is a per-room control and these two are the property.
 */

export type DryingTileStatus = "empty" | "weather_only" | "entered";

export type DryingDayTile = {
  date: string;
  status: DryingTileStatus;
  /** Crew readings taken that day. The modelled baseline never counts. */
  crewReadings: number;
  /**
   * Highest affected dew point of the day. The wettest room is the one the
   * claim turns on, so the tile shows that rather than an average.
   */
  affectedDewPoint: number | null;
  unaffectedDewPoint: number | null;
  /** A crew's outside reading when there is one, else the modelled figure. */
  outsideDewPoint: number | null;
  /**
   * The relative humidity and temperature the outside dew point was derived
   * from. Mark, 2026-10-05: "humidity is missing". A dew point is a derived
   * figure; relative humidity is the one a technician read off a meter and the
   * one an S500 log is written in, so a carrier arguing about equipment days
   * expects to see it. Both come off the SAME reading as outsideDewPoint — a
   * humidity from one row beside a dew point from another is a reading nobody
   * took.
   */
  outsideRh: number | null;
  outsideTempF: number | null;
  /** True when the outside figure came from the nightly weather job, not a meter. */
  outsideModelled: boolean;
  /**
   * When that automatic figure is a National Weather Service station's
   * measurement rather than Open-Meteo's model, the station ("KEWR"). Optional
   * so a tile built anywhere else still reads as the model, which is what
   * every automatic figure was before 2026-10-07.
   */
  outsideStation?: string | null;
  /** Inside the property, off a technician's meter. Never modelled. */
  insideDewPoint: number | null;
  /** Off the same interior reading as insideDewPoint, for the same reason. */
  insideRh: number | null;
  insideTempF: number | null;
  /** Inside dew point minus the baseline's. Negative is drying. */
  insideDeltaF: number | null;
  /** How many of the day's readings carry a photograph of the meter. */
  meterPhotos: number;
  /** This is the day the whole job is read against. */
  isBaseline: boolean;
  isToday: boolean;
};

function last(readings: DryingReading[] | undefined): DryingReading | null {
  // The last reading of the day is the one the day is judged on — the same
  // rule the historical table applies.
  return readings?.[0] ?? null;
}

function hasPhoto(r: DryingReading): boolean {
  return Boolean((r as { photo_path?: string | null }).photo_path);
}

/** The NWS station behind an automatic outside reading, or null for the model or no reading. */
function stationOf(r: DryingReading | null | undefined): string | null {
  if (!r) return null;
  const p = parseOutsideSourceDetail(r.source_detail);
  return p.kind === "station" ? p.stationId : null;
}

/**
 * Squares for every day the log covers, oldest first. Today is always present
 * so there is a square to tap before the first reading exists.
 *
 * `baseline` is optional because a job that has never been logged has none, and
 * because `is_baseline` ships in a migration that is not applied yet — the
 * squares have to read correctly with it absent.
 */
export function buildDryingDayTiles(
  log: DryingLog,
  today: string,
  baseline?: { date: string; insideDewPoint: number | null } | null,
): DryingDayTile[] {
  const tiles: DryingDayTile[] = [];
  let sawToday = false;

  // The log is newest first; a calendar reads the other way.
  for (const day of [...log.days].reverse()) {
    let crewReadings = 0;
    let weatherReadings = 0;
    let meterPhotos = 0;
    let affectedDewPoint: number | null = null;
    let unaffectedDewPoint: number | null = null;
    let insideDewPoint: number | null = null;
    let insideReading: DryingReading | null = null;
    let crewOutside: DryingReading | null = null;
    let modelledOutside: DryingReading | null = null;

    for (const series of log.series) {
      const taken = day.bySeries[series.key] ?? [];
      for (const r of taken) {
        if (r.source === "weather") weatherReadings += 1;
        else crewReadings += 1;
        if (hasPhoto(r)) meterPhotos += 1;
      }
      const r = last(taken);
      if (!r) continue;
      if (series.point === "affected") {
        if (r.dew_point_f != null) {
          affectedDewPoint =
            affectedDewPoint == null ? r.dew_point_f : Math.max(affectedDewPoint, r.dew_point_f);
        }
      } else if (series.point === "unaffected") {
        unaffectedDewPoint ??= r.dew_point_f;
      } else if (series.point === "interior") {
        // Since 2026-09-07 an interior reading can name the room it was taken
        // in, so a day may carry several. The square shows the WETTEST, for the
        // same reason `affected` does: a house is dry when its worst room is
        // dry, and an average would invent a room nobody stood in. This is also
        // the rule compareToBaseline already applies, so the square's figure and
        // the baseline delta beside it are the same reading.
        if (r.dew_point_f != null && (insideDewPoint == null || r.dew_point_f > insideDewPoint)) {
          insideDewPoint = r.dew_point_f;
          // The whole reading, not just the figure: the humidity shown beside
          // the dew point has to be the humidity that dew point was derived
          // from, or the square quotes two different rooms as one reading.
          insideReading = r;
        }
      } else if (series.point === "exterior") {
        if (r.source === "weather") modelledOutside ??= r;
        else crewOutside ??= r;
      }
    }

    const outside = crewOutside ?? modelledOutside;
    const isToday = day.date === today;
    if (isToday) sawToday = true;
    tiles.push({
      date: day.date,
      status: crewReadings > 0 ? "entered" : weatherReadings > 0 ? "weather_only" : "empty",
      crewReadings,
      affectedDewPoint,
      unaffectedDewPoint,
      outsideDewPoint: outside?.dew_point_f ?? null,
      outsideRh: outside?.relative_humidity ?? null,
      outsideTempF: outside?.temperature_f ?? null,
      outsideModelled: !crewOutside && !!modelledOutside,
      outsideStation: stationOf(crewOutside ? null : modelledOutside),
      insideDewPoint,
      insideRh: insideReading?.relative_humidity ?? null,
      insideTempF: insideReading?.temperature_f ?? null,
      insideDeltaF: deltaAgainst(insideDewPoint, baseline?.insideDewPoint ?? null),
      meterPhotos,
      isBaseline: !!baseline && baseline.date === day.date,
      isToday,
    });
  }

  if (!sawToday) {
    tiles.push({
      date: today,
      status: "empty",
      crewReadings: 0,
      affectedDewPoint: null,
      unaffectedDewPoint: null,
      outsideDewPoint: null,
      outsideRh: null,
      outsideTempF: null,
      outsideModelled: false,
      insideDewPoint: null,
      insideRh: null,
      insideTempF: null,
      insideDeltaF: null,
      meterPhotos: 0,
      isBaseline: !!baseline && baseline.date === today,
      isToday: true,
    });
  }

  return tiles;
}

/** One decimal place, so a square never shows 3.7000000000000002 degrees. */
function deltaAgainst(current: number | null, baseline: number | null): number | null {
  if (current == null || baseline == null) return null;
  return Math.round((current - baseline) * 10) / 10;
}

/* ------------------------------------------------------------------ */
/* Why a square is empty                                               */
/* ------------------------------------------------------------------ */

/**
 * A square that reads "out —" tells a user nothing. It looks identical whether
 * the nightly job has not run yet, whether the job has no address to ask about,
 * or whether the database is refusing the write — three situations with three
 * different people who have to do three different things.
 *
 * CORRECTED 2026-10-05, from the live database. The paragraph that stood here
 * said (from a 2026-09-07 read) that the policy migration was unapplied and no
 * `drying-outside-conditions` job existed. Both were applied on 2026-09-09.
 * What the live database shows instead: the job runs every day at 13:20 UTC
 * and authenticates — a 200 — but every site's Open-Meteo fetch fails
 * (`"failed_fetches":2`), so it has never written a row. All 23 outside
 * readings on file came from the Fetch outside button, in bursts. The browser
 * path works; the server path, identical but for where the request leaves
 * from, does not. See the header of
 * src/routes/api/public/hooks/drying-weather.ts for the cause and the fix.
 *
 * None of that is visible from the browser, which is why `writesRefused` is
 * reported rather than guessed, and why the log now fills its own missing days
 * when it is opened (see `outsideDaysToFill`) instead of waiting on the server.
 */
export type OutsideCellState =
  /** A figure exists — a crew's or the model's. */
  | "reading"
  /** Today, before 09:00 local: the observation being asked for has not happened. */
  | "soon"
  /** Fetchable and nobody has. This is the state a tap fixes. */
  | "unfetched"
  /** The job has no coordinates, so no grid square can be asked about. */
  | "no_location"
  /** The database refused the write. Applying a migration is the only fix. */
  | "blocked";

export type InsideCellState =
  | "reading"
  /** Today, and nobody has been round with a meter yet. */
  | "due"
  /** A past day nobody read. Already counted as a gap in the log. */
  | "none"
  /** The database cannot store an interior reading yet. */
  | "blocked";

/** What the panel knows about this job's ability to fill the outside figure. */
export type OutsideContext = {
  /** The job has a lat/lon to ask Open-Meteo about. */
  hasLocation: boolean;
  /** A write was refused by the database this session — retrying cannot help. */
  writesRefused: boolean;
  /** Whether this database can store an interior reading at all. */
  interiorAvailable: boolean;
  /**
   * Local wall-clock hour, 0-23. The 09:00 observation does not exist before
   * 09:00, so a morning square is "coming", not "missing" — see
   * OUTSIDE_BASELINE_HOUR in outside-conditions.ts.
   */
  hourOfDay: number;
};

/** The hour the automatic baseline is observed at. Kept in step with outside-conditions.ts. */
const BASELINE_HOUR = 9;

export function outsideCellState(tile: DryingDayTile, ctx: OutsideContext): OutsideCellState {
  if (tile.outsideDewPoint != null) return "reading";
  if (ctx.writesRefused) return "blocked";
  if (!ctx.hasLocation) return "no_location";
  if (tile.isToday && ctx.hourOfDay < BASELINE_HOUR) return "soon";
  return "unfetched";
}

export function insideCellState(tile: DryingDayTile, ctx: OutsideContext): InsideCellState {
  if (tile.insideDewPoint != null) return "reading";
  if (!ctx.interiorAvailable) return "blocked";
  return tile.isToday ? "due" : "none";
}

/**
 * What one half of the square says when it has no reading — the word — and
 * the sentence behind it, for the square's accessible name.
 *
 * `word` is null when there IS a reading: the figures then speak for
 * themselves, each under its own label, through `tileFigures` below. When
 * there is not, the word stands in the column where the figures would be and
 * says which of the reasons it is. Never an em-dash: every one of these words
 * names a different next step.
 */
export type DryingCellText<S> = {
  state: S;
  word: string | null;
  long: string;
};

/** "59.4 °F / 80% RH" — the pair as a meter reads it, for the accessible name. */
function meterPhrase(tempF: number | null, rh: number | null): string | null {
  if (tempF == null && rh == null) return null;
  if (rh == null) return `${tempF} °F`;
  if (tempF == null) return `${rh}% RH`;
  return `${tempF} °F / ${rh}% RH`;
}

export function describeOutsideCell(
  tile: DryingDayTile,
  ctx: OutsideContext,
): DryingCellText<OutsideCellState> {
  const state = outsideCellState(tile, ctx);
  switch (state) {
    case "reading": {
      const meter = meterPhrase(tile.outsideTempF, tile.outsideRh);
      return {
        state,
        word: null,
        long:
          `outside ${tile.outsideDewPoint}° dew point` +
          (meter ? `, ${meter}` : "") +
          (tile.outsideModelled
            ? tile.outsideStation
              ? ` (NWS station ${tile.outsideStation}, not on site)`
              : " (modeled)"
            : ""),
      };
    }
    case "soon":
      return {
        state,
        word: "soon",
        long: "outside is taken at 09:00 local — today's has not happened yet",
      };
    case "no_location":
      return {
        state,
        word: "n/a",
        long: "no outside figure — this job has no coordinates to fetch conditions for",
      };
    case "blocked":
      return {
        state,
        word: "setup",
        long: "no outside figure — this database is refusing automatic outside readings",
      };
    case "unfetched":
      return {
        state,
        word: "fetch",
        long: "no outside figure yet — tap Fetch outside to fill it now",
      };
  }
}

export function describeInsideCell(
  tile: DryingDayTile,
  ctx: OutsideContext,
): DryingCellText<InsideCellState> {
  const state = insideCellState(tile, ctx);
  switch (state) {
    case "reading": {
      const meter = meterPhrase(tile.insideTempF, tile.insideRh);
      return {
        state,
        word: null,
        long: `inside ${tile.insideDewPoint}° dew point` + (meter ? `, ${meter}` : ""),
      };
    }
    case "blocked":
      return {
        state,
        word: "setup",
        long: "inside readings cannot be stored by this database yet",
      };
    case "due":
      return { state, word: "due", long: "no inside reading typed today" };
    case "none":
      return { state, word: "none", long: "nobody read the inside on this day" };
  }
}

/* ------------------------------------------------------------------ */
/* Every figure on the square, each with its label                     */
/* ------------------------------------------------------------------ */

/**
 * Mark, 2026-10-05, the second message of the day: "for the temp readings,
 * everything need to be labeled in the box."
 *
 * The first pass put the dew point and the humidity on the square and left the
 * temperature in the hover text. A crew on a phone cannot hover, and neither
 * can a carrier reviewer looking at a screenshot — so a figure that only
 * exists on hover does not exist for either of the two people this strip is
 * for. Every number now lives inside the box, under a label.
 *
 * THE SHAPE IS A SMALL TABLE, NOT A STRING PER FIGURE. Two columns, Out and
 * In, one row each for Temp, RH and Dew:
 *
 *            Out     In
 *     Temp  59.4°  72.1°
 *     RH     80%    61%
 *     Dew   53.2°  58.0°
 *
 * Six figures as six "label value" strings ("out temp 59.4°") do not fit a
 * phone square at a legible size — and, worse, they scatter the comparison a
 * crew is actually making across six lines. In a table each figure is labelled
 * by the row it sits on AND the column it sits in, both printed inside the box,
 * and the out/in pair for each quantity sits side by side on one line: reading
 * the Dew row left to right IS the question "is the inside drying towards the
 * outside". That is the comparison the 2026-09-04 tile was built for, made
 * easier to read rather than harder.
 *
 * The labels are the detail panel's own words — the entry form below asks for
 * "Temp °F" and "RH %" and prints "Dew point" — so the square and the panel a
 * tap away say the same thing. Temp, RH, Dew order: the two a meter reads,
 * then the one calculated from them, which is how the panel quotes a reading.
 *
 * A side with no reading shows its word ("fetch", "none", "setup", …) in the
 * column instead, standing in for all three figures. A side WITH a reading
 * that lacks one field shows an em-dash in that cell — still on its labelled
 * row, so it is a labelled absence, not the bare "out —" that told nobody
 * anything.
 */
export type TileFigureRow = {
  label: "Temp" | "RH" | "Dew";
  /** The formatted figure, or null when that side has no reading at all. */
  out: string | null;
  in: string | null;
  /** The row the out/in comparison is read on. Drawn a shade stronger. */
  compare: boolean;
};

export type TileFigureColumn<S> = {
  heading: "Out" | "In";
  state: S;
  /** Set when the side has no reading; stands in the column for all three rows. */
  word: string | null;
};

export type TileFigures = {
  out: TileFigureColumn<OutsideCellState>;
  in: TileFigureColumn<InsideCellState>;
  rows: TileFigureRow[];
  /**
   * The wettest affected room's dew point, labelled. Always present: a day
   * nobody read the chamber prints "Affected dew —", a labelled absence, so
   * every square in the strip has the same rows in the same places.
   */
  affected: { label: "Affected dew"; value: string };
  /**
   * Inside dew point against the baseline set, labelled. Null when either half
   * is missing or the two are equal — a "▼0" says nothing.
   */
  insideVsBaseline: { label: "In vs base"; value: string; drier: boolean } | null;
};

function figure(n: number | null, unit: "°" | "%"): string {
  return n == null ? "—" : `${n}${unit}`;
}

export function tileFigures(tile: DryingDayTile, ctx: OutsideContext): TileFigures {
  const outside = describeOutsideCell(tile, ctx);
  const inside = describeInsideCell(tile, ctx);
  const outRead = outside.state === "reading";
  const inRead = inside.state === "reading";
  const pick = (read: boolean, n: number | null, unit: "°" | "%") =>
    read ? figure(n, unit) : null;
  return {
    out: { heading: "Out", state: outside.state, word: outside.word },
    in: { heading: "In", state: inside.state, word: inside.word },
    rows: [
      {
        label: "Temp",
        out: pick(outRead, tile.outsideTempF, "°"),
        in: pick(inRead, tile.insideTempF, "°"),
        compare: false,
      },
      {
        label: "RH",
        out: pick(outRead, tile.outsideRh, "%"),
        in: pick(inRead, tile.insideRh, "%"),
        compare: false,
      },
      {
        label: "Dew",
        out: pick(outRead, tile.outsideDewPoint, "°"),
        in: pick(inRead, tile.insideDewPoint, "°"),
        compare: true,
      },
    ],
    affected: { label: "Affected dew", value: figure(tile.affectedDewPoint, "°") },
    insideVsBaseline:
      tile.insideDeltaF == null || tile.insideDeltaF === 0
        ? null
        : {
            label: "In vs base",
            value: `${tile.insideDeltaF < 0 ? "▼" : "▲"}${Math.abs(tile.insideDeltaF)}°`,
            drier: tile.insideDeltaF < 0,
          },
  };
}

/**
 * The one sentence under the calendar that explains the whole strip, so the
 * answer is on the screen rather than only in a square's hover text.
 *
 * Null when there is nothing to explain: a log that already carries modelled
 * outside rows is evidence that the automatic fill works on this deployment,
 * and saying otherwise would be inventing a fault to go with an empty square.
 */
export function describeOutsideSetup(ctx: OutsideContext, tiles: DryingDayTile[]): string | null {
  if (ctx.writesRefused) {
    return (
      "Outside conditions are not being written to this database. This is a setup problem, not a " +
      "missing reading — until it is fixed, enter the outside figures by hand."
    );
  }
  if (!ctx.hasLocation) {
    return (
      "This job has no coordinates, so its outside conditions can never fill in by themselves. " +
      "Fix the site address so it geocodes, or enter the reading by hand."
    );
  }
  // One modelled row anywhere in the log means something is filling them.
  if (tiles.some((t) => t.outsideModelled)) return null;

  // "Nobody has set this up" and "nine o'clock has not come round yet" look
  // identical on an empty strip, and only one of them is somebody's job to
  // fix. A log whose only square is today, read before 09:00, has nothing
  // wrong with it — reporting a fault on a job that is an hour old teaches a
  // crew to ignore the line, and then they ignore the real one.
  const daysGoneBy = tiles.filter((t) => !t.isToday).length;
  if (daysGoneBy === 0 && ctx.hourOfDay < BASELINE_HOUR) {
    return (
      "Outside conditions fill in by themselves from the 09:00 local observation. Today's has " +
      "not happened yet, so there is nothing missing."
    );
  }

  return (
    "No outside conditions have ever been filled in on this job" +
    (daysGoneBy > 0
      ? `, and ${daysGoneBy} day${daysGoneBy === 1 ? " has" : "s have"} already gone by`
      : "") +
    ". They fill in by themselves when this log is opened; if they have not, the fetch is " +
    "failing — tap Fetch outside to try again and see why."
  );
}

/**
 * The days on the strip that are missing an outside figure AND could be filled
 * right now: no reading, the job has coordinates, the database has not refused
 * a write, and the day's 09:00 has happened.
 *
 * This is what decides whether opening the drying log fills it by itself. Mark
 * asked for the outside information "to automatically be inputted", and the
 * live database shows the path that has always worked is the browser's — every
 * reading on file came from somebody tapping Fetch outside — while the nightly
 * server path has failed every run. So the log asks for what it is missing
 * when it is opened, which a crew does every day they log a reading.
 *
 * Empty means do nothing: every square already has a figure, or every gap is
 * one a fetch cannot fix ("soon", "n/a", "setup") and retrying would only
 * repeat the failure on every page load.
 */
export function outsideDaysToFill(tiles: DryingDayTile[], ctx: OutsideContext): string[] {
  return tiles.filter((t) => outsideCellState(t, ctx) === "unfetched").map((t) => t.date);
}
