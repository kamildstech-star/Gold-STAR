-- Give every database caller of an app hook pg_net's 60-second timeout, not
-- its default 5.
--
-- WHAT WAS HAPPENING (read live 2026-10-11, net._http_response, ~6 h window)
-- 47 responses were "Timeout of 5000 ms reached", every one on a */5 or */15
-- tick. Matched against cron.job and the responses that did come back:
--   * run-automations-15min (inline net.http_post, */15): timed out on every
--     tick, 16:45 → 22:30 UTC. Not one 200 from it in the window — the hook
--     walks every automation rule and takes longer than 5 s.
--   * raven-positions (raven_sync_kick, */5): answered 502 until 20:40, then
--     timed out on every tick from 20:45 — Raven's API got slow, and we hung
--     up on it instead of hearing what it said.
--   * kahi-equipment-sync (kahi_sync_kick, */15): answered 502 (the equipment
--     id bug fixed in the same PR) on every tick to 22:15, then timed out at
--     22:30 — a full pull of 387 assets sits right at 5 s.
-- Every quarter hour from 16:45 to 22:30 had exactly three responses (Kahi,
-- Raven, run-automations), which is how each timeout is attributed.
-- graph_sync_kick and fire_feed_kick already pass 60000 (20261011120000,
-- 20261011140000). The other callers of net.http_post — drying_weather_kick,
-- email_release_kick and the event-driven tg_automation_notify (which posts to
-- the same slow run-automations hook) — are given the same timeout so no
-- caller is left on the default.
--
-- WHY IT MATTERS BEYOND THE LOG
-- The hooks run on Cloudflare Workers. When the caller hangs up, the Worker's
-- request is cancelled, so a 5-second pg_net timeout does not just lose the
-- answer — it can cut a sync or an automation sweep off half way. pg_net's
-- requests are asynchronous: a longer timeout holds no cron worker, no lock
-- and no user's transaction.
--
-- HOW
-- Each function below is pg_get_functiondef() of the live definition on
-- 2026-10-11, byte for byte, with `timeout_milliseconds := 60000` added to
-- its net.http_post call and nothing else changed (search_path included).
-- CREATE OR REPLACE keeps the existing ACL; the kick functions' grants are
-- restated exactly as 20261011130000 / 20260928122000 left them (service_role
-- only), and tg_automation_notify's are left alone (a trigger function's
-- EXECUTE is not what fires it).
-- The cron job run-automations-15min is changed with cron.alter_job so it
-- keeps its jobid, active flag and run history; if it is missing it is
-- scheduled with the name, schedule and URL 20260903200000 gave it.
--
-- Re-runnable.

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
  hook_url := cfg->>'hook_url';
  IF hook_url IS NULL THEN RETURN; END IF;
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
  hook_url := cfg->>'hook_url';
  IF hook_url IS NULL THEN RETURN; END IF;
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
  hook_url := cfg->>'hook_url';
  IF hook_url IS NULL THEN RETURN; END IF;
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
-- 4. email_release_kick — cron 'email-release', every minute (posts only when
--    a held message is due)
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
  ) THEN
    RETURN;
  END IF;
  SELECT value->>'release_hook_url' INTO hook_url
    FROM public.app_settings WHERE key = 'email_send';
  hook_url := COALESCE(
    NULLIF(btrim(hook_url), ''),
    'https://project--b0a4cfc7-3fd3-46ba-aa5d-90a925aaa67c.lovable.app/api/public/hooks/email-release'
  );
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
-- 5. tg_automation_notify — AFTER triggers on accounts, account_stage_history,
--    tasks, touchpoints; posts to run-automations. Grants untouched.
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
    body := jsonb_build_object('triggers', triggers),
    timeout_milliseconds := 60000
  );
  RETURN NULL;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 6. cron.job 'run-automations-15min' — inline net.http_post, */15.
--    Same name, schedule, URL and header as live; only the timeout is added.
-- ---------------------------------------------------------------------------
DO $do$
DECLARE
  _jobid bigint;
  _command text := $cron$
  select net.http_post(
    url:='https://project--b0a4cfc7-3fd3-46ba-aa5d-90a925aaa67c.lovable.app/api/public/hooks/run-automations',
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
