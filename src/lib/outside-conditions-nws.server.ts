/**
 * The National Weather Service as the nightly job's second source of the
 * outside baseline — used only when Open-Meteo refuses the server.
 *
 * WHY THIS EXISTS (2026-10-07)
 * The nightly hook has never written a row. Every call it makes to Open-Meteo
 * is answered 429 "Daily API request limit exceeded": the free tier is counted
 * per IP address, the hook runs on a Cloudflare Worker, and that Worker's
 * outbound address is shared with every other tenant on it, so the quota is
 * spent before we ask. The browser path works because each user calls from
 * their own address — which is why every weather row on file was written by
 * somebody opening a drying log, and a job nobody opens gets none.
 *
 * Mark: "keep what we are using; if it won't work, change to anything that's
 * free that will work." So Open-Meteo stays first, on both paths, and when it
 * refuses the SERVER (429, a 5xx, no answer) the hook asks api.weather.gov —
 * free, no key, no account, and not counted per address. The browser never
 * calls this file (it is `.server`, and weather.gov is not in the CSP).
 *
 * WHAT THE NUMBER IS — AND WHY IT IS LABELLED DIFFERENTLY
 * Open-Meteo's figure is a model's value for the grid square. This one is a
 * real measurement, by a real instrument, at a named station — usually an
 * airport — some miles away. Better evidence of what the air was doing that
 * morning; still not a measurement at the address. The row's `source_detail`
 * names the station, its distance and the report's local time, and every
 * surface prints `outsideReadingNote(row)` (outside-conditions.ts), which says
 * exactly that.
 *
 * THE SAME 09:00 RULE
 * The module this backs up takes the 09:00 local hour and never a mean, for
 * reasons in its header. A station does not report on the hour — airports
 * mostly report at :51, many every five minutes — so this takes the report
 * NEAREST 09:00 local, within two hours either side, and never one from the
 * future. A day with no usable report in that window gets nothing, and is a
 * visible gap rather than a 06:00 figure passed off as the morning's.
 *
 * HOW FAR BACK
 * Station observations are kept about a week, which is OUTSIDE_PAST_DAYS. The
 * thirty-day backfill for a newly opened log stays Open-Meteo's, in the
 * browser, where the quota is the user's own.
 */

import type { OutsideObservation } from "@/lib/outside-conditions";
import {
  nwsSourceDetail,
  OUTSIDE_BASELINE_HOUR,
  OUTSIDE_PAST_DAYS,
} from "@/lib/outside-conditions";

const NWS_BASE = "https://api.weather.gov";

/**
 * weather.gov refuses requests without a User-Agent that identifies the
 * caller and a way to reach them; it is their stated substitute for an API
 * key. A constant, so every request is the same caller.
 */
export const NWS_USER_AGENT = "GoldstarRecoveryHub/1.0 (it@goldstarrestoration.com)";

/** Either side of 09:00 local a station report may be taken from. */
export const NWS_WINDOW_MINUTES = 120;

/**
 * Stations tried per site, nearest first. The nearest airport is normally
 * enough; the next two cover an instrument that was down that morning.
 */
export const NWS_MAX_STATIONS = 3;

/**
 * Beyond this a station describes a different place's weather, and a figure
 * from it would be a measurement of nowhere near the property. A site with no
 * station this close gets no NWS figure, and the failure says why.
 */
export const NWS_MAX_STATION_MILES = 30;

/** Per request. A Worker's run should not hang on one slow answer. */
export const NWS_TIMEOUT_MS = 10_000;

/**
 * Why the NWS path gave nothing. `code` is short and stable so the nightly
 * summary can count failures by cause; `reason` is the sentence. Like
 * OutsideProviderError, it never keeps the request URL — the URL holds the
 * site's coordinates.
 */
export class NwsError extends Error {
  readonly status: number | null;
  readonly code: string;
  readonly reason: string;
  constructor(code: string, status: number | null, reason: string) {
    super(`National Weather Service: ${reason}`);
    this.name = "NwsError";
    this.code = code;
    this.status = status;
    this.reason = reason;
  }
}

/** One station near a site, as far as this module needs it. */
export type NwsStation = { id: string; name: string | null; distanceMi: number };

/** The per-site facts that do not change from night to night. */
export type NwsSite = { timeZone: string; stations: NwsStation[] };

