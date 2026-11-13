CREATE OR REPLACE FUNCTION public.gift_tag_name_for_policy(_policy text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE _policy
    WHEN 'prohibited' THEN 'NO GIFTS'
    WHEN 'approval_required' THEN 'LEGAL REVIEW'
    WHEN 'open' THEN 'GIFTS OK'
    ELSE NULL END
$$;

CREATE OR REPLACE FUNCTION public.contact_gift_policy(_contact uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE
    WHEN bool_or(t.name IN ('NO GIFTS','OFF LIMITS')) THEN 'prohibited'
    WHEN bool_or(t.name = 'LEGAL REVIEW') THEN 'approval_required'
    WHEN bool_or(t.name = 'GIFTS OK') THEN 'open'
    ELSE 'unknown' END
  FROM public.contact_tags ct
  JOIN public.tags t ON t.id = ct.tag_id
  WHERE ct.contact_id = _contact
$$;

REVOKE ALL ON FUNCTION public.gift_tag_name_for_policy(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.contact_gift_policy(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gift_tag_name_for_policy(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.contact_gift_policy(uuid) TO authenticated, service_role;

INSERT INTO public.tags (name, color, scopes)
SELECT v.name, v.color, ARRAY['contact','account']::tag_scope[]
FROM (VALUES ('NO GIFTS','#B91C1C'), ('OFF LIMITS','#B91C1C'), ('GIFTS OK','#15803D'), ('LEGAL REVIEW','#B45309')) AS v(name,color)
WHERE NOT EXISTS (SELECT 1 FROM public.tags t WHERE t.name = v.name);

DO $mig$
DECLARE def text; before text;
BEGIN
  -- seed_demo_extras -------------------------------------------------------
  def := pg_get_functiondef('public.seed_demo_extras()'::regprocedure);
  before := def;

  def := replace(def,
$q$  INSERT INTO contacts (id, account_id, full_name, email, phone, title, gift_policy, is_primary, created_by, is_demo)
  VALUES
    ('c0000000-0000-4000-8000-000000000013', 'ac000000-0000-4000-8000-000000000010', 'Gina Moretti', 'gina@ironboundholdings.example', '(973) 555-0142', 'Director of Operations', 'open', true, u2, true),
    ('c0000000-0000-4000-8000-000000000032', 'ac000000-0000-4000-8000-000000000027', 'Marcus Chen', 'mchen@sunsetbaypg.example', '(310) 555-0188', 'Portfolio Manager', 'approval_required', true, u5, true)
  ON CONFLICT (id) DO NOTHING;$q$,
$q$  INSERT INTO contacts (id, account_id, full_name, email, phone, title, is_primary, created_by, is_demo)
  VALUES
    ('c0000000-0000-4000-8000-000000000013', 'ac000000-0000-4000-8000-000000000010', 'Gina Moretti', 'gina@ironboundholdings.example', '(973) 555-0142', 'Director of Operations', true, u2, true),
    ('c0000000-0000-4000-8000-000000000032', 'ac000000-0000-4000-8000-000000000027', 'Marcus Chen', 'mchen@sunsetbaypg.example', '(310) 555-0188', 'Portfolio Manager', true, u5, true)
  ON CONFLICT (id) DO NOTHING;

  -- gift policy lives in the tag system now
  INSERT INTO contact_tags (contact_id, tag_id, is_demo)
  SELECT v.cid::uuid, t.id, true
  FROM (VALUES
    ('c0000000-0000-4000-8000-000000000013', 'open'),
    ('c0000000-0000-4000-8000-000000000032', 'approval_required')
  ) AS v(cid, policy)
  JOIN tags t ON t.name = public.gift_tag_name_for_policy(v.policy)
  ON CONFLICT DO NOTHING;$q$);
  IF def = before THEN RAISE EXCEPTION 'seed_demo_extras: contacts block not matched'; END IF;

  before := def;
  def := replace(def, $q$CASE WHEN c.gift_policy = 'prohibited'$q$,
                       $q$CASE WHEN public.contact_gift_policy(c.id) = 'prohibited'$q$);
  def := replace(def, $q$WHEN c.gift_policy = 'approval_required' AND camp.status = 'draft'$q$,
                       $q$WHEN public.contact_gift_policy(c.id) = 'approval_required' AND camp.status = 'draft'$q$);
  def := replace(def, $q$(c.gift_policy <> 'prohibited' AND NOT (c.gift_policy = 'approval_required' AND camp.status = 'draft'))$q$,
                       $q$(public.contact_gift_policy(c.id) <> 'prohibited' AND NOT (public.contact_gift_policy(c.id) = 'approval_required' AND camp.status = 'draft'))$q$);
  IF def = before OR def LIKE '%c.gift_policy%' THEN
    RAISE EXCEPTION 'seed_demo_extras: recipient block not fully repointed';
  END IF;
  EXECUTE def;

  -- seed_demo_data ---------------------------------------------------------
  def := pg_get_functiondef('public.seed_demo_data()'::regprocedure);

  before := def;
  def := replace(def,
$q$      gift_policy, gift_policy_notes, is_primary, birthday_month, birthday_day,$q$,
$q$      gift_policy_notes, is_primary, birthday_month, birthday_day,$q$);
  def := replace(def, $q$      s.policy::gift_policy, s.pol_notes,$q$, $q$      s.pol_notes,$q$);
  IF def LIKE '%gift_policy,%' OR def LIKE '%::gift_policy%' THEN
    RAISE EXCEPTION 'seed_demo_data: contacts column list not repointed';
  END IF;

  before := def;
  def := replace(def,
$q$    ON CONFLICT (id) DO NOTHING
    RETURNING 1)
  SELECT count(*) INTO n FROM ins;
  IF n > 0 THEN table_name := 'contacts';$q$,
$q$    ON CONFLICT (id) DO NOTHING
    RETURNING id
  ), tagged AS (
    INSERT INTO public.contact_tags (contact_id, tag_id, is_demo)
    SELECT i.id, t.id, true
    FROM ins i
    JOIN src s ON ('c0000000-0000-4000-8000-' || lpad(s.seq::text, 12, '0'))::uuid = i.id
    JOIN public.tags t ON t.name = public.gift_tag_name_for_policy(s.policy)
    ON CONFLICT DO NOTHING
    RETURNING 1)
  SELECT count(*) INTO n FROM ins;
  IF n > 0 THEN table_name := 'contacts';$q$);
  IF def = before THEN RAISE EXCEPTION 'seed_demo_data: contacts insert tail not matched'; END IF;

  EXECUTE def;
END
$mig$;