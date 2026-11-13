import { describe, expect, it } from "vitest";

import {
  buildDryingDayTiles,
  describeInsideCell,
  describeOutsideCell,
  describeOutsideSetup,
  outsideDaysToFill,
  tileFigures,
  type DryingDayTile,
  type OutsideContext,
} from "@/lib/drying-day-grid";
import { buildDryingLog, type DryingReading } from "@/lib/drying-log";

/**
 * The calendar squares are read at a glance from across a room, so the one
 * thing they must never do is make an unvisited day look logged.
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
    created_by: null,
    created_at: `${over.reading_date}T15:00:00Z`,
    updated_at: `${over.reading_date}T15:00:00Z`,
    is_demo: false,
    ...over,
  } as DryingReading;
}

describe("the day grid", () => {
  it("always offers today, even before the first reading", () => {
    const tiles = buildDryingDayTiles(buildDryingLog([], { today: "2026-08-03" }), "2026-08-03");
    expect(tiles).toHaveLength(1);
    expect(tiles[0]).toMatchObject({ date: "2026-08-03", status: "empty", isToday: true });
  });

  it("reads oldest to newest like a calendar, with the untouched days in between", () => {
    const log = buildDryingLog(
      [reading({ reading_date: "2026-08-01" }), reading({ reading_date: "2026-08-03" })],
      { today: "2026-08-03" },
    );
    const tiles = buildDryingDayTiles(log, "2026-08-03");
    expect(tiles.map((t) => t.date)).toEqual(["2026-08-01", "2026-08-02", "2026-08-03"]);
    expect(tiles.map((t) => t.status)).toEqual(["entered", "empty", "entered"]);
    expect(tiles[2]!.isToday).toBe(true);
    expect(tiles[0]!.isToday).toBe(false);
  });

  it("does not let the nightly weather fill pass for a logged day", () => {
    const log = buildDryingLog(
      [
        reading({ reading_date: "2026-08-01" }),
        reading({
          reading_date: "2026-08-02",
          point: "exterior",
          source: "weather",
          dew_point_f: 55,
        }),
      ],
      { today: "2026-08-02" },
    );
    const tiles = buildDryingDayTiles(log, "2026-08-02");
    expect(tiles[1]).toMatchObject({
      status: "weather_only",
      crewReadings: 0,
      outsideDewPoint: 55,
      outsideModelled: true,
    });
  });

  it("shows the wettest room, and prefers a meter in the driveway to the model", () => {
    const log = buildDryingLog(
      [
        reading({ reading_date: "2026-08-01", room_id: "a", dew_point_f: 58 }),
        reading({ reading_date: "2026-08-01", room_id: "b", dew_point_f: 64 }),
        reading({ reading_date: "2026-08-01", point: "unaffected", dew_point_f: 52 }),
        reading({
          reading_date: "2026-08-01",
          point: "exterior",
          source: "weather",
          dew_point_f: 50,
        }),
        reading({ reading_date: "2026-08-01", point: "exterior", dew_point_f: 49 }),
      ],
      { today: "2026-08-01" },
    );
    const [tile] = buildDryingDayTiles(log, "2026-08-01");
    expect(tile).toMatchObject({
      status: "entered",
      crewReadings: 4,
      affectedDewPoint: 64,
      unaffectedDewPoint: 52,
      outsideDewPoint: 49,
      outsideModelled: false,
    });
  });
});

describe("outside and inside on one square", () => {
  it("carries the pair for the day", () => {
    const log = buildDryingLog(
      [
        reading({
          reading_date: "2026-08-01",
          point: "exterior",
          source: "weather",
          dew_point_f: 54,
        }),
        reading({ reading_date: "2026-08-01", point: "interior", dew_point_f: 68 }),
      ],
      { today: "2026-08-01" },
    );
    const tile = buildDryingDayTiles(log, "2026-08-01")[0]!;
    expect(tile.outsideDewPoint).toBe(54);
    expect(tile.outsideModelled).toBe(true);
    expect(tile.insideDewPoint).toBe(68);
    // An inside reading is a crew reading, so the day is logged.
    expect(tile.status).toBe("entered");
  });

  it("shows how far inside has moved from the baseline, one decimal", () => {
    const log = buildDryingLog(
      [reading({ reading_date: "2026-08-05", point: "interior", dew_point_f: 61.4 })],
      { today: "2026-08-05" },
    );
    const tile = buildDryingDayTiles(log, "2026-08-05", {
      date: "2026-08-01",
      insideDewPoint: 68,
    })[0]!;
    expect(tile.insideDeltaF).toBe(-6.6);
  });

  it("has no delta when either half is missing", () => {
    const log = buildDryingLog(
      [reading({ reading_date: "2026-08-05", point: "affected", dew_point_f: 61 })],
      { today: "2026-08-05" },
    );
    const tile = buildDryingDayTiles(log, "2026-08-05", {
      date: "2026-08-01",
      insideDewPoint: 68,
    })[0]!;
    expect(tile.insideDewPoint).toBeNull();
    expect(tile.insideDeltaF).toBeNull();
  });

  it("marks the baseline day and counts the meter photos", () => {
    const log = buildDryingLog(
      [
        reading({
          reading_date: "2026-08-01",
          point: "interior",
          dew_point_f: 68,
          photo_path: "u1/j1/r1.webp",
        } as never),
        reading({ reading_date: "2026-08-01", point: "affected", dew_point_f: 72 }),
      ],
      { today: "2026-08-01" },
    );
    const tile = buildDryingDayTiles(log, "2026-08-01", {
      date: "2026-08-01",
      insideDewPoint: 68,
    })[0]!;
    expect(tile.isBaseline).toBe(true);
    expect(tile.meterPhotos).toBe(1);
  });

  it("leaves today's square untouched by a baseline on another day", () => {
    const tiles = buildDryingDayTiles(buildDryingLog([], { today: "2026-08-03" }), "2026-08-03", {
      date: "2026-08-01",
      insideDewPoint: 68,
    });
    expect(tiles[0]!.isBaseline).toBe(false);
  });
});

/**
 * A square that cannot show a figure has to say WHY. On 2026-09-07 the live
 * database held no drying readings at all, had no `drying-outside-conditions`
 * job in `cron.job`, and had not been given the migration that permits an
 * automatic outside row — three different problems, all of which the square
 * reported identically as "out —". These pin them apart.
 */
