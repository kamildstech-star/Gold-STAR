-- Every database-side caller of /api/public/hooks/* sends the new shared secret.
--
-- WHY
-- src/lib/cron-auth.ts (denyUnlessCron) now fails closed: the cron hooks accept
-- only an `x-cron-secret` header equal to the app's CRON_SECRET, and refuse
-- everything -- including the real scheduler -- while that env var is unset.
-- The publishable `apikey` the database used to send is public, so it is no
-- longer accepted. Verified live on 2026-09-03: net._http_response holds a
-- 503 "CRON_SECRET is not configured on this server." for every tick of
-- run-automations-15min, kahi-equipment-sync and raven-positions.
--
-- WHAT CALLS THE HOOKS FROM THE DATABASE (all four found by grepping pg_proc
-- for net.http_post, plus cron.job):
--   1. cron.job 'run-automations-15min' -- inline net.http_post, header apikey
--   2. public.kahi_sync_kick()          -- cron 'kahi-equipment-sync', */15
--   3. public.raven_sync_kick(text)     -- cron 'raven-positions', */5
--   4. public.tg_automation_notify()    -- AFTER triggers on accounts,
--      account_stage_history, tasks, touchpoints (event-driven automations)
-- All four read hook_url (and formerly apikey) from public.app_settings.
--
-- WHERE THE SECRET LIVES
-- Supabase Vault, under the name CRON_SECRET, read at call time through
-- public.cron_secret(). The same value must be set as CRON_SECRET in the app's
-- server environment. Setup and verification: supabase/CRON_SECRET_SETUP.md.
--
-- FAIL CLOSED, LIKE THE APP
-- cron_secret() raises when the Vault entry is missing, so a scheduled job
-- shows `failed` in cron.job_run_details instead of quietly posting an empty
-- header and collecting 401s. The one exception is tg_automation_notify: it is
-- a trigger on user writes, so a missing secret there is downgraded to a
-- WARNING -- an automation that does not fire is a bug, an account that cannot
-- be saved is an outage.
--
-- RE-RUNNABLE. Every statement is CREATE OR REPLACE, IF EXISTS-guarded, or an
-- upsert where the stored value wins. Applying this file does NOT require the
-- Vault entry to exist yet; only the next scheduled tick does.
--
-- Must be applied AFTER 20260902190000_drying_outside_conditions.sql if that
-- file is ever applied: both define drying_weather_kick() and this one carries
-- the new header.

-- ---------------------------------------------------------------------------
-- 0. Preconditions. Vault and pg_net are installed on the live project
--    (supabase_vault 0.3.1, pg_net 0.20.4); say so plainly if a copy lacks them.
-- ---------------------------------------------------------------------------
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'supabase_vault') THEN
    RAISE EXCEPTION 'supabase_vault is not installed; public.cron_secret() needs vault.decrypted_secrets.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
    RAISE EXCEPTION 'pg_net is not installed; the hook callers need net.http_post.';
  END IF;
END
$do$;

-- ---------------------------------------------------------------------------
-- 1. public.cron_secret() -- the only reader of the Vault entry.
--
-- SECURITY DEFINER so the kick functions (owned by postgres, run by pg_cron as
-- postgres, or by a trigger under whoever is writing) can read Vault without
-- any of those callers being granted Vault access themselves. EXECUTE is held
-- by postgres and service_role only: an authenticated session that could call
-- this would hold the scheduler's credential.
--
-- If more than one Vault row carries the name (a rotation that created before
-- deleting), the newest wins.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cron_secret()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  s text;
BEGIN
  SELECT decrypted_secret
    INTO s
    FROM vault.decrypted_secrets
   WHERE name = 'CRON_SECRET'
   ORDER BY created_at DESC
   LIMIT 1;

  IF s IS NULL OR length(s) = 0 THEN
    RAISE EXCEPTION 'CRON_SECRET is not in Supabase Vault; the cron hooks cannot be called.'
      USING HINT = 'Run: select vault.create_secret(''<value>'', ''CRON_SECRET''); '
                   'with the SAME value as the app''s CRON_SECRET env var. See supabase/CRON_SECRET_SETUP.md.';
  END IF;

  RETURN s;
