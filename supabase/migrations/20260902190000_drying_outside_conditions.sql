-- The automatic exterior baseline: schedule it, stamp it, and stop an
-- automatic figure from ever standing over a crew's.
--
-- SUPERSEDED IN PART: section 3's drying_weather_kick() still sends the old
-- `apikey` header, which the hook no longer accepts. 20260903200000 redefines
-- it with `x-cron-secret` and schedules the same job. If this file is applied,
-- apply 20260903200000 after it so the newer body wins. Sections 1-2 stand.
--
-- NOT YET APPLIED. Re-runnable end to end -- every statement is IF NOT EXISTS,
-- DROP-then-CREATE, or guarded -- so it can be applied, re-applied, and applied
-- again after a Lovable migration lands on top of it.
--
-- EXTENSIONS THIS NEEDS: pg_cron and pg_net, both in the `extensions` schema
-- on Supabase. Section 3 is skipped entirely if pg_cron is absent, so the rest
-- of the file still applies; enabling them is a decision for the client, not
-- something this file makes on their behalf.
--
-- BACKGROUND ON WHAT IS ACTUALLY IN THE DATABASE
-- 20260901120000_drying_log.sql was written but never applied: the live table
-- is the one from 20260902172552, which has no `updated_at`, no `is_demo`, and
-- crucially NO UNIQUE INDEX on the daily weather row. Confirmed against the
-- live schema -- selecting updated_at returns 42703. So sections 1 and 2 below
-- are not belt-and-braces; without them a cron job running twice writes the
-- same modelled reading twice.

-- ---------------------------------------------------------------------------
-- 1. observed_at -- WHEN the conditions were observed, not when they were saved.
--
-- The automatic baseline is the 09:00 LOCAL observation at the site. A drying
-- log is read day over day, so outside at noon on Monday against outside at 4pm
-- on Tuesday compares weather, not progress: the hour has to be fixed and it
-- has to be visible. 09:00 is when crews arrive, which puts the baseline next
-- to the hand readings taken on the same visit.
--
-- `reading_date` carries only a date and `captured_at` means "when this was
-- recorded", so neither can state the observation hour without lying about its
-- own meaning. Nullable, because every row written before this column existed
-- genuinely does not know -- and src/lib/outside-conditions.ts also writes the
-- hour into source_detail so the stamp survives on a database without it.
-- ---------------------------------------------------------------------------

ALTER TABLE public.job_drying_readings
  ADD COLUMN IF NOT EXISTS observed_at timestamptz;

COMMENT ON COLUMN public.job_drying_readings.observed_at IS
  'The instant the conditions existed. On automatic exterior rows this is 09:00 local at the site, which is the fixed hour the outside series is compared on. NULL where unknown.';

-- ---------------------------------------------------------------------------
-- 2. One automatic exterior row per job per day.
--
-- The fetch backfills a week on every run and can be triggered by hand from the
-- drying log, so it will ask about the same day repeatedly. The index is
-- PARTIAL on source = 'weather' on purpose: a crew may legitimately take two
-- exterior readings in a day, and constraining theirs would delete evidence.
--
-- The delete first is what makes this re-runnable on a database that already
-- collected duplicates. It only ever removes machine-written rows that
-- duplicate another machine-written row for the same job and day, keeping the
-- most recent; no crew reading can match the predicate.
-- ---------------------------------------------------------------------------

DELETE FROM public.job_drying_readings a
USING public.job_drying_readings b
WHERE a.source = 'weather'
  AND b.source = 'weather'
  AND a.job_id = b.job_id
  AND a.reading_date = b.reading_date
  AND (a.captured_at, a.id) < (b.captured_at, b.id);

CREATE UNIQUE INDEX IF NOT EXISTS job_drying_readings_daily_weather_uniq
  ON public.job_drying_readings (job_id, reading_date)
  WHERE source = 'weather';