const CTX: OutsideContext = {
  hasLocation: true,
  writesRefused: false,
  interiorAvailable: true,
  hourOfDay: 14,
};

function todayTile(over: Partial<DryingDayTile> = {}): DryingDayTile {
  return {
    ...buildDryingDayTiles(buildDryingLog([], { today: "2026-09-07" }), "2026-09-07")[0]!,
    ...over,
  };
}

describe("what an empty square says", () => {
  it("never shows a bare em-dash for the outside figure", () => {
    const tile = todayTile();
    for (const ctx of [
      CTX,
      { ...CTX, hasLocation: false },
      { ...CTX, writesRefused: true },
      { ...CTX, hourOfDay: 6 },
    ]) {
      const word = describeOutsideCell(tile, ctx).word;
      expect(word).toBeTruthy();
      expect(word).not.toContain("—");
    }
  });

  it("offers the fetch when one is possible and nobody has run it", () => {
    const cell = describeOutsideCell(todayTile(), CTX);
    expect(cell.state).toBe("unfetched");
    expect(cell.long).toMatch(/Fetch outside/);
  });

  it("says the observation has not happened yet before 09:00 local", () => {
    expect(describeOutsideCell(todayTile(), { ...CTX, hourOfDay: 6 }).state).toBe("soon");
    // Yesterday's 09:00 has happened whatever the clock says now.
    const yesterday = todayTile({ isToday: false });
    expect(describeOutsideCell(yesterday, { ...CTX, hourOfDay: 6 }).state).toBe("unfetched");
  });

  it("blames the address when the job has no coordinates", () => {
    const cell = describeOutsideCell(todayTile(), { ...CTX, hasLocation: false });
    expect(cell.state).toBe("no_location");
    expect(cell.long).toMatch(/coordinates/);
  });

  it("a refused write outranks every other explanation", () => {
    // Both wrong at once: retrying and fixing the address are equally futile
    // while the database is refusing the row, so that is what it must say.
    const cell = describeOutsideCell(todayTile(), {
      ...CTX,
      hasLocation: false,
      writesRefused: true,
    });
    expect(cell.state).toBe("blocked");
  });

  it("shows the figure once there is one, modeled or not", () => {
    const cell = describeOutsideCell(
      todayTile({ outsideDewPoint: 54, outsideModelled: true }),
      CTX,
    );
    expect(cell.word).toBeNull();
    expect(cell.long).toMatch(/modeled/);
  });

  it("separates an inside reading nobody has taken yet from one that cannot be stored", () => {
    expect(describeInsideCell(todayTile(), CTX).state).toBe("due");
    expect(describeInsideCell(todayTile({ isToday: false }), CTX).state).toBe("none");
    expect(describeInsideCell(todayTile(), { ...CTX, interiorAvailable: false }).state).toBe(
      "blocked",
    );
    expect(describeInsideCell(todayTile({ insideDewPoint: 61 }), CTX).word).toBeNull();
  });
});

