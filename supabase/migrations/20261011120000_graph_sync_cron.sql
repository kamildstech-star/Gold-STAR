-- Schedule the Microsoft 365 reconciliation (/api/public/hooks/graph-sync).
--
-- WHY THIS IS NEEDED
-- The hook renews Graph change-notification subscriptions (mail and calendar
-- subscriptions expire within about three days), runs a delta query per
-- mailbox to catch anything a dropped notification lost, and drains the
-- outbound calendar queue. Nothing ever called it: cron.job on 2026-10-11 had
-- jobs for run-automations, drying-outside-conditions, email-release and the
-- rest, and none for graph-sync. 20260903200000 left it out on purpose because
-- it then had its own secret (GRAPH_SYNC_SECRET) and was meant to be driven
-- from outside the database; nothing outside ever was. So after a mailbox's
-- first sync its subscriptions would lapse and its mail would stop arriving.
--
-- The hook now authenticates like every other cron hook (denyUnlessCron, the
-- shared CRON_SECRET), so it can be called the same way: a small kick
-- function that reads public.cron_secret() from Vault and posts with pg_net.
-- This copies email_release_kick (20260928122000), the newest of the kick
-- functions: search_path pinned to '', the URL overridable from app_settings,
-- the same app origin as run-automations-15min, EXECUTE for service_role only.
--
-- WHEN IT POSTS
-- Only when at least one mailbox is enabled, and not when an admin has set
-- app_settings 'graph_sync'.enabled to false. Until IT's setup is finished and
-- someone registers a mailbox, a run costs one EXISTS and no HTTP call. The
-- hook has its own "not configured" no-op too, for a mailbox registered before
-- the Outlook secrets are.
--
-- THE SCHEDULE: every 15 minutes, at :07, :22, :37 and :52.
--   * Change notifications are the real-time path; this is the safety net, so
--     it only has to be soon enough that a dropped notification is not
--     noticed. A quarter of an hour is what run-automations and the Kahi sync
--     already use, and matches how often anyone looks at a mailbox's CRM log.
--   * Renewal needs far less: subscriptions are renewed when they have under
--     12 hours left (RENEW_WINDOW_MS), so even several failed runs in a row
--     leave days of margin before one lapses.
--   * A delta query with nothing new is one cheap Graph call per mailbox per
--     folder; at Gold Star's few dozen mailboxes, 96 runs a day is well inside
--     Graph's per-app throttling.
--   * Offset by seven minutes so it does not start in the same second as
--     run-automations-15min and kahi-equipment-sync (both on */15).
--
-- THE TIMEOUT: 60 seconds, not pg_net's default 5. A run walks every mailbox
-- and then the calendar queue, which can take longer than five seconds; with
-- the default, pg_net would hang up on a run still working (net._http_response
-- already holds a stream of 5000 ms timeouts from the other hooks) and the
-- response row would say nothing useful. The request is asynchronous, so the
-- longer timeout holds no cron worker and no lock.
--
-- Re-runnable: CREATE OR REPLACE, and the job is unscheduled before it is
-- scheduled again.

-- ---------------------------------------------------------------------------
-- 1. The kick.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.graph_sync_kick()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
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
  hook_url := COALESCE(
    NULLIF(btrim(cfg->>'hook_url'), ''),
    'https://project--b0a4cfc7-3fd3-46ba-aa5d-90a925aaa67c.lovable.app/api/public/hooks/graph-sync'
  );
  PERFORM net.http_post(
    url := hook_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', public.cron_secret()),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
END;
$$;
-- It sends the cron secret to a URL an app_settings row can change, so nobody
-- but the scheduler (and the service role) may call it.
REVOKE ALL ON FUNCTION public.graph_sync_kick() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.graph_sync_kick() TO service_role;

-- ---------------------------------------------------------------------------
-- 2. The schedule.
-- ---------------------------------------------------------------------------
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron is not installed; graph-sync remains unscheduled.';
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'graph-sync') THEN
    PERFORM cron.unschedule('graph-sync');
  END IF;
  PERFORM cron.schedule(
    'graph-sync',
    '7-59/15 * * * *',
    $cron$SELECT public.graph_sync_kick();$cron$
  );
END
$do$;
