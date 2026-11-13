/**
 * The nightly hook's decisions, kept out of the route so they can be tested
 * with a mocked fetch: which source each job's outside baseline comes from,
 * and what the run reports about itself.
 *
 * Per job: Open-Meteo first — it is what the browser uses, so a job filled at
 * night and a job filled by a technician opening the log read the same model.
 * When Open-Meteo refuses the SERVER (429 from the shared outbound address, a
 * 5xx, a timeout, no answer), the National Weather Service's nearest station
 * (outside-conditions-nws.server.ts). Any other refusal — a 400 for bad
 * coordinates — is not something a second provider fixes, and is reported.
 *
 * The run's status tells the truth in both directions. It answered 200 for a
 * month while every fetch failed; then 502 every night, correctly, because
 * every fetch did. Now: 200 when every job got its baseline from one source or
 * the other, 502 when any job got none — so a 502 in `net._http_response`
 * always means a job's outside figures are missing, and a 200 never hides one.
 */

import {
  OUTSIDE_PAST_DAYS,
  OutsideProviderError,
  fetchOutsideConditions,
  providerFailureHint,
  summarizeProviderFailure,
  type OutsideFetchFailureDetail,
  type OutsideObservation,
} from "@/lib/outside-conditions";
import {
  NwsError,
  fetchNwsOutsideConditions,
  type NwsMissingDay,
  type NwsSite,
} from "@/lib/outside-conditions-nws.server";

/** Open-Meteo's own wait, per job. The fallback needs time left in the run. */
export const OPEN_METEO_TIMEOUT_MS = 10_000;

export type OutsideSourceKey = "open_meteo" | "nws";

export type JobOutsideOutcome =
  | { jobId: string; source: "open_meteo"; observations: OutsideObservation[] }
  | {
      jobId: string;
      source: "nws";
      observations: OutsideObservation[];
      /** Why Open-Meteo was not used. */
      openMeteo: OutsideFetchFailureDetail;
      /** Days the station had nothing usable for. */
      missing: NwsMissingDay[];
    }
  | {
      jobId: string;
      source: null;
      openMeteo: OutsideFetchFailureDetail;
      /** Null when the NWS was not tried (Open-Meteo's refusal was not one it could fix). */
      nws: { code: string; status: number | null; reason: string } | null;
      /** Short and stable, for counting: `open_meteo_http_400`, `nws_http_404`, … */
      code: string;
    };

/**
 * A refusal another provider can route around: the per-address quota (429),
 * the provider being down (5xx), or no answer at all (network, timeout).
 */
export function openMeteoShouldFallBack(error: unknown): boolean {
  if (!(error instanceof OutsideProviderError)) return true;
  return error.status == null || error.status === 429 || error.status >= 500;
}

/** One job's outside baseline for the night, from whichever source answered. */
export async function fetchJobOutside(
  job: { id: string; lat: number; lon: number },
  opts: {
    now: Date;
    apiKey: string | null;
    /** Dates that already have an exterior row — not asked of the NWS again. */
    settled: ReadonlySet<string>;
    nwsCache: Map<string, Promise<NwsSite>>;
    openMeteoTimeoutMs?: number;
    nwsTimeoutMs?: number;
  },
): Promise<JobOutsideOutcome> {
  let openMeteoError: unknown;
  try {
    const observations = await fetchOutsideConditions(job.lat, job.lon, {
      apiKey: opts.apiKey,
      now: opts.now,
      timeoutMs: opts.openMeteoTimeoutMs ?? OPEN_METEO_TIMEOUT_MS,
    });
    return { jobId: job.id, source: "open_meteo", observations };
  } catch (error) {
    openMeteoError = error;
  }

  const openMeteo = summarizeProviderFailure(job.id, openMeteoError);
  if (!openMeteoShouldFallBack(openMeteoError)) {
    return {
      jobId: job.id,
      source: null,
      openMeteo,
      nws: null,
      code: `open_meteo_http_${openMeteo.status ?? "error"}`,
    };
  }

  try {
    const nws = await fetchNwsOutsideConditions(job.lat, job.lon, {
      now: opts.now,
      pastDays: OUTSIDE_PAST_DAYS,
      skipDates: opts.settled,
      cache: opts.nwsCache,
      timeoutMs: opts.nwsTimeoutMs,
    });
    // Some days measured is a job with a baseline; the quiet mornings are
    // counted separately. Every wanted day empty is a job with none.
    if (nws.wanted > 0 && nws.observations.length === 0) {
      return {
        jobId: job.id,
        source: null,
        openMeteo,
        nws: { code: "nws_no_observation", status: null, reason: nws.missing[0]?.reason ?? "" },
        code: "nws_no_observation",
      };
    }
    return {
      jobId: job.id,
      source: "nws",
      observations: nws.observations,
      openMeteo,
      missing: nws.missing,
    };
  } catch (error) {
    const e =
      error instanceof NwsError
        ? error
        : new NwsError(
            "nws_unreachable",
            null,
            error instanceof Error ? error.message : String(error),
          );
    return {
      jobId: job.id,
      source: null,
      openMeteo,
      nws: { code: e.code, status: e.status, reason: e.reason },
      code: e.code,
    };
  }
}