/**
 * Mark, 2026-10-05, two messages about the same strip:
 *
 *   "humidity is missing and we need the outisde information to automatically
 *    be inputted"
 *   "for the temp readings, everything need to be labeled in the box"
 *
 * The strip showed "out 55.9°" — a dew point, printed as a bare degree — and no
 * humidity or temperature at all. These pin the answer to both: every figure a
 * reading carries is on the square, and every one of them sits under a label
 * printed inside the box. Nothing is left that only a hover could reveal.
 */
describe("every figure on the square, labeled", () => {
  const CONDITIONS = {
    temperature_f: 59.4,
    relative_humidity: 80,
    dew_point_f: 53.2,
  };

  function pairTile() {
    const log = buildDryingLog(
      [
        reading({
          reading_date: "2026-08-01",
          point: "exterior",
          source: "weather",
          ...CONDITIONS,
        }),
        reading({
          reading_date: "2026-08-01",
          point: "interior",
          temperature_f: 72.1,
          relative_humidity: 61,
          dew_point_f: 58,
        }),
        reading({ reading_date: "2026-08-01", point: "affected", dew_point_f: 64.2 }),
      ],
      { today: "2026-08-01" },
    );
    return buildDryingDayTiles(log, "2026-08-01", { date: "2026-07-29", insideDewPoint: 61.7 })[0]!;
  }

  it("carries temperature, humidity and dew point off the same reading, out and in", () => {
    const tile = pairTile();
    expect(tile).toMatchObject({
      outsideDewPoint: 53.2,
      outsideRh: 80,
      outsideTempF: 59.4,
      insideDewPoint: 58,
      insideRh: 61,
      insideTempF: 72.1,
    });
  });

  it("lays them out as Temp / RH / Dew rows under Out and In columns", () => {
    const figures = tileFigures(pairTile(), CTX);
    expect(figures.out.heading).toBe("Out");
    expect(figures.in.heading).toBe("In");
    expect(figures.rows).toEqual([
      { label: "Temp", out: "59.4°", in: "72.1°", compare: false },
      { label: "RH", out: "80%", in: "61%", compare: false },
      // The row the drying question is read on: inside falling towards out.
      { label: "Dew", out: "53.2°", in: "58°", compare: true },
    ]);
  });

  it("labels the affected figure and the baseline delta too", () => {
    const figures = tileFigures(pairTile(), CTX);
    expect(figures.affected).toEqual({ label: "Affected dew", value: "64.2°" });
    // 58 against a baseline of 61.7: 3.7 drier, said with its label and unit.
    expect(figures.insideVsBaseline).toEqual({ label: "In vs base", value: "▼3.7°", drier: true });
  });

  it("never puts a figure on the square without a label beside it", () => {
    // The structural guarantee Mark asked for. Every value the square can
    // print comes out of tileFigures attached to a non-empty label; if a
    // future field is added without one, this fails rather than the strip
    // quietly growing another bare degree sign.
    for (const tile of [
      pairTile(),
      todayTile(),
      todayTile({ outsideDewPoint: 54, outsideRh: null, outsideTempF: null }),
      todayTile({ insideDewPoint: 61, insideRh: 54, insideTempF: 70 }),
    ]) {
      const figures = tileFigures(tile, CTX);
      for (const row of figures.rows) {
        expect(row.label).toMatch(/^(Temp|RH|Dew)$/);
        for (const v of [row.out, row.in]) {
          if (v == null) continue;
          // A figure carries its unit: a degree for Temp and Dew, a percent for RH.
          expect(v).toMatch(row.label === "RH" ? /^(—|-?\d+(\.\d+)?%)$/ : /^(—|-?\d+(\.\d+)?°)$/);
        }
      }
      expect(figures.affected.label).toBe("Affected dew");
      if (figures.insideVsBaseline) expect(figures.insideVsBaseline.label).toBe("In vs base");
    }
  });

  it("puts the side's status word in place of its figures when it has no reading", () => {
    const figures = tileFigures(todayTile({ isToday: false }), CTX);
    expect(figures.out.word).toBe("fetch");
    expect(figures.in.word).toBe("none");
    // No figure is invented for a side nobody read — the word stands for all three rows.
    for (const row of figures.rows) {
      expect(row.out).toBeNull();
      expect(row.in).toBeNull();
    }
  });

  it("shows a labeled dash for one missing field, never a guessed number", () => {
    const figures = tileFigures(
      todayTile({ outsideDewPoint: 54, outsideRh: null, outsideTempF: null }),
      CTX,
    );
    expect(figures.out.word).toBeNull();
    expect(figures.rows.map((r) => [r.label, r.out])).toEqual([
      ["Temp", "—"],
      ["RH", "—"],
      ["Dew", "54°"],
    ]);
    expect(figures.affected.value).toBe("—");
  });

  it("takes the humidity off the same reading as the dew point it stands beside", () => {
    // Two rooms read on one day. The square shows the wettest; the humidity
    // and temperature beside it must be THAT room's, not the other one's.
    const log = buildDryingLog(
      [
        reading({
          reading_date: "2026-08-02",
          point: "interior",
          room_id: "room-kitchen",
          temperature_f: 70,
          relative_humidity: 45,
          dew_point_f: 47.5,
        }),
        reading({
          reading_date: "2026-08-02",
          point: "interior",
          room_id: "room-basement",
          temperature_f: 66,
          relative_humidity: 88,
          dew_point_f: 62.4,
        }),
      ],
      { today: "2026-08-02" },
    );
    const tile = buildDryingDayTiles(log, "2026-08-02")[0]!;
    expect(tileFigures(tile, CTX).rows.map((r) => r.in)).toEqual(["66°", "88%", "62.4°"]);
  });

  it("keeps the whole reading in the accessible name as well", () => {
    const tile = pairTile();
    expect(describeOutsideCell(tile, CTX).long).toBe(
      "outside 53.2° dew point, 59.4 °F / 80% RH (modeled)",
    );
    expect(describeInsideCell(tile, CTX).long).toBe("inside 58° dew point, 72.1 °F / 61% RH");
  });
});

