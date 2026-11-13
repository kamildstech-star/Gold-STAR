CREATE OR REPLACE FUNCTION public.seed_demo_extras()
RETURNS TABLE(table_name text, inserted_count bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  PIPE constant uuid := '22222222-2222-4222-8222-222222222222';
  u1 constant uuid := 'd0000001-0000-4000-8000-000000000001';
  u2 constant uuid := 'd0000001-0000-4000-8000-000000000002';
  u3 constant uuid := 'd0000001-0000-4000-8000-000000000003';
  u4 constant uuid := 'd0000001-0000-4000-8000-000000000004';
  u5 constant uuid := 'd0000001-0000-4000-8000-000000000005';
  u6 constant uuid := 'd0000001-0000-4000-8000-000000000006';
  u7 constant uuid := 'd0000001-0000-4000-8000-000000000007';
  loc_ny uuid; loc_nj uuid; loc_md uuid; loc_ca uuid;
  st_ready uuid; st_outreach uuid; st_conv uuid;
  jb uuid[];
  n bigint;
BEGIN
  SELECT id INTO loc_ny FROM locations WHERE code = 'NY';
  SELECT id INTO loc_nj FROM locations WHERE code = 'NJ';
  SELECT id INTO loc_md FROM locations WHERE code = 'MD';
  SELECT id INTO loc_ca FROM locations WHERE code = 'CA';
  SELECT id INTO st_ready    FROM pipeline_stages WHERE pipeline_id = PIPE AND key = 'ready';
  SELECT id INTO st_outreach FROM pipeline_stages WHERE pipeline_id = PIPE AND key = 'active_outreach';
  SELECT id INTO st_conv     FROM pipeline_stages WHERE pipeline_id = PIPE AND key = 'conversation_established';
  SELECT array_agg(id ORDER BY job_number) INTO jb FROM jobs WHERE is_demo;

  -- Clear anything a previous extras run created.
  DELETE FROM gift_campaign_recipients WHERE is_demo;
  DELETE FROM gift_sends WHERE is_demo;
  DELETE FROM gift_campaigns WHERE is_demo;
  DELETE FROM photo_folders WHERE is_demo;
  DELETE FROM projects WHERE is_demo;
  DELETE FROM vehicle_positions WHERE is_demo;
  DELETE FROM vehicles WHERE is_demo;
  DELETE FROM time_entries WHERE is_demo;
  DELETE FROM shifts WHERE is_demo;
  DELETE FROM expenses WHERE is_demo;
  DELETE FROM expense_requests WHERE is_demo;
  DELETE FROM reminders WHERE is_demo;
  DELETE FROM notifications WHERE is_demo;
  DELETE FROM quote_line_items WHERE is_demo;
  DELETE FROM quotes WHERE is_demo;
  DELETE FROM job_reports WHERE is_demo;
  DELETE FROM documents WHERE is_demo;
  DELETE FROM vendor_documents WHERE is_demo;
  DELETE FROM email_messages WHERE is_demo;
  DELETE FROM calendar_events WHERE is_demo;
  DELETE FROM captured_communications WHERE is_demo;
  DELETE FROM escalation_rules WHERE is_demo;
  DELETE FROM automation_rules WHERE is_demo;
  DELETE FROM commission_plans WHERE is_demo;
  DELETE FROM pay_structures WHERE is_demo;
  DELETE FROM feature_requests WHERE is_demo;

  ---------------------------------------------------------------- accounts the old seeder dropped
  INSERT INTO accounts (id, name, location_id, assigned_rep, status, stage_id, pipeline_id,
                        estimated_annual_value, created_by, is_demo)
  VALUES
    ('ac000000-0000-4000-8000-000000000010', 'Newark Ironbound Holdings', loc_nj, u2, 'prospect', st_conv, PIPE, 180000, u2, true),
    ('ac000000-0000-4000-8000-000000000027', 'Sunset Bay Property Group', loc_ca, u5, 'prospect', st_outreach, PIPE, 145000, u5, true)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO contacts (id, account_id, full_name, email, phone, title, gift_policy, is_primary, created_by, is_demo)
  VALUES
    ('c0000000-0000-4000-8000-000000000013', 'ac000000-0000-4000-8000-000000000010', 'Gina Moretti', 'gina@ironboundholdings.example', '(973) 555-0142', 'Director of Operations', 'open', true, u2, true),
    ('c0000000-0000-4000-8000-000000000032', 'ac000000-0000-4000-8000-000000000027', 'Marcus Chen', 'mchen@sunsetbaypg.example', '(310) 555-0188', 'Portfolio Manager', 'approval_required', true, u5, true)
  ON CONFLICT (id) DO NOTHING;

  ---------------------------------------------------------------- leads out of the pipeline, into the inbox
  DELETE FROM fire_leads WHERE is_demo;

  INSERT INTO fire_leads (source_system, source_record_id, jurisdiction, source_ref, title, org_name, address,
                          contact_name, contact_email, contact_phone, location_id, assigned_rep,
                          intake_kind, approval_state, approval_due_on, value_amount, status,
                          incident_date, is_demo)
  SELECT 'inbox',
         a.id::text,
         'demo',
         jsonb_build_object('origin_account_id', a.id, 'migrated_from_stage', s.key),
         a.name,
         a.name,
         l.locality || ', ' || l.region,
         c.full_name, c.email, c.phone,
         a.location_id, a.assigned_rep,
         CASE WHEN s.key = 'new_lead_input' THEN 'rep_entered' ELSE 'sourced' END,
         CASE WHEN s.key = 'new_lead_input' THEN
                CASE WHEN a.approval_due_on < current_date THEN 'escalated' ELSE 'pending' END
              ELSE 'not_required' END,
         a.approval_due_on,
         a.estimated_annual_value,
         'open'::lead_status,
         a.created_at::date,
         true
  FROM accounts a
  JOIN pipeline_stages s ON s.id = a.stage_id
  LEFT JOIN locations l ON l.id = a.location_id
  LEFT JOIN LATERAL (
    SELECT full_name, email, phone FROM contacts
     WHERE account_id = a.id ORDER BY is_primary DESC NULLS LAST LIMIT 1
  ) c ON true
  WHERE a.is_demo AND s.key IN ('leads', 'new_lead_input');

  UPDATE accounts a
     SET archived_at = COALESCE(a.archived_at, now()), archived_by = u1
    FROM pipeline_stages s
   WHERE s.id = a.stage_id AND a.is_demo AND s.key IN ('leads','new_lead_input');

  ---------------------------------------------------------------- gifts, batched by month
  INSERT INTO gift_campaigns (id, name, occasion, target_month, target_year, location_id, catalog_item_id, status, notes, created_by, is_demo)
  SELECT v.id, v.name, v.occasion::gift_occasion, v.month, 2026, v.loc,
         (SELECT id FROM gift_catalog ORDER BY unit_cost_cents LIMIT 1 OFFSET v.item), v.status::gift_campaign_status, v.notes, u1, true
  FROM (VALUES
    ('ef000000-0000-4000-8000-000000000001'::uuid, 'March Purim baskets — NY book', 'jewish_holiday', 3::smallint, loc_ny, 1, 'sent',   'Batched for the NY managed-property book.'),
    ('ef000000-0000-4000-8000-000000000002'::uuid, 'June thank-you — NJ referrals',  'thank_you',     6::smallint, loc_nj, 0, 'sent',   'Plumbers and brokers who referred work in Q2.'),
    ('ef000000-0000-4000-8000-000000000003'::uuid, 'September Rosh Hashanah baskets','jewish_holiday',9::smallint, loc_ny, 2, 'approved','Prohibited-policy contacts excluded automatically.'),
    ('ef000000-0000-4000-8000-000000000004'::uuid, 'December seasonal — MD book',    'seasonal',     12::smallint, loc_md, 1, 'draft',  'Awaiting Sales Head approval.')
  ) AS v(id, name, occasion, month, loc, item, status, notes);

  INSERT INTO gift_campaign_recipients (campaign_id, contact_id, account_id, excluded_reason, approved, is_demo)
  SELECT camp.id, c.id, c.account_id,
         CASE WHEN c.gift_policy = 'prohibited'
              THEN 'Excluded automatically — this contact''s employer prohibits vendor gifts'
              WHEN c.gift_policy = 'approval_required' AND camp.status = 'draft'
              THEN 'Holding for written approval from the contact''s employer'
              ELSE NULL END,
         (c.gift_policy <> 'prohibited' AND NOT (c.gift_policy = 'approval_required' AND camp.status = 'draft')),
         true
  FROM gift_campaigns camp
  JOIN accounts a ON a.is_demo AND a.archived_at IS NULL
   AND (camp.location_id IS NULL OR a.location_id = camp.location_id)
  JOIN contacts c ON c.account_id = a.id AND c.is_demo
  WHERE camp.is_demo;

  INSERT INTO gift_sends (campaign_id, contact_id, account_id, catalog_item_id, sent_at, cost_cents, delivery_status, tracking_ref, notes, created_by, is_demo)
  SELECT r.campaign_id, r.contact_id, r.account_id, camp.catalog_item_id,
         make_date(2026, camp.target_month, 12) + interval '9 hours',
         COALESCE(gc.unit_cost_cents, 4500),
         (ARRAY['delivered','delivered','delivered','sent','returned'])[1 + (abs(hashtext(r.id::text)) % 5)]::gift_delivery_status,
         'GS-GIFT-' || upper(substr(replace(r.id::text,'-',''), 1, 8)),
         NULL, u1, true
  FROM gift_campaign_recipients r
  JOIN gift_campaigns camp ON camp.id = r.campaign_id
  LEFT JOIN gift_catalog gc ON gc.id = camp.catalog_item_id
  WHERE r.is_demo AND r.approved AND camp.status IN ('sent','sending');

  ---------------------------------------------------------------- photo projects
  INSERT INTO projects (id, name, address, locality, region, loss_type, location_id, job_id,
                        customer_name, customer_phone, status, created_by, is_demo)
  SELECT ('60000000-0000-4000-8000-0000000000' || lpad(i::text, 2, '0'))::uuid,
         j.job_number || ' — ' || initcap(lower(j.address)),
         j.address, 'Brooklyn', 'NY', j.loss_type, j.location_id, j.id,
         'Demo Customer ' || i, '(718) 555-01' || lpad(i::text, 2, '0'),
         CASE WHEN j.status IN ('paid','complete') THEN 'archived' ELSE 'active' END::project_status,
         u6, true
  FROM (SELECT j.*, row_number() OVER (ORDER BY job_number) AS i FROM jobs j WHERE j.is_demo) j
  WHERE j.i <= 8;

  INSERT INTO photo_folders (project_id, name, sort_order, created_by, is_demo)
  SELECT p.id, f.name, f.ord, u6, true
  FROM projects p
  CROSS JOIN (VALUES ('Before', 1), ('Demolition', 2), ('Drying', 3), ('After', 4)) AS f(name, ord)
  WHERE p.is_demo;

  ---------------------------------------------------------------- fleet
  INSERT INTO vehicles (provider, external_id, label, location_id, assigned_user_id, last_lat, last_lon, last_position_at, ignition, is_demo)
  VALUES
    ('raven','DEMO-RVN-101','Box Truck 101 — Brooklyn', loc_ny, u4, 40.6782, -73.9442, now() - interval '6 minutes', true, true),
    ('raven','DEMO-RVN-102','Box Truck 102 — Brooklyn', loc_ny, u6, 40.6501, -73.9496, now() - interval '21 minutes', true, true),
    ('raven','DEMO-RVN-103','Van 103 — Queens',        loc_ny, u1, 40.7282, -73.7949, now() - interval '2 hours', false, true),
    ('raven','DEMO-RVN-201','Box Truck 201 — Lakewood', loc_nj, u2, 40.0959, -74.2179, now() - interval '35 minutes', true, true),
    ('raven','DEMO-RVN-301','Van 301 — Baltimore',      loc_md, u7, 39.2904, -76.6122, now() - interval '4 hours', false, true),
    ('raven','DEMO-RVN-401','Box Truck 401 — Los Angeles', loc_ca, u5, 34.0522, -118.2437, now() - interval '52 minutes', true, true);

  INSERT INTO vehicle_positions (vehicle_id, occurred_at, lat, lon, speed_mph, heading, ignition, is_demo)
  SELECT v.id,
         now() - (g * interval '11 minutes'),
         v.last_lat + (g * 0.0031), v.last_lon - (g * 0.0027),
         CASE WHEN g % 4 = 0 THEN 0 ELSE 12 + (g * 3) % 34 END,
         (g * 37) % 360, g % 4 <> 0, true
  FROM vehicles v CROSS JOIN generate_series(1, 8) g
  WHERE v.is_demo;

  ---------------------------------------------------------------- shifts and labour
  INSERT INTO shifts (id, user_id, location_id, clock_in_at, clock_out_at, total_minutes, status, approved_by, approved_at, is_demo)
  SELECT ('70000000-0000-4000-8000-0000000000' || lpad(row_number() OVER ()::text, 2, '0'))::uuid,
         s.uid, loc_ny,
         (current_date - s.d) + time '07:30',
         CASE WHEN s.d = 0 THEN NULL ELSE (current_date - s.d) + time '16:45' END,
         CASE WHEN s.d = 0 THEN NULL ELSE 555 END,
         CASE WHEN s.d = 0 THEN 'open' WHEN s.d <= 2 THEN 'closed' ELSE 'approved' END::shift_status,
         CASE WHEN s.d > 2 THEN u1 END,
         CASE WHEN s.d > 2 THEN now() - (s.d * interval '1 day') END,
         true
  FROM (SELECT uid, d FROM unnest(ARRAY[u4, u6]::uuid[]) uid CROSS JOIN generate_series(0, 5) d) s;

  INSERT INTO time_entries (shift_id, user_id, job_id, started_at, ended_at, minutes, work_date, entry_type, status, entered_by, is_demo)
  SELECT sh.id, sh.user_id, jb[1 + (abs(hashtext(sh.id::text || g::text)) % LEAST(array_length(jb,1), 10))],
         sh.clock_in_at + ((g - 1) * interval '4 hours'),
         sh.clock_in_at + (g * interval '4 hours') - interval '25 minutes',
         215,
         sh.clock_in_at::date,
         CASE WHEN g = 1 THEN 'labour' ELSE 'travel' END::time_entry_type,
         CASE WHEN sh.status = 'approved' THEN 'approved' ELSE 'submitted' END::time_entry_status,
         sh.user_id, true
  FROM shifts sh CROSS JOIN generate_series(1, 2) g
  WHERE sh.is_demo AND sh.clock_out_at IS NOT NULL;

  ---------------------------------------------------------------- expenses
  INSERT INTO expense_requests (user_id, location_id, kind, amount, merchant, purpose, threshold_at_request, status, requested_at, decided_by, decided_at, is_demo)
  VALUES
    (u1, loc_ny, 'company_card', 128.40, 'Home Depot', 'Replacement air-mover filters for the Grant Ave job', 50, 'approved', now() - interval '3 days', u1, now() - interval '3 days' + interval '11 minutes', true),
    (u4, loc_ny, 'company_card', 62.10,  'Shell',      'Fuel — overnight chase coverage', 50, 'auto_approved', now() - interval '2 days', NULL, NULL, true),
    (u2, loc_nj, 'company_card', 340.00, 'Sherwin-Williams', 'Sealer for the Ridge Ave reconstruction', 50, 'pending', now() - interval '6 hours', NULL, NULL, true),
    (u5, loc_ca, 'general',      88.75,  'Panera',     'Lunch for the Slauson Ave broker meeting', 50, 'declined', now() - interval '9 days', u1, now() - interval '9 days' + interval '2 hours', true),
    (u7, loc_md, 'company_card', 51.20,  'Uline',      'Containment tape and poly', 50, 'approved', now() - interval '15 days', u1, now() - interval '15 days' + interval '40 minutes', true);

  INSERT INTO expenses (user_id, location_id, kind, amount, spent_on, merchant, description, card_last4, reimbursed, created_by, is_demo)
  SELECT v.uid, v.loc, v.kind::expense_kind, v.amt, current_date - v.ago, v.merch, v.descr, v.last4, v.reimb, v.uid, true
  FROM (VALUES
    (u1, loc_ny, 'company_card', 128.40, 3,  'Home Depot',       'Air-mover filters',        '4417', false),
    (u1, loc_ny, 'gas_card',      74.22, 5,  'BP',               'Fuel',                     '4417', false),
    (u2, loc_nj, 'auto_stipend', 450.00, 12, 'Gold Star Payroll','Monthly vehicle stipend',  NULL,   true),
    (u2, loc_nj, 'company_card',  96.15, 8,  'Lowes',            'Moisture meter batteries', '9082', false),
    (u4, loc_ny, 'gas_card',      62.10, 2,  'Shell',            'Fuel — chase coverage',    '3310', false),
    (u4, loc_ny, 'general',       23.85, 6,  'Dunkin',           'Crew coffee, night call',  NULL,   true),
    (u5, loc_ca, 'car_payment',  612.00, 20, 'Gold Star Fleet',  'Vehicle payment',          NULL,   true),
    (u5, loc_ca, 'company_card', 141.60, 11, 'Chevron',          'Fuel and tolls',           '7741', false),
    (u6, loc_ny, 'company_card',  58.99, 4,  'Uline',            'Poly sheeting',            '2288', false),
    (u7, loc_md, 'company_card',  51.20, 15, 'Uline',            'Containment tape',         '5510', true),
    (u7, loc_md, 'gas_card',      69.40, 9,  'Exxon',            'Fuel',                     '5510', false),
    (u3, loc_ny, 'general',       18.00, 1,  'MTA',              'Subway — broker drop-ins', NULL,   false)
  ) AS v(uid, loc, kind, amt, ago, merch, descr, last4, reimb);

  ---------------------------------------------------------------- notifications and reminders
  INSERT INTO notifications (user_id, type, title, body, entity_type, entity_id, href, priority, read_at, created_at, is_demo)
  SELECT v.uid, v.t::notification_type, v.title, v.body, v.et, v.eid, v.href, v.prio::notification_priority,
         CASE WHEN v.readx THEN now() - interval '4 hours' END, now() - (v.ago * interval '1 hour'), true
  FROM (VALUES
    (u1, 'task_overdue',        'Task overdue: quarterly touch',       'Meridian Property Group is 9 days past its quarterly touch.', 'account', 'ac000000-0000-4000-8000-000000000001'::uuid, '/farming', 'high',   false, 2),
    (u1, 'account_meeting_due', 'Annual in-person meeting window open', 'Kingsbridge Residential Mgmt — window closes in 11 days.',   'account', 'ac000000-0000-4000-8000-000000000002'::uuid, '/farming', 'normal', false, 7),
    (u1, 'invoice_paid',        'Payment received',                     'A check was scanned for one of your jobs.',                  'job',     jb[1], '/jobs', 'normal', true, 26),
    (u2, 'record_stalled',      'Opportunity stalled 21 days',          'Ridge Avenue Realty Partners has had no activity.',          'account', 'ac000000-0000-4000-8000-000000000009'::uuid, '/pipeline', 'high', false, 5),
    (u2, 'job_assigned',        'You were assigned a job',              'GS-2026-0004 — water loss, White Plains Road.',              'job',     jb[4], '/jobs', 'normal', true, 30),
    (u3, 'automation_task',     'Automation created a task',            'No activity for 14 days — call queue task created.',         'account', 'ac000000-0000-4000-8000-000000000004'::uuid, '/tasks', 'normal', false, 3),
    (u4, 'incident_new',        'New incident in your area',            'Fire reported — Bedford Avenue. Accept to chase.',           'incident', NULL, '/fire-chase', 'urgent', false, 1),
    (u4, 'incident_unaccepted', 'Incident still unaccepted',            'Nobody has accepted the Flatbush incident.',                 'incident', NULL, '/fire-chase', 'urgent', false, 1),
    (u5, 'vendor_doc_expiring', 'COI expires in 21 days',               'Slauson Avenue Management — certificate of insurance.',      'account', 'ac000000-0000-4000-8000-000000000026'::uuid, '/accounts', 'normal', false, 12),
    (u5, 'expense_decision',    'Expense declined',                     'Your $88.75 Panera expense was declined.',                   'expense', NULL, '/expenses', 'low', true, 40),
    (u6, 'job_status_changed',  'Job moved to Drying',                  'GS-2026-0004 is now drying.',                                'job',     jb[4], '/jobs', 'low', true, 18),
    (u7, 'task_due_today',      'Two tasks due today',                  'Coldwater Property Services and Triangle Student Housing.',  'account', 'ac000000-0000-4000-8000-000000000014'::uuid, '/tasks', 'normal', false, 4)
  ) AS v(uid, t, title, body, et, eid, href, prio, readx, ago);

  INSERT INTO reminders (entity_type, entity_id, user_id, remind_at, offset_minutes, is_demo)
  SELECT 'account', t.account_id, t.assignee, (t.due_date + time '09:00') - interval '1 hour', 60, true
  FROM tasks t
  WHERE t.is_demo AND t.assignee IS NOT NULL AND t.due_date IS NOT NULL AND t.account_id IS NOT NULL
  LIMIT 8;

  ---------------------------------------------------------------- feature requests
  INSERT INTO feature_requests (title, description, category, status, priority, submitted_by, submitter_name, submitter_role, submitter_location_id, submitter_location_name, created_at, is_demo)
  VALUES
    ('One-tap "log arrival" from the truck', 'On a chase I have gloves on. I want a single big button on the phone lock screen widget.', 'Fire Chase', 'planned', 'high', u4, 'Dallas Crowther (demo)', 'field_chaser', loc_ny, 'Brooklyn, NY', now() - interval '9 days', true),
    ('Show days-since-last-touch on the farm table', 'The date is there but I count the days in my head every morning.', 'Farming', 'completed', 'normal', u1, 'Renata Vozniak (demo)', 'sales_person', loc_ny, 'Brooklyn, NY', now() - interval '21 days', true),
    ('Photos upload stall on bad signal', 'In a basement the upload spins forever and I do not know if it saved.', 'Bug', 'in_progress', 'urgent', u6, 'Boone Hallstead (demo)', 'crew', loc_ny, 'Brooklyn, NY', now() - interval '4 days', true),
    ('Dial the next number automatically', 'After I log a call the queue should advance without me tapping back.', 'Dialer', 'reviewed', 'high', u3, 'Sunny Okafor (demo)', 'cold_caller', loc_ny, 'Brooklyn, NY', now() - interval '2 days', true),
    ('Spanish on the customer update report', 'Half my customers in Garner want it in Spanish.', 'Reports', 'new', 'normal', u7, 'Arden Kwiatkowski (demo)', 'sales_person', loc_ny, 'Brooklyn, NY', now() - interval '1 day', true),
    ('Export my own pipeline to Excel', 'I want to work my list offline on the train.', 'Exports', 'dismissed', 'low', u2, 'Ivo Marchetti (demo)', 'sales_person', loc_nj, 'Lakewood, NJ', now() - interval '30 days', true);

  UPDATE feature_requests
     SET dismissed_reason = 'Export is deliberately restricted to Sales Head and Owner, and every export is logged.',
         dismissed_at = now() - interval '29 days'
   WHERE is_demo AND status = 'dismissed';

  ---------------------------------------------------------------- quotes
  INSERT INTO quotes (id, job_id, location_id, version, status, title, xactimate_reference, subtotal, tax, total, submitted_at, created_by, is_demo)
  SELECT ('80000000-0000-4000-8000-0000000000' || lpad(j.i::text, 2, '0'))::uuid,
         j.id, j.location_id, 1,
         (ARRAY['submitted','approved','internal_review','draft','approved','submitted'])[j.i]::quote_status,
         'Scope of work — ' || j.job_number,
         'XA-2026-' || lpad(j.i::text, 4, '0'),
         (8400 + j.i * 1350), (8400 + j.i * 1350) * 0.08875, (8400 + j.i * 1350) * 1.08875,
         now() - (j.i * interval '3 days'), u1, true
  FROM (SELECT j.*, row_number() OVER (ORDER BY job_number) AS i FROM jobs j WHERE j.is_demo) j
  WHERE j.i <= 6;

  INSERT INTO quote_line_items (quote_id, position, description, category, quantity, unit, unit_price, is_demo)
  SELECT q.id, li.pos, li.descr, li.cat::quote_category, li.qty, li.unit, li.price, true
  FROM quotes q
  CROSS JOIN (VALUES
    (1, 'Water extraction — affected floor area', 'mitigation', 1400, 'sqft', 1.85),
    (2, 'Air movers, 4 days', 'equipment', 24, 'unit-day', 32.00),
    (3, 'Dehumidifier, 4 days', 'equipment', 8, 'unit-day', 78.00),
    (4, 'Antimicrobial application', 'materials', 1400, 'sqft', 0.42),
    (5, 'Debris disposal', 'disposal', 3, 'load', 285.00)
  ) AS li(pos, descr, cat, qty, unit, price)
  WHERE q.is_demo;

  ---------------------------------------------------------------- documents and vendor paperwork
  INSERT INTO documents (location_id, job_id, doc_type, name, status, storage_bucket, storage_path, mime, size_bytes, created_by, is_demo)
  SELECT j.location_id, j.id, d.dt::document_type,
         d.label || ' — ' || j.job_number, d.st::document_status,
         'documents', 'demo/' || j.job_number || '/' || d.slug || '.pdf', 'application/pdf', 180000 + (j.i * 4200), u1, true
  FROM (SELECT j.*, row_number() OVER (ORDER BY job_number) AS i FROM jobs j WHERE j.is_demo) j
  CROSS JOIN (VALUES
    ('work_authorization', 'Work authorization', 'signed', 'work-auth'),
    ('direction_to_pay',   'Direction to pay',   'signed', 'dtp'),
    ('certificate_of_completion', 'Certificate of completion', 'pending_signature', 'coc')
  ) AS d(dt, label, st, slug)
  WHERE j.i <= 5;

  INSERT INTO vendor_documents (account_id, kind, name, status, expiry_date, storage_path, created_by, is_demo)
  SELECT a.id, d.kind::vendor_doc_kind, d.label,
         CASE WHEN d.kind = 'coi' AND (abs(hashtext(a.id::text)) % 4) = 0 THEN 'expired'
              WHEN (abs(hashtext(a.id::text || d.kind)) % 5) = 0 THEN 'pending'
              ELSE 'active' END::vendor_doc_status,
         CASE WHEN d.kind = 'coi' THEN current_date + ((abs(hashtext(a.id::text)) % 300) - 30) END,
         'vendor-docs/demo/' || a.id || '-' || d.kind || '.pdf',
         u1, true
  FROM accounts a
  CROSS JOIN (VALUES ('coi', 'Certificate of insurance'), ('w9', 'W-9')) AS d(kind, label)
  WHERE a.is_demo AND a.archived_at IS NULL AND a.status = 'active';

  ---------------------------------------------------------------- job reports (human-approved)
  INSERT INTO job_reports (job_id, location_id, report_type, language, version, status, narrative, snapshot, generated_by, approved_by, approved_at, is_demo)
  SELECT j.id, j.location_id, r.rt::job_report_type, r.lang, 1, r.st::job_report_status,
         r.narrative, jsonb_build_object('job_number', j.job_number, 'loss_type', j.loss_type, 'status', j.status),
         u1, CASE WHEN r.st = 'approved' THEN u1 END, CASE WHEN r.st = 'approved' THEN now() - interval '2 days' END, true
  FROM (SELECT j.*, row_number() OVER (ORDER BY job_number) AS i FROM jobs j WHERE j.is_demo) j
  CROSS JOIN (VALUES
    ('carrier_submission', 'en', 'approved', 'Mitigation began within four hours of first notice. Moisture readings, equipment placement and daily drying logs are attached. Affected assemblies were dried in place where readings permitted; removal was limited to materials at or above saturation.'),
    ('customer_update',    'es', 'draft',    'El equipo completó la extracción de agua y colocó equipos de secado. Volveremos cada día para tomar lecturas de humedad hasta que la estructura esté seca.'),
    ('internal_review',    'en', 'approved', 'Time to arrival was inside target. Labour hours ran slightly over scope because of stairwell access. No change order was raised.')
  ) AS r(rt, lang, st, narrative)
  WHERE j.i <= 2;

  ---------------------------------------------------------------- auto-capture: email, calendar, calls
  INSERT INTO email_messages (category, to_emails, cc_emails, subject, body_html, account_id, contact_id, location_id, sent_by, status, queued_at, sent_at, delivered_at, opened_at, is_demo)
  SELECT 'follow_up', ARRAY[c.email], ARRAY[]::text[],
         'Following up — ' || a.name,
         '<p>Hi ' || split_part(c.full_name, ' ', 1) || ', following up on our conversation about coverage for your buildings.</p>',
         a.id, c.id, a.location_id, a.assigned_rep,
         (ARRAY['delivered','opened','sent','delivered','bounced'])[1 + (abs(hashtext(c.id::text)) % 5)]::email_status,
         now() - (row_number() OVER (ORDER BY c.id) * interval '2 days'),
         now() - (row_number() OVER (ORDER BY c.id) * interval '2 days') + interval '3 minutes',
         now() - (row_number() OVER (ORDER BY c.id) * interval '2 days') + interval '4 minutes',
         CASE WHEN abs(hashtext(c.id::text)) % 2 = 0 THEN now() - (row_number() OVER (ORDER BY c.id) * interval '2 days') + interval '2 hours' END,
         true
  FROM contacts c JOIN accounts a ON a.id = c.account_id
  WHERE c.is_demo AND a.archived_at IS NULL AND c.email IS NOT NULL
  LIMIT 12;

  INSERT INTO calendar_events (provider, external_id, user_id, account_id, contact_id, subject, body_preview, location_text, starts_at, ends_at, attendees, is_demo)
  SELECT 'outlook', 'demo-cal-' || c.id, a.assigned_rep, a.id, c.id,
         'In-person review — ' || a.name,
         'Annual relationship review. Bring the loss summary for the last twelve months.',
         l.locality || ', ' || l.region,
         date_trunc('hour', now()) + ((row_number() OVER (ORDER BY c.id)) * interval '1 day') + interval '10 hours',
         date_trunc('hour', now()) + ((row_number() OVER (ORDER BY c.id)) * interval '1 day') + interval '11 hours',
         jsonb_build_array(jsonb_build_object('name', c.full_name, 'email', c.email, 'response', 'accepted')),
         true
  FROM contacts c
  JOIN accounts a ON a.id = c.account_id
  LEFT JOIN locations l ON l.id = a.location_id
  WHERE c.is_demo AND c.is_primary AND a.archived_at IS NULL
  LIMIT 8;

  INSERT INTO captured_communications (provider, external_id, channel, direction, occurred_at, duration_seconds,
                                       from_address, to_address, subject, body_preview, outcome,
                                       recording_consent_state, account_id, contact_id, user_id, raw, is_demo)
  SELECT 'callrail', 'demo-call-' || c.id || '-' || g,
         CASE WHEN g = 3 THEN 'sms' ELSE 'call' END,
         (CASE WHEN g = 2 THEN 'inbound' ELSE 'outbound' END)::comm_direction,
         now() - ((g * 3 + (abs(hashtext(c.id::text)) % 11)) * interval '1 day'),
         CASE WHEN g = 3 THEN NULL ELSE 60 + (abs(hashtext(c.id::text || g::text)) % 540) END,
         '+18779592837', c.phone,
         CASE WHEN g = 3 THEN 'SMS' ELSE NULL END,
         CASE WHEN g = 3 THEN 'Confirming Thursday at 10. — sent from a Gold Star company number'
              WHEN g = 2 THEN 'Inbound: asked about response time for an overnight loss.'
              ELSE 'Outbound: left voicemail about the annual review.' END,
         (ARRAY['connected','voicemail','no_answer','connected'])[1 + (abs(hashtext(c.id::text || g::text)) % 4)],
         CASE WHEN g = 3 THEN NULL ELSE 'disclosure_played' END,
         a.id, c.id, a.assigned_rep,
         jsonb_build_object('demo', true, 'source', 'seed'),
         true
  FROM contacts c
  JOIN accounts a ON a.id = c.account_id
  CROSS JOIN generate_series(1, 3) g
  WHERE c.is_demo AND a.archived_at IS NULL AND c.phone IS NOT NULL;

  ---------------------------------------------------------------- rules, pay
  INSERT INTO escalation_rules (location_id, name, record_type, statuses, stale_days, target_kind, target_user_id, step2_days, step2_target_kind, active, created_by, is_demo)
  VALUES
    (loc_ny, 'Opportunity with no movement (14 days)', 'account', ARRAY['prospect'], 14, 'record_owner', NULL, 21, 'location_manager', true, u1, true),
    (loc_ny, 'Invoice unpaid past 30 days',            'invoice', ARRAY['sent'],     30, 'collector',    NULL, 60, 'location_manager', true, u1, true),
    (loc_nj, 'Rep-entered lead not approved in 7 days','lead',    ARRAY['new'],       7, 'location_manager', NULL, NULL, NULL, true, u1, true);

  INSERT INTO automation_rules (location_id, name, description, trigger_type, trigger_config, conditions, actions, run_order, is_active, is_system, created_by, is_demo)
  VALUES
    (loc_ny, 'No activity for 14 days — create a call task', 'Creates an internal call task for the owner. Never contacts the client.', 'no_activity', '{"days":14}', '{"pipeline":"prospecting"}', '[{"type":"create_task","title":"No activity in 14 days — call the account","due_in_days":1,"assign_to":"record_owner"}]', 10, true, false, u1, true),
    (loc_ny, 'Rotting in Active Outreach', 'Flags the card and notifies the Sales Head.', 'stage_rot', '{"stage":"active_outreach","days":10}', '{}', '[{"type":"flag"},{"type":"notify","target":"sales_head"}]', 20, true, false, u1, true),
    (loc_ny, 'Task past due — notify the manager', 'Internal notification only.', 'task_past_due', '{"days":7}', '{}', '[{"type":"notify","target":"location_manager"}]', 30, true, false, u1, true),
    (loc_nj, 'Deal won — open the onboarding checklist', 'Creates internal onboarding tasks.', 'deal_won', '{}', '{}', '[{"type":"create_task","title":"Collect COI and W-9","due_in_days":3,"assign_to":"record_owner"}]', 40, false, false, u1, true);

  INSERT INTO pay_structures (user_id, pay_type, base_salary_annual, draw_amount, draw_period, draw_recoverable, effective_from, note, created_by, is_demo)
  VALUES
    (u1, 'combination', 62000, 2000, 'monthly', true,  date '2026-01-01', 'Recoverable draw against commission.', u1, true),
    (u2, 'draw',        NULL,  2500, 'monthly', true,  date '2025-07-01', 'Draw only.', u1, true),
    (u3, 'salary',      48000, NULL, NULL,      false, date '2026-01-01', 'Cold-caller, no commission.', u1, true),
    (u5, 'commission',  NULL,  NULL, NULL,      false, date '2025-04-01', 'Outside rep, pure commission.', u1, true),
    (u7, 'combination', 58000, 1500, 'monthly', false, date '2026-02-01', 'Non-recoverable draw.', u1, true);

  INSERT INTO commission_plans (user_id, deal_source, basis, rate_percent, tiers, effective_from, note, created_by, is_demo)
  VALUES
    (u1, 'self_generated', 'collected', 6.0, '[{"to":250000,"rate":6},{"to":null,"rate":8}]', date '2026-01-01', 'Paid on cash collected, never on invoiced.', u1, true),
    (u1, 'house',          'collected', 3.0, '[]', date '2026-01-01', NULL, u1, true),
    (u2, 'self_generated', 'collected', 6.5, '[]', date '2025-07-01', NULL, u1, true),
    (u5, 'referral',       'collected', 4.0, '[]', date '2025-04-01', 'Referral-sourced work.', u1, true),
    (u7, 'self_generated', 'gross_profit', 12.0, '[]', date '2026-02-01', NULL, u1, true);

  RETURN QUERY
  SELECT t.tbl, t.cnt FROM (
    SELECT 'fire_leads (inbox)'::text tbl, count(*) cnt FROM fire_leads WHERE is_demo
    UNION ALL SELECT 'gift_campaigns', count(*) FROM gift_campaigns WHERE is_demo
    UNION ALL SELECT 'gift_campaign_recipients', count(*) FROM gift_campaign_recipients WHERE is_demo
    UNION ALL SELECT 'gift_sends', count(*) FROM gift_sends WHERE is_demo
    UNION ALL SELECT 'projects', count(*) FROM projects WHERE is_demo
    UNION ALL SELECT 'photo_folders', count(*) FROM photo_folders WHERE is_demo
    UNION ALL SELECT 'vehicles', count(*) FROM vehicles WHERE is_demo
    UNION ALL SELECT 'vehicle_positions', count(*) FROM vehicle_positions WHERE is_demo
    UNION ALL SELECT 'shifts', count(*) FROM shifts WHERE is_demo
    UNION ALL SELECT 'time_entries', count(*) FROM time_entries WHERE is_demo
    UNION ALL SELECT 'expenses', count(*) FROM expenses WHERE is_demo
    UNION ALL SELECT 'expense_requests', count(*) FROM expense_requests WHERE is_demo
    UNION ALL SELECT 'notifications', count(*) FROM notifications WHERE is_demo
    UNION ALL SELECT 'reminders', count(*) FROM reminders WHERE is_demo
    UNION ALL SELECT 'feature_requests', count(*) FROM feature_requests WHERE is_demo
    UNION ALL SELECT 'quotes', count(*) FROM quotes WHERE is_demo
    UNION ALL SELECT 'quote_line_items', count(*) FROM quote_line_items WHERE is_demo
    UNION ALL SELECT 'documents', count(*) FROM documents WHERE is_demo
    UNION ALL SELECT 'vendor_documents', count(*) FROM vendor_documents WHERE is_demo
    UNION ALL SELECT 'job_reports', count(*) FROM job_reports WHERE is_demo
    UNION ALL SELECT 'email_messages', count(*) FROM email_messages WHERE is_demo
    UNION ALL SELECT 'calendar_events', count(*) FROM calendar_events WHERE is_demo
    UNION ALL SELECT 'captured_communications', count(*) FROM captured_communications WHERE is_demo
    UNION ALL SELECT 'escalation_rules', count(*) FROM escalation_rules WHERE is_demo
    UNION ALL SELECT 'automation_rules', count(*) FROM automation_rules WHERE is_demo
    UNION ALL SELECT 'pay_structures', count(*) FROM pay_structures WHERE is_demo
    UNION ALL SELECT 'commission_plans', count(*) FROM commission_plans WHERE is_demo
  ) t ORDER BY t.tbl;
END;
$fn$;

REVOKE ALL ON FUNCTION public.seed_demo_extras() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.seed_demo_extras() TO authenticated, service_role;

DO $$ BEGIN PERFORM public.seed_demo_extras(); END $$;