-- A crew reading is never overwritten by an automatic one, and the index above
-- cannot express that (it deliberately does not span manual rows). The rule is
-- enforced in the writer instead -- both the cron endpoint and the on-demand
-- button skip any date that already carries a manual exterior row -- so this
-- trigger is the backstop for anything that bypasses them.
CREATE OR REPLACE FUNCTION public.drying_weather_never_overwrites_crew()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.source = 'weather' AND EXISTS (
    SELECT 1 FROM public.job_drying_readings r
    WHERE r.job_id = NEW.job_id
      AND r.reading_date = NEW.reading_date
      AND r.point = 'exterior'
      AND r.source <> 'weather'
  ) THEN
    -- Silently dropped, not raised: one job's crew reading must not fail the
    -- nightly sweep for every other job on the batch.
    RETURN NULL;
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS job_drying_readings_weather_defers ON public.job_drying_readings;
CREATE TRIGGER job_drying_readings_weather_defers
  BEFORE INSERT ON public.job_drying_readings
  FOR EACH ROW EXECUTE FUNCTION public.drying_weather_never_overwrites_crew();

-- The on-demand fetch runs as the signed-in user, and a machine row carries no
-- author -- nobody took it. The stricter of the two insert policies now on this
-- table (20260901120000's, if it is ever applied) pins created_by to auth.uid()
-- and would refuse that, so state the exception rather than leave the button
-- depending on which migration happened to win.
DROP POLICY IF EXISTS "job_drying_readings_insert_weather" ON public.job_drying_readings;
CREATE POLICY "job_drying_readings_insert_weather" ON public.job_drying_readings
  FOR INSERT TO authenticated
  WITH CHECK (
    public.can_view_job(auth.uid(), job_id)
    AND source = 'weather'
    AND created_by IS NULL
  );

-- ---------------------------------------------------------------------------
-- 3. The schedule. Nothing has ever called the endpoint, which is why the
--    Outside column is empty on every job.
--
-- 13:00 UTC is 09:00 in New York on daylight time, so the run lands just after
-- the site's 09:00 observation exists. It does not have to be exact: every run
-- asks for the past seven days and writes only the days that are missing, so a
-- late run, a missed night, and a job that started drying last Tuesday all
-- come out the same.
--
-- Guarded on pg_cron because a database without it should still get sections 1
-- and 2. cron.unschedule is guarded on the job actually existing, so this file
-- re-runs cleanly.
-- ---------------------------------------------------------------------------

-- The URL and key live in app_settings, exactly as raven and kahi do, so the
-- host can be corrected without a migration when the deployment moves -- which
-- it already has once (20260821235452 repointed raven off the lovable.app
-- host). The apikey is copied from whichever hook already has one rather than
-- hard-coded a fourth time.
--
-- On re-run the STORED value wins over the seed (note the operand order, which
-- is the reverse of raven's): an operator who fixed the host here must not have
-- it reset by applying this file again.
INSERT INTO public.app_settings (key, value)
VALUES ('drying_weather', jsonb_build_object(
  'hook_url', 'https://goldstar.falconstaging.com/api/public/hooks/drying-weather',
  'apikey', COALESCE(
    (SELECT value->>'apikey' FROM public.app_settings WHERE key = 'raven'),
    (SELECT value->>'apikey' FROM public.app_settings WHERE key = 'kahi')
  ),
  'enabled', true
))
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value || public.app_settings.value;

CREATE OR REPLACE FUNCTION public.drying_weather_kick()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE cfg jsonb; hook_url text; hook_key text;
BEGIN
  SELECT value INTO cfg FROM public.app_settings WHERE key = 'drying_weather';
  IF cfg IS NULL THEN RETURN; END IF;
  IF COALESCE((cfg->>'enabled')::boolean, true) IS FALSE THEN RETURN; END IF;
  hook_url := cfg->>'hook_url';
  hook_key := cfg->>'apikey';
  -- No key, no call. A 401 every morning in cron.job_run_details is noise that
  -- hides the runs that failed for a real reason.
  IF hook_url IS NULL OR hook_key IS NULL THEN RETURN; END IF;
  PERFORM net.http_post(
    url := hook_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'apikey', hook_key),
    body := '{}'::jsonb
  );
END; $$;

REVOKE EXECUTE ON FUNCTION public.drying_weather_kick() FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.drying_weather_kick() TO authenticated;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron is not installed; drying-outside-conditions remains unscheduled.';
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'drying-outside-conditions') THEN
    PERFORM cron.unschedule('drying-outside-conditions');
  END IF;

  PERFORM cron.schedule(
    'drying-outside-conditions',
    '20 13 * * *',
    $cron$SELECT public.drying_weather_kick();$cron$
  );
END
$do$;
