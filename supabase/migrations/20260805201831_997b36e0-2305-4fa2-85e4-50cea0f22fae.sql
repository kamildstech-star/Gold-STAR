DO $$
DECLARE fn record;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN (
         'scorecard_identity','can_view_person_scorecard','scorecard_people',
         'scorecard_metrics','scorecard_metrics_raw','scorecard_team_medians',
         'person_timeline','person_accounts','person_jobs','person_chase','person_stalled')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', fn.sig);
    IF fn.sig::text NOT LIKE 'scorecard_metrics_raw%' THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', fn.sig);
    END IF;
  END LOOP;
END $$;