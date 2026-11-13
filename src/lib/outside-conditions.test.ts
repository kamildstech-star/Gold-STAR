import { afterEach, describe, expect, it, vi } from "vitest";

import {
  OUTSIDE_MAX_BACKFILL_DAYS,
  OUTSIDE_PAST_DAYS,
  OUTSIDE_POLICY_MIGRATION,
  OutsideProviderError,
  backfillPastDays,
  daysBetweenDates,
  describeOutsideFetchFailure,
  fetchOutsideConditions,
  outsideConditionsUrl,
  parseOutsideObservations,
  outsideReadingRow,
  providerFailureHint,
  providerReason,
  summarizeProviderFailure,
} from "@/lib/outside-conditions";

/**
 * The hour is the whole point. A backfilled week that mixes 06:00 and 09:00 is
 * a series that shows the weather moving rather than the structure drying, and
 * an adjuster reading it would be right to throw it out.
 */

/** A week of hourly data at a fixed offset, 06:00 through 12:00 each day. */
function payload(opts: {
  days: string[];
  offsetSeconds: number;
  /** Override or delete the value at one local stamp. */
  tweak?: (stamp: string) => { temp: number | null; rh: number | null } | undefined;
}) {
  const time: string[] = [];
  const temperature_2m: (number | null)[] = [];
  const relative_humidity_2m: (number | null)[] = [];
  for (const day of opts.days) {
    for (const hour of ["06:00", "09:00", "12:00"]) {
      const stamp = `${day}T${hour}`;
      const override = opts.tweak?.(stamp);
      time.push(stamp);
      temperature_2m.push(override ? override.temp : hour === "09:00" ? 61 : 99);
      relative_humidity_2m.push(override ? override.rh : hour === "09:00" ? 70 : 20);
    }
  }
  return {
    utc_offset_seconds: opts.offsetSeconds,
    hourly: { time, temperature_2m, relative_humidity_2m },
  };
}

const NY_OFFSET = -4 * 3600;

describe("the 09:00 local baseline", () => {
  it("takes the 09:00 hour and no other, on every backfilled day", () => {
    const days = ["2026-08-25", "2026-08-26", "2026-08-27"];
    const got = parseOutsideObservations(
      payload({ days, offsetSeconds: NY_OFFSET }),
      new Date("2026-08-28T00:00:00Z"),
    );
    expect(got.map((o) => o.date)).toEqual(days);
    // 61/70 is the 09:00 pair; 99/20 is every other hour in the fixture.
    expect(got.every((o) => o.tempF === 61 && o.rh === 70)).toBe(true);
    expect(got.every((o) => o.observedAt.endsWith("T13:00:00.000Z"))).toBe(true);
  });

  it("reads the local stamp against the offset the provider reported", () => {
    const [tokyo] = parseOutsideObservations(
      payload({ days: ["2026-08-25"], offsetSeconds: 9 * 3600 }),
      new Date("2026-08-28T00:00:00Z"),
    );
    // 09:00 in Tokyo is the previous midnight in UTC.
    expect(tokyo!.observedAt).toBe("2026-08-25T00:00:00.000Z");
    expect(tokyo!.date).toBe("2026-08-25");
  });

  it("writes nothing for a day whose 09:00 has not happened yet on site", () => {
    // 08:30 local in New York on the 26th: today's 09:00 is still a forecast.
    const got = parseOutsideObservations(
      payload({ days: ["2026-08-25", "2026-08-26"], offsetSeconds: NY_OFFSET }),
      new Date("2026-08-26T12:30:00Z"),
    );
    expect(got.map((o) => o.date)).toEqual(["2026-08-25"]);
  });

  it("skips a day the provider has a hole in rather than reaching for 06:00", () => {
    const got = parseOutsideObservations(
      payload({
        days: ["2026-08-25", "2026-08-26"],
        offsetSeconds: NY_OFFSET,
        tweak: (stamp) => (stamp === "2026-08-25T09:00" ? { temp: null, rh: null } : undefined),
      }),
      new Date("2026-08-28T00:00:00Z"),
    );
    expect(got.map((o) => o.date)).toEqual(["2026-08-26"]);
  });

  it("refuses a humidity of zero, which is a hole and not a reading", () => {
    const got = parseOutsideObservations(
      payload({
        days: ["2026-08-25"],
        offsetSeconds: NY_OFFSET,
        tweak: (stamp) => (stamp === "2026-08-25T09:00" ? { temp: 61, rh: 0 } : undefined),
      }),
      new Date("2026-08-28T00:00:00Z"),
    );
    expect(got).toEqual([]);
  });
});

