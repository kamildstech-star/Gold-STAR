INSERT INTO public.app_settings (key, value)
VALUES ('raven', jsonb_build_object(
  'hook_url', 'https://project--b0a4cfc7-3fd3-46ba-aa5d-90a925aaa67c.lovable.app/api/public/hooks/raven-sync',
  'apikey', 'sb_publishable_fAsD3M2I7EBxTfUEexGL0Q_U-DHQ7ua',
  'positions_enabled', true,
  'trips_enabled', true
))
ON CONFLICT (key) DO UPDATE SET value = public.app_settings.value || EXCLUDED.value;

CREATE OR REPLACE FUNCTION public.raven_sync_kick(_mode text DEFAULT 'positions')
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE cfg jsonb; hook_url text; hook_key text;
BEGIN
  SELECT value INTO cfg FROM public.app_settings WHERE key = 'raven';
  IF cfg IS NULL THEN RETURN; END IF;
  IF _mode = 'positions' AND COALESCE((cfg->>'positions_enabled')::boolean, true) IS FALSE THEN RETURN; END IF;
  IF _mode = 'trips' AND COALESCE((cfg->>'trips_enabled')::boolean, true) IS FALSE THEN RETURN; END IF;
  hook_url := cfg->>'hook_url';
  hook_key := cfg->>'apikey';
  IF hook_url IS NULL OR hook_key IS NULL THEN RETURN; END IF;
  PERFORM net.http_post(
    url := hook_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'apikey', hook_key),
    body := jsonb_build_object('mode', _mode)
  );
END; $$;

REVOKE EXECUTE ON FUNCTION public.raven_sync_kick(text) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.raven_sync_kick(text) TO authenticated;

DO $do$
BEGIN
  PERFORM cron.unschedule('raven-positions');
EXCEPTION WHEN OTHERS THEN NULL;
END $do$;

DO $do$
BEGIN
  PERFORM cron.unschedule('raven-trips');
EXCEPTION WHEN OTHERS THEN NULL;
END $do$;

SELECT cron.schedule('raven-positions', '*/5 * * * *', $cron$SELECT public.raven_sync_kick('positions');$cron$);
SELECT cron.schedule('raven-trips', '7 * * * *', $cron$SELECT public.raven_sync_kick('trips');$cron$);