CREATE OR REPLACE FUNCTION public.seed_demo_pipelines()
RETURNS TABLE(table_name text, inserted_count bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  n bigint;
  v_prospect uuid := '22222222-2222-4222-8222-222222222222';
  v_rel      uuid := '11111111-1111-4111-8111-111111111111';
  v_health   uuid := '33333333-3333-4333-8333-333333333333';
  r_renata uuid := 'd0000001-0000-4000-8000-000000000001';
  r_ivo    uuid := 'd0000001-0000-4000-8000-000000000002';
  r_sunny  uuid := 'd0000001-0000-4000-8000-000000000003';
  r_pilar  uuid := 'd0000001-0000-4000-8000-000000000005';
  r_arden  uuid := 'd0000001-0000-4000-8000-000000000007';
  reps uuid[];
BEGIN
  IF NOT (public.has_role(auth.uid(),'admin')
          OR public.has_role(auth.uid(),'owner')
          OR current_user IN ('postgres','supabase_admin')) THEN
    RAISE EXCEPTION 'Only owners and admins can seed demo data';
  END IF;

  SELECT coalesce(array_agg(user_id ORDER BY user_id), '{}')
    INTO reps FROM public.profiles WHERE is_demo;
  IF coalesce(array_length(reps,1),0) = 0 THEN
    reps := ARRAY[r_renata, r_ivo, r_sunny, r_pilar, r_arden];
  END IF;

  ---------------------------------------------------------------- relationship pipeline
  WITH src(seq, nm, code, stage_key, atype, est) AS (VALUES
    (101,'Bregman & Associates Public Adjusters','NY','target','other',180000),
    (102,'Kensington Claims Advocates','NY','researching','other',120000),
    (103,'Rapid Rooter Plumbing & Drain','NY','attempting_contact','other',90000),
    (104,'Palisade Property Management','NJ','attempting_contact','property_management',260000),
    (105,'Sentry Independent Adjusting','NJ','meeting_booked','other',210000),
    (106,'Beacon Hill Realty Services','MD','meeting_held','property_management',175000),
    (107,'Copperline Mechanical & Plumbing','MD','vendor_onboarding','other',85000),
    (108,'Ashford Residential Partners','NC','active','property_management',300000),
    (109,'Sunbelt Claims Consultants','GA','active','other',150000),
    (110,'Northline Building Services','IL','nurture','commercial',95000),
    (111,'Gulf Coast Plumbing Works','TX','dormant','other',60000),
    (112,'Westgate Asset Management','CA','lost','property_management',140000)
  ), ins AS (
    INSERT INTO public.accounts (
      id, name, location_id, assigned_rep, created_by, account_type, status,
      pipeline_id, stage_id, stage, priority, estimated_annual_value, lost_reason,
      what_they_do, is_demo, created_at, stage_changed_at)
    SELECT
      ('ac000000-0000-4000-8000-' || lpad(s.seq::text, 12, '0'))::uuid,
      s.nm, l.id, reps[1 + (s.seq % array_length(reps,1))], reps[1],
      s.atype::account_type,
      CASE WHEN s.stage_key = 'active' THEN 'active'
           WHEN s.stage_key = 'lost' THEN 'lost'
           WHEN s.stage_key = 'dormant' THEN 'dormant'
           ELSE 'prospect' END::account_status,
      v_rel, ps.id, s.stage_key,
      (ARRAY['low','normal','high'])[1 + (s.seq % 3)],
      s.est,
      CASE WHEN s.stage_key = 'lost' THEN 'Signed a national vendor agreement elsewhere' ELSE NULL END,
      ARRAY['water','fire'], true,
      now() - ((200 - s.seq) || ' days')::interval,
      now() - ((3 + (s.seq % 40)) || ' days')::interval
    FROM src s
    JOIN public.locations l ON l.code = s.code
    JOIN public.pipeline_stages ps ON ps.pipeline_id = v_rel AND ps.key = s.stage_key
    ON CONFLICT (id) DO NOTHING
    RETURNING 1)
  SELECT count(*) INTO n FROM ins;
  IF n > 0 THEN table_name := 'accounts (relationship)'; inserted_count := n; RETURN NEXT; END IF;

  WITH src(seq, person, title) AS (VALUES
    (101,'Ari Bregman','Principal Public Adjuster'),
    (102,'Nadia Petrov','Senior Adjuster'),
    (103,'Sal Marchetti','Owner'),
    (104,'Denise Falk','Portfolio Manager'),
    (105,'Ray Okafor','Field Adjuster'),
    (106,'Gina Alvarez','Regional Director'),
    (107,'Wes Trumbull','Service Manager'),
    (108,'Priya Raman','Director of Facilities'),
    (109,'Marcus Deleon','Managing Adjuster'),
    (110,'Karen Vosburg','Operations Lead'),
    (111,'Hector Ibarra','Owner'),
    (112,'Todd Kerrigan','Asset Manager')
  ), ins AS (
    INSERT INTO public.contacts (id, account_id, location_id, full_name, title,
      decision_role, email, phone, is_primary, is_decision_maker, created_by, is_demo)
    SELECT ('c0000000-0000-4000-8000-' || lpad(s.seq::text, 12, '0'))::uuid,
           a.id, a.location_id, s.person, s.title, 'decision_maker'::contact_decision_role,
           lower(split_part(s.person,' ',1)) || '.' || lower(split_part(s.person,' ',2)) || '@example.com',
           '(212) 555-0' || lpad((100 + s.seq)::text, 3, '0'),
           true, true, a.assigned_rep, true
    FROM src s
    JOIN public.accounts a ON a.id = ('ac000000-0000-4000-8000-' || lpad(s.seq::text, 12, '0'))::uuid
    ON CONFLICT (id) DO NOTHING
    RETURNING 1)
  SELECT count(*) INTO n FROM ins;
  IF n > 0 THEN table_name := 'contacts (relationship)'; inserted_count := n; RETURN NEXT; END IF;

  ---------------------------------------------------------------- client health
  WITH src(seq, nm, code, hkey, est) AS (VALUES
    (121,'Brownstone Collective Management','NY','healthy',420000),
    (122,'Ellerbe Court Apartments','NY-UP','healthy',180000),
    (123,'Monmouth Facilities Group','NJ','needs_attention',240000),
    (124,'Patapsco Housing Partners','MD','needs_attention',160000),
    (125,'Carolina Ridge Communities','NC','annual_meeting',310000),
    (126,'Stone Mountain Retail Trust','GA','annual_meeting',140000),
    (127,'Lakeview Commercial Holdings','IL','ghosted',200000),
    (128,'Bayshore Residential Group','TX','ghosted',115000)
  ), ins AS (
    INSERT INTO public.accounts (
      id, name, location_id, assigned_rep, created_by, account_type, status,
      pipeline_id, stage_id, stage, priority, estimated_annual_value,
      health_pipeline_id, health_stage_id, health_changed_at, last_in_person_at,
      annual_meeting_due_on, what_they_do, is_demo, created_at, stage_changed_at)
    SELECT ('ac000000-0000-4000-8000-' || lpad(s.seq::text, 12, '0'))::uuid,
      s.nm, l.id, reps[1 + (s.seq % array_length(reps,1))], reps[1],
      'property_management'::account_type, 'active'::account_status,
      v_prospect, ps.id, 'active_client',
      (ARRAY['normal','high'])[1 + (s.seq % 2)], s.est,
      v_health, hs.id, now() - ((2 + (s.seq % 20)) || ' days')::interval,
      now() - (CASE s.hkey WHEN 'healthy' THEN 40 WHEN 'needs_attention' THEN 120
                           WHEN 'annual_meeting' THEN 350 ELSE 260 END || ' days')::interval,
      CASE s.hkey WHEN 'annual_meeting' THEN CURRENT_DATE + 6
                  WHEN 'ghosted' THEN CURRENT_DATE - 20
                  ELSE CURRENT_DATE + 120 END,
      ARRAY['water','mold'], true,
      now() - ((500 - s.seq) || ' days')::interval,
      now() - ((60 + s.seq) || ' days')::interval
    FROM src s
    JOIN public.locations l ON l.code = s.code
    JOIN public.pipeline_stages ps ON ps.pipeline_id = v_prospect AND ps.key = 'active_client'
    JOIN public.pipeline_stages hs ON hs.pipeline_id = v_health AND hs.key = s.hkey
    ON CONFLICT (id) DO NOTHING
    RETURNING 1)
  SELECT count(*) INTO n FROM ins;
  IF n > 0 THEN table_name := 'accounts (client health)'; inserted_count := n; RETURN NEXT; END IF;

  WITH src(seq, person, title) AS (VALUES
    (121,'Rivka Mandel','Property Director'),
    (122,'Owen Brackett','Site Manager'),
    (123,'Lucia Ferraro','Facilities Manager'),
    (124,'Andre Whitlock','Operations Director'),
    (125,'Shannon Grier','Regional Manager'),
    (126,'Elias Boateng','Property Manager'),
    (127,'Margo Sindelar','VP Operations'),
    (128,'Curtis Reyna','Portfolio Lead')
  ), ins AS (
    INSERT INTO public.contacts (id, account_id, location_id, full_name, title,
      decision_role, email, phone, is_primary, is_decision_maker, created_by, is_demo)
    SELECT ('c0000000-0000-4000-8000-' || lpad(s.seq::text, 12, '0'))::uuid,
           a.id, a.location_id, s.person, s.title, 'decision_maker'::contact_decision_role,
           lower(split_part(s.person,' ',1)) || '.' || lower(split_part(s.person,' ',2)) || '@example.com',
           '(347) 555-0' || lpad((100 + s.seq)::text, 3, '0'),
           true, true, a.assigned_rep, true
    FROM src s
    JOIN public.accounts a ON a.id = ('ac000000-0000-4000-8000-' || lpad(s.seq::text, 12, '0'))::uuid
    ON CONFLICT (id) DO NOTHING
    RETURNING 1)
  SELECT count(*) INTO n FROM ins;
  IF n > 0 THEN table_name := 'contacts (client health)'; inserted_count := n; RETURN NEXT; END IF;

  INSERT INTO public.account_locations (account_id, location_id, created_by, is_demo)
  SELECT a.id, a.location_id, a.created_by, true
  FROM public.accounts a
  WHERE a.is_demo AND NOT EXISTS (
    SELECT 1 FROM public.account_locations al WHERE al.account_id = a.id)
  ON CONFLICT DO NOTHING;

  ---------------------------------------------------------------- worked-looking prospecting cards
  UPDATE public.accounts a
     SET assigned_rep = coalesce(a.assigned_rep, reps[1 + (abs(hashtext(a.id::text)) % array_length(reps,1))]),
         estimated_annual_value = coalesce(a.estimated_annual_value,
           35000 + (abs(hashtext(a.name)) % 40) * 8000),
         priority = CASE WHEN a.priority = 'normal' AND abs(hashtext(a.name)) % 4 = 0
                         THEN 'high' ELSE a.priority END
   WHERE a.is_demo AND a.pipeline_id = v_prospect;

  WITH open_cards AS (
    SELECT a.id, a.location_id, a.assigned_rep, a.name, s.key
    FROM public.accounts a
    JOIN public.pipeline_stages s ON s.id = a.stage_id
    WHERE a.is_demo AND a.pipeline_id IN (v_prospect, v_rel)
      AND s.key NOT IN ('no_service_needed','lost')
      AND NOT EXISTS (SELECT 1 FROM public.tasks t
                      WHERE t.account_id = a.id AND t.status = 'open')
  ), ins AS (
    INSERT INTO public.tasks (title, description, assignee, due_date, priority, status,
      entity_type, entity_id, account_id, location_id, source, created_by, is_demo)
    SELECT
      CASE c.key
        WHEN 'leads' THEN 'Qualify and assign'
        WHEN 'new_lead_input' THEN 'Sales Head approval review'
        WHEN 'ready' THEN 'First outreach call'
        WHEN 'active_outreach' THEN 'Follow-up call'
        WHEN 'conversation_established' THEN 'Book in-person meeting'
        WHEN 'active_client' THEN 'Quarterly touch'
        WHEN 'goasted' THEN 'Reassign or close decision'
        WHEN 'target' THEN 'Research and qualify'
        WHEN 'researching' THEN 'Find the decision maker'
        WHEN 'attempting_contact' THEN 'Call the office'
        WHEN 'meeting_booked' THEN 'Prep pre-call brief'
        WHEN 'meeting_held' THEN 'Send follow-up recap'
        WHEN 'vendor_onboarding' THEN 'Chase signed vendor packet'
        WHEN 'active' THEN 'Quarterly touch'
        ELSE 'Next step' END,
      'Demo next activity for ' || c.name,
      c.assigned_rep,
      CURRENT_DATE + ((abs(hashtext(c.id::text)) % 11) - 3),
      (ARRAY['normal','high','urgent'])[1 + (abs(hashtext(c.name)) % 3)]::task_priority,
      'open'::task_status, 'account', c.id, c.id, c.location_id, 'manual',
      c.assigned_rep, true
    FROM open_cards c
    RETURNING 1)
  SELECT count(*) INTO n FROM ins;
  IF n > 0 THEN table_name := 'tasks (next activity)'; inserted_count := n; RETURN NEXT; END IF;

  ---------------------------------------------------------------- gifts (NO GIFTS tags respected)
  WITH eligible AS (
    SELECT c.id AS contact_id, c.account_id, a.assigned_rep,
           row_number() OVER (ORDER BY c.created_at, c.id) AS rn
    FROM public.contacts c
    JOIN public.accounts a ON a.id = c.account_id
    WHERE c.is_demo AND a.is_demo AND c.archived_at IS NULL
      AND public.contact_gift_policy(c.id) <> 'prohibited'
      AND NOT EXISTS (SELECT 1 FROM public.gift_sends g WHERE g.contact_id = c.id)
  ), pick AS (SELECT * FROM eligible WHERE rn % 5 = 1 LIMIT 8), ins AS (
    INSERT INTO public.gift_sends (contact_id, account_id, catalog_item_id, sent_at,
      cost_cents, delivery_status, tracking_ref, notes, created_by, is_demo)
    SELECT p.contact_id, p.account_id,
           (SELECT id FROM public.gift_catalog ORDER BY unit_cost_cents LIMIT 1 OFFSET (p.rn % 3)),
           now() - ((p.rn * 9) || ' days')::interval,
           4500 + (p.rn % 4) * 1500,
           (ARRAY['delivered','delivered','sent','queued'])[1 + (p.rn % 4)]::gift_delivery_status,
           'GS-DEMO-' || lpad(p.rn::text, 5, '0'),
           'Demo relationship gift.', p.assigned_rep, true
    FROM pick p
    RETURNING 1)
  SELECT count(*) INTO n FROM ins;
  IF n > 0 THEN table_name := 'gift_sends'; inserted_count := n; RETURN NEXT; END IF;

  UPDATE public.account_stage_history h SET is_demo = true
  FROM public.accounts a WHERE a.id = h.account_id AND a.is_demo AND NOT h.is_demo;
  UPDATE public.touchpoints t SET is_demo = true
  FROM public.accounts a WHERE a.id = t.account_id AND a.is_demo AND NOT t.is_demo;

  RETURN;
END $$;

REVOKE ALL ON FUNCTION public.seed_demo_pipelines() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.seed_demo_pipelines() TO authenticated;

SELECT * FROM public.seed_demo_pipelines();
