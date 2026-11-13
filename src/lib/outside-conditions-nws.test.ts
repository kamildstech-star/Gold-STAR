import { afterEach, describe, expect, it, vi } from "vitest";

import {
  OUTSIDE_MODELLED_NOTE,
  outsideReadingNote,
  outsideReadingRow,
} from "@/lib/outside-conditions";
import {
  NWS_MAX_STATION_MILES,
  NWS_USER_AGENT,
  NwsError,
  fetchNwsOutsideConditions,
  localDateIn,
  localTimeIn,
  parseNwsStations,
  pickNearestObservation,
  zonedInstant,
  type NwsSite,
} from "@/lib/outside-conditions-nws.server";
import {
  fetchJobOutside,
  openMeteoShouldFallBack,
  summarizeNightlyRun,
  type JobOutsideOutcome,
} from "@/lib/outside-conditions-nightly.server";
import { OutsideProviderError } from "@/lib/outside-conditions";

/**
 * 2026-10-07: the nightly drying-weather job has never written a row, because
 * Open-Meteo answers the shared Cloudflare address 429. Mark: "keep what we are
 * using; if it won't work, change to anything that's free that will work." So
 * the server falls back to the National Weather Service. These pin that the
 * fallback happens only when it should, reads a station the way the Open-Meteo
 * path reads the model (09:00 local, never a mean), and that the run's status
 * tells the truth.
 *
 * Every request is mocked. The one real call made while building this
 * (Newark, NJ) is where the fixture shapes come from: `/points` names
 * `observationStations` and `timeZone`; stations are GeoJSON points with
 * `stationIdentifier` and `name`; an observation's temperature is
 * `{ unitCode: "wmoUnit:degC", value, qualityControl }`, and KEWR reports
 * every five minutes, many of them without a temperature.
 */

// Newark, NJ — the job.
const LAT = 40.7357;
const LON = -74.1724;
/** 09:20 EDT on the 7th: the 13:20 UTC cron, after the morning's 09:00. */
const NOW = new Date("2026-10-07T13:20:00Z");
const NY = "America/New_York";

const STATIONS = {
  type: "FeatureCollection",
  features: [
    // Deliberately not in distance order: the order must come from our own arithmetic.
    station("KTEB", "Teterboro, Teterboro Airport", 40.85889, -74.05667),
    station("KFAR", "Somewhere Far", 41.9, -75.9),
    station("KEWR", "Newark, Newark International Airport", 40.6825, -74.16944),
    station("KCDW", "Caldwell, Essex County Airport", 40.87639, -74.28306),
    station("KNYC", "New York City, Central Park", 40.78333, -73.96667),
  ],
};

function station(id: string, name: string, lat: number, lon: number) {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [lon, lat] },
    properties: { stationIdentifier: id, name },
  };
}

type Obs = { at: string; c?: number | null; rh?: number | null; qc?: string; unit?: string };
function observations(list: Obs[]) {
  return {
    type: "FeatureCollection",
    features: list.map((o) => ({
      properties: {
        timestamp: o.at,
        temperature: {
          unitCode: o.unit ?? "wmoUnit:degC",
          value: o.c === undefined ? 15 : o.c,
          qualityControl: o.qc ?? "V",
        },
        relativeHumidity: {
          unitCode: "wmoUnit:percent",
          value: o.rh === undefined ? 80 : o.rh,
          qualityControl: "V",
        },
      },
    })),
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/geo+json" },
  });

/**
 * A fake network: Open-Meteo, /points, the station list, and per-station
 * observations. Records every call so tests can count requests and read
 * headers.
 */
