import { describe, expect, it } from "vitest";

import type { DryingReading } from "@/lib/drying-log";
import { derive } from "@/lib/psychrometrics";

import {
  deriveGridDay,
  draftKey,
  gridChanges,
  gridDateLabel,
  gridDaysFromReadings,
  gridLines,
  lineKey,
} from "./drying-psychro-grid";

const EXT = lineKey("exterior", null);
const PROP = lineKey("interior", null);
const ROOMS = new Map([
  ["r1", "Kitchen"],
  ["r2", "Bedroom"],
]);

function reading(over: Partial<DryingReading>): DryingReading {
  return {
    id: Math.random().toString(36).slice(2),
    job_id: "j1",
    point: "interior",
    reading_date: "2026-11-09",
    temperature_f: 72,
    relative_humidity: 50,
    dew_point_f: null,
    grains_per_pound: null,
    room_id: null,
    equipment_id: null,
    label: null,
    notes: null,
    source: "manual",
    source_detail: null,
    is_baseline: false,
    is_demo: false,
    photo_mime: null,
    photo_path: null,
    photo_thumb_path: null,
    values_source: "typed",
    observed_at: null,
    created_by: "u1",
    captured_at: "2026-11-09T10:00:00Z",
    created_at: "2026-11-09T10:00:00Z",
    updated_at: "2026-11-09T10:00:00Z",
    ...over,
  };
}

const DATES = ["2026-11-08", "2026-11-09"];

describe("gridDaysFromReadings", () => {
  it("prefers a crew's outside reading over the automatic one", () => {
    const days = gridDaysFromReadings(
      [
        reading({ point: "exterior", source: "weather", temperature_f: 50, relative_humidity: 80 }),
        reading({ point: "exterior", source: "manual", temperature_f: 48, relative_humidity: 85 }),
      ],
      DATES,
    );
    expect(days.get("2026-11-09")![EXT]).toMatchObject({ tempF: 48, rh: 85, source: "manual" });
  });

  it("marks an automatic outside figure as automatic", () => {
    const days = gridDaysFromReadings(
      [reading({ point: "exterior", source: "weather", temperature_f: 50, relative_humidity: 80 })],
      DATES,
    );
    expect(days.get("2026-11-09")![EXT].source).toBe("weather");
  });

  it("takes the whole property's inside reading, newest first", () => {
    const days = gridDaysFromReadings(
      [
        reading({ temperature_f: 70, captured_at: "2026-11-09T08:00:00Z" }),
        reading({ temperature_f: 74, captured_at: "2026-11-09T15:00:00Z" }),
        reading({ temperature_f: 90, room_id: "r1", captured_at: "2026-11-09T16:00:00Z" }),
      ],
      DATES,
    );
    expect(days.get("2026-11-09")![PROP]).toMatchObject({ tempF: 74, source: "manual" });
  });

  it("11 Nov: gives every room its own inside line, read from that room's newest reading", () => {
    const readings = [
      reading({ temperature_f: 80, room_id: "r1", captured_at: "2026-11-09T08:00:00Z" }),
      reading({ temperature_f: 82, room_id: "r1", captured_at: "2026-11-09T12:00:00Z" }),
      reading({ temperature_f: 68, relative_humidity: 40, room_id: "r2" }),
    ];
    const lines = gridLines(ROOMS, readings, DATES);
    expect(lines.map((l) => l.label)).toEqual(["Outside", "Kitchen", "Bedroom"]);
    const days = gridDaysFromReadings(readings, DATES, lines);
    expect(days.get("2026-11-09")![lineKey("interior", "r1")].tempF).toBe(82);
    expect(days.get("2026-11-09")![lineKey("interior", "r2")]).toMatchObject({ tempF: 68, rh: 40 });
    expect(days.get("2026-11-08")![lineKey("interior", "r2")].tempF).toBeNull();
  });

  it("keeps the whole-property line beside the rooms only while it holds a reading", () => {
    expect(gridLines(ROOMS, [], DATES).map((l) => l.label)).toEqual([
      "Outside",
      "Kitchen",
      "Bedroom",
    ]);
    const withProperty = gridLines(ROOMS, [reading({ room_id: null })], DATES);
    expect(withProperty.map((l) => l.label)).toEqual([
      "Outside",
      "Kitchen",
      "Bedroom",
      "Whole property",
    ]);
    // A job with no rooms keeps the one property pair.
    expect(gridLines(new Map()).map((l) => l.label)).toEqual(["Outside", "Inside"]);
  });

  it("leaves an untouched day empty", () => {
    const days = gridDaysFromReadings([], DATES);
    expect(days.get("2026-11-08")![EXT].tempF).toBeNull();
  });
});

