import { createFileRoute } from "@tanstack/react-router";

import { denyUnlessCron } from "@/lib/cron-auth";
import { jobsPickedUp } from "@/lib/drying-pickup";

/**
 * The exterior half of the drying log, taken automatically.
 *
 * A psychrometric log is argued against the outside air: the crew's readings
 * are the evidence, and the exterior conditions are the baseline that makes
 * them mean something. Nobody should have to remember to take that baseline,
 * and it is the one point on the job that a machine can read as well as a
 * person can. So this writes one `source = 'weather'` row per drying job per
 * day and leaves every other point to the crew.
 *
 * The provider call, the 09:00 local selection and the row shape all live in
 * src/lib/outside-conditions.ts, shared with the "Fetch outside conditions"
 * button on the job's drying log. One implementation, so the scheduled run and
 * the on-demand tap cannot drift into producing different numbers.
 *
 * Self-healing: each call asks for the past week, so a run that was missed —
 * or a job that started drying five days ago — is backfilled rather than
 * leaving a permanent hole in the record. Only dates with no exterior row yet
 * are written, because PostgREST cannot name a PARTIAL unique index as an
 * ON CONFLICT arbiter (42P10, the bug that silently stopped the cadence sweep).
 *
 * Auth: the `x-cron-secret` shared secret, compared in constant time by
 * denyUnlessCron (src/lib/cron-auth.ts). It fails closed when CRON_SECRET
 * is unset. The publishable key this once accepted is not a secret.
 * Schedule it once a day, after 09:00 local.
 *
 * WHY THIS HAS NEVER WRITTEN A ROW (found 2026-10-05, from the live database)
 * The job runs and authenticates: `net._http_response` holds a 200 for the
 * 13:20 UTC run with `"failed_fetches":2` — every site's Open-Meteo call
 * failed. Every one of the 23 drying readings on file is a burst written by
 * somebody tapping Fetch outside in the browser, never one row a day at 13:20.
 * Same URL, same function (`fetchOutsideConditions`), same parameters; the
 * only difference between the path that works and the path that never has is
 * WHERE the request leaves from. The browser calls from the user's own
 * address. This hook calls from a Cloudflare Worker, whose outbound address is
 * shared with every other tenant on it, and Open-Meteo's free tier is limited
 * per IP — it answers "Daily API request limit exceeded" to a shared address
 * whose quota other people spent (open-meteo/open-meteo discussion #853).
 *
 * That is the leading explanation and it fits every fact on file, but the
 * hook used to throw the reason away, so it is not yet PROVEN. It now keeps
 * it: each failure is returned with its HTTP status and Open-Meteo's own
 * reason, logged, and a run in which every fetch failed answers 502 instead
 * of a 200 that read as success for a month. The first run after this ships
 * settles it.
 *
 * The fix that does not depend on this server: the drying log now fills its
 * own missing days when it is opened (job-drying-log.tsx), from the browser,
 * which is the path that has always worked. The fix for this hook is
 * OPEN_METEO_API_KEY — a paid key, whose quota is the key's and not the
 * address's. It is also the honest one: Open-Meteo's free tier is for
 * non-commercial use, and a restoration company's CRM is not that.
 *
 * PROVEN, AND ROUTED AROUND (2026-10-07)
 * The first runs after the reason was kept settled it: every fetch answered
 * 429 "Daily API request limit exceeded". Mark: "keep what we are using; if it
 * won't work, change to anything that's free that will work." No paid key, so
 * Open-Meteo stays first and, when it refuses this server, the job's figure
 * comes from the nearest National Weather Service station instead — free, no
 * key, not counted per address. Labelled as a station measurement, never as
 * the model. The decisions live in outside-conditions-nightly.server.ts; the
 * NWS client in outside-conditions-nws.server.ts. The run answers 200 when
 * every job got a baseline from either source and 502 when any job got none.
 */

import { isMissingSchema } from "@/lib/schema-fallback";
import { OUTSIDE_PAST_DAYS, outsideReadingRow, withoutObservedAt } from "@/lib/outside-conditions";
import type { JobOutsideOutcome, OutsideSourceKey } from "@/lib/outside-conditions-nightly.server";
import type { NwsSite } from "@/lib/outside-conditions-nws.server";

/** Jobs per batch. Keeps one run well inside a Worker's CPU budget. */
const BATCH = 10;

/** Cap per run, so a database full of old jobs cannot make this unbounded. */
const MAX_JOBS = 200;

