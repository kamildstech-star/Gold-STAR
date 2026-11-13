/**
 * The automatic exterior baseline: Open-Meteo, one 09:00 local observation per
 * day per job.
 *
 * Shared by the nightly cron endpoint
 * (src/routes/api/public/hooks/drying-weather.ts) and the "Fetch outside
 * conditions" button on the drying log, so an office manager tapping the button
 * and the scheduler running at 3am cannot produce different numbers or label
 * them differently.
 *
 * WHY 09:00 AND NOT AN AVERAGE, OR NOON
 * A drying log is argued day over day. Outside at noon on Monday against
 * outside at 4pm on Tuesday compares weather, not progress, so the hour has to
 * be fixed. 09:00 is when crews arrive, which puts the baseline alongside the
 * hand readings taken on the same visit — outside at 9 against the affected
 * room at 9 is the comparison an adjuster actually makes. A daily mean is worse
 * than either: the mean of hourly relative humidities is not the humidity at
 * any moment, so it invents a reading nobody could have taken.
 *
 * WHAT THE NUMBER IS
 * A modelled value for the grid square containing the address, not a
 * measurement at the address. Every surface that shows it says so — see
 * OUTSIDE_MODELLED_NOTE — because an adjuster is entitled to challenge it and
 * the log is worth nothing if it overstates its own evidence.
 *
 * Open-Meteo (https://open-meteo.com) needs no API key, no account and no
 * dependency. The chase screen already calls it from the browser, so the
 * on-demand path is a plain fetch there too.
 */

import { derive } from "@/lib/psychrometrics";
import { isMissingSchema } from "@/lib/schema-fallback";

/** How far back a fetch backfills. A week absorbs any plausible cron outage. */
export const OUTSIDE_PAST_DAYS = 7;

/**
 * How far back a one-off backfill will reach.
 *
 * A week is right for the nightly job — it only has to survive an outage
 * between two runs. It is wrong for the case on the screen today: the nightly
 * fill has never once written a row, so jobs are carrying logs with every
 * outside figure missing, and historical weather for those days still exists.
 * A day left blank is a day a carrier can refuse the equipment for, and a day
 * that can be recovered from the provider should not be written off because
 * the window was sized for a different problem.
 *
 * Thirty days, because: Open-Meteo's forecast endpoint serves `past_days` up to
 * 92, so this is a judgement and not a provider limit; a structural dry that
 * runs past a month is not a drying log any more, it is a reconstruction; and
 * a month is long enough that a crew noticing the gap mid-job can still fix
 * the whole job rather than most of it.
 *
 * The depth is only ever the OUTER bound. Every backfill is also clamped to the
 * day the job's own log starts — see `backfillPastDays` — because writing a
 * modelled row onto a date before anybody was on site would lengthen the log
 * backwards with days nobody visited, and the log counts those as gaps. We
 * would be manufacturing the exact evidence a carrier uses to deny the claim.
 */
export const OUTSIDE_MAX_BACKFILL_DAYS = 30;

/**
 * Whole days from one `YYYY-MM-DD` to another, never negative.
 *
 * Parsed at UTC midnight on both ends so the answer is a count of calendar
 * days and cannot shift by one over a daylight-saving boundary — these are
 * date strings, not instants, and must not be run through the local timezone.
 */