describe("the row an observation becomes", () => {
  it("carries the hour in source_detail, so the stamp survives without observed_at", () => {
    const [obs] = parseOutsideObservations(
      payload({ days: ["2026-08-25"], offsetSeconds: NY_OFFSET }),
      new Date("2026-08-28T00:00:00Z"),
    );
    const row = outsideReadingRow("job-1", obs!);
    expect(row["source"]).toBe("weather");
    expect(row["source_detail"]).toBe("open-meteo 09:00 local");
    expect(row["observed_at"]).toBe(obs!.observedAt);
    // The instant the air was like that, not the moment the fetch ran.
    expect(row["captured_at"]).toBe(obs!.observedAt);
    // Nobody took this reading; claiming an author is the lie the source
    // column exists to prevent.
    expect(row["created_by"]).toBeNull();
  });
});

/**
 * The failure text IS the fix instruction. A crew told "the weather service did
 * not answer" taps the button all week; a crew told the database is refusing
 * the row goes and gets somebody to apply a migration. Getting this wrong costs
 * days of unrecorded drying, so the wording is pinned.
 */
describe("why an outside fetch produced nothing", () => {
  it("names the migration when row-level security refuses the write", () => {
    const failure = describeOutsideFetchFailure({
      code: "42501",
      message: 'new row violates row-level security policy for table "job_drying_readings"',
    });
    expect(failure.kind).toBe("blocked");
    expect(failure.message).toContain(OUTSIDE_POLICY_MIGRATION);
  });

  it("recognizes a policy refusal that arrives with no SQLSTATE", () => {
    const failure = describeOutsideFetchFailure(
      new Error("new row violates row-level security policy"),
    );
    expect(failure.kind).toBe("blocked");
  });

  it("treats a missing table as setup, not as a provider outage", () => {
    const failure = describeOutsideFetchFailure({
      code: "PGRST205",
      message: "relation 'public.job_drying_readings' does not exist",
    });
    expect(failure.kind).toBe("blocked");
    expect(failure.message).toMatch(/not in this database yet/);
  });

  it("reports a provider outage as retryable, and never as a reading of zero", () => {
    const failure = describeOutsideFetchFailure(new Error("Open-Meteo returned 503"));
    expect(failure.kind).toBe("provider");
    expect(failure.message).toContain("Open-Meteo returned 503");
    expect(failure.message).toMatch(/not a reading of zero/);
  });

  it("still says something useful when it is handed nothing at all", () => {
    const failure = describeOutsideFetchFailure(undefined);
    expect(failure.kind).toBe("provider");
    expect(failure.message).toMatch(/did not answer/);
  });
});

/**
 * The backfill window. Every one of these passes `today` explicitly: this file
 * is full of dates and hours, and a fixture pinned to a fixed day against a
 * function that reads the clock is how the suite went red on 24 September on a
 * date nobody chose.
 */
describe("how far back a backfill reaches", () => {
  it("counts whole calendar days, both ways round", () => {
    expect(daysBetweenDates("2026-09-28", "2026-10-05")).toBe(7);
    expect(daysBetweenDates("2026-10-05", "2026-10-05")).toBe(0);
    // Never negative: a record that starts in the future is a data problem,
    // not a reason to ask the provider for a negative window.
    expect(daysBetweenDates("2026-10-09", "2026-10-05")).toBe(0);
  });

  it("spans a daylight-saving boundary without gaining or losing a day", () => {
    // US DST ends 2026-11-01. These are date strings, not instants; parsed
    // through a local timezone the count would come out 7.04 and round wrong.
    expect(daysBetweenDates("2026-10-29", "2026-11-05")).toBe(7);
  });

  it("still asks for the nightly week when the job's start is unknown", () => {
    expect(backfillPastDays(null, "2026-10-05")).toBe(OUTSIDE_PAST_DAYS);
    expect(backfillPastDays(undefined, "2026-10-05")).toBe(OUTSIDE_PAST_DAYS);
  });

  it("never asks for less than the nightly week on a job that started today", () => {
    // A short job still wants the full week: its first day may predate the
    // first typed reading, and asking for less cannot make the fetch cheaper.
    expect(backfillPastDays("2026-10-05", "2026-10-05")).toBe(OUTSIDE_PAST_DAYS);
    expect(backfillPastDays("2026-10-03", "2026-10-05")).toBe(OUTSIDE_PAST_DAYS);
  });

  it("reaches back to the day the record starts when that is further than a week", () => {
    // Mark's strip: eight days already gone with nothing recorded.
    expect(backfillPastDays("2026-09-27", "2026-10-05")).toBe(8);
    expect(backfillPastDays("2026-09-15", "2026-10-05")).toBe(20);
  });

  it("stops at the cap rather than inventing a month of weather for an old job", () => {
    expect(backfillPastDays("2026-01-01", "2026-10-05")).toBe(OUTSIDE_MAX_BACKFILL_DAYS);
    // And the cap stays inside what Open-Meteo's forecast endpoint serves.
    expect(OUTSIDE_MAX_BACKFILL_DAYS).toBeLessThanOrEqual(92);
  });
});

