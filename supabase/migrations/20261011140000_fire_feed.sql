-- The fire feed: Gold Star's own fire alerts, in place of BNN.
--
-- Mark: "we need to make a feed that crawls google and x for fires in certain
-- areas and gathers those and can implement it into the program in place of
-- bnn", then "I don't want to pay API fees." So every source is free and
-- sanctioned — Google News's published RSS endpoint, RSS/Atom feeds an admin
-- adds, and (in a separate PR) public government incident pages. No scraping
-- of google.com or x.com, which forbid it.
--
-- WHAT THIS ADDS
--   1. incidents.source_links — every report of a fire (article, feed item,
--      911 listing) on the one incident, so corroborating sources merge onto
--      one card instead of becoming three leads.
--   2. fire_feed_areas — the towns being watched. Seeded from each active
--      office's own town and coordinates (15-mile radius); an admin adds the
--      county, ZIPs, or more towns, and switches each on or off.
--   3. fire_feed_sources — where to look: one Google News row (seeded), and
--      any RSS/Atom feeds or public incident pages an admin adds. The fetch
--      state columns (last fetch, status, error, ETag, Last-Modified) are the
--      hook's to write; admins can write only the configuration columns.
--   4. fire_feed_items — the ledger of every item already decided (lead,
--      merged, skipped + reason). It is what makes "already seen" free, and
--      what the admin screen lists. Kept 30 days by the hook.
--   5. fire_feed_cursors — per-source, per-query fetch state (validators for
--      each Google News area query).
--   6. fire_feed_runs — one row per run: fetched per source, leads created,
--      merged, skipped by reason, errors. The admin screen's status panel.
--   7. app_settings 'fire_feed' = {"enabled": false} — the master switch,
--      OFF until an admin turns it on.
--   8. fire_feed_kick() + pg_cron 'fire-feed' every two minutes.
--
-- LEADS GO THROUGH THE SAME PATH AS BNN
-- The hook inserts with ingestIncident (src/lib/incident-ingest.server.ts),
-- the very function the signed incident webhook now uses, with
-- incidents.source = 'google_news' | 'rss' | 'public_page'. incidents.source
-- has no CHECK and needs none; reports split by it as they already do.
-- Zone/market routing, the address dedupe, the location match, escalation,
-- the chase deck and the cockpit map are untouched and simply see a row.
--
-- WHO CAN DO WHAT
--   * Configure (areas, sources, the switch): is_privileged — owner, admin,
--     dev — the same people who edit Territory and chase assignment rules.
--   * Read the runs and the ledger: is_privileged.
--   * Cursors: no client role at all.
--   * Writes to runs, items, cursors and the sources' fetch state: the hook,
--     as service_role.
--   * Restrictive active_profile_required, portal_customer_denied and
--     anonymous_business_access_denied on every table; no anon grant.
--   * The incidents rows the feed creates are read under incidents' own RLS,
--     exactly as a BNN row would be.
--
-- Re-runnable: IF NOT EXISTS / OR REPLACE / ON CONFLICT DO NOTHING throughout,
-- and the cron job is unscheduled before it is scheduled again.

-- ---------------------------------------------------------------------------
-- 1. Every report of a fire on the one incident.
-- ---------------------------------------------------------------------------
ALTER TABLE public.incidents
  ADD COLUMN IF NOT EXISTS source_links jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.incidents DROP CONSTRAINT IF EXISTS incidents_source_links_is_array;
ALTER TABLE public.incidents
  ADD CONSTRAINT incidents_source_links_is_array CHECK (jsonb_typeof(source_links) = 'array');
COMMENT ON COLUMN public.incidents.source_links IS
  'Every report of this incident: [{kind, url, title, publisher, published_at}]. Written by the fire feed; a corroborating report is appended, not inserted as a second incident.';