describe("the sentence under the calendar", () => {
  it("says nothing when the automatic fill is evidently working", () => {
    expect(describeOutsideSetup(CTX, [todayTile({ outsideModelled: true })])).toBeNull();
  });

  it("says the outside figures have never arrived when none ever have", () => {
    expect(describeOutsideSetup(CTX, [todayTile()])).toMatch(/have ever been filled in/);
  });

  it("calls a refused write a setup problem rather than a missing reading", () => {
    const note = describeOutsideSetup({ ...CTX, writesRefused: true }, [todayTile()]);
    expect(note).toMatch(/setup problem, not a missing reading/);
  });

  /**
   * "Nobody has set this up" and "nine o'clock has not come round yet" are the
   * two readings of an empty strip, and only one of them is somebody's job.
   */
  it("does not report a fault on a job whose only square is this morning", () => {
    const note = describeOutsideSetup({ ...CTX, hourOfDay: 7 }, [todayTile()]);
    expect(note).toMatch(/nothing missing/);
    expect(note).not.toMatch(/have ever been filled in/);
  });

  it("does report one once the morning has passed with nothing filled in", () => {
    expect(describeOutsideSetup({ ...CTX, hourOfDay: 11 }, [todayTile()])).toMatch(
      /have ever been filled in/,
    );
  });

  it("counts the days already lost, because that is the number that costs money", () => {
    // Mark's strip: eight days gone, every outside figure missing. Saying
    // "none have ever arrived" understates it; saying how many says what the
    // tap is for.
    const strip = [...Array.from({ length: 8 }, () => todayTile({ isToday: false })), todayTile()];
    const note = describeOutsideSetup({ ...CTX, hourOfDay: 7 }, strip);
    expect(note).toMatch(/8 days have already gone by/);
    expect(note).toMatch(/Fetch outside/);
  });

  it("counts one lost day in the singular", () => {
    const note = describeOutsideSetup(CTX, [todayTile({ isToday: false }), todayTile()]);
    expect(note).toMatch(/1 day has already gone by/);
  });
});