/**
 * 2026-10-05, from the live database: the nightly hook answered 200 with
 * `"failed_fetches":2` every morning for a month and never said why, while the
 * same request from the browser worked. These pin that a failure now carries
 * its status and the provider's own reason — and never the URL, which holds
 * the site's coordinates and, on the server, the API key.
 */
describe("why a fetch failed, kept", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const NOW = new Date("2026-10-05T14:00:00Z");

  it("keeps Open-Meteo's status and reason on a refusal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: true,
              reason: "Daily API request limit exceeded. Please try again tomorrow.",
            }),
            { status: 429 },
          ),
      ),
    );
    const err = await fetchOutsideConditions(40.73, -74.06, { now: NOW }).catch((e) => e);
    expect(err).toBeInstanceOf(OutsideProviderError);
    expect(err.status).toBe(429);
    expect(err.reason).toBe("Daily API request limit exceeded. Please try again tomorrow.");
    // The sentence the drying log shows a technician carries the reason too.
    expect(describeOutsideFetchFailure(err).message).toContain("429");
    expect(describeOutsideFetchFailure(err).message).toContain("limit exceeded");
  });

  it("says the provider was unreachable when no answer came back at all", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const err = await fetchOutsideConditions(40.73, -74.06, { now: NOW }).catch((e) => e);
    expect(err).toBeInstanceOf(OutsideProviderError);
    expect(err.status).toBeNull();
    expect(err.message).toMatch(/could not be reached: fetch failed/);
  });

  it("never carries the request URL, the coordinates or the key in what it reports", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html><body>Bad gateway</body></html>", { status: 502 })),
    );
    const err = await fetchOutsideConditions(40.7322, -74.0631, {
      now: NOW,
      apiKey: "sekret-key-123",
    }).catch((e) => e);
    const reported = JSON.stringify(summarizeProviderFailure("job-1", err)) + err.message;
    expect(reported).toContain("Bad gateway");
    for (const leak of ["open-meteo.com/v1", "40.7322", "-74.0631", "sekret-key-123", "<html"]) {
      expect(reported).not.toContain(leak);
    }
  });

  it("reads Open-Meteo's JSON reason, falls back to text, and caps the length", () => {
    expect(providerReason('{"error":true,"reason":"Latitude must be in range"}')).toBe(
      "Latitude must be in range",
    );
    expect(providerReason("  upstream   timeout  ")).toBe("upstream timeout");
    expect(providerReason("x".repeat(500))).toHaveLength(200);
  });

  it("summarizes an unexpected error without inventing a status", () => {
    expect(summarizeProviderFailure("job-9", new Error("boom"))).toEqual({
      job_id: "job-9",
      status: null,
      reason: "boom",
    });
  });

  it("names the shared-address rate limit when every failure is a 429", () => {
    const hint = providerFailureHint([
      { job_id: "a", status: 429, reason: "Daily API request limit exceeded." },
      { job_id: "b", status: 429, reason: "Daily API request limit exceeded." },
    ]);
    expect(hint).toMatch(/per IP address/);
    expect(hint).toMatch(/OPEN_METEO_API_KEY/);
    // Mixed causes are left to the per-job list rather than summarised wrongly.
    expect(
      providerFailureHint([
        { job_id: "a", status: 429, reason: "" },
        { job_id: "b", status: 500, reason: "" },
      ]),
    ).toBeNull();
    expect(providerFailureHint([])).toBeNull();
  });
});

describe("the request, with and without a paid key", () => {
  it("uses the free endpoint by default, exactly as the browser always has", () => {
    const url = outsideConditionsUrl(40.73, -74.06, 7);
    expect(url.startsWith("https://api.open-meteo.com/v1/forecast?")).toBe(true);
    expect(url).not.toContain("apikey");
  });

  it("moves to the customer endpoint with the key when one is set", () => {
    const url = outsideConditionsUrl(40.73, -74.06, 7, "k&y");
    expect(url.startsWith("https://customer-api.open-meteo.com/v1/forecast?")).toBe(true);
    expect(url).toContain("&apikey=k%26y");
    // Every other parameter identical, so a keyed run cannot pick a different hour.
    expect(url.replace("customer-api", "api").replace("&apikey=k%26y", "")).toBe(
      outsideConditionsUrl(40.73, -74.06, 7),
    );
  });
});