/** Failures returned per run. Enough to diagnose; never a 200-row response. */
export const MAX_REPORTED_FAILURES = 20;

function bump(counts: Record<string, number>, key: string, by = 1) {
  counts[key] = (counts[key] ?? 0) + by;
}

/**
 * What the hook answers, and with which status.
 *
 * `rowsBySource` is what was queued for insert per source — the hook either
 * inserts them all or answers 500 — so the per-source reading counts add up
 * to `readings_written` on any run that got this far.
 */
export function summarizeNightlyRun(input: {
  outcomes: readonly JobOutsideOutcome[];
  jobsWithoutCoordinates: number;
  written: number;
  rowsBySource: Readonly<Record<OutsideSourceKey, number>>;
  keyed: boolean;
}): { status: 200 | 502; body: Record<string, unknown> } {
  const { outcomes } = input;
  const jobsBySource: Record<OutsideSourceKey, number> = { open_meteo: 0, nws: 0 };
  const openMeteoRefusals: Record<string, number> = {};
  const failureReasons: Record<string, number> = {};
  const openMeteoFailures: OutsideFetchFailureDetail[] = [];
  const failed: Extract<JobOutsideOutcome, { source: null }>[] = [];
  let nwsDaysMissing = 0;

  for (const o of outcomes) {
    if (o.source === "open_meteo") {
      jobsBySource.open_meteo += 1;
      continue;
    }
    openMeteoFailures.push(o.openMeteo);
    bump(
      openMeteoRefusals,
      o.openMeteo.status == null ? "no_response" : String(o.openMeteo.status),
    );
    if (o.source === "nws") {
      jobsBySource.nws += 1;
      nwsDaysMissing += o.missing.length;
    } else {
      failed.push(o);
      bump(failureReasons, o.code);
    }
  }

  const allCovered = failed.length === 0;
  const hint =
    openMeteoFailures.length === 0
      ? null
      : allCovered
        ? "Open-Meteo refused this server" +
          (openMeteoFailures.every((f) => f.status === 429)
            ? " (429: the free quota on the shared outbound address is spent by other tenants)"
            : "") +
          "; the National Weather Service's nearest stations filled in. Those rows are labeled " +
          "as station measurements, not as the model."
        : providerFailureHint(openMeteoFailures);

  return {
    status: allCovered ? 200 : 502,
    body: {
      ok: allCovered,
      jobs: outcomes.length,
      jobs_without_coordinates: input.jobsWithoutCoordinates,
      readings_written: input.written,
      by_source: {
        open_meteo: { jobs: jobsBySource.open_meteo, readings: input.rowsBySource.open_meteo },
        nws: { jobs: jobsBySource.nws, readings: input.rowsBySource.nws },
      },
      open_meteo_refusals: openMeteoRefusals,
      nws_days_without_observation: nwsDaysMissing,
      failed_jobs: failed.length,
      failure_reasons: failureReasons,
      failures: failed.slice(0, MAX_REPORTED_FAILURES).map((f) => ({
        job_id: f.jobId,
        code: f.code,
        open_meteo: { status: f.openMeteo.status, reason: f.openMeteo.reason },
        nws: f.nws,
      })),
      hint,
      keyed: input.keyed,
    },
  };
}
