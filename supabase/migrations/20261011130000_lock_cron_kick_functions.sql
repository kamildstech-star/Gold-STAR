-- Scheduler "kick" functions are for pg_cron and the server only.
--
-- APPLIED to production 2026-10-11 (ledgered as 20261011130000).
--
-- Each *_kick function is SECURITY DEFINER and POSTs to an app hook with
-- public.cron_secret() in the x-cron-secret header, to a URL read from
-- app_settings. drying_weather_kick, kahi_sync_kick and raven_sync_kick were
-- still executable by every signed-in user (the default grant), so anyone
-- signed in could fire the Kahi / Raven syncs or the outside-weather fetch at
-- will, and an admin who can edit app_settings could have pointed the hook URL
-- elsewhere and received the cron secret. email_release_kick and
-- graph_sync_kick (20261011120000) were already locked; this brings the other
-- three in line. Nothing in the app calls them — pg_cron runs them as the
-- owner, which keeps EXECUTE.
--
-- Re-runnable.
REVOKE ALL ON FUNCTION public.drying_weather_kick() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.kahi_sync_kick() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.raven_sync_kick(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.drying_weather_kick() TO service_role;
GRANT EXECUTE ON FUNCTION public.kahi_sync_kick() TO service_role;
GRANT EXECUTE ON FUNCTION public.raven_sync_kick(text) TO service_role;