/* ------------------------------------------------------------------ */
/* Time at the site                                                    */
/* ------------------------------------------------------------------ */

/**
 * Wall-clock parts of an instant in an IANA zone. Intl is the only correct
 * source of a zone's rules here — a hard-coded offset is wrong for half the
 * year — and it is available in a Worker.
 */
function wallClock(ms: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${get("hour")}:${get("minute")}`,
    utcGuess: Date.UTC(
      Number(get("year")),
      Number(get("month")) - 1,
      Number(get("day")),
      Number(get("hour")),
      Number(get("minute")),
      Number(get("second")),
    ),
  };
}

/** The site's calendar date at an instant, `YYYY-MM-DD`. */
export function localDateIn(ms: number, timeZone: string): string {
  return wallClock(ms, timeZone).date;
}

/** The site's wall-clock at an instant, `HH:MM`. */
export function localTimeIn(ms: number, timeZone: string): string {
  return wallClock(ms, timeZone).time;
}

/**
 * The instant at which it is `hhmm` on `date` at the site.
 *
 * Two passes: the zone's offset at a first guess, then at the corrected
 * instant, which lands right on either side of a daylight-saving change.
 */
export function zonedInstant(date: string, hhmm: string, timeZone: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const [h, min] = hhmm.split(":").map(Number);
  const target = Date.UTC(y!, m! - 1, d!, h!, min!);
  const offsetAt = (ms: number) => wallClock(ms, timeZone).utcGuess - Math.floor(ms / 1000) * 1000;
  let ms = target - offsetAt(target);
  ms = target - offsetAt(ms);
  return ms;
}

function addDays(date: string, n: number): string {
  // UTC noon, so a step can never be eaten by a DST change.
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ */
/* Parsing                                                             */
/* ------------------------------------------------------------------ */

/** Great-circle miles. Stations are a few miles off; the earth's curve is enough precision. */
export function milesBetween(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = (x: number) => (x * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 3958.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

type StationsPayload = {
  features?: {
    geometry?: { coordinates?: number[] } | null;
    properties?: { stationIdentifier?: string; name?: string | null };
  }[];
};

/**
 * The stations worth asking, nearest first.
 *
 * Distance is measured here, from the job's own coordinates, rather than
 * trusted from the response: the list weather.gov returns is ordered from its
 * forecast grid cell, and the figure printed beside a reading must be the
 * distance to the property.
 */
export function parseNwsStations(payload: StationsPayload, lat: number, lon: number): NwsStation[] {
  const out: NwsStation[] = [];
  for (const f of payload?.features ?? []) {
    const id = f.properties?.stationIdentifier;
    const c = f.geometry?.coordinates;
    if (!id || !c || typeof c[0] !== "number" || typeof c[1] !== "number") continue;
    const distanceMi = milesBetween(lat, lon, c[1], c[0]);
    if (distanceMi > NWS_MAX_STATION_MILES) continue;
    out.push({ id, name: f.properties?.name?.trim() || null, distanceMi });
  }
  return out.sort((a, b) => a.distanceMi - b.distanceMi).slice(0, NWS_MAX_STATIONS);
}

type NwsValue = { unitCode?: string; value?: number | null; qualityControl?: string } | null;

type ObservationsPayload = {
  features?: {
    properties?: { timestamp?: string; temperature?: NwsValue; relativeHumidity?: NwsValue };
  }[];
};

/** "X" is the NWS quality check's "rejected": the instrument reported, and it was wrong. */
function usable(v: NwsValue | undefined): v is { unitCode?: string; value: number } {
  return (
    v != null && typeof v.value === "number" && Number.isFinite(v.value) && v.qualityControl !== "X"
  );
}

function toFahrenheit(v: { unitCode?: string; value: number }): number | null {
  const unit = v.unitCode ?? "";
  if (unit.endsWith("degC")) return (v.value * 9) / 5 + 32;
  if (unit.endsWith("degF")) return v.value;
  // An unknown unit is a number we cannot defend; skip it like a null.
  return null;
}

/**
 * The report nearest `targetMs`, within NWS_WINDOW_MINUTES either side and
 * never later than `nowMs`, with a real temperature and humidity.
 *
 * A report with a null temperature or humidity — common: an airport's
 * five-minute reports often carry only wind and pressure — is skipped and the
 * next nearest taken, which is why this is a sort and not a single lookup.
 * Equal distance either side goes to the earlier report: it is the one that
 * existed when the crew arrived.
 */
export function pickNearestObservation(
  payload: ObservationsPayload,
  targetMs: number,
  nowMs: number,
): { ms: number; tempF: number; rh: number } | null {
  const windowMs = NWS_WINDOW_MINUTES * 60_000;
  let best: { ms: number; tempF: number; rh: number; gap: number } | null = null;
  for (const f of payload?.features ?? []) {
    const p = f.properties;
    const ms = p?.timestamp ? Date.parse(p.timestamp) : NaN;
    if (!Number.isFinite(ms) || ms > nowMs) continue;
    const gap = Math.abs(ms - targetMs);
    if (gap > windowMs) continue;
    if (!usable(p?.temperature) || !usable(p?.relativeHumidity)) continue;
    const tempF = toFahrenheit(p!.temperature!);
    const rh = p!.relativeHumidity!.value!;
    if (tempF == null || rh <= 0 || rh > 100) continue;
    if (!best || gap < best.gap || (gap === best.gap && ms < best.ms)) {
      best = { ms, tempF, rh, gap };
    }
  }
  return best ? { ms: best.ms, tempF: best.tempF, rh: best.rh } : null;
}

/* ------------------------------------------------------------------ */
/* Requests                                                            */
/* ------------------------------------------------------------------ */

/** weather.gov redirects any coordinate with more than four decimals; ask with four. */
export function nwsPointsUrl(lat: number, lon: number): string {
  return `${NWS_BASE}/points/${lat.toFixed(4)},${lon.toFixed(4)}`;
}

/** Without milliseconds: the observations endpoint is strict about its ISO form. */
function isoSeconds(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function nwsObservationsUrl(stationId: string, startMs: number, endMs: number): string {
  return (
    `${NWS_BASE}/stations/${encodeURIComponent(stationId)}/observations` +
    `?start=${isoSeconds(startMs)}&end=${isoSeconds(endMs)}&limit=100`
  );
}

/** NWS errors are problem+json: `{ title, detail, status }`. */
function nwsReason(body: string): string {
  let reason = "";
  try {
    const parsed = JSON.parse(body) as { detail?: unknown; title?: unknown };
    if (typeof parsed?.detail === "string") reason = parsed.detail;
    else if (typeof parsed?.title === "string") reason = parsed.title;
  } catch {
    // not JSON
  }
  if (!reason)
    reason = body
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  return reason.length > 200 ? `${reason.slice(0, 199)}…` : reason;
}

async function nwsGet<T>(url: string, timeoutMs: number): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "User-Agent": NWS_USER_AGENT, Accept: "application/geo+json" },
      signal:
        typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(timeoutMs) : undefined,
    });
  } catch (error) {
    throw new NwsError(
      "nws_unreachable",
      null,
      `could not be reached (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const reason = nwsReason(body);
    throw new NwsError(
      `nws_http_${response.status}`,
      response.status,
      `returned ${response.status}${reason ? `: ${reason}` : ""}`,
    );
  }
  try {
    return (await response.json()) as T;
  } catch {
    throw new NwsError(
      "nws_bad_response",
      response.status,
      "answered with something that is not JSON",
    );
  }
}