-- ---------------------------------------------------------------------------
-- 2. Who stamps a configuration row. SECURITY INVOKER: it only reads auth.uid().
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fire_feed_stamp()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := now();
  NEW.updated_by := auth.uid();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.fire_feed_stamp() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Watch areas.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.fire_feed_areas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label text NOT NULL CHECK (btrim(label) <> '' AND length(label) <= 120),
  locality text CHECK (locality IS NULL OR (btrim(locality) <> '' AND length(locality) <= 120)),
  county text CHECK (county IS NULL OR (btrim(county) <> '' AND length(county) <= 120)),
  state text NOT NULL CHECK (state ~ '^[A-Z]{2}$'),
  postal_codes text[] NOT NULL DEFAULT '{}'::text[]
    CHECK (array_to_string(postal_codes, ',') ~ '^([0-9]{5}(,[0-9]{5})*)?$' AND cardinality(postal_codes) <= 500),
  center_lat double precision CHECK (center_lat IS NULL OR center_lat BETWEEN -90 AND 90),
  center_lon double precision CHECK (center_lon IS NULL OR center_lon BETWEEN -180 AND 180),
  radius_miles numeric(5,1) NOT NULL DEFAULT 15 CHECK (radius_miles > 0 AND radius_miles <= 100),
  -- The office it was seeded from, so a re-run never seeds that office twice.
  location_id uuid REFERENCES public.locations(id) ON DELETE SET NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  -- Something to search the news for.
  CONSTRAINT fire_feed_areas_has_place CHECK (locality IS NOT NULL OR county IS NOT NULL),
  CONSTRAINT fire_feed_areas_center_pair CHECK ((center_lat IS NULL) = (center_lon IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS fire_feed_areas_location_uniq
  ON public.fire_feed_areas (location_id) WHERE location_id IS NOT NULL;

DROP TRIGGER IF EXISTS fire_feed_areas_stamp ON public.fire_feed_areas;
CREATE TRIGGER fire_feed_areas_stamp
  BEFORE INSERT OR UPDATE ON public.fire_feed_areas
  FOR EACH ROW EXECUTE FUNCTION public.fire_feed_stamp();

-- Seed one area per active office town. Offices carry no territory polygon
-- (locations.territory is empty for all of them on 2026-10-11) and the only
-- ZIP zones on file belong to demo markets, so the office's own town and
-- coordinates are the honest starting point; an admin widens or narrows from
-- there. Two offices in one town (Lakewood, NJ has two) share one area.
INSERT INTO public.fire_feed_areas (label, locality, state, center_lat, center_lon, radius_miles, location_id)
SELECT DISTINCT ON (lower(btrim(l.locality)), upper(btrim(l.region)))
       btrim(l.locality) || ', ' || upper(btrim(l.region)),
       btrim(l.locality),
       upper(btrim(l.region)),
       l.lat,
       l.lon,
       15,
       l.id
  FROM public.locations l
 WHERE l.active
   AND l.locality IS NOT NULL AND btrim(l.locality) <> ''
   AND upper(btrim(coalesce(l.region, ''))) ~ '^[A-Z]{2}$'
   AND (l.lat IS NULL) = (l.lon IS NULL)
 ORDER BY lower(btrim(l.locality)), upper(btrim(l.region)), l.code
ON CONFLICT (location_id) WHERE location_id IS NOT NULL DO NOTHING;

-- ---------------------------------------------------------------------------
-- 4. Sources.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.fire_feed_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('google_news', 'rss', 'public_page')),
  label text NOT NULL CHECK (btrim(label) <> '' AND length(label) <= 120),
  url text CHECK (url IS NULL OR (url ~* '^https?://[^\s]+$' AND length(url) <= 2000)),
  -- Kind-specific settings (a public page's parser preset and column map).
  config jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(config) = 'object'),
  -- A feed known to cover one area; null means "place each item by location".
  area_id uuid REFERENCES public.fire_feed_areas(id) ON DELETE SET NULL,
  -- Never more often than every two minutes, per URL.
  poll_minutes integer NOT NULL DEFAULT 15 CHECK (poll_minutes BETWEEN 2 AND 1440),
  enabled boolean NOT NULL DEFAULT true,
  -- Fetch state: written by the hook (service_role), never by a client.
  last_fetched_at timestamptz,
  last_status integer,
  last_error text,
  etag text,
  last_modified text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT fire_feed_sources_url_required CHECK (kind = 'google_news' OR url IS NOT NULL)
);
-- One Google News row: it searches every area, so a second would only double the requests.
CREATE UNIQUE INDEX IF NOT EXISTS fire_feed_sources_one_google_news
  ON public.fire_feed_sources (kind) WHERE kind = 'google_news';
CREATE UNIQUE INDEX IF NOT EXISTS fire_feed_sources_url_uniq
  ON public.fire_feed_sources (lower(url)) WHERE url IS NOT NULL;

