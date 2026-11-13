-- vehicle_positions: the two reads that time out on it.
--
-- WRITTEN, NOT APPLIED. Both halves close blockers 2 and 3 in
-- docs/qa/senior-handover.md, which recorded the diagnosis but left the fix
-- for a reviewed migration. Nothing here is destructive: one function is
-- created, and indexes are only ever added.
--
-- The table is the hot one in this database -- roughly 134,492 rows / 81 MB
-- during the investigation, growing every five minutes from the Raven poller
-- (src/lib/raven-sync.server.ts). Two unrelated queries walk it on ordinary
-- page loads and both were reported as
-- `canceling statement due to statement timeout`.
--
-- ===========================================================================
-- 1. The demo predicate, indexed on every demo-enabled table (blocker 2)
-- ===========================================================================
--
-- `demo_data_total()` runs one count per table that has an `is_demo` column,
-- on application-shell load, for every user. 20260806180637 created the
-- partial index for each table in `demo_tables()` AS IT STOOD THEN. Tables
-- that gained the column later were never indexed, because two later
-- migrations add the column without an index:
--
--   20260806205751 -- projects, photos, vehicles, VEHICLE_POSITIONS, ...
--   20260807010348 -- account_tags, messages, labour_rates, ...
--
-- and by then `demo_tables()` had become dynamic ("derive the demo table list
-- from the presence of the column"), so every one of them is counted. The
-- 81 MB table with no index is the one that shows up as the timeout, but it is
-- not a special case -- it is the biggest instance of a general miss.
--
-- So this does what the handover asked for in full ("audit all public tables
-- containing is_demo so future tables are not missed") rather than only the
-- one table it named: it walks the catalogue and indexes the predicate
-- wherever it is not already indexed. Re-running it is a no-op, and a table
-- that gains `is_demo` next month is covered by applying this file again.
--
-- WHY A PARTIAL INDEX (`WHERE is_demo`). The column is `NOT NULL DEFAULT
-- false` and production is overwhelmingly false, so the partial index holds
-- only the demo rows -- kilobytes, not megabytes -- and is exactly the set
-- `count(*) WHERE is_demo` needs. It also keeps the build cheap: a plain
-- CREATE INDEX takes a SHARE lock that blocks writes on the table for its
-- duration, and on a predicate this selective that duration is milliseconds.
-- CONCURRENTLY is deliberately NOT used: it cannot run inside the transaction
-- a migration executes in.
--
-- The skip condition tests the index DEFINITION, not the name. `IF NOT EXISTS`
-- alone only matches our own naming, so re-running after somebody indexed
-- `is_demo` by hand under another name would build a duplicate.

DO $$
DECLARE
  t text;
  idx text;
BEGIN
  FOR t IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid
     WHERE n.nspname = 'public'
       AND c.relkind = 'r'
       AND a.attname = 'is_demo'
       AND a.attnum > 0
       AND NOT a.attisdropped
     ORDER BY c.relname
  LOOP
    -- Already indexed on the predicate, under any name? Leave it alone.
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename = t
         AND indexdef LIKE '%(is_demo)%'
    );

    -- 63 characters is the identifier limit; long table names would otherwise
    -- truncate into a collision with each other.
    idx := left(t, 50) || '_is_demo_idx';

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON public.%I (is_demo) WHERE is_demo',
      idx, t);

    RAISE NOTICE 'indexed is_demo on public.% as %', t, idx;
  END LOOP;
END $$;

-- The one the handover named explicitly, stated on its own so the intent
-- survives even if the loop above is ever narrowed. Both are IF NOT EXISTS,
-- so whichever runs second does nothing.
CREATE INDEX IF NOT EXISTS vehicle_positions_is_demo_idx
  ON public.vehicle_positions (is_demo)
  WHERE is_demo;

