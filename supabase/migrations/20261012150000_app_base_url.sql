-- One base URL for every database caller of an app hook.
--
-- WHY
-- The app is moving off Lovable's hosting. The database calls the app on a
-- schedule (pg_cron → *_kick() → net.http_post → /api/public/hooks/...), and
-- until now each caller carried its own copy of the host: three as a
-- hard-coded fallback inside the function (email_release_kick,
-- graph_sync_kick, fire_feed_kick), one inline in the cron job's command
-- (run-automations-15min), and four as a full URL in their app_settings row
-- with no fallback at all (kahi_sync_kick, raven_sync_kick,
-- drying_weather_kick, tg_automation_notify). Moving host meant finding all
-- eight. After this file it is ONE row:
--
--   UPDATE public.app_settings
--      SET value = jsonb_build_object('url', 'https://<new host>')
--    WHERE key = 'app_base_url';
--
-- (plus clearing any per-job hook_url override that still names the old host
-- — docs/MOVING-OFF-LOVABLE.md has the single statement that does both).
--
-- WHAT CHANGES (and what does not)
--   * public.app_base_url() — the row's url, or today's Lovable host when the
--     row is missing or does not look like `https://host[:port]`. A typo
--     falls back instead of posting the cron secret somewhere odd.
--   * public.app_hook_url(hook, override) — the per-job override when one is
--     set (unchanged precedence: every caller's existing hook_url /
--     release_hook_url still wins), else `<base>/api/public/hooks/<hook>`.
--   * Every caller below is pg_get_functiondef() of the LIVE definition,
--     recorded 2026-10-12 in supabase/tests/fixtures/live-hook-callers-2026-10-12.json
--     (after 20261012100000 email retry #360 and 20261012120000 timeouts #355
--     were applied), with ONLY its hook_url assignment changed — every guard,
--     body, timeout, search_path and argument is as live.
--     supabase/tests/app-base-url-live-parity.test.ts fails if any body here
--     differs from the recording anywhere but that line. The four callers that
--     returned when hook_url was NULL now fall back to the base instead; live
--     has a hook_url on all four rows, so nothing changes on Lovable.
--     If a later migration redefines one of these before this file is
--     applied, re-record the fixture and regenerate the body from it.
--   * Grants restated exactly as live: the six kick functions are EXECUTE for
--     service_role only (20261011130000 / 20260928122000 / 20261011120000 /
--     20261011140000); tg_automation_notify keeps postgres, authenticated and
--     service_role (a trigger function's EXECUTE is not what fires it, and
--     anon/PUBLIC already hold nothing). The two new helpers are service_role
--     only — the kick functions run as their owner and need no grant.
--   * The seed is today's Lovable project host, the one the hard-coded
--     fallbacks and the cron job already use, so applying this file changes
--     no URL that is called today.
--   * kahi and automations store a hook_url that is EXACTLY what the base now
--     produces (project--…lovable.app + the default path), so those two
--     overrides are dropped — a no-op today, and it means they follow the
--     base at cutover. drying_weather and raven point at
--     goldstar.falconstaging.com on purpose (20260903200000) and are kept.
--   * The app_base_url row is closed to signed-in users (restrictive policy):
--     whatever it says receives the cron secret on every tick, so only the
--     service role / SQL editor may read or change it. 20261011130000 closed
--     the same hole for the kick functions themselves.
--
-- Apply AFTER 20261012100000 (#360) and 20261012120000 (#355) — version
-- order does that. Either one applied later would put a hard-coded host back.
--
-- Re-runnable: CREATE OR REPLACE, ON CONFLICT DO NOTHING (the stored value
-- wins), DROP POLICY IF EXISTS, and cron.alter_job keeps the job's id,
-- active flag and history.

-- ---------------------------------------------------------------------------
-- 0. The setting and its two readers
-- ---------------------------------------------------------------------------
INSERT INTO public.app_settings (key, value)
VALUES (
  'app_base_url',
  jsonb_build_object('url', 'https://project--b0a4cfc7-3fd3-46ba-aa5d-90a925aaa67c.lovable.app')
)
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.app_base_url()
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  SELECT COALESCE(
    (SELECT u
       FROM (SELECT rtrim(btrim(s.value->>'url'), '/') AS u
               FROM public.app_settings s
              WHERE s.key = 'app_base_url') x
      WHERE u ~ '^https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?$'),
    'https://project--b0a4cfc7-3fd3-46ba-aa5d-90a925aaa67c.lovable.app'
  )
$function$;

REVOKE ALL ON FUNCTION public.app_base_url() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_base_url() TO service_role;

CREATE OR REPLACE FUNCTION public.app_hook_url(_hook text, _override text DEFAULT NULL)
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  SELECT COALESCE(
    NULLIF(btrim(_override), ''),
    public.app_base_url() || '/api/public/hooks/' || _hook
  )
$function$;

REVOKE ALL ON FUNCTION public.app_hook_url(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_hook_url(text, text) TO service_role;

-- Whoever can write this row can send the cron secret anywhere. Admins can
-- write app_settings (app_settings_write); this row is the exception.
DROP POLICY IF EXISTS app_settings_base_url_service_only ON public.app_settings;
CREATE POLICY app_settings_base_url_service_only ON public.app_settings
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (key <> 'app_base_url')
  WITH CHECK (key <> 'app_base_url');

-- Overrides that say exactly what the base now says: dropping them is a no-op
-- today and lets them follow the base at cutover.
UPDATE public.app_settings
   SET value = value - 'hook_url'
 WHERE key = 'kahi'
   AND value->>'hook_url' = public.app_base_url() || '/api/public/hooks/kahi-sync';
UPDATE public.app_settings
   SET value = value - 'hook_url'
 WHERE key = 'automations'
   AND value->>'hook_url' = public.app_base_url() || '/api/public/hooks/run-automations';

-- ---------------------------------------------------------------------------
-- 1. kahi_sync_kick — cron 'kahi-equipment-sync', */15
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
  hook_url := public.app_hook_url('kahi-sync', cfg->>'hook_url');
  PERFORM net.http_post(
    url := hook_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', public.cron_secret()),
    body := jsonb_build_object('mode', 'assets'),
    timeout_milliseconds := 60000
  );
END; $function$;

REVOKE ALL ON FUNCTION public.kahi_sync_kick() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kahi_sync_kick() TO service_role;

-- ---------------------------------------------------------------------------
-- 2. raven_sync_kick — cron 'raven-positions', */5
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
  hook_url := public.app_hook_url('raven-sync', cfg->>'hook_url');
  PERFORM net.http_post(
    url := hook_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', public.cron_secret()),
    body := jsonb_build_object('mode', _mode),
    timeout_milliseconds := 60000
  );
END; $function$;

REVOKE ALL ON FUNCTION public.raven_sync_kick(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.raven_sync_kick(text) TO service_role;

-- ---------------------------------------------------------------------------
-- 3. drying_weather_kick — cron 'drying-outside-conditions', daily 13:20
-- ---------------------------------------------------------------------------
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
  hook_url := public.app_hook_url('drying-weather', cfg->>'hook_url');
  PERFORM net.http_post(
    url := hook_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', public.cron_secret()),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
END; $function$;

REVOKE ALL ON FUNCTION public.drying_weather_kick() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.drying_weather_kick() TO service_role;

-- ---------------------------------------------------------------------------
-- 4. email_release_kick — cron 'email-release', every minute (held mail due,
--    or a parked queued row due a retry — 20261012100000, #360)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.email_release_kick()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  hook_url text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.email_messages WHERE status = 'held' AND release_at <= now()
  ) AND NOT EXISTS (
    SELECT 1 FROM public.email_messages q
     WHERE q.status = 'queued'
       AND q.sent_at IS NULL
       AND q.delivery_reason IS NOT NULL
       AND q.supply_request_id IS NULL
       AND q.created_at > now() - interval '14 days'
       AND q.delivery_attempts < 6
       AND (q.next_attempt_at IS NULL OR q.next_attempt_at <= now())
       AND (q.claimed_at IS NULL OR q.claimed_at < now() - interval '10 minutes')
  ) THEN
    RETURN;
  END IF;
  SELECT value->>'release_hook_url' INTO hook_url
    FROM public.app_settings WHERE key = 'email_send';
  hook_url := public.app_hook_url('email-release', hook_url);
  PERFORM net.http_post(
    url := hook_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', public.cron_secret()),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.email_release_kick() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.email_release_kick() TO service_role;

-- ---------------------------------------------------------------------------
-- 5. graph_sync_kick — cron 'graph-sync', every 15 min at :07
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.graph_sync_kick()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  cfg jsonb;
  hook_url text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.graph_mailboxes WHERE enabled) THEN
    RETURN;
  END IF;
  SELECT value INTO cfg FROM public.app_settings WHERE key = 'graph_sync';
  IF COALESCE((cfg->>'enabled')::boolean, true) IS FALSE THEN
    RETURN;
  END IF;
  hook_url := public.app_hook_url('graph-sync', cfg->>'hook_url');
  PERFORM net.http_post(
    url := hook_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', public.cron_secret()),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.graph_sync_kick() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.graph_sync_kick() TO service_role;

-- ---------------------------------------------------------------------------
-- 6. fire_feed_kick — cron 'fire-feed', every 2 min
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fire_feed_kick()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  cfg jsonb;
  hook_url text;
BEGIN
  SELECT value INTO cfg FROM public.app_settings WHERE key = 'fire_feed';
  IF COALESCE((cfg->>'enabled')::boolean, false) IS NOT TRUE THEN
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.fire_feed_areas WHERE active) THEN
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.fire_feed_sources s
     WHERE s.enabled
       AND (s.last_fetched_at IS NULL
            OR s.last_fetched_at <= now() - make_interval(mins => s.poll_minutes) + interval '30 seconds')
  ) THEN
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.fire_feed_runs
     WHERE status = 'running' AND started_at > now() - interval '5 minutes'
  ) THEN
    RETURN;
  END IF;
  hook_url := public.app_hook_url('fire-feed', cfg->>'hook_url');
  PERFORM net.http_post(
    url := hook_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', public.cron_secret()),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.fire_feed_kick() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fire_feed_kick() TO service_role;

-- ---------------------------------------------------------------------------
-- 7. tg_automation_notify — AFTER triggers on accounts, account_stage_history,
--    tasks, touchpoints; posts to run-automations. Grants as live
--    (postgres, authenticated, service_role); anon and PUBLIC hold nothing.
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

  hook_url := public.app_hook_url('run-automations', cfg->>'hook_url');

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
    body := jsonb_build_object('triggers', triggers),
    timeout_milliseconds := 60000
  );
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.tg_automation_notify() FROM PUBLIC, anon;

-- ---------------------------------------------------------------------------
-- 8. cron.job 'run-automations-15min' — the inline caller. Live command
--    (recorded in the same fixture) with only the url changed; same name and
--    schedule. alter_job keeps the jobid, the active flag and the run history.
-- ---------------------------------------------------------------------------
DO $do$
DECLARE
  _jobid bigint;
  _command text := $cron$
  select net.http_post(
    url:=public.app_hook_url('run-automations'),
    headers:=jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', public.cron_secret()),
    body:='{}'::jsonb,
    timeout_milliseconds:=60000
  ) as request_id;
  $cron$;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron is not installed; run-automations-15min not changed.';
    RETURN;
  END IF;

  SELECT jobid INTO _jobid FROM cron.job WHERE jobname = 'run-automations-15min';
  IF _jobid IS NULL THEN
    PERFORM cron.schedule('run-automations-15min', '*/15 * * * *', _command);
  ELSE
    PERFORM cron.alter_job(_jobid, command := _command);
  END IF;
END
$do$;
