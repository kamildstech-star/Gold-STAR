CREATE OR REPLACE FUNCTION public.seed_demo_visits()
RETURNS TABLE(table_name text, inserted_count integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inserted integer := 0;
  v_rep uuid;
  v_reps uuid[];
  v_acc record;
  v_i integer;
  v_when timestamptz;
  v_outcome text;
  v_outcomes text[] := ARRAY['Met the adjuster','Dropped literature','Owner not in','Booked a follow-up','Lunch and learn booked','Introduced the new coordinator'];
BEGIN
  IF NOT (public.is_privileged(auth.uid()) OR public.has_role(auth.uid(), 'owner')) THEN
    RAISE EXCEPTION 'Not authorised to seed demo data';
  END IF;

  -- Demo reps that already own demo accounts.
  SELECT array_agg(DISTINCT a.assigned_rep)
    INTO v_reps
    FROM public.accounts a
    JOIN public.profiles p ON p.id = a.assigned_rep
   WHERE a.is_demo AND a.assigned_rep IS NOT NULL;

  IF v_reps IS NULL OR array_length(v_reps, 1) = 0 THEN
    RETURN QUERY SELECT 'touchpoints'::text, 0;
    RETURN;
  END IF;

  v_i := 0;
  FOR v_acc IN
    SELECT a.id AS account_id,
           a.assigned_rep,
           COALESCE(a.name, 'Account') AS name,
           l.lat AS lat,
           l.lon AS lon
      FROM public.accounts a
      JOIN public.account_locations al ON al.account_id = a.id
      JOIN public.locations l ON l.id = al.location_id
     WHERE a.is_demo
       AND a.assigned_rep IS NOT NULL
       AND l.lat IS NOT NULL
       AND l.lon IS NOT NULL
     ORDER BY a.assigned_rep, a.name
     LIMIT 30
  LOOP
    v_i := v_i + 1;
    v_rep := v_acc.assigned_rep;
    -- Spread across the past 14 days, business hours.
    v_when := date_trunc('day', now()) - ((v_i % 14) || ' days')::interval
              + ((9 + (v_i % 8)) || ' hours')::interval
              + (((v_i * 17) % 60) || ' minutes')::interval;
    v_outcome := v_outcomes[1 + (v_i % array_length(v_outcomes, 1))];

    INSERT INTO public.touchpoints
      (account_id, type, direction, occurred_at, lat, lon, place_label,
       duration_seconds, notes, meeting_held, counts_toward_cadence,
       is_self_reported, capture_source, created_by, is_demo)
    VALUES
      (v_acc.account_id, 'meeting_in_person', 'outbound', v_when,
       v_acc.lat + ((v_i % 11) - 5) * 0.012,
       v_acc.lon + ((v_i % 9) - 4) * 0.014,
       v_acc.name,
       (20 + (v_i % 6) * 10) * 60,
       'Outcome: ' || v_outcome,
       true, true, true, 'manual', v_rep, true);
    v_inserted := v_inserted + 1;
  END LOOP;

  RETURN QUERY SELECT 'touchpoints'::text, v_inserted;
END;
$$;

REVOKE ALL ON FUNCTION public.seed_demo_visits() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.seed_demo_visits() TO authenticated;