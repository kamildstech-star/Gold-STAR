ALTER TABLE public.locations
  ADD COLUMN IF NOT EXISTS legal_entity_name text,
  ADD COLUMN IF NOT EXISTS ein text,
  ADD COLUMN IF NOT EXISTS payment_options_text text,
  ADD COLUMN IF NOT EXISTS card_payment_url text,
  ADD COLUMN IF NOT EXISTS logo_url text;

UPDATE public.locations
   SET legal_entity_name = 'Gold Star Restoration LLC-' || code
 WHERE legal_entity_name IS NULL;

UPDATE public.locations
   SET payment_options_text = 'Checks payable to ' || coalesce(legal_entity_name, name)
     || E'.\nMail to: ' || address || coalesce(', ' || locality, '') || ', ' || region
     || coalesce(' ' || postal_code, '')
     || E'.\nACH / wire details available on request — call the office.'
 WHERE payment_options_text IS NULL;

ALTER TABLE public.estimate_catalog_items ADD COLUMN IF NOT EXISTS short_name text;
ALTER TABLE public.estimate_lines ADD COLUMN IF NOT EXISTS short_name text;

CREATE OR REPLACE FUNCTION public.seed_demo_jobs()
RETURNS TABLE(table_name text, inserted_count bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  n bigint;
  r_renata uuid := 'd0000001-0000-4000-8000-000000000001';
  r_ivo    uuid := 'd0000001-0000-4000-8000-000000000002';
  r_sunny  uuid := 'd0000001-0000-4000-8000-000000000003';
  r_pilar  uuid := 'd0000001-0000-4000-8000-000000000005';
  r_arden  uuid := 'd0000001-0000-4000-8000-000000000007';
  v_rate numeric := coalesce(
    (SELECT (value->>'tax_rate')::numeric FROM public.app_settings WHERE key = 'estimates'),
    0.08875);
BEGIN
  IF NOT (public.has_role(auth.uid(),'admin')
          OR public.has_role(auth.uid(),'owner')
          OR current_user IN ('postgres','supabase_admin')) THEN
    RAISE EXCEPTION 'Only owners and admins can seed demo data';
  END IF;

  ---------------------------------------------------------------- jobs
  WITH src(seq, code, acct, nm, addr, city, zip, loss, jtype, stat, days_ago, carrier, adjuster,
           est_amt, billed, collected, instr, descr, rep) AS (VALUES
    ( 1,'NY',   1,'Meridian — 40 Clark St, unit 6B','40 Clark Street','Brooklyn','11201','water','insurance','paid',       78,'State Farm','R. Kimura',   28500, 27400, 27400,NULL,'Supply line let go under the kitchen sink overnight; water reached two units below.', 'renata'),
    ( 2,'NY',   2,'Kingsbridge — 1250 Ocean Pkwy lobby','1250 Ocean Parkway','Brooklyn','11230','fire','insurance','invoiced', 41,'Travelers','D. Okonkwo',  96000, 94250, 41000,'Board president must be present for any work in the lobby. No trucks in the driveway before 8am.','Electrical fire in the lobby ceiling; heavy smoke through the first three floors.','renata'),
    ( 3,'NY',   3,'Flatbush co-op — 219 E 21st St basement','219 East 21st Street','Brooklyn','11226','mold','insurance','complete',  22,'Allstate','S. Petrov',     18400, 18400, 0,NULL,'Mold across the basement storage partitions after a slow foundation seep.','renata'),
    ( 4,'NY',   4,'Atlas Facilities — 88 Withers St','88 Withers Street','Brooklyn','11211','water','cash','drying',        4,NULL,NULL,                    12200, NULL, NULL,NULL,'Roof drain backed up into the third-floor office suite.','sunny'),
    ( 5,'NY',   5,'Prospect Heights — 655 Vanderbilt Ave','655 Vanderbilt Avenue','Brooklyn','11238','water','insurance','in_progress',7,'Chubb','L. Vance',    34000, NULL, NULL,'Tenant works nights — no loud equipment before 10am.','Riser failure flooded the stairwell and two hallways.','sunny'),
    ( 6,'NY-UP',7,'Rockland Estates — 12 Maple Ave','12 Maple Avenue','Haverstraw','10927','storm','insurance','scheduled',  2,'Liberty Mutual',NULL,       21500, NULL, NULL,NULL,'Wind-driven rain through a failed skylight; ceilings saturated in three rooms.',NULL),
    ( 7,'NY-UP',8,'Hudson Valley Senior Living — wing C','340 Route 9W','Haverstraw','10927','biohazard','insurance','complete',31,'Travelers','M. Estrada',  15900, 15900, 7500,'Occupied senior facility — all techs badge in at the front desk.','Sewage backup in a shared bathroom in the C wing.',NULL),
    ( 8,'NJ',   9,'Ridge Avenue — 78 Ridge Ave, unit 2','78 Ridge Avenue','Lakewood','08701','water','insurance','paid',      64,'Allstate','D. Okonkwo',      41200, 39800, 39800,NULL,'Washing machine hose burst on the second floor; ceiling below came down.','ivo'),
    ( 9,'NJ',  10,'Shore Line Condos — 22 Beach Blvd','22 Beach Boulevard','Lakewood','08701','mold','cash','in_progress',   9,NULL,NULL,                      9800, NULL, NULL,NULL,'Mold behind the shower wall in two adjacent units.','ivo'),
    (10,'MD',  12,'Greenwood Apartments — 3300 Reisterstown Rd','3300 Reisterstown Road','Baltimore','21215','fire','insurance','in_progress',12,'State Farm','R. Kimura',  72500, NULL, NULL,'Fire marshal release is on file — copy is in Documents.','Kitchen fire in unit 4C, smoke damage down the corridor.',NULL),
    (11,'NC',  14,'Coldwater — 1420 Timber Dr','1420 Timber Drive','Garner','27529','water','insurance','new',              0,'Nationwide',NULL,             0, NULL, NULL,NULL,'Called in this morning — water heater failure in a finished basement.','arden'),
    (12,'GA',  17,'Clarkston Community — 4130 Church St','4130 Church Street','Clarkston','30021','fire','insurance','complete',26,'Chubb','L. Vance',        58400, 58400, 20000,NULL,'Unit fire with heavy soot; contents packed out to storage.','pilar'),
    (13,'IL',  19,'North Shore — 900 Skokie Blvd','900 Skokie Boulevard','Skokie','60077','water','cash','scheduled',        1,NULL,NULL,                      6400, NULL, NULL,NULL,'Sprinkler head discharged in a vacant retail suite.',NULL),
    (14,'TX',  24,'Hopewell — 5511 Almeda Rd','5511 Almeda Road','Houston','77004','storm','insurance','drying',            5,'Farmers','T. Alvarado',        44700, NULL, NULL,NULL,'Roof loss after a hail event; water through the top-floor units.',NULL),
    (15,'CA',  26,'Slauson Ave — 4200 Slauson Ave','4200 Slauson Avenue','Los Angeles','90043','biohazard','cash','new',     0,NULL,NULL,                      0, NULL, NULL,'Contact the site manager, not the tenant.','Unattended death cleanup requested by the management company.',NULL)
  ), ins AS (
    INSERT INTO public.jobs (
      id, job_number, account_id, location_id, job_name, job_type, customer_kind, customer_name,
      address, locality, region, postal_code, loss_type, status, loss_date, call_date, call_time,
      first_response_at, start_date, completion_date, insurance_carrier, claim_number,
      adjuster_name, adjuster_email, adjuster_phone, policy_number, deductible,
      cash_payer_name, agreed_price, payment_terms,
      estimated_amount, billed_amount, collected_amount,
      initial_loss_description, loss_description, important_instructions,
      created_by, is_demo, created_at)
    SELECT
      ('1b000000-0000-4000-8000-' || lpad(s.seq::text, 12, '0'))::uuid,
      'GS-2026-' || lpad((9000 + s.seq)::text, 5, '0'),
      a.id, l.id, s.nm, s.jtype,
      CASE WHEN a.account_type = 'residential' THEN 'residential' ELSE 'commercial' END,
      a.name,
      s.addr, s.city, l.region, s.zip, s.loss::job_loss_type, s.stat::job_status,
      CURRENT_DATE - s.days_ago,
      CURRENT_DATE - s.days_ago,
      (ARRAY['07:20','09:45','13:10','18:35','22:05'])[1 + (s.seq % 5)]::time,
      now() - (s.days_ago || ' days')::interval + '95 minutes'::interval,
      CASE WHEN s.stat = 'new' THEN NULL ELSE CURRENT_DATE - s.days_ago + 1 END,
      CASE WHEN s.stat IN ('complete','invoiced','paid') THEN CURRENT_DATE - s.days_ago + 9 ELSE NULL END,
      s.carrier,
      CASE WHEN s.carrier IS NOT NULL THEN 'CLM-2026-' || lpad((4100 + s.seq)::text, 6, '0') ELSE NULL END,
      s.adjuster,
      CASE WHEN s.adjuster IS NOT NULL
           THEN lower(replace(split_part(s.adjuster, ' ', 2), '.', '')) || '@demo-carrier.example' END,
      CASE WHEN s.adjuster IS NOT NULL THEN '(555) 01' || lpad(s.seq::text, 2, '0') || '-4400' END,
      CASE WHEN s.carrier IS NOT NULL THEN 'POL-' || lpad((77000 + s.seq * 13)::text, 7, '0') ELSE NULL END,
      CASE WHEN s.carrier IS NOT NULL THEN (ARRAY[1000, 2500, 5000])[1 + (s.seq % 3)] ELSE NULL END,
      CASE WHEN s.jtype = 'cash' THEN a.name ELSE NULL END,
      CASE WHEN s.jtype = 'cash' THEN s.est_amt ELSE NULL END,
      CASE WHEN s.jtype = 'cash' THEN '50% deposit, balance on completion' ELSE NULL END,
      nullif(s.est_amt, 0), s.billed, s.collected,
      s.descr, s.descr, s.instr,
      coalesce(CASE s.rep WHEN 'renata' THEN r_renata WHEN 'ivo' THEN r_ivo
                          WHEN 'sunny' THEN r_sunny WHEN 'pilar' THEN r_pilar
                          WHEN 'arden' THEN r_arden END, r_renata),
      true,
      now() - (s.days_ago || ' days')::interval
    FROM src s
    JOIN public.locations l ON l.code = s.code
    JOIN public.accounts a ON a.id = ('ac000000-0000-4000-8000-' || lpad(s.acct::text, 12, '0'))::uuid
    ON CONFLICT (id) DO NOTHING
    RETURNING 1)
  SELECT count(*) INTO n FROM ins;
  IF n > 0 THEN table_name := 'jobs'; inserted_count := n; RETURN NEXT; END IF;

  ---------------------------------------------------------------- job notes
  WITH src(seq, body) AS (VALUES
    ( 1,'Final moisture readings dry standard on all affected assemblies. Homeowner signed the certificate of satisfaction.'),
    ( 2,'Board walkthrough done. Lobby ceiling to be rebuilt after the smoke seal is approved by the adjuster.'),
    ( 2,'Adjuster asked for a room-by-room breakdown before he releases the supplement.'),
    ( 3,'Clearance test passed. Awaiting the co-op board to sign off on the reconstruction scope.'),
    ( 4,'Six air movers and two dehus running. Daily readings logged on the drying tab.'),
    ( 5,'Tenant complained about noise — crew moved the equipment start to 10am as instructed.'),
    ( 7,'Facility asked for a written disinfection protocol for their file. Sent from the Documents tab.'),
    ( 8,'Check scanned by the office; payment posted in full.'),
   (10,'Contents pack-out inventory is being photographed before anything leaves the unit.'),
   (12,'Ozone treatment complete in the affected unit; deodorization holding after 48 hours.'),
   (14,'Roofer tarped the north slope. Interior drying started once the leak stopped.')
  ), ins AS (
    INSERT INTO public.job_notes (id, job_id, author_id, body, is_demo, created_at)
    SELECT md5('jn' || s.seq::text || s.body)::uuid,
           j.id, j.created_by, s.body, true, j.created_at + '2 days'::interval
    FROM src s
    JOIN public.jobs j ON j.id = ('1b000000-0000-4000-8000-' || lpad(s.seq::text, 12, '0'))::uuid
    ON CONFLICT (id) DO NOTHING
    RETURNING 1)
  SELECT count(*) INTO n FROM ins;
  IF n > 0 THEN table_name := 'job_notes'; inserted_count := n; RETURN NEXT; END IF;

  ---------------------------------------------------------------- job tasks & meetings
  WITH src(seq, title, descr, due_in, prio, stat) AS (VALUES
    ( 2,'Site meeting with the board president','Walk the lobby scope before reconstruction starts.', 2,'high','open'),
    ( 2,'Send the room-by-room breakdown to the adjuster',NULL, 1,'urgent','open'),
    ( 4,'Pull equipment once readings hit dry standard',NULL, 2,'normal','open'),
    ( 5,'Daily drying check — 655 Vanderbilt',NULL, 1,'normal','open'),
    ( 6,'Confirm scheduled start with the property manager',NULL, 1,'high','open'),
    (10,'Meet the fire marshal on site','Confirm release for the corridor work.', 3,'high','open'),
    (11,'First response call — water heater failure','Call the customer back and schedule today.', 0,'urgent','open'),
    (12,'Return the packed-out contents',NULL, 5,'normal','open'),
    (13,'Site meeting with the retail landlord',NULL, 1,'normal','open'),
    ( 3,'Collect the signed clearance report',NULL, -3,'normal','done')
  ), ins AS (
    INSERT INTO public.tasks (
      id, title, description, assignee, due_date, due_time, priority, status,
      entity_type, entity_id, job_id, account_id, location_id, source, created_by,
      completed_at, is_demo, created_at)
    SELECT md5('jt' || s.seq::text || s.title)::uuid,
      s.title, s.descr, j.created_by, CURRENT_DATE + s.due_in,
      (ARRAY['08:30','10:00','14:30'])[1 + (s.seq % 3)]::time,
      s.prio::task_priority, s.stat::task_status,
      'job', j.id, j.id, j.account_id, j.location_id, 'manual', j.created_by,
      CASE WHEN s.stat = 'done' THEN now() - '3 days'::interval ELSE NULL END,
      true, j.created_at + '1 day'::interval
    FROM src s
    JOIN public.jobs j ON j.id = ('1b000000-0000-4000-8000-' || lpad(s.seq::text, 12, '0'))::uuid
    ON CONFLICT (id) DO NOTHING
    RETURNING 1)
  SELECT count(*) INTO n FROM ins;
  IF n > 0 THEN table_name := 'tasks (jobs)'; inserted_count := n; RETURN NEXT; END IF;

  ---------------------------------------------------------------- estimates
  WITH src(seq, job_seq, title, stat, days_ago) AS (VALUES
    (1,  2,'Lobby fire & smoke restoration','sent',     18),
    (2,  5,'Emergency water mitigation','approved',      6),
    (3, 10,'Unit 4C fire cleanup and contents','draft',  4)
  ), ins AS (
    INSERT INTO public.estimates (
      id, job_id, location_id, status, title, call_date, estimate_date,
      job_number, customer_name, account_id, address, locality, region, postal_code,
      office_name, office_phone, office_email, office_address,
      tax_rate, notes, created_by, is_demo, created_at, sent_at, decided_at)
    SELECT ('e5000000-0000-4000-8000-' || lpad(s.seq::text, 12, '0'))::uuid,
      j.id, j.location_id, s.stat::estimate_status, s.title, j.call_date,
      CURRENT_DATE - s.days_ago,
      j.job_number, j.customer_name, j.account_id, j.address, j.locality, j.region, j.postal_code,
      l.name, l.office_phone, l.office_email,
      concat_ws(', ', l.address, l.locality, l.region, l.postal_code),
      v_rate,
      'Sample estimate. Pricing reflects the current catalog defaults.',
      j.created_by, true, now() - (s.days_ago || ' days')::interval,
      CASE WHEN s.stat IN ('sent','approved') THEN now() - (s.days_ago || ' days')::interval END,
      CASE WHEN s.stat = 'approved' THEN now() - '2 days'::interval END
    FROM src s
    JOIN public.jobs j ON j.id = ('1b000000-0000-4000-8000-' || lpad(s.job_seq::text, 12, '0'))::uuid
    JOIN public.locations l ON l.id = j.location_id
    ON CONFLICT (id) DO NOTHING
    RETURNING 1)
  SELECT count(*) INTO n FROM ins;
  IF n > 0 THEN table_name := 'estimates'; inserted_count := n; RETURN NEXT; END IF;

  ---------------------------------------------------------------- estimate scopes
  WITH src(est, pos, nm, room) AS (VALUES
    (1, 0,'Fire & Smoke','Lobby'),
    (1, 1,'Reconstruction','Lobby ceiling'),
    (2, 0,'Water Mitigation','Stairwell'),
    (2, 1,'Water Mitigation','2nd floor hallway'),
    (3, 0,'Fire & Smoke','Unit 4C kitchen'),
    (3, 1,'Contents','Unit 4C')
  ), ins AS (
    INSERT INTO public.estimate_scopes (id, estimate_id, name, room_name, position)
    SELECT md5('es' || src.est::text || src.pos::text)::uuid,
      ('e5000000-0000-4000-8000-' || lpad(src.est::text, 12, '0'))::uuid,
      src.nm, src.room, src.pos
    FROM src
    WHERE EXISTS (SELECT 1 FROM public.estimates e
                  WHERE e.id = ('e5000000-0000-4000-8000-' || lpad(src.est::text, 12, '0'))::uuid)
    ON CONFLICT (id) DO NOTHING
    RETURNING 1)
  SELECT count(*) INTO n FROM ins;
  IF n > 0 THEN table_name := 'estimate_scopes'; inserted_count := n; RETURN NEXT; END IF;

  ---------------------------------------------------------------- estimate lines
  WITH src(est, scope_pos, pos, item_code, qty) AS (VALUES
    (1,0,0,'LAB-EMER',      1),
    (1,0,1,'FIR-SOOT',   3200),
    (1,0,2,'FIR-SEAL',   1800),
    (1,0,3,'FIR-HYDRO',     6),
    (1,0,4,'LAB-TECH',     64),
    (1,1,0,'RCN-DRY',    1400),
    (1,1,1,'RCN-PAINT',  1400),
    (1,1,2,'RCN-BASE',    220),
    (2,0,0,'LAB-EMER',      1),
    (2,0,1,'WTR-EXT',     900),
    (2,0,2,'WTR-DRY',     140),
    (2,0,3,'WTR-AM',       24),
    (2,0,4,'WTR-DEHU',      8),
    (2,1,0,'WTR-CARP',    620),
    (2,1,1,'WTR-MON',       5),
    (3,0,0,'FIR-DEBRIS',   14),
    (3,0,1,'FIR-SOOT',   1100),
    (3,0,2,'FIR-OZONE',     2),
    (3,1,0,'CNT-PACK',     85),
    (3,1,1,'CNT-CLEAN',    18),
    (3,1,2,'CNT-STOR',      2)
  ), ins AS (
    INSERT INTO public.estimate_lines (
      id, estimate_id, scope_id, catalog_item_id, position, code, name, description,
      uom, quantity, unit_cost, unit_price, taxable)
    SELECT md5('el' || s.est::text || s.scope_pos::text || s.pos::text)::uuid,
      e.id, sc.id, ci.id, s.pos, ci.code, ci.name, ci.description,
      ci.uom, s.qty, ci.default_cost, ci.default_unit_price, ci.taxable
    FROM src s
    JOIN public.estimates e ON e.id = ('e5000000-0000-4000-8000-' || lpad(s.est::text, 12, '0'))::uuid
    JOIN public.estimate_scopes sc ON sc.id = md5('es' || s.est::text || s.scope_pos::text)::uuid
    JOIN public.estimate_catalog_items ci ON ci.code = s.item_code
    ON CONFLICT (id) DO NOTHING
    RETURNING 1)
  SELECT count(*) INTO n FROM ins;
  IF n > 0 THEN table_name := 'estimate_lines'; inserted_count := n; RETURN NEXT; END IF;

  ---------------------------------------------------------------- invoices (paid + balance due)
  WITH src(job_seq, num, billed, approved, collected, stat, issued_ago, due_ago) AS (VALUES
    ( 8,'DEMO-INV-9008', 39800.00, 39800.00, 39800.00,'paid',    52, 22),
    ( 2,'DEMO-INV-9002', 94250.00, 88700.00, 41000.00,'partial', 34,  4)
  ), ins AS (
    INSERT INTO public.invoices (
      id, invoice_number, job_id, account_id, location_id, carrier, claim_number,
      adjuster_name, adjuster_email, issue_date, due_date, billed_amount,
      approved_amount, collected_amount, status, sent_at, notes, created_by, is_demo)
    SELECT md5(j.id::text || 'inv')::uuid, s.num, j.id, j.account_id, j.location_id,
      j.insurance_carrier, j.claim_number, j.adjuster_name, j.adjuster_email,
      CURRENT_DATE - s.issued_ago, CURRENT_DATE - s.due_ago,
      s.billed, s.approved, s.collected, s.stat::invoice_status,
      now() - (s.issued_ago || ' days')::interval,
      CASE WHEN s.stat = 'paid' THEN 'Paid in full — check scanned by the office.'
           ELSE 'Carrier released a partial payment; balance is in follow-up.' END,
      j.created_by, true
    FROM src s
    JOIN public.jobs j ON j.id = ('1b000000-0000-4000-8000-' || lpad(s.job_seq::text, 12, '0'))::uuid
    ON CONFLICT (id) DO NOTHING
    RETURNING 1)
  SELECT count(*) INTO n FROM ins;
  IF n > 0 THEN table_name := 'invoices (jobs)'; inserted_count := n; RETURN NEXT; END IF;

  ---------------------------------------------------------------- invoice payments
  WITH src(job_seq, amt, ago, meth, ref) AS (VALUES
    ( 8, 39800.00, 20,'check','CHK-118420'),
    ( 2, 41000.00,  9,'ach',  'ACH-559013')
  ), ins AS (
    INSERT INTO public.invoice_payments (id, invoice_id, amount, received_at, method, reference, is_demo)
    SELECT md5(i.id::text || 'demopay')::uuid, i.id, s.amt, CURRENT_DATE - s.ago, s.meth, s.ref, true
    FROM src s
    JOIN public.jobs j ON j.id = ('1b000000-0000-4000-8000-' || lpad(s.job_seq::text, 12, '0'))::uuid
    JOIN public.invoices i ON i.id = md5(j.id::text || 'inv')::uuid
    ON CONFLICT (id) DO NOTHING
    RETURNING 1)
  SELECT count(*) INTO n FROM ins;
  IF n > 0 THEN table_name := 'invoice_payments (jobs)'; inserted_count := n; RETURN NEXT; END IF;

  UPDATE public.job_status_history h SET is_demo = true
  FROM public.jobs j WHERE j.id = h.job_id AND j.is_demo AND NOT h.is_demo;

  RETURN;
END;
$fn$;