-- Per-job hook URL overrides become service-only, and the geocode misses that
-- a refused Google key left in the shared cache are cleared.
--
-- WHY (14 Oct audit, fire-feed handoff 20 Oct)
-- Every *_kick() posts the cron secret to public.app_hook_url(hook, override),
-- and the override is read from that job's app_settings row
-- (fire_feed.hook_url, kahi.hook_url, raven.hook_url, drying_weather.hook_url,
-- graph_sync.hook_url, automations.hook_url, email_send.release_hook_url).
-- Admins can write app_settings from the browser (app_settings_write), so an
-- admin session — or a stolen one — could point fire_feed.hook_url at its own
-- host and collect the cron secret on the next tick. 20261012150000 closed the
-- same hole for app_base_url with a restrictive policy; the overrides live
-- inside rows admins must keep editing (the fire feed switch, the email undo
-- window), so a policy on the whole row will not do. Instead:
--
--   1. app_settings_hook_url_guard — a BEFORE INSERT OR UPDATE trigger that
--      refuses any change to a top-level hook_url / release_hook_url made by
--      a signed-in (or anonymous) API caller. Saving a row that carries the
--      existing value unchanged still works — the email undo-window card
--      merges and re-saves release_hook_url as it is. The SQL editor and the
--      service role are unaffected, so a real override is still one UPDATE.
--   2. app_hook_url() takes an override only when it looks like
--      https://host[:port]/api/public/hooks/<name>; anything else falls back
--      to the base, as app_base_url() already does for a malformed base.
--      The two overrides kept on purpose (raven, drying_weather →
--      goldstar.falconstaging.com) already have that shape.
--   3. geocode_cache: unresolved rows from Google are deleted, once. Until
--      this change the exposure lookups cached REQUEST_DENIED /
--      OVER_QUERY_LIMIT (both HTTP 200) and strict-filter misses as "no such
--      place", and the fire feed reads the same cache, so a real fire at one
--      of those addresses was skipped as not_found forever. A genuine miss is
--      simply asked again once and cached again.
--
-- Before applying, check that no override names a host you do not expect:
--   SELECT key, value->>'hook_url' AS hook_url, value->>'release_hook_url' AS release_hook_url
--     FROM public.app_settings
--    WHERE value ? 'hook_url' OR value ? 'release_hook_url';
--
-- Re-runnable: CREATE OR REPLACE, DROP TRIGGER IF EXISTS.

-- ---------------------------------------------------------------------------
-- 1. Overrides only from the SQL editor / service role
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.app_settings_hook_url_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  caller text := COALESCE(
    NULLIF(current_setting('request.jwt.claims', true), '')::jsonb->>'role',
    ''
  );
  prev jsonb;
  k text;
BEGIN
  -- No JWT (SQL editor, pg_cron, migrations) or the service role: trusted.
  IF caller NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.key = NEW.key THEN
    prev := OLD.value;
  ELSE
    -- An INSERT here is usually the first half of an upsert: compare with the
    -- row it is about to update, not with nothing.
    SELECT s.value INTO prev FROM public.app_settings s WHERE s.key = NEW.key;
  END IF;

  FOREACH k IN ARRAY ARRAY['hook_url', 'release_hook_url'] LOOP
    IF (NEW.value -> k) IS DISTINCT FROM (prev -> k) THEN
      RAISE EXCEPTION 'app_settings.%.% receives the cron secret, so it can only be changed from the SQL editor.', NEW.key, k
        USING ERRCODE = '42501';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.app_settings_hook_url_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS app_settings_hook_url_guard ON public.app_settings;
CREATE TRIGGER app_settings_hook_url_guard
  BEFORE INSERT OR UPDATE ON public.app_settings
  FOR EACH ROW EXECUTE FUNCTION public.app_settings_hook_url_guard();

-- ---------------------------------------------------------------------------
-- 2. An override must look like one of our hook URLs
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.app_hook_url(_hook text, _override text DEFAULT NULL)
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  SELECT COALESCE(
    (SELECT o
       FROM (SELECT btrim(_override) AS o) x
      WHERE o ~ '^https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?/api/public/hooks/[A-Za-z0-9_-]+$'),
    public.app_base_url() || '/api/public/hooks/' || _hook
  )
$function$;

REVOKE ALL ON FUNCTION public.app_hook_url(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_hook_url(text, text) TO service_role;

-- ---------------------------------------------------------------------------
-- 3. Clear the cached Google misses (see WHY, 3)
-- ---------------------------------------------------------------------------
DELETE FROM public.geocode_cache
 WHERE resolved IS NOT TRUE
   AND provider = 'google';