DROP TRIGGER IF EXISTS fire_feed_sources_stamp ON public.fire_feed_sources;
CREATE TRIGGER fire_feed_sources_stamp
  BEFORE INSERT OR UPDATE OF kind, label, url, config, area_id, poll_minutes, enabled
  ON public.fire_feed_sources
  FOR EACH ROW EXECUTE FUNCTION public.fire_feed_stamp();

INSERT INTO public.fire_feed_sources (kind, label, poll_minutes, enabled)
VALUES ('google_news', 'Google News', 15, true)
ON CONFLICT (kind) WHERE kind = 'google_news' DO NOTHING;

-- ---------------------------------------------------------------------------
-- 5. Runs.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.fire_feed_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  trigger text NOT NULL DEFAULT 'cron' CHECK (trigger IN ('cron', 'manual')),
  triggered_by uuid,
  -- Run now while the feed is off: read and decide, write nothing to incidents.
  dry_run boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ok', 'partial', 'failed')),
  fetched jsonb NOT NULL DEFAULT '{}'::jsonb,
  new_items integer NOT NULL DEFAULT 0,
  leads_created integer NOT NULL DEFAULT 0,
  merged integer NOT NULL DEFAULT 0,
  skipped jsonb NOT NULL DEFAULT '{}'::jsonb,
  deferred integer NOT NULL DEFAULT 0,
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  extractor jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- A dry run's per-item decisions (it has no ledger rows).
  decisions jsonb
);
CREATE INDEX IF NOT EXISTS fire_feed_runs_started_idx ON public.fire_feed_runs (started_at DESC);

-- ---------------------------------------------------------------------------
-- 6. The ledger.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.fire_feed_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_key text NOT NULL UNIQUE CHECK (length(item_key) BETWEEN 1 AND 300),
  source_id uuid REFERENCES public.fire_feed_sources(id) ON DELETE SET NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('google_news', 'rss', 'public_page')),
  run_id uuid REFERENCES public.fire_feed_runs(id) ON DELETE SET NULL,
  title text,
  url text,
  publisher text,
  published_at timestamptz,
  area_id uuid REFERENCES public.fire_feed_areas(id) ON DELETE SET NULL,
  decision text NOT NULL CHECK (decision IN ('lead', 'merged', 'skipped')),
  reason text,
  incident_id uuid REFERENCES public.incidents(id) ON DELETE SET NULL,
  extraction jsonb,
  extracted_by text CHECK (extracted_by IS NULL OR extracted_by IN ('ai', 'rules')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fire_feed_items_created_idx ON public.fire_feed_items (created_at DESC);
CREATE INDEX IF NOT EXISTS fire_feed_items_incident_idx ON public.fire_feed_items (incident_id) WHERE incident_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 7. Cursors.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.fire_feed_cursors (
  source_id uuid NOT NULL REFERENCES public.fire_feed_sources(id) ON DELETE CASCADE,
  query_key text NOT NULL CHECK (length(query_key) BETWEEN 1 AND 200),
  cursor text NOT NULL CHECK (length(cursor) <= 2000),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, query_key)
);

-- ---------------------------------------------------------------------------
-- 8. Privileges and RLS.
-- ---------------------------------------------------------------------------
REVOKE ALL ON public.fire_feed_areas, public.fire_feed_sources, public.fire_feed_runs,
              public.fire_feed_items, public.fire_feed_cursors
  FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.fire_feed_areas, public.fire_feed_sources, public.fire_feed_runs,
             public.fire_feed_items, public.fire_feed_cursors
  TO service_role;

GRANT SELECT, DELETE ON public.fire_feed_areas TO authenticated;
GRANT INSERT (label, locality, county, state, postal_codes, center_lat, center_lon, radius_miles, active)
  ON public.fire_feed_areas TO authenticated;
GRANT UPDATE (label, locality, county, state, postal_codes, center_lat, center_lon, radius_miles, active)
  ON public.fire_feed_areas TO authenticated;

GRANT SELECT, DELETE ON public.fire_feed_sources TO authenticated;
GRANT INSERT (kind, label, url, config, area_id, poll_minutes, enabled)
  ON public.fire_feed_sources TO authenticated;
GRANT UPDATE (label, url, config, area_id, poll_minutes, enabled)
  ON public.fire_feed_sources TO authenticated;

GRANT SELECT ON public.fire_feed_runs, public.fire_feed_items TO authenticated;

ALTER TABLE public.fire_feed_areas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fire_feed_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fire_feed_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fire_feed_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fire_feed_cursors ENABLE ROW LEVEL SECURITY;