/**
 * The site's time zone and nearest stations: two requests (`/points`, then
 * the stations list it links to). Stable for a site, so a run asks once per
 * coordinate pair — pass the same `cache` for every job in the run.
 */
export async function lookupNwsSite(
  lat: number,
  lon: number,
  opts?: { cache?: Map<string, Promise<NwsSite>>; timeoutMs?: number },
): Promise<NwsSite> {
  const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
  const cached = opts?.cache?.get(key);
  if (cached) return cached;
  const timeoutMs = opts?.timeoutMs ?? NWS_TIMEOUT_MS;
  const pending = (async () => {
    const points = await nwsGet<{
      properties?: { timeZone?: string; observationStations?: string };
    }>(nwsPointsUrl(lat, lon), timeoutMs);
    const timeZone = points.properties?.timeZone;
    const stationsUrl = points.properties?.observationStations;
    if (!timeZone || !stationsUrl || !stationsUrl.startsWith(`${NWS_BASE}/`)) {
      throw new NwsError(
        "nws_bad_response",
        null,
        "gave no time zone or station list for this site",
      );
    }
    try {
      localDateIn(Date.now(), timeZone);
    } catch {
      throw new NwsError(
        "nws_bad_response",
        null,
        `named a time zone this server cannot read (${timeZone})`,
      );
    }
    const stations = parseNwsStations(
      await nwsGet<StationsPayload>(stationsUrl, timeoutMs),
      lat,
      lon,
    );
    if (stations.length === 0) {
      throw new NwsError(
        "nws_no_station_nearby",
        null,
        `has no observation station within ${NWS_MAX_STATION_MILES} miles of this site`,
      );
    }
    return { timeZone, stations };
  })();
  opts?.cache?.set(key, pending);
  // A failed lookup is not remembered as a site: the next job at the same
  // coordinates gets its own attempt rather than inheriting a timeout.
  pending.catch(() => opts?.cache?.delete(key));
  return pending;
}