export const Route = createFileRoute("/api/public/hooks/drying-weather")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const denied = denyUnlessCron(request);
        if (denied) return denied;

        /* After the credential check, never before: a database round trip per
           anonymous request would be the amplification the limiter exists to
           stop. Volumetric floods belong to Cloudflare WAF. */
        const { throttleWebhook } = await import("@/lib/rate-limit.server");
        const throttled = await throttleWebhook(request, "drying-weather", true);
        if (throttled) return throttled;

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        // Server modules load inside the handler, like every other hook's, so
        // nothing of them can reach a client bundle through this route file.
        const { fetchJobOutside, summarizeNightlyRun } =
          await import("@/lib/outside-conditions-nightly.server");

        const since = new Date(Date.now() - OUTSIDE_PAST_DAYS * 86_400_000)
          .toISOString()
          .slice(0, 10);

        // "Actively drying" is equipment still on site, or a crew reading in
        // the backfill window. Either is a job whose exterior baseline is
        // worth money; a closed job's is not.
        const { data: placed, error: placedError } = await supabaseAdmin
          .from("equipment_placements")
          .select("job_id")
          .is("retrieved_at", null);
        if (placedError) return Response.json({ error: placedError.message }, { status: 500 });

        const jobIds = new Set(
          (placed ?? []).map((p) => p.job_id).filter((id): id is string => Boolean(id)),
        );

        const { data: recent, error: recentError } = await supabaseAdmin
          .from("job_drying_readings")
          .select("job_id, reading_date, source, point")
          .gte("reading_date", since);
        if (recentError) {
          // The migration has not been applied yet. That is a deployment state,
          // not a failure the cron scheduler should retry all night.
          if (isMissingSchema(recentError)) {
            return Response.json(
              { ok: true, skipped: "job_drying_readings does not exist yet" },
              { status: 200 },
            );
          }
          return Response.json({ error: recentError.message }, { status: 500 });
        }

        /** job_id → dates whose exterior baseline is already settled, either way. */
        const haveExterior = new Map<string, Set<string>>();
        const claim = (jobId: string, date: string) => {
          const set = haveExterior.get(jobId) ?? new Set<string>();
          set.add(date);
          haveExterior.set(jobId, set);
        };
        for (const r of recent ?? []) {
          if (!r.job_id) continue;
          if (r.source === "weather") {
            claim(r.job_id, r.reading_date);
          } else {
            jobIds.add(r.job_id);
            // A crew stood outside with a meter that day. Their number is the
            // evidence; a grid model must not be written alongside it.
            if (r.point === "exterior") claim(r.job_id, r.reading_date);
          }
        }

        /*
         * A job whose equipment has all been picked up is finished drying
         * (David, 27 Oct): no more automatic outside readings against it,
         * even if a crew reading falls in the backfill window.
         */
        if (jobIds.size > 0) {
          const { data: all, error: allError } = await supabaseAdmin
            .from("equipment_placements")
            .select("job_id, retrieved_at")
            .in("job_id", [...jobIds]);
          if (allError) return Response.json({ error: allError.message }, { status: 500 });
          for (const id of jobsPickedUp(all ?? [])) jobIds.delete(id);
        }

        if (jobIds.size === 0) return Response.json({ ok: true, jobs: 0, readings_written: 0 });

        const { data: jobs, error: jobsError } = await supabaseAdmin
          .from("jobs")
          .select("id, lat, lon")
          .in("id", [...jobIds].slice(0, MAX_JOBS));
        if (jobsError) return Response.json({ error: jobsError.message }, { status: 500 });

        const located = (jobs ?? []).filter(
          (j): j is { id: string; lat: number; lon: number } => j.lat != null && j.lon != null,
        );

        const rows: Record<string, unknown>[] = [];
        const rowsBySource: Record<OutsideSourceKey, number> = { open_meteo: 0, nws: 0 };
        const outcomes: JobOutsideOutcome[] = [];
        // Server-side only, never sent to the browser. Unset means the free
        // endpoint — see the header for why that is unlikely to work here.
        const apiKey = (process.env.OPEN_METEO_API_KEY ?? "").trim() || null;
        // One NWS site lookup per coordinate pair per run, shared across jobs.
        const nwsCache = new Map<string, Promise<NwsSite>>();
        const now = new Date();

        for (let i = 0; i < located.length; i += BATCH) {
          const chunk = located.slice(i, i + BATCH);
          await Promise.all(
            chunk.map(async (job) => {
              const settled = haveExterior.get(job.id) ?? new Set<string>();
              // Open-Meteo, then the NWS when Open-Meteo refuses this server.
              // A failure keeps the job id, each provider's status and reason
              // — never the URL, which carries the coordinates and the key.
              const outcome = await fetchJobOutside(job, { now, apiKey, settled, nwsCache });
              outcomes.push(outcome);
              if (outcome.source === null) {
                console.error(
                  `drying-weather: job ${outcome.jobId} has no outside reading`,
                  outcome.code,
                  outcome.openMeteo.status ?? "no response",
                  outcome.openMeteo.reason,
                  outcome.nws?.reason ?? "",
                );
                return;
              }
              for (const obs of outcome.observations) {
                if (obs.date < since || settled.has(obs.date)) continue;
                rows.push(outsideReadingRow(job.id, obs));
                rowsBySource[outcome.source] += 1;
              }
            }),
          );
        }

        let written = 0;
        if (rows.length > 0) {
          const insert = (r: Record<string, unknown>[]) =>
            supabaseAdmin
              .from("job_drying_readings")
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              .insert(r as any)
              .select("id");
          let { data: inserted, error } = await insert(rows);
          if (error && isMissingSchema(error)) {
            // observed_at ships in a later migration than the table; the hour
            // still survives in source_detail. A less precise stamp beats no
            // exterior baseline at all.
            ({ data: inserted, error } = await insert(withoutObservedAt(rows)));
          }
          if (error) return Response.json({ error: error.message }, { status: 500 });
          written = inserted?.length ?? 0;
        }

        // 200 when every job got its baseline from one source or the other;
        // 502 when any job got none. See outside-conditions-nightly.server.ts.
        const { status, body } = summarizeNightlyRun({
          outcomes,
          jobsWithoutCoordinates: (jobs ?? []).length - located.length,
          written,
          rowsBySource,
          keyed: apiKey != null,
        });
        return Response.json(body, { status });
      },
    },
  },
});