DO $do$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['fire_feed_areas', 'fire_feed_sources', 'fire_feed_runs', 'fire_feed_items', 'fire_feed_cursors']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS active_profile_required ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY active_profile_required ON public.%I AS RESTRICTIVE FOR ALL TO authenticated
         USING ((SELECT goldstar_private.profile_is_active(auth.uid())))
         WITH CHECK ((SELECT goldstar_private.profile_is_active(auth.uid())))', t);
    EXECUTE format('DROP POLICY IF EXISTS portal_customer_denied ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY portal_customer_denied ON public.%I AS RESTRICTIVE FOR ALL TO portal_customer
         USING (false) WITH CHECK (false)', t);
    EXECUTE format('DROP POLICY IF EXISTS anonymous_business_access_denied ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY anonymous_business_access_denied ON public.%I AS RESTRICTIVE FOR ALL TO anon
         USING (false) WITH CHECK (false)', t);
  END LOOP;
END
$do$;

DROP POLICY IF EXISTS fire_feed_areas_admin ON public.fire_feed_areas;
CREATE POLICY fire_feed_areas_admin ON public.fire_feed_areas
  FOR ALL TO authenticated
  USING ((SELECT public.is_privileged((SELECT auth.uid()))))
  WITH CHECK ((SELECT public.is_privileged((SELECT auth.uid()))));

DROP POLICY IF EXISTS fire_feed_sources_admin ON public.fire_feed_sources;
CREATE POLICY fire_feed_sources_admin ON public.fire_feed_sources
  FOR ALL TO authenticated
  USING ((SELECT public.is_privileged((SELECT auth.uid()))))
  WITH CHECK ((SELECT public.is_privileged((SELECT auth.uid()))));

-- The Google News row searches every area; it is switched off, never deleted.
DROP POLICY IF EXISTS fire_feed_sources_keep_google_news ON public.fire_feed_sources;
CREATE POLICY fire_feed_sources_keep_google_news ON public.fire_feed_sources
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (kind <> 'google_news');

DROP POLICY IF EXISTS fire_feed_runs_admin_read ON public.fire_feed_runs;
CREATE POLICY fire_feed_runs_admin_read ON public.fire_feed_runs
  FOR SELECT TO authenticated
  USING ((SELECT public.is_privileged((SELECT auth.uid()))));

DROP POLICY IF EXISTS fire_feed_items_admin_read ON public.fire_feed_items;
CREATE POLICY fire_feed_items_admin_read ON public.fire_feed_items
  FOR SELECT TO authenticated
  USING ((SELECT public.is_privileged((SELECT auth.uid()))));

-- fire_feed_cursors: no permissive policy and no grant — machine state only.

-- ---------------------------------------------------------------------------
-- 9. The master switch, OFF.
-- ---------------------------------------------------------------------------
INSERT INTO public.app_settings (key, value)
VALUES ('fire_feed', '{"enabled": false}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 10. The kick. Copies graph_sync_kick / email_release_kick: search_path '',
--     URL overridable from app_settings, same app origin as
--     run-automations-15min, EXECUTE for service_role only.
--
-- It posts only when ALL of these hold, so an idle tick is three EXISTS and
-- no HTTP call:
--   * app_settings 'fire_feed'.enabled is true;
--   * at least one watch area is active;
--   * at least one enabled source is due (never fetched, or fetched longer
--     ago than its own poll_minutes — at least two minutes per URL);
--   * no run started in the last five minutes is still running.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fire_feed_kick()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
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
  hook_url := COALESCE(
    NULLIF(btrim(cfg->>'hook_url'), ''),
    'https://project--b0a4cfc7-3fd3-46ba-aa5d-90a925aaa67c.lovable.app/api/public/hooks/fire-feed'
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
REVOKE ALL ON FUNCTION public.fire_feed_kick() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fire_feed_kick() TO service_role;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron is not installed; fire-feed remains unscheduled.';
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'fire-feed') THEN
    PERFORM cron.unschedule('fire-feed');
  END IF;
  -- Every two minutes, offset by one so it never starts in the same second
  -- as the */5, */10 and */15 jobs. The kick decides whether anything is due.
  PERFORM cron.schedule(
    'fire-feed',
    '1-59/2 * * * *',
    $cron$SELECT public.fire_feed_kick();$cron$
  );
END
$do$;