-- ===========================================================================
-- 2. Latest position per vehicle, without reading the history (blocker 3)
-- ===========================================================================
--
-- `fetchTrackedVehicles` (src/lib/nearest-vehicle.ts) read up to 1,000
-- position rows for the visible vehicles ordered by `occurred_at` and picked
-- the newest per vehicle in JavaScript. That is slow, and it is also WRONG in
-- a way nobody would see: the 1,000 newest rows company-wide cover only a few
-- hours of a fleet reporting every thirty seconds, so any vehicle whose last
-- fix is older than that window returns no row at all and silently falls back
-- to its cached fix. The bug and the timeout have the same cause.
--
-- WHY NOT `DISTINCT ON`, WHICH THE HANDOVER NAMED. `DISTINCT ON (vehicle_id)
-- ... ORDER BY vehicle_id, occurred_at DESC` uses `vehicle_positions_recent`
-- to avoid the SORT, but it still READS every position row belonging to the
-- selected vehicles -- Postgres has no index skip scan -- so on this table it
-- reads ~134k rows where the old query read 1,000. It removes the sort and
-- makes the timeout worse. The LATERAL below is the same intent ("latest
-- position per vehicle, off the existing (vehicle_id, occurred_at DESC)
-- index") expressed so the planner does one index descent and one row per
-- vehicle, which is what the handover was actually asking for.
--
-- WHY SECURITY DEFINER. The RLS policy `positions viewable with vehicle`
-- (20260731004458) is a correlated EXISTS against `vehicles` evaluated PER
-- POSITION ROW, which is the other half of what made this slow. Here the
-- visibility test is resolved ONCE PER VEHICLE, in `visible`, before any
-- position is touched. The predicate is copied from that policy verbatim --
-- including `location_id IS NULL`, which the policy treats as visible to
-- everyone and `can_view_location` returns false for -- so this function
-- shows exactly what a direct select would show and nothing more. Vehicle ids
-- arrive from the client and are never trusted: an id the caller cannot see
-- is filtered out by `visible`, so passing somebody else's fleet returns
-- nothing rather than their coordinates.
--
-- Re-runnable: CREATE OR REPLACE plus idempotent REVOKE/GRANT.

CREATE OR REPLACE FUNCTION public.latest_vehicle_positions(_vehicle_ids uuid[])
RETURNS TABLE (
  vehicle_id uuid,
  lat double precision,
  lon double precision,
  occurred_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH visible AS (
    SELECT v.id
      FROM public.vehicles v
     WHERE v.id = ANY (COALESCE(_vehicle_ids, ARRAY[]::uuid[]))
       AND (
         v.location_id IS NULL
         OR public.can_view_location((SELECT auth.uid()), v.location_id)
       )
  )
  SELECT p.vehicle_id, p.lat, p.lon, p.occurred_at
    FROM visible
   CROSS JOIN LATERAL (
     SELECT vp.vehicle_id, vp.lat, vp.lon, vp.occurred_at
       FROM public.vehicle_positions vp
      WHERE vp.vehicle_id = visible.id
      ORDER BY vp.occurred_at DESC
      LIMIT 1
   ) p;
$$;

COMMENT ON FUNCTION public.latest_vehicle_positions(uuid[]) IS
  'Newest position for each of the given vehicles the caller may see: one index descent per vehicle, never a scan of the history. Mirrors the RLS policy "positions viewable with vehicle".';

REVOKE ALL ON FUNCTION public.latest_vehicle_positions(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.latest_vehicle_positions(uuid[]) TO authenticated, service_role;

-- ===========================================================================
-- Verification, per the handover's own checklist
-- ===========================================================================
--
--   -- every demo table indexed, none missed
--   SELECT c.relname
--     FROM pg_class c
--     JOIN pg_namespace n ON n.oid = c.relnamespace
--     JOIN pg_attribute a ON a.attrelid = c.oid
--    WHERE n.nspname = 'public' AND c.relkind = 'r'
--      AND a.attname = 'is_demo' AND a.attnum > 0 AND NOT a.attisdropped
--      AND NOT EXISTS (SELECT 1 FROM pg_indexes
--                       WHERE schemaname = 'public' AND tablename = c.relname
--                         AND indexdef LIKE '%(is_demo)%');
--   -- expected: zero rows
--
--   -- the count that was timing out, as a normal user and as a privileged one
--   EXPLAIN (ANALYZE, BUFFERS) SELECT public.demo_data_total();
--
--   -- one index descent per vehicle, no history read, RLS path included
--   EXPLAIN (ANALYZE, BUFFERS)
--   SELECT * FROM public.latest_vehicle_positions(
--     ARRAY(SELECT id FROM public.vehicles LIMIT 50));
--
-- Rollback:
--   DROP FUNCTION IF EXISTS public.latest_vehicle_positions(uuid[]);
--   -- indexes are additive; drop individually by name only if one is unwanted.
