-- The automatic outside baseline: is the nightly fetch working, and if not, why.
--
-- Read-only. Paste the whole file into the Lovable Cloud SQL editor.
--
-- WHAT THIS IS FOR (rewritten 2026-10-05, after a live read)
-- The schedule, the policy and the hook's credential are all in place: the
-- `drying-outside-conditions` job runs at 13:20 UTC and the hook answers 200.
-- But every one of those 200s said `"failed_fetches":2, "readings_written":0`
-- — every site's Open-Meteo call failed — and every outside reading on file
-- was written in a burst by somebody tapping Fetch outside in the browser.
-- The hook used to discard the reason. From the PR that added this file on,
-- it keeps it, and a run in which every fetch failed answers 502.
--
-- So the questions worth asking are no longer "is it scheduled" but:
--   A. what did the last runs answer, and why did their fetches fail?
--   B. has the nightly path EVER written a reading, or only the button?
-- The plumbing checks are kept at the bottom, because a broken schedule would
-- produce the same empty strip.

-- A. The last week of hook responses, newest first. Before the fix ships the
--    body has only the counts; after it, `failures` carries each site's HTTP
--    status and Open-Meteo's own reason, and `hint` names a shared cause.
--      429 on every site   = Open-Meteo's per-IP free quota, spent by other
--                            tenants on the Worker's shared outbound address.
--                            Fix: OPEN_METEO_API_KEY on the app.
--      status null         = the provider could not be reached at all.
--      502 overall         = every fetch failed; nothing was written.
SELECT r.created AT TIME ZONE 'UTC' AS at_utc,
       r.status_code,
       (r.content::jsonb ->> 'readings_written')::int AS written,
       (r.content::jsonb ->> 'failed_fetches')::int  AS failed,
       r.content::jsonb ->  'failures'               AS failures,
       r.content::jsonb ->> 'hint'                   AS hint,
       r.content::jsonb ->> 'keyed'                  AS keyed
  FROM net._http_response r
 WHERE r.created > now() - interval '7 days'
   AND r.content LIKE '%readings_written%'
 ORDER BY r.created DESC;

-- B. Who wrote the outside readings on file. The nightly job writes one row
--    per job per day, a few minutes after 13:20 UTC; the button writes a whole
--    backfill in one burst whenever someone taps it. A job whose rows were all
--    created in the same minute was filled by hand, not by the schedule.
SELECT j.job_number,
       min(d.reading_date) AS first_day,
       max(d.reading_date) AS last_day,
       count(*)            AS rows,
       count(DISTINCT date_trunc('minute', d.created_at)) AS distinct_write_minutes,
       count(*) FILTER (
         WHERE extract(hour FROM d.created_at AT TIME ZONE 'UTC') = 13
       )                   AS written_in_the_13utc_hour
  FROM public.job_drying_readings d
  LEFT JOIN public.jobs j ON j.id = d.job_id
 WHERE d.source = 'weather'
 GROUP BY j.job_number
 ORDER BY max(d.created_at) DESC;

-- C. The plumbing, one row each. Every one of these was OK on 2026-10-05.
SELECT 'cron job drying-outside-conditions' AS piece,
       COALESCE(
         (SELECT 'OK -- ' || schedule || CASE WHEN active THEN '' ELSE ' (INACTIVE)' END
            FROM cron.job WHERE jobname = 'drying-outside-conditions'),
         'MISSING -- apply 20260903200000_cron_callers_send_secret.sql') AS state
UNION ALL
SELECT 'app_settings drying_weather',
       COALESCE(
         (SELECT CASE WHEN COALESCE((value->>'enabled')::boolean, true)
                      THEN 'OK -- posts to ' || COALESCE(value->>'hook_url', '(no hook_url!)')
                      ELSE 'DISABLED -- enabled=false' END
            FROM public.app_settings WHERE key = 'drying_weather'),
         'MISSING -- apply 20260903200000_cron_callers_send_secret.sql')
UNION ALL
SELECT 'job_drying_readings_insert_weather policy (the button needs it)',
       CASE WHEN EXISTS (
         SELECT 1 FROM pg_policies
          WHERE schemaname = 'public' AND tablename = 'job_drying_readings'
            AND policyname = 'job_drying_readings_insert_weather')
       THEN 'OK' ELSE 'MISSING -- apply 20260902190000_drying_outside_conditions.sql' END
UNION ALL
SELECT 'daily weather unique index',
       CASE WHEN EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND indexname = 'job_drying_readings_daily_weather_uniq')
       THEN 'OK' ELSE 'MISSING -- apply 20260902190000_drying_outside_conditions.sql' END;