export function daysBetweenDates(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

/**
 * How many past days to ask the provider for, to backfill a log that starts on
 * `firstDay` when today is `today`.
 *
 * `today` is a required argument and never defaults to the clock. The 09:00
 * selection, the `isToday` squares and this window all read the same calendar,
 * and a function in this file that quietly consulted `Date.now()` is how a
 * fixture here goes red on a date nobody chose.
 */
export function backfillPastDays(firstDay: string | null | undefined, today: string): number {
  if (!firstDay) return OUTSIDE_PAST_DAYS;
  const span = daysBetweenDates(firstDay, today);
  return Math.min(OUTSIDE_MAX_BACKFILL_DAYS, Math.max(OUTSIDE_PAST_DAYS, span));
}

/**
 * The hour the baseline is taken at, local to the site, as it appears in
 * Open-Meteo's `hourly.time` strings when the request sets `timezone=auto`.
 */
export const OUTSIDE_BASELINE_HOUR = "09:00";

/** The hour as it is printed next to the figure. */
export const OUTSIDE_BASELINE_LABEL = "09:00 local";

/**
 * Written to `source_detail`. It carries the hour as well as the provider
 * because `observed_at` is a newer column than the table: on a database where
 * the migration has not landed, this string is the only place the 09:00 stamp
 * survives, and it is what an export prints.
 */
export const OUTSIDE_SOURCE_DETAIL = `open-meteo ${OUTSIDE_BASELINE_LABEL}`;

/** One sentence, used verbatim everywhere the automatic figure is shown. */
export const OUTSIDE_MODELLED_NOTE =
  `Modeled ${OUTSIDE_BASELINE_LABEL} conditions for this address's grid square (Open-Meteo) — ` +
  "not a measurement taken on site.";

/* ------------------------------------------------------------------ */
/* Where an automatic figure came from                                 */
/* ------------------------------------------------------------------ */

/**
 * Since 2026-10-07 an automatic outside row can come from either of two places,
 * and they are not the same kind of evidence:
 *
 *  - Open-Meteo: a weather MODEL's value for the grid square around the
 *    address. Nobody measured it anywhere.
 *  - The National Weather Service: a MEASUREMENT, taken by a real instrument at
 *    a named station (usually an airport) some miles from the address. Real,
 *    but not here.
 *
 * The nightly job uses the second only when Open-Meteo refuses the server
 * (see outside-conditions-nws.ts). Mark: "keep what we are using; if it won't
 * work, change to anything that's free that will work."
 *
 * Which one produced a row lives in `source_detail`, the column that has
 * carried the provider since the table existed — no new column, so a database
 * that has every drying migration needs nothing more. Every surface that
 * printed OUTSIDE_MODELLED_NOTE now prints `outsideReadingNote(row)`, which is
 * that same sentence for a modelled row and a station sentence for a station
 * row. Rows written before this change say "open-meteo 09:00 local" and read
 * exactly as they always did.
 */
export type OutsideProvenance =
  | { kind: "model" }
  | {
      kind: "station";
      /** ICAO-style identifier, "KEWR". */
      stationId: string;
      stationName: string | null;
      /** Straight-line miles from the job's coordinates to the station. */
      distanceMi: number | null;
      /** Wall-clock at the site, "08:51" — the station's nearest report to 09:00. */
      localTime: string | null;
    };

const NWS_DETAIL_PREFIX = "nws ";

/**
 * `source_detail` for a station row:
 * `nws KEWR 08:51 local · 5.1 mi · Newark, Newark International Airport`.
 *
 * Human-readable on purpose — it is what a raw SQL look at the table shows —
 * and parsed back by `parseOutsideSourceDetail`. The local time is in it for
 * the same reason the Open-Meteo string carries "09:00 local": on a database
 * without `observed_at` it is the only place the hour survives.
 */
export function nwsSourceDetail(station: {
  stationId: string;
  stationName?: string | null;
  distanceMi: number;
  localTime: string;
}): string {
  const name = station.stationName?.replace(/\s+/g, " ").trim();
  return (
    `${NWS_DETAIL_PREFIX}${station.stationId} ${station.localTime} local · ` +
    `${formatMiles(station.distanceMi)} mi` +
    (name ? ` · ${name}` : "")
  );
}

/** One decimal under ten miles, whole miles beyond — the precision a reader can use. */
function formatMiles(mi: number): string {
  return mi < 10 ? (Math.round(mi * 10) / 10).toFixed(1) : String(Math.round(mi));
}

/**
 * What a row's `source_detail` says about where its figure came from.
 *
 * Anything that is not a station string — the Open-Meteo string, null, a
 * string from some future provider this file does not know yet — reads as
 * "model". That is the conservative direction: the worst a misread can do is
 * understate a measurement, never promote a model value to one.
 */
export function parseOutsideSourceDetail(detail: string | null | undefined): OutsideProvenance {
  if (!detail || !detail.startsWith(NWS_DETAIL_PREFIX)) return { kind: "model" };
  const m = detail.match(/^nws (\S+)(?: (\d{2}:\d{2}) local)?(?: · ([\d.]+) mi)?(?: · (.+))?$/);
  if (!m) return { kind: "model" };
  const distance = m[3] == null ? null : Number(m[3]);
  return {
    kind: "station",
    stationId: m[1]!,
    localTime: m[2] ?? null,
    distanceMi: distance != null && Number.isFinite(distance) ? distance : null,
    stationName: m[4]?.trim() || null,
  };
}

type ProvenanceRow = { source?: string | null; source_detail?: string | null };

/** True for an automatic outside row that a weather-station instrument measured. */
export function isStationReading(r: ProvenanceRow): boolean {
  return r.source === "weather" && parseOutsideSourceDetail(r.source_detail).kind === "station";
}

/**
 * The one sentence printed beside an automatic outside figure — the drying
 * log, the workbook and the drying report PDF all call this, so a station
 * reading cannot be described one way on screen and another way to a carrier.
 *
 * A station sentence names the station and how far away it is, because that
 * distance is exactly what an adjuster will weigh: a measurement five miles
 * off is still not a measurement at the address, and the sentence says so.
 */
export function outsideReadingNote(r: ProvenanceRow): string {
  const p = parseOutsideSourceDetail(r.source_detail);
  if (p.kind === "model") return OUTSIDE_MODELLED_NOTE;
  const where = p.stationName ? `${p.stationId} (${p.stationName})` : p.stationId;
  const when = p.localTime ? `at ${p.localTime} local` : "nearest to 09:00 local";
  const far =
    p.distanceMi == null
      ? ""
      : `, ${formatMiles(p.distanceMi)} ${p.distanceMi === 1 ? "mile" : "miles"} from this address`;
  return (
    `Measured ${when} by National Weather Service station ${where}${far} — ` +
    "not a measurement taken on site."
  );
}

/**
 * The short source label printed in a report's row or cell beside an
 * automatic outside figure: "Modelled (Open-Meteo)" or "NWS KEWR, 3.8 mi".
 *
 * Mark, 13 Oct: the drying report repeated the full sentence (outsideReadingNote)
 * on every outside row and again above the table, and he wanted the sentences
 * gone. The report goes to carriers, so the SOURCE stays on every row — a
 * modelled or distant-station figure is never left looking like a crew
 * measurement — just in a few words. ASCII only: the PDF's standard fonts.
 */
export function outsideReadingLabel(r: ProvenanceRow): string {
  const p = parseOutsideSourceDetail(r.source_detail);
  if (p.kind === "model") return "Modeled (Open-Meteo)";
  return p.distanceMi == null
    ? `NWS ${p.stationId}`
    : `NWS ${p.stationId}, ${formatMiles(p.distanceMi)} mi`;
}

/**
 * Every distinct note among a set of rows' automatic figures, the model's
 * first, for a footer or summary that speaks for the whole log at once. Empty
 * when no row is automatic.
 */
export function outsideReadingNotes(rows: readonly ProvenanceRow[]): string[] {
  const notes = new Set<string>();
  const auto = rows.filter((r) => r.source === "weather");
  if (auto.some((r) => !isStationReading(r))) notes.add(OUTSIDE_MODELLED_NOTE);
  for (const r of auto) if (isStationReading(r)) notes.add(outsideReadingNote(r));
  return [...notes];
}

export type OutsideObservation = {
  /** Local calendar date, `YYYY-MM-DD`. */
  date: string;
  /**
   * The instant the figure is for: the 09:00 local hour for a model value, the
   * station's actual report time (nearest 09:00) for a measurement.
   */
  observedAt: string;
  tempF: number;
  rh: number;
  /**
   * Provenance for `source_detail`. Absent means Open-Meteo, which is every
   * observation `parseOutsideObservations` produces — the browser path never
   * sets it.
   */
  sourceDetail?: string;
};

type OpenMeteoPayload = {
  utc_offset_seconds?: number;
  hourly?: {
    time?: string[];
    temperature_2m?: (number | null)[];
    relative_humidity_2m?: (number | null)[];
  };
};

/**
 * The request for one site.
 *
 * `apiKey` is for the SERVER path only and is never passed from the browser.
 * Open-Meteo's free endpoint counts calls per IP address, and the nightly hook
 * runs on a Cloudflare Worker whose outbound address is shared with every
 * other tenant on it — so the free quota it draws on is not ours to spend. A
 * paid key moves the call to `customer-api.open-meteo.com`, with a quota that
 * belongs to the key rather than the address. Identical parameters and
 * response otherwise. The URL therefore carries a credential whenever a key is
 * set, and is never logged or returned — see `OutsideProviderError`, which
 * deliberately does not keep it.
 */
export function outsideConditionsUrl(
  lat: number,
  lon: number,
  pastDays = OUTSIDE_PAST_DAYS,
  apiKey?: string | null,
) {
  // timezone=auto makes `hourly.time` local wall-clock at the site, so the
  // 09:00 hour can be picked by string rather than by an offset computed here.
  const host = apiKey ? "https://customer-api.open-meteo.com" : "https://api.open-meteo.com";
  return (
    `${host}/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&hourly=temperature_2m,relative_humidity_2m&temperature_unit=fahrenheit` +
    `&past_days=${pastDays}&forecast_days=1&timezone=auto` +
    (apiKey ? `&apikey=${encodeURIComponent(apiKey)}` : "")
  );
}

/**
 * The 09:00 local observation for every day in the response, backfill included.
 *
 * Each day is selected independently by its own `T09:00` stamp, so a run that
 * backfills a missed week gets seven 09:00 values rather than a mix of hours.
 * A day whose 09:00 is missing from the provider's series, or whose 09:00 has
 * not happened yet at the site, yields nothing at all: a substituted 06:00 is a
 * number nobody can defend, and a missing day is visible in the log as a gap.
 */
export function parseOutsideObservations(
  payload: OpenMeteoPayload | undefined,
  now: Date = new Date(),
): OutsideObservation[] {
  const hourly = payload?.hourly;
  const offsetMs = (payload?.utc_offset_seconds ?? 0) * 1000;
  const times = hourly?.time ?? [];
  const out: OutsideObservation[] = [];

  for (let i = 0; i < times.length; i += 1) {
    const stamp = times[i]!;
    if (!stamp.endsWith(`T${OUTSIDE_BASELINE_HOUR}`)) continue;

    const tempF = hourly?.temperature_2m?.[i];
    const rh = hourly?.relative_humidity_2m?.[i];
    // A humidity of 0 is not a reading; it is a hole in the provider's data.
    if (typeof tempF !== "number" || typeof rh !== "number" || rh <= 0 || rh > 100) continue;

    // Local wall-clock back to an instant. Never Date.parse on the bare string:
    // an offsetless stamp is read as UTC in a Worker and as the server's own
    // timezone in a browser.
    const observedMs = Date.parse(`${stamp}:00Z`) - offsetMs;
    if (!Number.isFinite(observedMs)) continue;
    // Today's 09:00 before 09:00 is a forecast of an hour that has not
    // happened. The log records what the weather was, not what it will be.
    if (observedMs > now.getTime()) continue;

    out.push({
      date: stamp.slice(0, 10),
      observedAt: new Date(observedMs).toISOString(),
      tempF,
      rh,
    });
  }
  return out;
}

/**
 * Why Open-Meteo did not answer with data — kept, rather than thrown away.
 *
 * Until 2026-10-05 a failed fetch threw `Open-Meteo returned 429` at best, and
 * the nightly hook caught it as a bare `failed_fetches += 1`. The live
 * database then showed `{"ok":true,…,"failed_fetches":2}` every morning for a
 * month with no reason attached, while the same request from the drying log
 * button worked — and the only way to tell the difference between "the
 * provider is refusing this server" and "the provider is down" was to guess.
 * So the status and the provider's own `reason` travel with the error.
 *
 * Deliberately NOT kept: the request URL. It carries the site's coordinates —
 * an address, near enough — and, on the server path, the API key.
 */
export class OutsideProviderError extends Error {
  readonly status: number | null;
  readonly reason: string;
  constructor(status: number | null, reason: string) {
    super(
      status == null
        ? `Open-Meteo could not be reached: ${reason}`
        : `Open-Meteo returned ${status}${reason ? `: ${reason}` : ""}`,
    );
    this.name = "OutsideProviderError";
    this.status = status;
    this.reason = reason;
  }
}

/** Long enough for any reason Open-Meteo gives; short enough for a cron log. */
const REASON_MAX = 200;

/**
 * Open-Meteo's error body is `{"error":true,"reason":"…"}`. Anything else — an
 * HTML page from a proxy, an empty body — is kept as its first line of text.
 */
export function providerReason(body: string): string {
  let reason = "";
  try {
    const parsed = JSON.parse(body) as { reason?: unknown };
    if (typeof parsed?.reason === "string") reason = parsed.reason;
  } catch {
    // not JSON; fall through to the raw text
  }
  if (!reason)
    reason = body
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  return reason.length > REASON_MAX ? `${reason.slice(0, REASON_MAX - 1)}…` : reason;
}

/** Throws on a network error or a non-2xx, so a failure can never read as "no data". */
export async function fetchOutsideConditions(
  lat: number,
  lon: number,
  opts?: { pastDays?: number; now?: Date; apiKey?: string | null; timeoutMs?: number },
): Promise<OutsideObservation[]> {
  let response: Response;
  try {
    // The nightly hook sets a timeout so a hung answer still leaves time for
    // its fallback; the browser path has never needed one and does not pass it.
    const signal =
      opts?.timeoutMs != null && typeof AbortSignal.timeout === "function"
        ? AbortSignal.timeout(opts.timeoutMs)
        : undefined;
    const url = outsideConditionsUrl(lat, lon, opts?.pastDays, opts?.apiKey);
    response = await (signal ? fetch(url, { signal }) : fetch(url));
  } catch (error) {
    throw new OutsideProviderError(
      null,
      providerReason(error instanceof Error ? error.message : String(error)),
    );
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new OutsideProviderError(response.status, providerReason(body));
  }
  const payload = (await response.json()) as OpenMeteoPayload;
  return parseOutsideObservations(payload, opts?.now);
}

export type OutsideFetchFailureDetail = {
  job_id: string;
  /** HTTP status, or null when the request never got an answer. */
  status: number | null;
  reason: string;
};

/** What the nightly hook records about one site whose fetch failed. */
export function summarizeProviderFailure(jobId: string, error: unknown): OutsideFetchFailureDetail {
  if (error instanceof OutsideProviderError) {
    return { job_id: jobId, status: error.status, reason: error.reason };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { job_id: jobId, status: null, reason: providerReason(message) };
}

/**
 * One sentence for whoever reads the hook's response in `net._http_response`,
 * when the failures share a cause worth naming.
 *
 * Every failure a 429 is the signature of the per-IP limit being spent by
 * somebody else on a shared outbound address: the same request from a browser
 * succeeds, retrying from the server does not, and only a key (or a different
 * address) fixes it.
 */
export function providerFailureHint(failures: OutsideFetchFailureDetail[]): string | null {
  if (failures.length === 0) return null;
  if (failures.every((f) => f.status === 429)) {
    return (
      "Every fetch was refused with 429. Open-Meteo's free tier is limited per IP address and this " +
      "server's outbound address is shared, so the quota is being spent by other tenants. Set " +
      "OPEN_METEO_API_KEY (a paid Open-Meteo key) on the app, or rely on the drying log filling " +
      "itself from the browser."
    );
  }
  if (failures.every((f) => f.status == null)) {
    return "Open-Meteo could not be reached at all from this server — a network or DNS failure.";
  }
  return null;
}

/**
 * The row an observation becomes.
 *
 * `captured_at` is the observation instant rather than the moment of the fetch:
 * on a crew row it means when the reading was taken, and a machine row that
 * claimed 3am — when the scheduler ran — would be lying in the same field.
 * `observed_at` states it unambiguously for anything that reads the row later.
 */
export function outsideReadingRow(jobId: string, obs: OutsideObservation): Record<string, unknown> {
  const { dewPointF, gpp } = derive(obs.tempF, obs.rh);
  return {
    job_id: jobId,
    point: "exterior",
    source: "weather",
    source_detail: obs.sourceDetail ?? OUTSIDE_SOURCE_DETAIL,
    reading_date: obs.date,
    observed_at: obs.observedAt,
    captured_at: obs.observedAt,
    temperature_f: Math.round(obs.tempF * 10) / 10,
    relative_humidity: Math.round(obs.rh * 10) / 10,
    dew_point_f: dewPointF,
    grains_per_pound: gpp,
    // No created_by: nobody took this reading, and pretending a person did is
    // exactly the claim the source column exists to keep the log honest about.
    created_by: null,
  };
}

/**
 * The same rows for a database that has not had the observed_at migration
 * applied. The hour still survives in source_detail, so the write degrades to a
 * less precise stamp rather than to no baseline at all.
 */
export function withoutObservedAt(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map(({ observed_at: _observedAt, ...rest }) => rest);
}

/* ------------------------------------------------------------------ */
/* Why a fetch produced nothing                                        */
/* ------------------------------------------------------------------ */

/**
 * The migration that lets an automatic exterior row exist at all. Named in the
 * message rather than described, because the person who has to act on it is
 * looking for a file to apply, not a paragraph to interpret.
 */
export const OUTSIDE_POLICY_MIGRATION = "20260902190000_drying_outside_conditions";

/**
 * What went wrong when the outside baseline could not be filled.
 *
 *  - `provider`  Open-Meteo could not be reached, or answered badly. Retrying
 *                is the right move and the crew can type the reading instead.
 *  - `blocked`   The database will not accept the row. Retrying will never
 *                help; somebody has to apply a migration.
 *
 * The two are kept apart because they need opposite things from whoever is
 * looking at the screen, and because a setup problem shown as "the weather
 * service did not answer" is a technician tapping a button all week.
 */
export type OutsideFetchFailure = {
  kind: "provider" | "blocked";
  /** One sentence, shown verbatim. Says what was NOT written, not just what failed. */
  message: string;
};

/**
 * A row-level-security refusal, which is what a database missing
 * `20260902190000` answers with.
 *
 * The automatic figure is written with `created_by = null` on purpose — nobody
 * took it — and the insert policy that shipped with the table pins `created_by`
 * to `auth.uid()`. `20260902190000` adds the second policy that admits a
 * `source = 'weather'` row with no author. Without it every automatic write,
 * from the nightly job and from the button alike, is refused with 42501.
 *
 * Matched on the SQLSTATE first and the sentence second, because PostgREST
 * relays the message but not always the code.
 */
function isPolicyRefusal(error: unknown): boolean {
  const e = error as { code?: string; message?: string } | null;
  if (e?.code === "42501") return true;
  return /row-level security|violates .*policy/i.test(errorMessage(error));
}

/**
 * Turn whatever the write threw into something a person can act on.
 *
 * Pure, and separate from the component, so the sentence a technician reads in
 * a basement is the same one the tests pin — the failure text IS the fix
 * instruction here, and a wrong one costs a day of unrecorded drying.
 */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  const m = (error as { message?: unknown } | null)?.message;
  return typeof m === "string" ? m : "";
}

export function describeOutsideFetchFailure(error: unknown): OutsideFetchFailure {
  if (isPolicyRefusal(error)) {
    return {
      kind: "blocked",
      message:
        "This database refuses automatic outside readings, so nothing was written — this is not a " +
        `reading of zero. The migration that permits them (${OUTSIDE_POLICY_MIGRATION}) has not ` +
        "been applied. Until it is, enter the outside reading by hand.",
    };
  }
  // A PostgREST failure arrives as a plain object, not an Error, so the
  // message has to be read off the shape rather than stringified — String({})
  // is "[object Object]", which would send a missing table down the "retry the
  // weather service" path forever.
  const message = errorMessage(error);
  if (isMissingSchema(error)) {
    return {
      kind: "blocked",
      message:
        "The drying log table is not in this database yet, so nothing was written. The outside " +
        "baseline starts filling once the drying migrations are applied.",
    };
  }
  return {
    kind: "provider",
    message:
      `The outside conditions could not be fetched (${message || "the weather service did not answer"}). ` +
      "Nothing was recorded — this is not a reading of zero. Try again, or enter it by hand.",
  };
}