function network(opts: {
  openMeteo?: () => Response | Promise<Response>;
  points?: () => Response;
  obs?: (stationId: string, start: string, end: string) => Response;
}) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    if (url.includes("open-meteo.com")) {
      if (!opts.openMeteo) throw new Error("open-meteo not expected");
      return opts.openMeteo();
    }
    if (url.includes("/points/")) {
      return opts.points
        ? opts.points()
        : json({
            properties: {
              timeZone: NY,
              observationStations: "https://api.weather.gov/gridpoints/OKX/27,42/stations",
            },
          });
    }
    if (url.includes("/gridpoints/")) return json(STATIONS);
    const m = url.match(/\/stations\/([^/]+)\/observations\?start=([^&]+)&end=([^&]+)/);
    if (m) return opts.obs ? opts.obs(m[1]!, m[2]!, m[3]!) : json(observations([]));
    throw new Error(`unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Every date but `keep` in the week the 7th's run looks at — already settled. */
function settledExcept(...keep: string[]): Set<string> {
  const all = [
    "2026-09-30",
    "2026-10-01",
    "2026-10-02",
    "2026-10-03",
    "2026-10-04",
    "2026-10-05",
    "2026-10-06",
    "2026-10-07",
  ];
  return new Set(all.filter((d) => !keep.includes(d)));
}

describe("09:00 at the site, in the site's own time zone", () => {
  it("is 13:00 UTC in a New Jersey summer and 14:00 UTC in its winter", () => {
    expect(new Date(zonedInstant("2026-10-07", "09:00", NY)).toISOString()).toBe(
      "2026-10-07T13:00:00.000Z",
    );
    expect(new Date(zonedInstant("2026-01-15", "09:00", NY)).toISOString()).toBe(
      "2026-01-15T14:00:00.000Z",
    );
  });

  it("is right on the morning the clocks change", () => {
    // 2026-03-08: clocks go forward at 02:00, so 09:00 is already EDT.
    expect(new Date(zonedInstant("2026-03-08", "09:00", NY)).toISOString()).toBe(
      "2026-03-08T13:00:00.000Z",
    );
    // 2026-11-01: back at 02:00, so 09:00 is EST again.
    expect(new Date(zonedInstant("2026-11-01", "09:00", NY)).toISOString()).toBe(
      "2026-11-01T14:00:00.000Z",
    );
  });

  it("reads the date and time at the site, not on the server", () => {
    const ms = Date.parse("2026-10-07T02:30:00Z");
    expect(localDateIn(ms, NY)).toBe("2026-10-06");
    expect(localTimeIn(ms, NY)).toBe("22:30");
    expect(localTimeIn(Date.parse("2026-10-07T12:51:00Z"), NY)).toBe("08:51");
  });
});

describe("which stations", () => {
  it("orders by distance from the property, drops the far ones, keeps three", () => {
    const got = parseNwsStations(STATIONS, LAT, LON);
    expect(got.map((s) => s.id)).toEqual(["KEWR", "KTEB", "KNYC"]);
    expect(got[0]!.name).toBe("Newark, Newark International Airport");
    expect(got[0]!.distanceMi).toBeGreaterThan(3);
    expect(got[0]!.distanceMi).toBeLessThan(4.5);
    expect(got.every((s) => s.distanceMi <= NWS_MAX_STATION_MILES)).toBe(true);
  });

  it("skips a station with no coordinates rather than guessing its distance", () => {
    const got = parseNwsStations(
      { features: [{ geometry: null, properties: { stationIdentifier: "KXXX" } }] },
      LAT,
      LON,
    );
    expect(got).toEqual([]);
  });
});

describe("the report nearest 09:00", () => {
  const target = Date.parse("2026-10-07T13:00:00Z");
  const now = Date.parse("2026-10-07T16:00:00Z");

  it("converts Celsius to Fahrenheit and keeps the humidity as reported", () => {
    const pick = pickNearestObservation(
      observations([{ at: "2026-10-07T12:51:00+00:00", c: 19, rh: 37.06 }]),
      target,
      now,
    );
    expect(pick!.tempF).toBeCloseTo(66.2, 5);
    expect(pick!.rh).toBe(37.06);
  });

  it("takes the nearest report either side, the earlier on a tie", () => {
    const later = pickNearestObservation(
      observations([
        { at: "2026-10-07T12:51:00+00:00", c: 10 },
        { at: "2026-10-07T13:04:00+00:00", c: 11 },
      ]),
      target,
      now,
    );
    expect(later!.ms).toBe(Date.parse("2026-10-07T13:04:00Z"));
    const tie = pickNearestObservation(
      observations([
        { at: "2026-10-07T13:05:00+00:00", c: 12 },
        { at: "2026-10-07T12:55:00+00:00", c: 11 },
      ]),
      target,
      now,
    );
    expect(tie!.ms).toBe(Date.parse("2026-10-07T12:55:00Z"));
  });

  it("skips reports with no temperature or humidity, or a rejected one, for the next nearest", () => {
    const pick = pickNearestObservation(
      observations([
        { at: "2026-10-07T13:00:00+00:00", c: null },
        { at: "2026-10-07T13:05:00+00:00", rh: null },
        { at: "2026-10-07T12:58:00+00:00", c: 40, qc: "X" },
        { at: "2026-10-07T12:51:00+00:00", c: 14, rh: 82 },
      ]),
      target,
      now,
    );
    expect(pick!.ms).toBe(Date.parse("2026-10-07T12:51:00Z"));
    expect(pick!.rh).toBe(82);
  });

  it("takes nothing more than two hours off, nothing from the future, nothing in an unknown unit", () => {
    expect(
      pickNearestObservation(observations([{ at: "2026-10-07T10:30:00+00:00" }]), target, now),
    ).toBeNull();
    expect(
      pickNearestObservation(
        observations([{ at: "2026-10-07T13:10:00+00:00" }]),
        target,
        Date.parse("2026-10-07T13:05:00Z"),
      ),
    ).toBeNull();
    expect(
      pickNearestObservation(
        observations([{ at: "2026-10-07T13:00:00+00:00", unit: "wmoUnit:K" }]),
        target,
        now,
      ),
    ).toBeNull();
  });
});

describe("fetching a week of station reports", () => {
  it("asks only for the days not already settled, as an identified caller", async () => {
    const calls = network({
      obs: () => json(observations([{ at: "2026-10-07T12:51:00+00:00", c: 15, rh: 80 }])),
    });
    const got = await fetchNwsOutsideConditions(LAT, LON, {
      now: NOW,
      skipDates: settledExcept("2026-10-07"),
    });
    expect(got.wanted).toBe(1);
    expect(got.missing).toEqual([]);
    expect(got.observations).toHaveLength(1);
    const obs = got.observations[0]!;
    expect(obs.date).toBe("2026-10-07");
    expect(obs.observedAt).toBe("2026-10-07T12:51:00.000Z");
    expect(obs.tempF).toBeCloseTo(59, 5);
    expect(obs.sourceDetail).toMatch(
      /^nws KEWR 08:51 local · \d\.\d mi · Newark, Newark International Airport$/,
    );

    // points, stations, one day's observations at the nearest station.
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.headers["User-Agent"] === NWS_USER_AGENT)).toBe(true);
    const obsCall = calls[2]!.url;
    expect(obsCall).toContain(
      "/stations/KEWR/observations?start=2026-10-07T11:00:00Z&end=2026-10-07T13:20:00Z",
    );
    // Four decimals: weather.gov redirects anything longer.
    expect(calls[0]!.url).toBe("https://api.weather.gov/points/40.7357,-74.1724");
  });

  it("does not ask for a day whose 09:00 has not happened yet at the site", async () => {
    const calls = network({});
    const got = await fetchNwsOutsideConditions(LAT, LON, {
      // 08:20 EDT.
      now: new Date("2026-10-07T12:20:00Z"),
      skipDates: settledExcept("2026-10-07"),
    });
    expect(got).toEqual({ observations: [], missing: [], wanted: 0 });
    expect(calls.filter((c) => c.url.includes("/observations"))).toHaveLength(0);
  });

  it("goes to the next station when the nearest had nothing usable that morning", async () => {
    network({
      obs: (id) =>
        id === "KEWR"
          ? json(observations([{ at: "2026-10-07T12:51:00+00:00", c: null }]))
          : json(observations([{ at: "2026-10-07T12:53:00+00:00", c: 16, rh: 75 }])),
    });
    const got = await fetchNwsOutsideConditions(LAT, LON, {
      now: NOW,
      skipDates: settledExcept("2026-10-07"),
    });
    expect(got.observations[0]!.sourceDetail).toMatch(/^nws KTEB 08:53 local/);
  });

  it("records a day with nothing at any station as missing, with why", async () => {
    network({ obs: () => json(observations([{ at: "2026-10-07T12:51:00+00:00", rh: null }])) });
    const got = await fetchNwsOutsideConditions(LAT, LON, {
      now: NOW,
      skipDates: settledExcept("2026-10-07"),
    });
    expect(got.observations).toEqual([]);
    expect(got.missing).toEqual([
      {
        date: "2026-10-07",
        reason:
          "no report with a temperature and humidity within 2 h of 09:00 local at KEWR, KTEB, KNYC",
      },
    ]);
  });

  it("looks a site up once per run, however many jobs share it", async () => {
    const calls = network({ obs: () => json(observations([{ at: "2026-10-07T12:51:00+00:00" }])) });
    const cache = new Map<string, Promise<NwsSite>>();
    const opts = { now: NOW, skipDates: settledExcept("2026-10-07"), cache };
    await fetchNwsOutsideConditions(LAT, LON, opts);
    await fetchNwsOutsideConditions(LAT, LON, opts);
    expect(calls.filter((c) => c.url.includes("/points/"))).toHaveLength(1);
    expect(calls.filter((c) => c.url.includes("/gridpoints/"))).toHaveLength(1);
  });

  it("throws a coded error for a site weather.gov does not cover", async () => {
    network({
      points: () =>
        json(
          {
            title: "Data Unavailable For Requested Point",
            detail: "Unable to provide data for requested point",
          },
          404,
        ),
    });
    const err = await fetchNwsOutsideConditions(51.5, -0.12, { now: NOW }).catch((e) => e);
    expect(err).toBeInstanceOf(NwsError);
    expect(err.code).toBe("nws_http_404");
    expect(err.reason).toContain("Unable to provide data for requested point");
    // Never the coordinates.
    expect(err.message).not.toContain("51.5");
  });
});

describe("one job, Open-Meteo first", () => {
  const job = { id: "job-1", lat: LAT, lon: LON };
  const base = () => ({
    now: NOW,
    apiKey: null,
    settled: settledExcept("2026-10-07"),
    nwsCache: new Map<string, Promise<NwsSite>>(),
  });
  const refused = () =>
    json(
      { error: true, reason: "Daily API request limit exceeded. Please try again tomorrow." },
      429,
    );

  it("uses Open-Meteo when it answers, and never asks the NWS", async () => {
    const calls = network({
      openMeteo: () =>
        json({
          utc_offset_seconds: -4 * 3600,
          hourly: { time: [], temperature_2m: [], relative_humidity_2m: [] },
        }),
    });
    const got = await fetchJobOutside(job, base());
    expect(got.source).toBe("open_meteo");
    expect(calls.some((c) => c.url.includes("weather.gov"))).toBe(false);
  });

  it("falls back to the NWS on a 429 and keeps Open-Meteo's reason", async () => {
    network({
      openMeteo: refused,
      obs: () => json(observations([{ at: "2026-10-07T12:51:00+00:00", c: 15, rh: 80 }])),
    });
    const got = await fetchJobOutside(job, base());
    expect(got.source).toBe("nws");
    if (got.source !== "nws") throw new Error("unreachable");
    expect(got.openMeteo.status).toBe(429);
    expect(got.openMeteo.reason).toContain("Daily API request limit exceeded");
    expect(got.observations).toHaveLength(1);
    const row = outsideReadingRow("job-1", got.observations[0]!);
    expect(row["source"]).toBe("weather");
    expect(row["source_detail"]).toMatch(/^nws KEWR 08:51 local/);
    expect(row["observed_at"]).toBe("2026-10-07T12:51:00.000Z");
    expect(row["temperature_f"]).toBe(59);
    expect(row["relative_humidity"]).toBe(80);
    // Dew point and GPP come from the same derive() a crew row uses.
    expect(typeof row["dew_point_f"]).toBe("number");
    expect(typeof row["grains_per_pound"]).toBe("number");
  });

  it("falls back on a 5xx, on no answer, and on a timeout — not on a 400", async () => {
    expect(openMeteoShouldFallBack(new OutsideProviderError(429, ""))).toBe(true);
    expect(openMeteoShouldFallBack(new OutsideProviderError(503, ""))).toBe(true);
    expect(openMeteoShouldFallBack(new OutsideProviderError(null, "The operation timed out"))).toBe(
      true,
    );
    expect(
      openMeteoShouldFallBack(new OutsideProviderError(400, "Latitude must be in range")),
    ).toBe(false);

    network({ openMeteo: () => json({ error: true, reason: "Latitude must be in range" }, 400) });
    const got = await fetchJobOutside(job, base());
    expect(got.source).toBeNull();
    if (got.source !== null) throw new Error("unreachable");
    expect(got.code).toBe("open_meteo_http_400");
    expect(got.nws).toBeNull();
  });

  it("falls back when Open-Meteo times out", async () => {
    network({
      openMeteo: () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      },
      obs: () => json(observations([{ at: "2026-10-07T12:51:00+00:00" }])),
    });
    const got = await fetchJobOutside(job, base());
    expect(got.source).toBe("nws");
  });

  it("is a failed job when the NWS has nothing either, with both reasons", async () => {
    network({ openMeteo: refused, obs: () => json(observations([])) });
    const got = await fetchJobOutside(job, base());
    expect(got.source).toBeNull();
    if (got.source !== null) throw new Error("unreachable");
    expect(got.code).toBe("nws_no_observation");
    expect(got.openMeteo.status).toBe(429);
    expect(got.nws!.reason).toContain("KEWR, KTEB, KNYC");
  });

  it("is a covered job when every day was already settled — nothing to fetch is not a failure", async () => {
    network({ openMeteo: refused });
    const got = await fetchJobOutside(job, { ...base(), settled: settledExcept() });
    expect(got.source).toBe("nws");
  });
});

describe("what the run reports", () => {
  const om = (jobId: string) => ({
    jobId,
    source: "open_meteo" as const,
    observations: [],
  });
  const nws = (jobId: string, missing = 0): JobOutsideOutcome => ({
    jobId,
    source: "nws",
    observations: [],
    openMeteo: { job_id: jobId, status: 429, reason: "Daily API request limit exceeded." },
    missing: Array.from({ length: missing }, (_, i) => ({
      date: `2026-10-0${i + 1}`,
      reason: "x",
    })),
  });
  const failed = (jobId: string, code: string): JobOutsideOutcome => ({
    jobId,
    source: null,
    openMeteo: { job_id: jobId, status: 429, reason: "Daily API request limit exceeded." },
    nws: { code, status: null, reason: "no report" },
    code,
  });

  it("answers 200 when every job got a reading from one source or the other", () => {
    const { status, body } = summarizeNightlyRun({
      outcomes: [om("a"), nws("b"), nws("c", 2)],
      jobsWithoutCoordinates: 1,
      written: 5,
      rowsBySource: { open_meteo: 3, nws: 2 },
      keyed: false,
    });
    expect(status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      jobs: 3,
      jobs_without_coordinates: 1,
      readings_written: 5,
      by_source: { open_meteo: { jobs: 1, readings: 3 }, nws: { jobs: 2, readings: 2 } },
      open_meteo_refusals: { "429": 2 },
      nws_days_without_observation: 2,
      failed_jobs: 0,
      failure_reasons: {},
      failures: [],
    });
    expect(String(body.hint)).toMatch(/National Weather Service/);
  });

  it("answers 502 when any job got none, counted by reason", () => {
    const { status, body } = summarizeNightlyRun({
      outcomes: [
        nws("a"),
        failed("b", "nws_no_observation"),
        failed("c", "nws_http_404"),
        failed("d", "nws_http_404"),
      ],
      jobsWithoutCoordinates: 0,
      written: 1,
      rowsBySource: { open_meteo: 0, nws: 1 },
      keyed: false,
    });
    expect(status).toBe(502);
    expect(body.ok).toBe(false);
    expect(body.failed_jobs).toBe(3);
    expect(body.failure_reasons).toEqual({ nws_no_observation: 1, nws_http_404: 2 });
    expect((body.failures as unknown[])[0]).toEqual({
      job_id: "b",
      code: "nws_no_observation",
      open_meteo: { status: 429, reason: "Daily API request limit exceeded." },
      nws: { code: "nws_no_observation", status: null, reason: "no report" },
    });
  });

  it("answers 200 with nothing to say on a night Open-Meteo answered everyone", () => {
    const { status, body } = summarizeNightlyRun({
      outcomes: [om("a")],
      jobsWithoutCoordinates: 0,
      written: 1,
      rowsBySource: { open_meteo: 1, nws: 0 },
      keyed: false,
    });
    expect(status).toBe(200);
    expect(body.hint).toBeNull();
    expect(body.open_meteo_refusals).toEqual({});
  });
});

describe("a station row is never described as the model", () => {
  it("names the station, its distance and its time", () => {
    const note = outsideReadingNote({
      source: "weather",
      source_detail: "nws KEWR 08:51 local · 3.8 mi · Newark, Newark International Airport",
    });
    expect(note).toBe(
      "Measured at 08:51 local by National Weather Service station KEWR " +
        "(Newark, Newark International Airport), 3.8 miles from this address — " +
        "not a measurement taken on site.",
    );
    expect(note).not.toBe(OUTSIDE_MODELLED_NOTE);
  });
});