describe("gridChanges", () => {
  const days = gridDaysFromReadings(
    [reading({ point: "exterior", source: "weather", temperature_f: 50, relative_humidity: 80 })],
    DATES,
  );

  it("saves several days typed at once", () => {
    const drafts = {
      [draftKey("2026-11-08", PROP, "temp")]: "75",
      [draftKey("2026-11-08", PROP, "rh")]: "60",
      [draftKey("2026-11-09", PROP, "temp")]: "73.5",
      [draftKey("2026-11-09", PROP, "rh")]: "52",
    };
    const { saves, problems } = gridChanges(drafts, days, DATES);
    expect(problems).toEqual([]);
    expect(saves).toEqual([
      {
        date: "2026-11-08",
        point: "interior",
        roomId: null,
        temperatureF: 75,
        relativeHumidity: 60,
      },
      {
        date: "2026-11-09",
        point: "interior",
        roomId: null,
        temperatureF: 73.5,
        relativeHumidity: 52,
      },
    ]);
  });

  it("writes nothing for a figure retyped unchanged, or tabbed through", () => {
    const drafts = {
      [draftKey("2026-11-09", EXT, "temp")]: "50",
      [draftKey("2026-11-09", EXT, "rh")]: "80",
    };
    expect(gridChanges(drafts, days, DATES).saves).toEqual([]);
  });

  it("saves a crew's outside reading over the automatic one when it differs", () => {
    const drafts = { [draftKey("2026-11-09", EXT, "temp")]: "48" };
    expect(gridChanges(drafts, days, DATES).saves).toEqual([
      {
        date: "2026-11-09",
        point: "exterior",
        roomId: null,
        temperatureF: 48,
        relativeHumidity: 80,
      },
    ]);
  });

  it("refuses half a pair and an impossible humidity", () => {
    const drafts = {
      [draftKey("2026-11-08", PROP, "temp")]: "75",
      [draftKey("2026-11-09", PROP, "temp")]: "70",
      [draftKey("2026-11-09", PROP, "rh")]: "140",
    };
    const { saves, problems } = gridChanges(drafts, days, DATES);
    expect(saves).toEqual([]);
    expect(problems.map((p) => p.date)).toEqual(["2026-11-08", "2026-11-09"]);
  });

  it("11 Nov: saves each room's pair as that room's reading", () => {
    const lines = gridLines(ROOMS);
    const roomDays = gridDaysFromReadings([], DATES, lines);
    const drafts = {
      [draftKey("2026-11-09", lineKey("interior", "r1"), "temp")]: "77",
      [draftKey("2026-11-09", lineKey("interior", "r1"), "rh")]: "55",
      [draftKey("2026-11-09", lineKey("interior", "r2"), "temp")]: "70",
      [draftKey("2026-11-09", lineKey("interior", "r2"), "rh")]: "45",
    };
    const { saves, problems } = gridChanges(drafts, roomDays, DATES, lines);
    expect(problems).toEqual([]);
    expect(saves).toEqual([
      {
        date: "2026-11-09",
        point: "interior",
        roomId: "r1",
        temperatureF: 77,
        relativeHumidity: 55,
      },
      {
        date: "2026-11-09",
        point: "interior",
        roomId: "r2",
        temperatureF: 70,
        relativeHumidity: 45,
      },
    ]);
  });

  it("ignores a box typed into and cleared again", () => {
    const drafts = {
      [draftKey("2026-11-08", PROP, "temp")]: "",
      [draftKey("2026-11-08", PROP, "rh")]: "",
    };
    expect(gridChanges(drafts, days, DATES)).toEqual({ saves: [], problems: [] });
  });
});

describe("deriveGridDay", () => {
  it("uses the log's own derivation and takes outside from inside", () => {
    const d = deriveGridDay({ tempF: 50, rh: 80 }, { tempF: 75, rh: 60 });
    expect(d.outsideGpp).toBe(derive(50, 80).gpp);
    expect(d.insideGpp).toBe(derive(75, 60).gpp);
    expect(d.insideDewPoint).toBe(derive(75, 60).dewPointF);
    expect(d.gppDifference).toBeCloseTo(d.insideGpp! - d.outsideGpp!, 1);
  });

  it("has no difference until both sides have a reading", () => {
    expect(
      deriveGridDay({ tempF: 50, rh: 80 }, { tempF: null, rh: null }).gppDifference,
    ).toBeNull();
  });
});

describe("gridDateLabel", () => {
  it("writes month/day", () => {
    expect(gridDateLabel("2026-08-09")).toBe("8/9");
  });
});