END;
$$;

REVOKE ALL ON FUNCTION public.cron_secret() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cron_secret() TO postgres, service_role;

COMMENT ON FUNCTION public.cron_secret() IS
  'Shared secret for /api/public/hooks/* (x-cron-secret header), read from Vault entry CRON_SECRET. Raises when missing. postgres/service_role only.';

-- ---------------------------------------------------------------------------
-- 2. kahi_sync_kick -- identical to the live definition except that the
--    apikey header (and the silent return when app_settings had no apikey)
--    is replaced by x-cron-secret from cron_secret().
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.kahi_sync_kick()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE cfg jsonb; hook_url text;
BEGIN
  SELECT value INTO cfg FROM public.app_settings WHERE key = 'kahi';
  IF cfg IS NULL THEN RETURN; END IF;
  IF COALESCE((cfg->>'enabled')::boolean, true) IS FALSE THEN RETURN; END IF;
  hook_url := cfg->>'hook_url';
  IF hook_url IS NULL THEN RETURN; END IF;
  PERFORM net.http_post(
    url := hook_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', public.cron_secret()),
    body := jsonb_build_object('mode', 'assets')
  );
END; $function$;

-- Grants exactly as 20260820181707 left them (and as live): not anon/PUBLIC.
REVOKE EXECUTE ON FUNCTION public.kahi_sync_kick() FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.kahi_sync_kick() TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. raven_sync_kick -- same change.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.raven_sync_kick(_mode text DEFAULT 'positions'::text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE cfg jsonb; hook_url text;
BEGIN
  SELECT value INTO cfg FROM public.app_settings WHERE key = 'raven';
  IF cfg IS NULL THEN RETURN; END IF;
  IF _mode = 'positions' AND COALESCE((cfg->>'positions_enabled')::boolean, true) IS FALSE THEN RETURN; END IF;
  IF _mode = 'trips' AND COALESCE((cfg->>'trips_enabled')::boolean, true) IS FALSE THEN RETURN; END IF;
  hook_url := cfg->>'hook_url';
  IF hook_url IS NULL THEN RETURN; END IF;
  PERFORM net.http_post(
    url := hook_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', public.cron_secret()),
    body := jsonb_build_object('mode', _mode)
  );
END; $function$;

REVOKE EXECUTE ON FUNCTION public.raven_sync_kick(text) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.raven_sync_kick(text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. tg_automation_notify -- the event-driven caller of run-automations.
--    Same header change; a missing secret is a WARNING here, never an error,
--    because this runs inside the user's INSERT/UPDATE on accounts, tasks,
--    touchpoints and account_stage_history. The triggers themselves
--    (20260820070116) are untouched.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tg_automation_notify()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  cfg jsonb;
  hook_url text;
  secret text;
  triggers jsonb;
BEGIN
  SELECT value INTO cfg FROM public.app_settings WHERE key = 'automations';
  IF cfg IS NULL THEN RETURN NULL; END IF;
  IF COALESCE((cfg->>'event_driven')::boolean, true) IS FALSE THEN RETURN NULL; END IF;

  hook_url := cfg->>'hook_url';
  IF hook_url IS NULL THEN RETURN NULL; END IF;

  triggers := COALESCE(TG_ARGV[0]::jsonb, '[]'::jsonb);

  BEGIN
    secret := public.cron_secret();
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'tg_automation_notify: automation hook not called: %', SQLERRM;
    RETURN NULL;
  END;

  PERFORM net.http_post(
    url := hook_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', secret),
    body := jsonb_build_object('triggers', triggers)
  );
  RETURN NULL;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.tg_automation_notify() FROM anon, PUBLIC;

-- ---------------------------------------------------------------------------
-- 5. cron.job 'run-automations-15min' -- same name, schedule and URL as live
--    (jobid 10 today); only the header changes. cron.schedule with an existing
--    name updates in place on pg_cron >= 1.4, but unscheduling first keeps the
--    intent obvious and the file safe on older versions.
-- ---------------------------------------------------------------------------
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron is not installed; run-automations-15min not (re)scheduled.';
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'run-automations-15min') THEN
    PERFORM cron.unschedule('run-automations-15min');
  END IF;

  PERFORM cron.schedule(
    'run-automations-15min',
    '*/15 * * * *',
    $cron$
  select net.http_post(
    url:='https://project--b0a4cfc7-3fd3-46ba-aa5d-90a925aaa67c.lovable.app/api/public/hooks/run-automations',
    headers:=jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', public.cron_secret()),
    body:='{}'::jsonb
  ) as request_id;
  $cron$
  );
END
$do$;

-- ---------------------------------------------------------------------------
-- 6. drying-weather -- a schedule that was written but never reached the
--    database. 20260902190000_drying_outside_conditions.sql defined
--    drying_weather_kick() and the job 'drying-outside-conditions' at
--    20 13 * * * (09:20 New York on daylight time, just after the site's
--    09:00 observation exists); live today there is no such function, job or
--    app_settings row, so the Outside column stays empty. Recreated here with
--    the new header. URL and enabled flag live in app_settings exactly as for
--    raven and kahi, so the host can be corrected without a migration; on
--    re-run the stored value wins over this seed.
--
--    Host: goldstar.falconstaging.com, the one 20260902190000 chose and the
--    one raven was deliberately repointed to in 20260821235452. Both hosts
--    serve the current build (each returned the 503 above today).
-- ---------------------------------------------------------------------------
INSERT INTO public.app_settings (key, value)
VALUES ('drying_weather', jsonb_build_object(
  'hook_url', 'https://goldstar.falconstaging.com/api/public/hooks/drying-weather',
  'enabled', true
))
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value || public.app_settings.value;

CREATE OR REPLACE FUNCTION public.drying_weather_kick()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE cfg jsonb; hook_url text;
BEGIN
  SELECT value INTO cfg FROM public.app_settings WHERE key = 'drying_weather';
  IF cfg IS NULL THEN RETURN; END IF;
  IF COALESCE((cfg->>'enabled')::boolean, true) IS FALSE THEN RETURN; END IF;
  hook_url := cfg->>'hook_url';
  IF hook_url IS NULL THEN RETURN; END IF;
  PERFORM net.http_post(
    url := hook_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', public.cron_secret()),
    body := '{}'::jsonb
  );
END; $function$;

REVOKE EXECUTE ON FUNCTION public.drying_weather_kick() FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.drying_weather_kick() TO authenticated, service_role;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron is not installed; drying-outside-conditions not scheduled.';
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

-- ---------------------------------------------------------------------------
-- NOT SCHEDULED HERE, on purpose. Hooks under src/routes/api/public/hooks that
-- use denyUnlessCron and have no database caller, with why each is left alone:
--
--   cadence-sweep         Never scheduled in any migration. Its upsert names a
--                         partial unique index as the ON CONFLICT arbiter and
--                         fails with 42P10 (BACKLOG.md). Scheduling it would
--                         schedule an error; fix the hook first, then add
--                         e.g. cron.schedule('cadence-sweep', '30 11 * * *', ...)
--                         through a *_kick() like the ones above.
--
--   chase-escalation      Header says "every 30s-60s from pg_cron" but it was
--                         never scheduled. The SQL half of what it does
--                         (expire_stale_dispatches) already runs every 5 min
--                         inside the live job 'chase-claim-expiry'; the other
--                         half, escalate_incidents(), exists as a SQL function
--                         and could be added to that same job without HTTP at
--                         all. Product should pick the cadence.
--
--   document-signature-reminders
--                         The live job of the same name (20 7 * * *) calls the
--                         SQL function run_document_signature_reminders(); the
--                         TypeScript hook duplicates it. Scheduling both would
--                         double the nudges.
--
--   sync-nyc-fire-leads   No cron intent stated; it is invoked from the
--                         "Sync now" button on /admin/integrations, which
--                         POSTs from the browser with no header and now gets
--                         401. That is an app-side fix (a server function that
--                         adds the header), not a schedule.
--
-- graph-sync is not in this set: it has its own secret (GRAPH_SYNC_SECRET) and
-- is driven from outside the database.
-- ---------------------------------------------------------------------------
