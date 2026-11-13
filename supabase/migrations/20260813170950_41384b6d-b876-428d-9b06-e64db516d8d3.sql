DO $mig$
DECLARE def text; before text;
BEGIN
  def := pg_get_functiondef('public.seed_demo_extras()'::regprocedure);
  before := def;
  def := replace(def,
$q$  INSERT INTO contacts (id, account_id, full_name, email, phone, title, is_primary, created_by, is_demo)
  VALUES
    ('c0000000-0000-4000-8000-000000000013', 'ac000000-0000-4000-8000-000000000010', 'Gina Moretti', 'gina@ironboundholdings.example', '(973) 555-0142', 'Director of Operations', true, u2, true),
    ('c0000000-0000-4000-8000-000000000032', 'ac000000-0000-4000-8000-000000000027', 'Marcus Chen', 'mchen@sunsetbaypg.example', '(310) 555-0188', 'Portfolio Manager', true, u5, true)
  ON CONFLICT (id) DO NOTHING;$q$,
$q$  INSERT INTO contacts (id, account_id, location_id, full_name, email, phone, title, is_primary, created_by, is_demo)
  SELECT v.cid::uuid, v.aid::uuid, a.location_id, v.nm, v.em, v.ph, v.title, true, v.owner::uuid, true
  FROM (VALUES
    ('c0000000-0000-4000-8000-000000000013', 'ac000000-0000-4000-8000-000000000010', 'Gina Moretti', 'gina@ironboundholdings.example', '(973) 555-0142', 'Director of Operations', u2::text),
    ('c0000000-0000-4000-8000-000000000032', 'ac000000-0000-4000-8000-000000000027', 'Marcus Chen', 'mchen@sunsetbaypg.example', '(310) 555-0188', 'Portfolio Manager', u5::text)
  ) AS v(cid, aid, nm, em, ph, title, owner)
  JOIN accounts a ON a.id = v.aid::uuid
  ON CONFLICT (id) DO NOTHING;$q$);
  IF def = before THEN RAISE EXCEPTION 'seed_demo_extras: contacts block not matched'; END IF;
  EXECUTE def;

  def := pg_get_functiondef('public.seed_demo_data()'::regprocedure);
  before := def;
  def := replace(def,
$q$      spouse_name, hobbies, preferred_contact_method, best_time_to_reach,
      created_by, is_demo)$q$,
$q$      spouse_name, hobbies, preferred_contact_method, best_time_to_reach,
      created_by, is_demo, location_id)$q$);
  def := replace(def,
$q$      (ARRAY['Early morning','Late afternoon','Mid-week'])[1 + (s.seq % 3)],
      a.assigned_rep, true
    FROM src s$q$,
$q$      (ARRAY['Early morning','Late afternoon','Mid-week'])[1 + (s.seq % 3)],
      a.assigned_rep, true, a.location_id
    FROM src s$q$);
  IF def = before THEN RAISE EXCEPTION 'seed_demo_data: contacts insert not matched'; END IF;
  EXECUTE def;
END
$mig$;