export type NwsMissingDay = { date: string; reason: string };

export type NwsFetchResult = {
  /** One per day that had a usable report, oldest first. */
  observations: OutsideObservation[];
  /** Days that were wanted and got nothing, each with why. */
  missing: NwsMissingDay[];
  /** Days that were asked for at all — zero when every day was already settled. */
  wanted: number;
};

/**
 * Station reports nearest 09:00 local for each day of the past week that the
 * caller has not already settled.
 *
 * `skipDates` is the hook's own "already has an exterior row" set: unlike
 * Open-Meteo, which answers a whole week in one call, this costs a request per
 * day, so a night where only today is missing is one request per site.
 *
 * Throws NwsError when the site itself cannot be looked up (outside the US,
 * no station nearby, weather.gov down). A day with no usable report is not a
 * throw — it is a `missing` entry, so one quiet morning does not cost the
 * other six.
 */
export async function fetchNwsOutsideConditions(
  lat: number,
  lon: number,
  opts: {
    now: Date;
    pastDays?: number;
    skipDates?: ReadonlySet<string>;
    cache?: Map<string, Promise<NwsSite>>;
    timeoutMs?: number;
  },
): Promise<NwsFetchResult> {
  const timeoutMs = opts.timeoutMs ?? NWS_TIMEOUT_MS;
  const site = await lookupNwsSite(lat, lon, { cache: opts.cache, timeoutMs });
  const nowMs = opts.now.getTime();
  const today = localDateIn(nowMs, site.timeZone);
  const pastDays = opts.pastDays ?? OUTSIDE_PAST_DAYS;

  const observations: OutsideObservation[] = [];
  const missing: NwsMissingDay[] = [];
  let wanted = 0;

  for (let back = pastDays; back >= 0; back -= 1) {
    const date = addDays(today, -back);
    if (opts.skipDates?.has(date)) continue;
    const targetMs = zonedInstant(date, OUTSIDE_BASELINE_HOUR, site.timeZone);
    // Today's 09:00 has not happened yet: nothing to measure, and not a gap.
    if (targetMs > nowMs) continue;
    wanted += 1;

    const windowMs = NWS_WINDOW_MINUTES * 60_000;
    let lastError: NwsError | null = null;
    let found = false;
    for (const station of site.stations) {
      let payload: ObservationsPayload;
      try {
        payload = await nwsGet<ObservationsPayload>(
          nwsObservationsUrl(station.id, targetMs - windowMs, Math.min(targetMs + windowMs, nowMs)),
          timeoutMs,
        );
      } catch (error) {
        lastError =
          error instanceof NwsError ? error : new NwsError("nws_unreachable", null, String(error));
        continue;
      }
      const pick = pickNearestObservation(payload, targetMs, nowMs);
      if (!pick) continue;
      const localTime = localTimeIn(pick.ms, site.timeZone);
      observations.push({
        date,
        observedAt: new Date(pick.ms).toISOString(),
        tempF: pick.tempF,
        rh: pick.rh,
        sourceDetail: nwsSourceDetail({
          stationId: station.id,
          stationName: station.name,
          distanceMi: station.distanceMi,
          localTime,
        }),
      });
      found = true;
      break;
    }
    if (!found) {
      const ids = site.stations.map((s) => s.id).join(", ");
      missing.push({
        date,
        reason: lastError
          ? `${lastError.reason} (stations ${ids})`
          : `no report with a temperature and humidity within ${NWS_WINDOW_MINUTES / 60} h of ` +
            `${OUTSIDE_BASELINE_HOUR} local at ${ids}`,
      });
    }
  }
  return { observations, missing, wanted };
}
