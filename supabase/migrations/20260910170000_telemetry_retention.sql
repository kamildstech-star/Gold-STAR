-- Stop the telemetry tables growing forever.
--
-- The database ran out of disk on 9 September and took the whole app down with
-- it, including sign-in. When it came back, 71% of a 262 MB database was two
-- tables that nothing has ever pruned:
--
--   public.vehicle_positions        103 MB   174,508 rows   21 Aug - 10 Sep
--   public.equipment_tracker_events  83 MB   142,988 rows   20 Aug -  2 Sep
--
-- Both are telemetry. Raven writes a GPS position per vehicle per poll, every
-- 5 minutes across 31 vehicles; Kahi writes an equipment event every 15
-- minutes. Neither is business data anybody types, and neither had a ceiling.
-- Roughly 5 MB a day between them, forever, on a disk that can only grow.
--
-- Melly said the same thing out loud on the 9 September call before any of this
-- was measured: "it was the vehicle positions constantly being updated ... that
-- was slowing down the system."
--
-- 90 days is deliberately loose. Nothing on this database is older than 21 days,
-- so applying this deletes NOTHING today -- it exists so the tables can never
-- run away again. Tightening it is one number, and 30 days would still cover
-- the "show me past routes" case these rows are kept for. That is a decision
-- about how much history the business wants, not one to bury in a migration.

CREATE OR REPLACE FUNCTION public.prune_telemetry(_keep_days integer DEFAULT 90)
RETURNS TABLE(table_name text, deleted bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _cutoff timestamptz := now() - make_interval(days => greatest(_keep_days, 7));
  _n bigint;
BEGIN
  -- greatest(_keep_days, 7) is a floor, not a suggestion: a mistyped 0 here
  -- would delete every position the fleet map is currently drawing.

  DELETE FROM public.vehicle_positions WHERE occurred_at < _cutoff;
  GET DIAGNOSTICS _n = ROW_COUNT;
  table_name := 'vehicle_positions'; deleted := _n; RETURN NEXT;

  DELETE FROM public.equipment_tracker_events WHERE created_at < _cutoff;
  GET DIAGNOSTICS _n = ROW_COUNT;
  table_name := 'equipment_tracker_events'; deleted := _n; RETURN NEXT;

  -- pg_cron's own history. 26,801 rows since 28 July and nothing prunes it
  -- either. Owned by another role on some projects, so a failure here must not
  -- take the rest of the prune down with it.
  BEGIN
    DELETE FROM cron.job_run_details WHERE start_time < _cutoff;
    GET DIAGNOSTICS _n = ROW_COUNT;
  EXCEPTION WHEN insufficient_privilege OR undefined_table THEN
    _n := -1;
  END;
  table_name := 'cron.job_run_details'; deleted := _n; RETURN NEXT;

  RETURN;
END;
$$;

REVOKE ALL ON FUNCTION public.prune_telemetry(integer) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.prune_telemetry(integer) TO service_role;

-- 04:20 UTC: after the nightly sweeps, before anyone in New York is working.
SELECT cron.schedule(
  'prune-telemetry',
  '20 4 * * *',
  $cron$ SELECT public.prune_telemetry(90); $cron$
);