/**
 * 2026-09-07: an inside reading can name the room it was taken in, so a day
 * may carry several. The square has room for one number, and it has to be the
 * same one the baseline delta printed beside it uses — otherwise the square
 * says the kitchen and the delta says the basement.
 */
describe("several inside readings in one day", () => {
  it("shows the wettest room, the way it already shows the wettest chamber", () => {
    const log = buildDryingLog(
      [
        reading({
          reading_date: "2026-08-01",
          point: "interior",
          room_id: "room-kitchen",
          dew_point_f: 58,
        }),
        reading({
          reading_date: "2026-08-01",
          point: "interior",
          room_id: "room-basement",
          dew_point_f: 67,
        }),
      ],
      { today: "2026-08-01" },
    );
    expect(buildDryingDayTiles(log, "2026-08-01")[0]!.insideDewPoint).toBe(67);
  });

  it("ignores a room with no dew point rather than blanking the square", () => {
    const log = buildDryingLog(
      [
        reading({
          reading_date: "2026-08-01",
          point: "interior",
          room_id: "room-kitchen",
          dew_point_f: null,
        }),
        reading({
          reading_date: "2026-08-01",
          point: "interior",
          room_id: "room-basement",
          dew_point_f: 62,
        }),
      ],
      { today: "2026-08-01" },
    );
    expect(buildDryingDayTiles(log, "2026-08-01")[0]!.insideDewPoint).toBe(62);
  });
});

/**
 * What opening the drying log asks the provider for. The nightly server path
 * has never succeeded on the live database; the browser path always has. So
 * the log fills its own gaps on open — but only the gaps a fetch can fill, or
 * every page load would repeat a failure it already knows about.
 */
describe("the days opening the log will fill", () => {
  const past = (over: Partial<DryingDayTile> = {}) => todayTile({ isToday: false, ...over });

  it("asks for every past day with no outside figure", () => {
    const tiles = [
      past({ date: "2026-09-28" }),
      past({ date: "2026-09-29", outsideDewPoint: 51 }),
      past({ date: "2026-09-30" }),
    ];
    expect(outsideDaysToFill(tiles, CTX)).toEqual(["2026-09-28", "2026-09-30"]);
  });

  it("does not ask for today before its 09:00 has happened", () => {
    expect(outsideDaysToFill([todayTile()], { ...CTX, hourOfDay: 7 })).toEqual([]);
    expect(outsideDaysToFill([todayTile()], { ...CTX, hourOfDay: 10 })).toEqual(["2026-09-07"]);
  });

  it("asks for nothing when no fetch could succeed", () => {
    const tiles = [past({ date: "2026-09-28" })];
    // No coordinates: there is no grid square to ask about.
    expect(outsideDaysToFill(tiles, { ...CTX, hasLocation: false })).toEqual([]);
    // A refused write this session: asking again would be refused again.
    expect(outsideDaysToFill(tiles, { ...CTX, writesRefused: true })).toEqual([]);
  });
});
