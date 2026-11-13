import { describe, expect, it } from "vitest";

import {
  DRYING_POINTS,
  DRYING_POINT_LABEL,
  ENTRY_POINTS,
  buildDryingLog,
  buildReadingRow,
  checkReadingEntry,
  meterPhotoPaths,
  type DryingReading,
} from "@/lib/drying-log";

/**
 * The gap is the finding. A drying log that quietly closes up its missing days
 * reads as a complete record of a job nobody visited for a week, which is the
 * exact document a carrier uses to deny the equipment days.
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

describe("the historical log", () => {
  it("shows a day nobody logged rather than skipping it", () => {
    const log = buildDryingLog(
      [reading({ reading_date: "2026-08-01" }), reading({ reading_date: "2026-08-04" })],
      { today: "2026-08-04" },
    );
    expect(log.days.map((d) => d.date)).toEqual([
      "2026-08-04",
      "2026-08-03",
      "2026-08-02",
      "2026-08-01",
    ]);
    expect(log.gaps).toEqual(["2026-08-02", "2026-08-03"]);
  });

  it("counts the days since the last reading as missing, not as a finished job", () => {
    const log = buildDryingLog([reading({ reading_date: "2026-08-01" })], { today: "2026-08-04" });
    expect(log.gaps).toEqual(["2026-08-02", "2026-08-03", "2026-08-04"]);
  });

  it("does not let an automatic weather row close a gap", () => {
    // Nobody visited the structure on the 2nd. The exterior baseline arriving
    // from Open-Meteo is not evidence that they did.
    const log = buildDryingLog(
      [
        reading({ reading_date: "2026-08-01" }),
        reading({ reading_date: "2026-08-02", point: "exterior", source: "weather" }),
      ],
      { today: "2026-08-02" },
    );
    expect(log.gaps).toEqual(["2026-08-02"]);
    expect(log.days[0]!.bySeries).not.toEqual({});
  });

  it("has no gaps when every day was logged", () => {
    const log = buildDryingLog(
      [
        reading({ reading_date: "2026-08-01" }),
        reading({ reading_date: "2026-08-02" }),
        reading({ reading_date: "2026-08-03" }),
      ],
      { today: "2026-08-03" },
    );
    expect(log.gaps).toEqual([]);
    expect(log.days).toHaveLength(3);
  });

  it("is empty, with no gaps, before the first reading exists", () => {
    expect(buildDryingLog([], { today: "2026-08-03" })).toEqual({
      series: [],
      days: [],
      gaps: [],
    });
  });
});

describe("series", () => {
  it("splits affected rooms apart and names them, keeping outside single", () => {
    const log = buildDryingLog(
      [
        reading({ reading_date: "2026-08-01", point: "exterior" }),
        reading({ reading_date: "2026-08-01", point: "unaffected" }),
        reading({ reading_date: "2026-08-01", room_id: "room-a" }),
        reading({ reading_date: "2026-08-01", room_id: "room-b" }),
        reading({ reading_date: "2026-08-02", room_id: "room-a" }),
      ],
      {
        today: "2026-08-02",
        roomNames: new Map([
          ["room-a", "Kitchen"],
          ["room-b", "Basement"],
        ]),
      },
    );
    expect(log.series.map((s) => s.label)).toEqual([
      "Outside",
      "Unaffected",
      "Affected — Basement",
      "Affected — Kitchen",
    ]);
    // The same room on two days is one series, which is what makes a trend.
    const kitchen = log.series.find((s) => s.roomId === "room-a")!;
    expect(log.days.filter((d) => d.bySeries[kitchen.key])).toHaveLength(2);
  });
});

describe("points taken off the form", () => {
  // 2026-09-07, Mark: "remove the unaffacted section". Off the form is not out
  // of the record — a reading somebody took is still a reading.
  it("offers exactly Outside, Inside and Affected for entry", () => {
    // "remove this as well" took the dehumidifier outlet off after it.
    expect(ENTRY_POINTS.map((p) => p.key)).toEqual(["exterior", "interior", "affected"]);
  });

  it("still knows every point, retired or not, so old rows keep their names", () => {
    expect(DRYING_POINTS.map((p) => p.key)).toEqual([
      "exterior",
      "interior",
      "unaffected",
      "affected",
      "dehu_inlet",
      "dehu_outlet",
    ]);
    expect(DRYING_POINT_LABEL.unaffected).toBe("Unaffected");
    expect(DRYING_POINT_LABEL.dehu_outlet).toBe("Dehu outlet");
  });

  it("keeps the dehumidifier pair off the daily cards — it has its own drawer", () => {
    // Heshy's checklist brought the inlet in beside the outlet; Mark's 7 Sep
    // form (Outside, Inside, Affected) is untouched by it.
    expect(DRYING_POINTS.filter((p) => p.key.startsWith("dehu")).map((p) => p.entry)).toEqual([
      false,
      false,
    ]);
  });

  it("gives each machine its own inlet and outlet series, named by asset tag", () => {
    const log = buildDryingLog(
      [
        reading({
          reading_date: "2026-09-01",
          point: "dehu_inlet",
          label: "GSR-DH01",
          equipment_id: "d1",
        }),
        reading({
          reading_date: "2026-09-01",
          point: "dehu_outlet",
          label: "GSR-DH01",
          equipment_id: "d1",
        }),
        reading({
          reading_date: "2026-09-01",
          point: "dehu_outlet",
          label: "GSR-DH02",
          equipment_id: "d2",
        }),
      ],
      { today: "2026-09-01" },
    );
    expect(log.series.map((s) => s.label)).toEqual([
      "Dehu inlet — GSR-DH01",
      "Dehu outlet — GSR-DH01",
      "Dehu outlet — GSR-DH02",
    ]);
  });

  it("still builds a row for a retired point, machine and all", () => {
    // The offline queue may hold an outlet reading typed before the section
    // went; draining it must still produce the row it always did.
    const row = buildReadingRow({
      id: "r1",
      jobId: "j1",
      point: "dehu_outlet",
      equipmentId: "dehu-7",
      readingDate: "2026-08-01",
      temperatureF: 95,
      relativeHumidity: 20,
    });
    expect(row.point).toBe("dehu_outlet");
    expect(row.equipment_id).toBe("dehu-7");
  });

  it("still gives a stored Unaffected row its own column in the historical log", () => {
    const log = buildDryingLog(
      [
        reading({ reading_date: "2026-08-01", point: "unaffected", dew_point_f: 52 }),
        reading({ reading_date: "2026-08-01", point: "affected", dew_point_f: 64 }),
      ],
      { today: "2026-08-01" },
    );
    expect(log.series.map((s) => s.label)).toEqual(["Unaffected", "Affected"]);
    expect(log.days[0]!.bySeries[log.series[0]!.key]).toHaveLength(1);
  });
});

describe("buildReadingRow", () => {
  it("derives the two figures the crew is never asked to type", () => {
    const row = buildReadingRow({
      id: "abc",
      jobId: "job-1",
      point: "affected",
      readingDate: "2026-08-01",
      temperatureF: 70,
      relativeHumidity: 50,
    });
    expect(row.dew_point_f).toBe(50.5);
    expect(row.grains_per_pound).toBe(54.4);
    expect(row.source).toBe("manual");
  });
});

describe("the interior point", () => {
  it("keeps Inside as one series when a stray label is the only difference", () => {
    // The entry form has no label box on an interior reading, so a label there
    // is leftover data. It must not fork the column the trend is read from —
    // only a deliberately chosen room does that.
    const log = buildDryingLog([
      reading({ reading_date: "2026-08-01", point: "interior", label: null }),
      reading({ reading_date: "2026-08-02", point: "interior", label: "upstairs" }),
    ]);
    const interior = log.series.filter((s) => s.point === "interior");
    expect(interior).toHaveLength(1);
    expect(interior[0]!.label).toBe("Inside");
  });

  it("splits Inside per room, and names each column after the room", () => {
    // 2026-09-07, Mark: a technician has to be able to say which room he is in.
    // A house dries room by room, so two rooms are two columns; averaging them
    // into one Inside figure would invent a room nobody stood in.
    const log = buildDryingLog(
      [
        reading({ reading_date: "2026-08-01", point: "interior", room_id: "room-kitchen" }),
        reading({ reading_date: "2026-08-01", point: "interior", room_id: "room-basement" }),
      ],
      {
        roomNames: new Map([
          ["room-kitchen", "Kitchen"],
          ["room-basement", "Basement"],
        ]),
      },
    );
    const interior = log.series.filter((s) => s.point === "interior");
    expect(interior.map((s) => s.label).sort()).toEqual(["Inside — Basement", "Inside — Kitchen"]);
  });

  it("leaves a roomless inside reading on the plain Inside column", () => {
    // A job logged before rooms were offered, and a reading a technician takes
    // for the property as a whole, are the same thing and stay one series.
    const log = buildDryingLog(
      [
        reading({ reading_date: "2026-08-01", point: "interior", room_id: null }),
        reading({ reading_date: "2026-08-02", point: "interior", room_id: "room-kitchen" }),
      ],
      { roomNames: new Map([["room-kitchen", "Kitchen"]]) },
    );
    const interior = log.series.filter((s) => s.point === "interior");
    expect(interior.map((s) => s.label).sort()).toEqual(["Inside", "Inside — Kitchen"]);
  });

  it("still keeps Outside as one column whatever is typed on it", () => {
    const log = buildDryingLog([
      reading({ reading_date: "2026-08-01", point: "exterior", label: null }),
      reading({ reading_date: "2026-08-02", point: "exterior", label: "driveway" }),
    ]);
    expect(log.series.filter((s) => s.point === "exterior")).toHaveLength(1);
  });

  it("sits between Outside and the per-room points, the order it is read in", () => {
    const log = buildDryingLog([
      reading({ reading_date: "2026-08-01", point: "affected" }),
      reading({ reading_date: "2026-08-01", point: "interior" }),
      reading({ reading_date: "2026-08-01", point: "exterior" }),
    ]);
    expect(log.series.map((s) => s.point)).toEqual(["exterior", "interior", "affected"]);
  });
});

describe("checkReadingEntry", () => {
  const base = { point: "interior" as const, hasPhoto: true };

  it("passes a complete reading", () => {
    const c = checkReadingEntry({ ...base, temperatureF: 72, relativeHumidity: 55 });
    expect(c).toMatchObject({ ready: true, error: null, warning: null });
  });

  it("leaves an untouched row alone rather than calling it an error", () => {
    const c = checkReadingEntry({ ...base, temperatureF: null, relativeHumidity: null });
    expect(c.ready).toBe(false);
    expect(c.started).toBe(false);
    expect(c.error).toBeNull();
  });

  it("refuses half a reading — a tech typed one number and was interrupted", () => {
    const c = checkReadingEntry({ ...base, temperatureF: 72, relativeHumidity: null });
    expect(c.ready).toBe(false);
    expect(c.started).toBe(true);
    expect(c.error).toMatch(/temperature and a humidity/);
  });

  it("refuses a humidity no meter reports", () => {
    expect(
      checkReadingEntry({ ...base, temperatureF: 72, relativeHumidity: 0 }).error,
    ).not.toBeNull();
    expect(
      checkReadingEntry({ ...base, temperatureF: 72, relativeHumidity: 140 }).error,
    ).not.toBeNull();
  });

  it("warns about a missing meter photo inside, but never blocks the save", () => {
    // A camera that will not open must not be the reason a day goes unlogged.
    const c = checkReadingEntry({
      point: "interior",
      temperatureF: 72,
      relativeHumidity: 55,
      hasPhoto: false,
    });
    expect(c.ready).toBe(true);
    expect(c.error).toBeNull();
    expect(c.warning).toMatch(/photo/i);
  });

  it("does not nag about a photo on the points that were never asked for one", () => {
    const c = checkReadingEntry({
      point: "dehu_outlet",
      temperatureF: 72,
      relativeHumidity: 55,
      hasPhoto: false,
    });
    expect(c.warning).toBeNull();
  });
});

describe("meter photo paths", () => {
  it("keys the object on the reading id, so a replay overwrites one file", () => {
    const paths = meterPhotoPaths({
      userId: "u1",
      jobId: "j1",
      readingId: "r1",
      mime: "image/webp",
    });
    expect(paths).toEqual({ photo: "u1/j1/r1.webp", thumb: "u1/j1/r1-thumb.webp" });
  });

  it("puts the uploader first, which is what the storage policy checks", () => {
    expect(
      meterPhotoPaths({ userId: "u1", jobId: "j1", readingId: "r1", mime: "image/jpeg" }).photo,
    ).toMatch(/^u1\//);
  });

  it("falls back to jpg for a type the bucket does not name", () => {
    expect(
      meterPhotoPaths({ userId: "u1", jobId: "j1", readingId: "r1", mime: "image/gif" }).photo,
    ).toBe("u1/j1/r1.jpg");
  });

  it("hangs the photo columns off buildReadingRow only when there is a photo", () => {
    const withPhoto = buildReadingRow({
      id: "r1",
      jobId: "j1",
      userId: "u1",
      point: "interior",
      readingDate: "2026-08-01",
      temperatureF: 70,
      relativeHumidity: 50,
      photoMime: "image/webp",
      hasPhotoThumb: true,
      isBaseline: true,
    });
    expect(withPhoto.photo_path).toBe("u1/j1/r1.webp");
    expect(withPhoto.photo_thumb_path).toBe("u1/j1/r1-thumb.webp");
    expect(withPhoto.is_baseline).toBe(true);
    expect(withPhoto.values_source).toBe("typed");

    const without = buildReadingRow({
      id: "r2",
      jobId: "j1",
      userId: "u1",
      point: "interior",
      readingDate: "2026-08-01",
      temperatureF: 70,
      relativeHumidity: 50,
    });
    expect(without.photo_path).toBeNull();
    expect(without.is_baseline).toBe(false);
  });
});
