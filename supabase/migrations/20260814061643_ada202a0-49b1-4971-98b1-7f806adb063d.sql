DO $$
DECLARE
  v_acc record;
  v_i integer := 0;
  v_when timestamptz;
  v_outcomes text[] := ARRAY['Met the adjuster','Dropped literature','Owner not in','Booked a follow-up','Lunch and learn booked','Introduced the new coordinator'];
BEGIN
  FOR v_acc IN
    SELECT a.id AS account_id, a.assigned_rep, COALESCE(a.name,'Account') AS name, l.lat, l.lon
      FROM public.accounts a
      JOIN public.account_locations al ON al.account_id = a.id
      JOIN public.locations l ON l.id = al.location_id
     WHERE a.is_demo AND a.assigned_rep IS NOT NULL AND l.lat IS NOT NULL AND l.lon IS NOT NULL
     ORDER BY a.assigned_rep, a.name
     LIMIT 30
  LOOP
    v_i := v_i + 1;
    v_when := date_trunc('day', now()) - ((v_i % 14) || ' days')::interval
              + ((9 + (v_i % 8)) || ' hours')::interval
              + (((v_i * 17) % 60) || ' minutes')::interval;
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
       'Outcome: ' || v_outcomes[1 + (v_i % array_length(v_outcomes,1))],
       true, true, true, 'manual', v_acc.assigned_rep, true);
  END LOOP;
END $$;