CREATE OR REPLACE FUNCTION public.seed_demo_data()
RETURNS TABLE(table_name text, inserted_count bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  n bigint;
  v_prospect uuid := '22222222-2222-4222-8222-222222222222';
  v_health   uuid := '33333333-3333-4333-8333-333333333333';
  r_renata uuid := 'd0000001-0000-4000-8000-000000000001';
  r_ivo    uuid := 'd0000001-0000-4000-8000-000000000002';
  r_sunny  uuid := 'd0000001-0000-4000-8000-000000000003';
  r_dallas uuid := 'd0000001-0000-4000-8000-000000000004';
  r_pilar  uuid := 'd0000001-0000-4000-8000-000000000005';
  r_arden  uuid := 'd0000001-0000-4000-8000-000000000007';
BEGIN
  -- Owners/admins in the app, or the platform itself during setup.
  IF NOT (public.has_role(auth.uid(),'admin')
          OR public.has_role(auth.uid(),'owner')
          OR current_user IN ('postgres','supabase_admin')) THEN
    RAISE EXCEPTION 'Only owners and admins can seed demo data';
  END IF;

  ---------------------------------------------------------------- accounts
  WITH src(seq, nm, code, stage_key, prio, est, rep, atype) AS (VALUES
    ( 1,'Meridian Property Group','NY','active_client','high',   480000, r_renata,'property_management'),
    ( 2,'Kingsbridge Residential Mgmt','NY','active_client','critical',720000, r_renata,'property_management'),
    ( 3,'Flatbush Co-op Board Alliance','NY','conversation_established','normal',150000, r_renata,'residential'),
    ( 4,'Atlas Facilities Services','NY','active_outreach','normal',210000, r_sunny,'commercial'),
    ( 5,'Prospect Heights Holdings','NY','new_lead_input','high',   95000, r_sunny,'property_management'),
    ( 6,'Harbour Point Management','NY','leads','low',            40000, r_sunny,'property_management'),
    ( 7,'Rockland Estates Management','NY-UP','active_client','normal',260000, NULL,'property_management'),
    ( 8,'Hudson Valley Senior Living','NY-UP','ready','normal',   130000, NULL,'commercial'),
    ( 9,'Ridge Avenue Realty Partners','NJ','active_client','high',390000, r_ivo,'property_management'),
    (10,'Shore Line Condominiums','NJ','meeting_held','normal',   175000, r_ivo,'residential'),
    (11,'Garden State Retail Group','NJ','goasted','low',          60000, r_ivo,'commercial'),
    (12,'Greenwood Apartment Trust','MD','active_client','normal',215000, NULL,'property_management'),
    (13,'Chesapeake Facility Partners','MD','active_outreach','normal',88000, NULL,'commercial'),
    (14,'Coldwater Property Services','NC','active_client','high', 340000, r_arden,'property_management'),
    (15,'Triangle Student Housing','NC','conversation_established','normal',120000, r_arden,'residential'),
    (16,'Wake County Medical Offices','NC','no_service_needed','low',45000, r_arden,'commercial'),
    (17,'Clarkston Community Housing','GA','active_client','normal',180000, r_pilar,'property_management'),
    (18,'Peachtree Industrial Park','GA','new_lead_input','normal', 99000, r_pilar,'commercial'),
    (19,'North Shore Property Mgmt','IL','active_outreach','high', 230000, NULL,'property_management'),
    (20,'Skokie Retail Holdings','IL','goasted','low',             55000, NULL,'commercial'),
    (21,'Marr Road Storage Group','IN','ready','low',              38000, NULL,'commercial'),
    (22,'Melrose Residential Trust','MI','active_client','normal',195000, NULL,'property_management'),
    (23,'Great Lakes Hospitality','MI','leads','normal',           70000, NULL,'commercial'),
    (24,'Hopewell Property Alliance','TX','conversation_established','high',280000, NULL,'property_management'),
    (25,'Bayou City Facilities','TX','active_outreach','normal',  115000, NULL,'commercial'),
    (26,'Slauson Avenue Management','CA','active_client','critical',530000, NULL,'property_management'),
    (27,'Westside Apartment Collective','CA','meeting_booked','high',240000, NULL,'residential'),
    (28,'Pacific Coast Retail Trust','CA','new_lead_input','normal',85000, NULL,'commercial')
  ), ins AS (
    INSERT INTO public.accounts (
      id, name, location_id, assigned_rep, created_by, account_type, status,
      pipeline_id, stage_id, stage, priority, estimated_annual_value,
      lost_reason, no_service_reason_code, approval_state, approval_due_on,
      goasted_at, health_pipeline_id, health_stage_id, health_changed_at,
      last_in_person_at, loss_types, is_demo, created_at, stage_changed_at)
    SELECT
      ('ac000000-0000-4000-8000-' || lpad(s.seq::text, 12, '0'))::uuid,
      s.nm, l.id, s.rep, s.rep, s.atype::account_type,
      CASE WHEN s.stage_key = 'active_client' THEN 'active'
           WHEN s.stage_key IN ('goasted','no_service_needed') THEN 'lost'
           ELSE 'prospect' END::account_status,
      v_prospect, ps.id, s.stage_key, s.prio, s.est,
      CASE WHEN s.stage_key = 'goasted' THEN 'No response after repeated outreach'
           WHEN s.stage_key = 'no_service_needed' THEN 'Uses an in-house maintenance team'
           ELSE NULL END,
      CASE WHEN s.stage_key = 'no_service_needed' THEN 'in_house' ELSE NULL END,
      CASE WHEN s.stage_key = 'new_lead_input' THEN 'pending' ELSE 'not_required' END,
      CASE WHEN s.stage_key = 'new_lead_input'
           THEN CURRENT_DATE - (CASE WHEN s.seq % 2 = 0 THEN 4 ELSE 11 END)
           ELSE NULL END,
      CASE WHEN s.stage_key = 'goasted'
           THEN now() - (CASE WHEN s.seq % 2 = 0 THEN 47 ELSE 12 END || ' days')::interval
           ELSE NULL END,
      CASE WHEN s.stage_key = 'active_client' THEN v_health ELSE NULL END,
      CASE WHEN s.stage_key = 'active_client' THEN hs.id ELSE NULL END,
      CASE WHEN s.stage_key = 'active_client' THEN now() - '6 days'::interval ELSE NULL END,
      CASE WHEN s.stage_key = 'active_client'
           THEN now() - ((100 + s.seq * 11) || ' days')::interval ELSE NULL END,
      CASE WHEN s.atype = 'commercial' THEN ARRAY['water','fire']
           ELSE ARRAY['water','mold'] END,
      true,
      now() - ((300 - s.seq * 7) || ' days')::interval,
      now() - ((30 + s.seq) || ' days')::interval
    FROM src s
    JOIN public.locations l ON l.code = s.code
    JOIN public.pipeline_stages ps ON ps.pipeline_id = v_prospect AND ps.key = s.stage_key
    LEFT JOIN public.pipeline_stages hs ON hs.pipeline_id = v_health AND hs.key =
      (ARRAY['healthy','needs_attention','annual_meeting','ghosted'])[1 + (s.seq % 4)]
    ON CONFLICT (id) DO NOTHING
    RETURNING 1)
  SELECT count(*) INTO n FROM ins;
  IF n > 0 THEN table_name := 'accounts'; inserted_count := n; RETURN NEXT; END IF;

  ---------------------------------------------------------------- contacts
  WITH src(seq, acc, nm, title, drole, policy, pol_notes) AS (VALUES
    ( 1, 1,'Dana Whitfield','Director of Operations','decision_maker','open',NULL),
    ( 2, 1,'Marcus Lieber','Portfolio Manager','regional_manager','approval_required','Requires written pre-approval for anything over $25'),
    ( 3, 2,'Yvette Sandoval','VP Asset Management','decision_maker','prohibited','Company policy forbids accepting any vendor gift or meal'),
    ( 4, 2,'Terrance Bell','Facilities Lead','influencer','unknown',NULL),
    ( 5, 3,'Helen Ostrowski','Board President','decision_maker','open',NULL),
    ( 6, 4,'Ravi Chandrasekar','Regional Facilities Director','decision_maker','approval_required','Must log any hospitality with compliance'),
    ( 7, 5,'Nina Petrakis','Property Manager','decision_maker','unknown',NULL),
    ( 8, 6,'Curtis Mbeki','Operations Coordinator','gatekeeper','unknown',NULL),
    ( 9, 7,'Sharon Delgado','Managing Partner','decision_maker','open',NULL),
    (10, 8,'Peter Nakamura','Facilities Manager','decision_maker','prohibited','Fired a colleague in 2024 over a vendor gift card'),
    (11, 9,'Aaron Feldman','Director of Property Ops','decision_maker','open',NULL),
    (12, 9,'Rochel Stern','Regional Manager','regional_manager','approval_required',NULL),
    (13,10,'Gino Baldassare','Board Treasurer','influencer','unknown',NULL),
    (14,11,'Wendy Kasprzak','Retail Operations Lead','decision_maker','unknown',NULL),
    (15,12,'Denise Aboagye','Portfolio Director','decision_maker','open',NULL),
    (16,13,'Hal Bricker','Facilities Supervisor','influencer','unknown',NULL),
    (17,14,'Miguel Serrano','Regional Director','decision_maker','open',NULL),
    (18,14,'Krista Lundgren','Maintenance Coordinator','gatekeeper','approval_required',NULL),
    (19,15,'Tobias Reinhardt','Housing Director','decision_maker','prohibited','University procurement policy — no gifts of any value'),
    (20,16,'Dr. Alicia Monroe','Practice Administrator','decision_maker','unknown',NULL),
    (21,17,'Fatima Ojo','Community Manager','decision_maker','open',NULL),
    (22,18,'Grant Whitaker','Site Operations Manager','decision_maker','unknown',NULL),
    (23,19,'Bethany Kozlow','VP Property Services','decision_maker','approval_required',NULL),
    (24,20,'Sam Ehrlich','Owner','decision_maker','unknown',NULL),
    (25,21,'Louis Tremblay','General Manager','decision_maker','open',NULL),
    (26,22,'Priya Raghunathan','Director of Residential Ops','decision_maker','open',NULL),
    (27,23,'Doug Farley','Regional Hospitality Manager','regional_manager','prohibited','Hotel group bans supplier gifts outright'),
    (28,24,'Camille Boudreaux','Head of Facilities','decision_maker','open',NULL),
    (29,25,'Everett Nash','Operations Manager','influencer','unknown',NULL),
    (30,26,'Sofia Almeida','SVP Portfolio Operations','decision_maker','approval_required','Anything over $50 needs sign-off'),
    (31,26,'Julian Reyes','Regional Manager, South Bay','regional_manager','open',NULL),
    (32,27,'Monica Trager','Asset Manager','decision_maker','unknown',NULL),
    (33,28,'Bill Hargrove','Retail Portfolio Lead','decision_maker','unknown',NULL)
  ), ins AS (
    INSERT INTO public.contacts (
      id, account_id, full_name, title, decision_role, email, phone,
      gift_policy, gift_policy_notes, is_primary, birthday_month, birthday_day,
      spouse_name, hobbies, preferred_contact_method, best_time_to_reach,
      created_by, is_demo)
    SELECT
      ('c0000000-0000-4000-8000-' || lpad(s.seq::text, 12, '0'))::uuid,
      ('ac000000-0000-4000-8000-' || lpad(s.acc::text, 12, '0'))::uuid,
      s.nm, s.title, s.drole::contact_decision_role,
      lower(regexp_replace(split_part(s.nm,' ',1),'[^a-zA-Z]','','g')) || '.' ||
        lower(regexp_replace(split_part(s.nm,' ',2),'[^a-zA-Z]','','g')) || '@example-demo.invalid',
      '(555) ' || lpad(((s.seq * 37) % 900 + 100)::text, 3, '0') || '-' ||
        lpad(((s.seq * 613) % 9000 + 1000)::text, 4, '0'),
      s.policy::gift_policy, s.pol_notes,
      (s.seq % 3 <> 2),
      1 + (s.seq * 5) % 12, 1 + (s.seq * 7) % 28,
      CASE WHEN s.seq % 4 = 0 THEN 'Spouse noted in relationship file' ELSE NULL END,
      (ARRAY['Golf','Cycling','Fishing','Cooking','Running'])[1 + (s.seq % 5)],
      (ARRAY['email','phone','text'])[1 + (s.seq % 3)],
      (ARRAY['Early morning','Late afternoon','Mid-week'])[1 + (s.seq % 3)],
      a.assigned_rep, true
    FROM src s
    JOIN public.accounts a
      ON a.id = ('ac000000-0000-4000-8000-' || lpad(s.acc::text, 12, '0'))::uuid
    ON CONFLICT (id) DO NOTHING
    RETURNING 1)
  SELECT count(*) INTO n FROM ins;
  IF n > 0 THEN table_name := 'contacts'; inserted_count := n; RETURN NEXT; END IF;

  ---------------------------------------------------------------- touchpoints
  WITH base AS (
    SELECT a.id AS account_id, a.assigned_rep,
           (SELECT c.id FROM public.contacts c
             WHERE c.account_id = a.id ORDER BY c.is_primary DESC, c.full_name LIMIT 1) AS contact_id,
           row_number() OVER (ORDER BY a.name) AS rn
    FROM public.accounts a WHERE a.is_demo
  ), ins AS (
    INSERT INTO public.touchpoints (
      id, account_id, contact_id, type, occurred_at, notes, created_by,
      capture_source, direction, is_self_reported, duration_seconds,
      replied_at, meeting_held, is_demo)
    SELECT
      md5(b.account_id::text || 'tp' || g)::uuid,
      b.account_id, b.contact_id,
      (ARRAY['call','email','meeting_in_person','call','email'])[1 + ((b.rn + g) % 5)]::touchpoint_type,
      now() - ((g * 34 + (b.rn % 11)) || ' days')::interval,
      (ARRAY[
        'Quarterly check-in call. Portfolio stable, no active losses.',
        'Emailed winter freeze-prevention guidance.',
        'On-site meeting — walked two buildings, discussed response times.',
        'Left voicemail, no answer.',
        'Follow-up on vendor onboarding paperwork.'])[1 + ((b.rn + g) % 5)],
      b.assigned_rep,
      (ARRAY['manual','dialer','mailbox'])[1 + ((b.rn + g) % 3)]::capture_source,
      CASE WHEN (b.rn + g) % 4 = 0 THEN 'inbound' ELSE 'outbound' END::comm_direction,
      ((b.rn + g) % 3 = 0),
      CASE WHEN (b.rn + g) % 5 IN (0,3) THEN 120 + (b.rn * 17) % 900 ELSE NULL END,
      CASE WHEN (b.rn + g) % 3 = 0
           THEN now() - ((g * 34 + (b.rn % 11)) || ' days')::interval + '19 hours'::interval
           ELSE NULL END,
      CASE WHEN (1 + ((b.rn + g) % 5)) = 3 THEN true ELSE NULL END,
      true
    FROM base b, generate_series(1, 3) g
    ON CONFLICT (id) DO NOTHING
    RETURNING 1)
  SELECT count(*) INTO n FROM ins;
  IF n > 0 THEN table_name := 'touchpoints'; inserted_count := n; RETURN NEXT; END IF;

  ---------------------------------------------------------------- account notes
  WITH base AS (
    SELECT a.id, a.assigned_rep, row_number() OVER (ORDER BY a.name) AS rn
    FROM public.accounts a WHERE a.is_demo
  ), ins AS (
    INSERT INTO public.account_notes (id, account_id, body, is_pinned, trigger_type, created_by, is_demo, created_at)
    SELECT md5(b.id::text || 'note')::uuid, b.id,
      (ARRAY[
        'Decision maker prefers a call before any site visit.',
        'Budget cycle resets in Q1 — revisit onboarding then.',
        'Gift policy is strict here. Confirm before any send.',
        'Two competing vendors already on the approved list.'])[1 + (b.rn % 4)],
      (b.rn % 4 = 2), 'none', b.assigned_rep, true, now() - ((b.rn * 3) || ' days')::interval
    FROM base b
    ON CONFLICT (id) DO NOTHING
    RETURNING 1)
  SELECT count(*) INTO n FROM ins;
  IF n > 0 THEN table_name := 'account_notes'; inserted_count := n; RETURN NEXT; END IF;

  ---------------------------------------------------------------- tasks
  WITH base AS (
    SELECT a.id, a.location_id, a.assigned_rep,
           row_number() OVER (ORDER BY a.name) AS rn
    FROM public.accounts a WHERE a.is_demo
  ), ins AS (
    INSERT INTO public.tasks (
      id, title, description, assignee, due_date, priority, status,
      entity_type, entity_id, account_id, location_id, source, cadence_key,
      completed_at, created_by, is_demo, created_at)
    SELECT md5(b.id::text || 'task' || g)::uuid,
      (ARRAY['Quarterly touchpoint due','Book annual in-person meeting','Chase COI renewal','Send seasonal guidance email'])[1 + ((b.rn + g) % 4)],
      'Sample task generated from the relationship cadence.',
      b.assigned_rep,
      CURRENT_DATE + ((((b.rn + g * 5) % 27) - 13)::int),
      (ARRAY['normal','high','urgent','low'])[1 + ((b.rn + g) % 4)]::task_priority,
      CASE WHEN (b.rn + g) % 5 = 0 THEN 'done'
           WHEN (b.rn + g) % 5 = 1 THEN 'in_progress'
           ELSE 'open' END::task_status,
      'account', b.id, b.id, b.location_id,
      CASE WHEN (b.rn + g) % 2 = 0 THEN 'automation' ELSE 'manual' END,
      CASE WHEN (b.rn + g) % 2 = 0
           THEN 'quarterly_touchpoint:' || b.id::text || ':' || g::text ELSE NULL END,
      CASE WHEN (b.rn + g) % 5 = 0 THEN now() - '2 days'::interval ELSE NULL END,
      b.assigned_rep, true, now() - ((b.rn + g) || ' days')::interval
    FROM base b, generate_series(1, 2) g
    ON CONFLICT (id) DO NOTHING
    RETURNING 1)
  SELECT count(*) INTO n FROM ins;
  IF n > 0 THEN table_name := 'tasks'; inserted_count := n; RETURN NEXT; END IF;

  ---------------------------------------------------------------- goals
  WITH reps(u, code, metric, target) AS (VALUES
    (r_renata,'NY','touchpoints', 60),
    (r_renata,'NY','meetings_held', 12),
    (r_sunny, 'NY','touchpoints', 180),
    (r_sunny, 'NY','new_accounts', 15),
    (r_ivo,   'NJ','touchpoints', 55),
    (r_ivo,   'NJ','meetings_held', 10),
    (r_pilar, 'GA','touchpoints', 45),
    (r_pilar, 'GA','meetings_held', 14),
    (r_arden, 'NC','touchpoints', 50),
    (r_arden, 'NC','new_accounts', 9)
  ), ins AS (
    INSERT INTO public.goals (
      id, subject_user_id, location_id, metric, target_value, period_type,
      starts_on, ends_on, is_active, set_by, is_demo)
    SELECT md5(rp.u::text || rp.metric)::uuid, rp.u, l.id,
      rp.metric::goal_metric, rp.target, 'quarter',
      date_trunc('quarter', CURRENT_DATE)::date,
      (date_trunc('quarter', CURRENT_DATE) + '3 months'::interval - '1 day'::interval)::date,
      true, rp.u, true
    FROM reps rp JOIN public.locations l ON l.code = rp.code
    ON CONFLICT (id) DO NOTHING
    RETURNING 1)
  SELECT count(*) INTO n FROM ins;
  IF n > 0 THEN table_name := 'goals'; inserted_count := n; RETURN NEXT; END IF;

  ---------------------------------------------------------------- gift catalog
  WITH src(seq, nm, descr, cost) AS (VALUES
    (1,'Gold Star Bakery Box — Classic','Assorted pastries, branded box', 4500),
    (2,'Gold Star Bakery Box — Large','Office-sized assortment', 8500),
    (3,'Branded Insulated Tumbler','Stainless, laser-etched logo', 2200),
    (4,'Winter Preparedness Kit','Freeze-prevention supplies and guide', 3800),
    (5,'Holiday Fruit Basket','Seasonal, kosher-certified', 6500)
  ), ins AS (
    INSERT INTO public.gift_catalog (id, name, description, unit_cost_cents, active, is_demo)
    SELECT ('9f000000-0000-4000-8000-' || lpad(seq::text, 12, '0'))::uuid, nm, descr, cost, true, true
    FROM src
    ON CONFLICT (id) DO NOTHING
    RETURNING 1)
  SELECT count(*) INTO n FROM ins;
  IF n > 0 THEN table_name := 'gift_catalog'; inserted_count := n; RETURN NEXT; END IF;

  ---------------------------------------------------------------- equipment
  WITH src AS (
    SELECT l.id AS location_id, l.code, g,
           row_number() OVER (ORDER BY l.code, g) AS rn
    FROM public.locations l, generate_series(1, 4) g
    WHERE l.active
  ), ins AS (
    INSERT INTO public.equipment (
      id, asset_tag, equipment_type, make, model, serial_number,
      purchase_date, purchase_cost_cents, location_id, status,
      external_tracker_id, is_demo)
    SELECT md5(s.location_id::text || 'eq' || s.g)::uuid,
      'DEMO-' || s.code || '-' || lpad(s.g::text, 3, '0'),
      (ARRAY['air_mover','dehumidifier','air_scrubber','hepa'])[1 + (s.rn % 4)]::equipment_type,
      (ARRAY['Phoenix','Dri-Eaz','B-Air','XPOWER'])[1 + (s.rn % 4)],
      (ARRAY['Axial Pro','LGR 7000XLi','VP-25','X-3400A'])[1 + (s.rn % 4)],
      'SN-' || lpad((s.rn * 7919 % 100000)::text, 6, '0'),
      CURRENT_DATE - ((300 + s.rn * 9)::int),
      (ARRAY[38000, 995000, 210000, 145000])[1 + (s.rn % 4)],
      s.location_id, 'available'::equipment_status,
      'KAI-' || lpad(s.rn::text, 5, '0'), true
    FROM src s
    ON CONFLICT (id) DO NOTHING
    RETURNING 1)
  SELECT count(*) INTO n FROM ins;
  IF n > 0 THEN table_name := 'equipment'; inserted_count := n; RETURN NEXT; END IF;

  ---------------------------------------------------------------- equipment placements
  WITH j AS (
    SELECT id, location_id, row_number() OVER (ORDER BY job_number) AS rn
    FROM public.jobs
    WHERE status IN ('in_progress','drying','scheduled')
    LIMIT 10
  ), e AS (
    SELECT id, location_id, row_number() OVER (PARTITION BY location_id ORDER BY asset_tag) AS erk
    FROM public.equipment WHERE is_demo AND status = 'available'
  ), pairs AS (
    SELECT DISTINCT ON (e.id) j.id AS job_id, e.id AS equipment_id, j.rn, e.erk
    FROM j JOIN e ON e.location_id = j.location_id AND e.erk <= 2
    ORDER BY e.id, j.rn
  ), ins AS (
    INSERT INTO public.equipment_placements (
      id, equipment_id, job_id, placed_at, expected_retrieval_date, notes, is_demo)
    SELECT md5(p.equipment_id::text || p.job_id::text)::uuid,
      p.equipment_id, p.job_id,
      now() - ((10 + p.rn * 2) || ' days')::interval,
      CURRENT_DATE - (CASE WHEN p.erk = 1 THEN 6 ELSE 1 END),
      'Sample placement — retrieval overdue', true
    FROM pairs p
    ON CONFLICT (id) DO NOTHING
    RETURNING 1)
  SELECT count(*) INTO n FROM ins;
  IF n > 0 THEN table_name := 'equipment_placements'; inserted_count := n; RETURN NEXT; END IF;

  ---------------------------------------------------------------- invoices
  WITH j AS (
    SELECT id, location_id, account_id, insurance_carrier, claim_number,
           coalesce(billed_amount, 24500) AS amt,
           row_number() OVER (ORDER BY job_number) AS rn
    FROM public.jobs
    WHERE status IN ('complete','invoiced','paid')
    LIMIT 18
  ), ins AS (
    INSERT INTO public.invoices (
      id, invoice_number, job_id, account_id, location_id, carrier, claim_number,
      adjuster_name, issue_date, due_date, billed_amount, approved_amount,
      status, sent_at, is_demo)
    SELECT md5(j.id::text || 'inv')::uuid,
      'DEMO-INV-' || lpad(j.rn::text, 4, '0'),
      j.id, j.account_id, j.location_id,
      coalesce(j.insurance_carrier, (ARRAY['State Farm','Allstate','Travelers','Chubb'])[1 + (j.rn % 4)]),
      j.claim_number,
      (ARRAY['R. Kimura','D. Okonkwo','S. Petrov','L. Vance'])[1 + (j.rn % 4)],
      CURRENT_DATE - (CASE WHEN j.rn % 4 = 0 THEN 100 WHEN j.rn % 4 = 1 THEN 70 WHEN j.rn % 4 = 2 THEN 40 ELSE 12 END),
      CURRENT_DATE - (CASE WHEN j.rn % 4 = 0 THEN 90 WHEN j.rn % 4 = 1 THEN 60 WHEN j.rn % 4 = 2 THEN 30 ELSE -18 END),
      j.amt, round(j.amt * 0.88, 2),
      'sent'::invoice_status,
      now() - ((30 + j.rn) || ' days')::interval, true
    FROM j
    ON CONFLICT (id) DO NOTHING
    RETURNING 1)
  SELECT count(*) INTO n FROM ins;
  IF n > 0 THEN table_name := 'invoices'; inserted_count := n; RETURN NEXT; END IF;

  ---------------------------------------------------------------- invoice payments
  WITH i AS (
    SELECT id, billed_amount, row_number() OVER (ORDER BY invoice_number) AS rn
    FROM public.invoices WHERE is_demo
  ), ins AS (
    INSERT INTO public.invoice_payments (id, invoice_id, amount, received_at, method, reference, is_demo)
    SELECT md5(i.id::text || 'pay')::uuid, i.id,
      round(i.billed_amount * (CASE WHEN i.rn % 3 = 0 THEN 1.0 ELSE 0.45 END), 2),
      CURRENT_DATE - ((5 + i.rn)::int), 'ach', 'DEMO-PMT-' || lpad(i.rn::text, 4, '0'), true
    FROM i WHERE i.rn % 2 = 1
    ON CONFLICT (id) DO NOTHING
    RETURNING 1)
  SELECT count(*) INTO n FROM ins;
  IF n > 0 THEN table_name := 'invoice_payments'; inserted_count := n; RETURN NEXT; END IF;

  ---------------------------------------------------------------- incidents
  WITH src(seq, code, addr, loc, st, outc) AS (VALUES
    (1,'NY','1140 Ocean Ave','Brooklyn','closed','contract_signed'),
    (2,'NY','88 Utica Ave','Brooklyn','closed','homeowner_declined'),
    (3,'NY','2201 Bedford Ave','Brooklyn','on_scene',NULL),
    (4,'NJ','620 Cross St','Lakewood','accepted',NULL),
    (5,'NJ','15 Pine Blvd','Lakewood','closed','competitor_present'),
    (6,'GA','410 Church St','Clarkston','new',NULL),
    (7,'CA','2900 W Slauson Ave','Los Angeles','dispatched',NULL),
    (8,'MI','19200 Melrose Ave','Southfield','closed','not_real_loss')
  ), ins AS (
    INSERT INTO public.incidents (
      id, source, external_ref, reported_at, raw_text, address, locality, region,
      incident_type, alarm_level, call_sign, status, location_id,
      dispatched_at, accepted_by, accepted_at, arrived_at, outcome, outcome_notes,
      outcome_at, is_demo)
    SELECT ('11000000-0000-4000-8000-' || lpad(s.seq::text, 12, '0'))::uuid,
      'scanner', 'DEMO-INC-' || s.seq,
      now() - ((s.seq * 2) || ' days')::interval,
      '10-75 working fire, all hands operating',
      s.addr, s.loc, l.region, 'fire'::incident_type,
      CASE WHEN s.seq % 3 = 0 THEN '2nd alarm' ELSE '10-75' END,
      '10-75', s.st::incident_status, l.id,
      now() - ((s.seq * 2) || ' days')::interval + '3 minutes'::interval,
      CASE WHEN s.st IN ('accepted','on_scene','closed') THEN r_dallas ELSE NULL END,
      CASE WHEN s.st IN ('accepted','on_scene','closed')
           THEN now() - ((s.seq * 2) || ' days')::interval + '7 minutes'::interval ELSE NULL END,
      CASE WHEN s.st IN ('on_scene','closed')
           THEN now() - ((s.seq * 2) || ' days')::interval + ((14 + s.seq * 3) || ' minutes')::interval ELSE NULL END,
      s.outc::incident_outcome,
      CASE WHEN s.outc IS NOT NULL THEN 'Sample outcome recorded on scene.' ELSE NULL END,
      CASE WHEN s.outc IS NOT NULL
           THEN now() - ((s.seq * 2) || ' days')::interval + '2 hours'::interval ELSE NULL END,
      true
    FROM src s JOIN public.locations l ON l.code = s.code
    ON CONFLICT (id) DO NOTHING
    RETURNING 1)
  SELECT count(*) INTO n FROM ins;
  IF n > 0 THEN table_name := 'incidents'; inserted_count := n; RETURN NEXT; END IF;

  -- Trigger-written child rows inherit the demo flag so the purge sweeps them.
  UPDATE public.incident_events ie SET is_demo = true
  FROM public.incidents i WHERE i.id = ie.incident_id AND i.is_demo AND NOT ie.is_demo;
  UPDATE public.account_stage_history h SET is_demo = true
  FROM public.accounts a WHERE a.id = h.account_id AND a.is_demo AND NOT h.is_demo;

  RETURN;
END;
$fn$;

REVOKE ALL ON FUNCTION public.seed_demo_data() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.seed_demo_data() TO authenticated;

SELECT * FROM public.seed_demo_data();