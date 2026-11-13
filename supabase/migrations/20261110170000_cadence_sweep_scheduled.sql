-- The nightly cadence sweep, scheduled at last.
--
-- 20260903200000 left `cadence-sweep` unscheduled on purpose: its upsert
-- named a partial unique index as the ON CONFLICT arbiter and failed with
-- 42P10, so scheduling it would have scheduled an error. The hook has since
-- been rewritten to read the period's keys first and insert only the fresh
-- ones (see src/routes/api/public/hooks/cadence-sweep.ts), which closes that.
--
-- Two things depend on it running every night:
--
--   * Melly's rule that "the system automatically creates a follow up task
--     dated ninety days from the last real touchpoint, and a meeting task
--     dated three hundred sixty five days from the last in person visit."
--     The sweep is the only thing that creates those.
--   * The Critical workflow (20261110160000): the sweep is what opens an
--     episode the night a client's band turns Critical, closes it when the
--     client answers, and reminds the managers of a day-30 decision.
--
-- Same shape as every other hook kick: app_hook_url() for the address (an
-- override in app_settings.cadence_sweep.hook_url wins, service-only), the
-- cron secret in the header, a 60-second timeout. 11:30 UTC is 06:30 New
-- York, before anyone's day starts.

CREATE OR REPLACE FUNCTION public.cadence_sweep_kick()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  cfg jsonb;
  hook_url text;
BEGIN
  SELECT value INTO cfg FROM public.app_settings WHERE key = 'cadence_sweep';
  IF COALESCE((cfg->>'enabled')::boolean, true) IS FALSE THEN
    RETURN;
  END IF;
  hook_url := public.app_hook_url('cadence-sweep', cfg->>'hook_url');
  PERFORM net.http_post(
    url := hook_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', public.cron_secret()),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
END;
$$;

REVOKE ALL ON FUNCTION public.cadence_sweep_kick() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cadence_sweep_kick() TO service_role;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron is not installed; cadence-sweep not scheduled.';
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cadence-sweep') THEN
    PERFORM cron.unschedule('cadence-sweep');
  END IF;

  PERFORM cron.schedule(
    'cadence-sweep',
    '30 11 * * *',
    $cron$SELECT public.cadence_sweep_kick();$cron$
  );
END
$do$;
