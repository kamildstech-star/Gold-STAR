-- Demo data lands on demo data only: the seeders never touch a real job.
--
-- UNAPPLIED when written (2026-10-16). Code only — this file re-defines the
-- seed functions; it seeds nothing and deletes nothing when it is applied.
--
-- Found during the 15 Oct work (the purge fix, 20261016120000): Admin → Demo
-- data → Seed attached demo invoices (and their payments) to REAL jobs.
--
--   * seed_demo_data's invoices step chose its jobs with
--       FROM public.jobs WHERE status IN ('complete','invoiced','paid') LIMIT 18
--     — no is_demo filter — so any completed real job could get a sent demo
--     invoice and a demo payment, and the payment rollup then changed that
--     real job's billed / collected figures. Its equipment-placements step had
--     the same unfiltered pick; that step, and the demo equipment it needs,
--     were already cut out on 21 Aug (20260821171822) because the Kahi sync
--     owns equipment. It stays out: placements need equipment, and borrowing a
--     real unit would put a real machine on a demo job.
--
--   * Why a filter alone would not have been enough: the app called
--     seed_demo_jobs() FIRST, and seed_demo_jobs only makes a job for a demo
--     account that already exists. On a fresh seed, or after a purge, there
--     were no demo accounts yet, so no demo job was made at all — and the
--     invoices step found only real jobs. seed_demo_data now makes the demo
--     jobs itself, right after the demo accounts and before the invoices, and
--     src/lib/demo-data.ts calls seed_demo_data first.
--
-- The same class of mistake — a demo row pointing at a parent nobody checked
-- was demo — is fixed everywhere it appeared:
--
--   seed_demo_data      invoices: demo jobs on demo accounts only; payments:
--                       demo invoices on demo jobs only, never a second
--                       payment; contacts: demo accounts only; touchpoints:
--                       the account's demo contact only; every created_by,
--                       assignee and goal owner: a demo profile or nobody.
--   seed_demo_jobs      jobs: demo accounts only; notes, tasks, estimates,
--                       invoices, payments: demo jobs only; scopes and lines:
--                       demo estimates only; reps: demo profiles or nobody.
--   seed_demo_pipelines gift sends: a DEMO catalog item (it took the cheapest
--                       item in the whole catalog, real ones included); next
--                       activities, gifts and contacts: owned by a demo rep or
--                       nobody; the fallback rep list: demo profiles only.
--   seed_demo_visits    in-person visits only for demo accounts held by a demo
--                       rep (a real rep assigned to a demo account was being
--                       credited with demo visits).
--   seed_demo_extras    (not callable from the app since 20260818170611, fixed
--                       anyway) gift campaigns: a demo catalog item; leads:
--                       copied from a demo contact; emails, calendar events
--                       and calls: a demo rep or nobody.
--
-- public.demo_user_or_null(uuid) is the one rule for "which person may own a
-- demo row": the id back when it is a demo profile, else NULL.
--
-- seed_demo_data and seed_demo_jobs are re-defined in full from their LIVE
-- source: the original files plus the in-place edits applied since
-- (20260811200822 loss_types -> what_they_do, 20260821171822 equipment cut,
-- 20260813174824 customer_kind person/company). seed_demo_visits is
-- re-defined in full. seed_demo_pipelines and seed_demo_extras are patched in
-- place, the way those earlier edits were made.
-- Re-runnable.

-- 0. Who may own a demo row.
CREATE OR REPLACE FUNCTION public.demo_user_or_null(_user uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.user_id FROM public.profiles p WHERE p.user_id = _user AND p.is_demo
$$;

REVOKE ALL ON FUNCTION public.demo_user_or_null(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.demo_user_or_null(uuid) TO authenticated, service_role;

-- 1. seed_demo_jobs
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

  -- The sample reps, only while they are demo profiles (see seed_demo_data).
  r_renata := public.demo_user_or_null(r_renata);
  r_ivo    := public.demo_user_or_null(r_ivo);
  r_sunny  := public.demo_user_or_null(r_sunny);
  r_pilar  := public.demo_user_or_null(r_pilar);
  r_arden  := public.demo_user_or_null(r_arden);

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
      CASE WHEN a.account_type = 'residential' THEN 'person' ELSE 'company' END,
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
     AND a.is_demo
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
     AND j.is_demo
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
     AND j.is_demo
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
     AND j.is_demo
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
                  WHERE e.id = ('e5000000-0000-4000-8000-' || lpad(src.est::text, 12, '0'))::uuid
                    AND e.is_demo)
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
     AND e.is_demo
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
     AND j.is_demo
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
     AND j.is_demo
    JOIN public.invoices i ON i.id = md5(j.id::text || 'inv')::uuid AND i.is_demo
    ON CONFLICT (id) DO NOTHING
    RETURNING 1)
  SELECT count(*) INTO n FROM ins;
  IF n > 0 THEN table_name := 'invoice_payments (jobs)'; inserted_count := n; RETURN NEXT; END IF;

  UPDATE public.job_status_history h SET is_demo = true
  FROM public.jobs j WHERE j.id = h.job_id AND j.is_demo AND NOT h.is_demo;

  RETURN;
END;
$fn$;

REVOKE ALL ON FUNCTION public.seed_demo_jobs() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.seed_demo_jobs() TO authenticated, service_role;

-- 2. seed_demo_data
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

  -- The sample reps, only while they are demo profiles. A missing one (purged)
  -- or one that is no longer demo becomes NULL: demo rows are never credited
  -- to a real person's activity, goals or pipeline.
  r_renata := public.demo_user_or_null(r_renata);
  r_ivo    := public.demo_user_or_null(r_ivo);
  r_sunny  := public.demo_user_or_null(r_sunny);
  r_dallas := public.demo_user_or_null(r_dallas);
  r_pilar  := public.demo_user_or_null(r_pilar);
  r_arden  := public.demo_user_or_null(r_arden);

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
      last_in_person_at, what_they_do, is_demo, created_at, stage_changed_at)
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
      public.demo_user_or_null(a.assigned_rep), true
    FROM src s
    JOIN public.accounts a
      ON a.id = ('ac000000-0000-4000-8000-' || lpad(s.acc::text, 12, '0'))::uuid
     AND a.is_demo
    ON CONFLICT (id) DO NOTHING
    RETURNING 1)
  SELECT count(*) INTO n FROM ins;
  IF n > 0 THEN table_name := 'contacts'; inserted_count := n; RETURN NEXT; END IF;

  ---------------------------------------------------------------- touchpoints
  WITH base AS (
    SELECT a.id AS account_id, public.demo_user_or_null(a.assigned_rep) AS assigned_rep,
           (SELECT c.id FROM public.contacts c
             WHERE c.account_id = a.id AND c.is_demo
             ORDER BY c.is_primary DESC, c.full_name LIMIT 1) AS contact_id,
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
    SELECT a.id, public.demo_user_or_null(a.assigned_rep) AS assigned_rep,
           row_number() OVER (ORDER BY a.name) AS rn
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
    SELECT a.id, a.location_id, public.demo_user_or_null(a.assigned_rep) AS assigned_rep,
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
    WHERE rp.u IS NOT NULL
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

  ---------------------------------------------------------------- demo jobs
  -- Invoices hang off jobs, so the demo jobs come first — made here, now that
  -- the demo accounts they belong to exist. This used to be left to a separate
  -- seed_demo_jobs() call the app made BEFORE this function; on a fresh seed
  -- (or after a purge) the demo accounts did not exist yet, no demo job was
  -- made, and the invoices below were attached to real jobs instead.
  -- Idempotent: rows already there are left alone.
  RETURN QUERY SELECT * FROM public.seed_demo_jobs();

  ---------------------------------------------------------------- invoices
  -- DEMO jobs only, on demo accounts. This step used to take any completed
  -- job in the database (no is_demo filter), so up to 18 REAL jobs were
  -- given a demo invoice and a demo payment.
  WITH j AS (
    SELECT jb.id, jb.location_id, jb.account_id, jb.insurance_carrier, jb.claim_number,
           coalesce(jb.billed_amount, 24500) AS amt,
           row_number() OVER (ORDER BY jb.job_number) AS rn
    FROM public.jobs jb
    WHERE jb.is_demo
      AND jb.status IN ('complete','invoiced','paid')
      AND (jb.account_id IS NULL
           OR EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = jb.account_id AND a.is_demo))
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
    SELECT inv.id, inv.billed_amount, row_number() OVER (ORDER BY inv.invoice_number) AS rn
    FROM public.invoices inv
    JOIN public.jobs jb ON jb.id = inv.job_id AND jb.is_demo
    WHERE inv.is_demo
  ), ins AS (
    INSERT INTO public.invoice_payments (id, invoice_id, amount, received_at, method, reference, is_demo)
    SELECT md5(i.id::text || 'pay')::uuid, i.id,
      round(i.billed_amount * (CASE WHEN i.rn % 3 = 0 THEN 1.0 ELSE 0.45 END), 2),
      CURRENT_DATE - ((5 + i.rn)::int), 'ach', 'DEMO-PMT-' || lpad(i.rn::text, 4, '0'), true
    FROM i WHERE i.rn % 2 = 1
      -- seed_demo_jobs() pays its own two invoices; never a second payment.
      -- After the numbering, so a re-seed picks the same invoices as before.
      AND NOT EXISTS (SELECT 1 FROM public.invoice_payments p
                       WHERE p.invoice_id = i.id AND p.id <> md5(i.id::text || 'pay')::uuid)
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

REVOKE ALL ON FUNCTION public.seed_demo_data() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.seed_demo_data() TO authenticated, service_role;

-- 3. seed_demo_visits
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

  SELECT array_agg(DISTINCT a.assigned_rep)
    INTO v_reps
    FROM public.accounts a
    JOIN public.profiles p ON p.user_id = a.assigned_rep AND p.is_demo
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
      -- Demo reps only: a demo visit is someone's logged activity, and a real
      -- rep assigned to a demo account must not be credited with it.
      JOIN public.profiles p ON p.user_id = a.assigned_rep AND p.is_demo
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

REVOKE EXECUTE ON FUNCTION public.seed_demo_visits() FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.seed_demo_visits() TO authenticated, service_role;

-- 4. seed_demo_pipelines, patched in place. Each edit refuses to run if the
-- text it expects is not there, and is skipped if it is already applied.
DO $mig$
DECLARE
  def text;
  froms text[] := ARRAY[
    '(SELECT id FROM public.gift_catalog ORDER BY unit_cost_cents LIMIT 1 OFFSET (p.rn % 3))',
    'SELECT a.id, a.location_id, a.assigned_rep, a.name, s.key',
    'SELECT c.id AS contact_id, c.account_id, a.assigned_rep,',
    'true, true, a.assigned_rep, true',
    'reps := ARRAY[r_renata, r_ivo, r_sunny, r_pilar, r_arden];'
  ];
  tos text[] := ARRAY[
    '(SELECT id FROM public.gift_catalog WHERE is_demo ORDER BY unit_cost_cents LIMIT 1 OFFSET (p.rn % 3))',
    'SELECT a.id, a.location_id, public.demo_user_or_null(a.assigned_rep) AS assigned_rep, a.name, s.key',
    'SELECT c.id AS contact_id, c.account_id, public.demo_user_or_null(a.assigned_rep) AS assigned_rep,',
    'true, true, public.demo_user_or_null(a.assigned_rep), true',
    'reps := array_remove(ARRAY[public.demo_user_or_null(r_renata), public.demo_user_or_null(r_ivo), public.demo_user_or_null(r_sunny), public.demo_user_or_null(r_pilar), public.demo_user_or_null(r_arden)], NULL);'
  ];
  i int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'seed_demo_pipelines';
  IF def IS NULL THEN
    RAISE EXCEPTION 'seed_demo_pipelines not found';
  END IF;
  FOR i IN 1 .. array_length(froms, 1) LOOP
    CONTINUE WHEN position(tos[i] in def) > 0;
    IF position(froms[i] in def) = 0 THEN
      RAISE EXCEPTION 'seed_demo_pipelines: expected text not found: %', froms[i];
    END IF;
    def := replace(def, froms[i], tos[i]);
  END LOOP;
  EXECUTE def;
END
$mig$;

-- 5. seed_demo_extras, patched in place. Not callable from the app, so a
-- missing pattern is reported rather than stopping this migration.
DO $mig$
DECLARE
  def text;
  froms text[] := ARRAY[
    '(SELECT id FROM gift_catalog ORDER BY unit_cost_cents LIMIT 1 OFFSET v.item)',
    'WHERE account_id = a.id ORDER BY is_primary DESC NULLS LAST LIMIT 1',
    'a.id, c.id, a.location_id, a.assigned_rep,',
    '''demo-cal-'' || c.id, a.assigned_rep,',
    'a.id, c.id, a.assigned_rep,'
  ];
  tos text[] := ARRAY[
    '(SELECT id FROM gift_catalog WHERE is_demo ORDER BY unit_cost_cents LIMIT 1 OFFSET v.item)',
    'WHERE account_id = a.id AND is_demo ORDER BY is_primary DESC NULLS LAST LIMIT 1',
    'a.id, c.id, a.location_id, public.demo_user_or_null(a.assigned_rep),',
    '''demo-cal-'' || c.id, public.demo_user_or_null(a.assigned_rep),',
    'a.id, c.id, public.demo_user_or_null(a.assigned_rep),'
  ];
  i int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'seed_demo_extras';
  IF def IS NULL THEN
    RETURN;
  END IF;
  FOR i IN 1 .. array_length(froms, 1) LOOP
    CONTINUE WHEN position(tos[i] in def) > 0;
    IF position(froms[i] in def) = 0 THEN
      RAISE NOTICE 'seed_demo_extras: expected text not found, left as is: %', froms[i];
      CONTINUE;
    END IF;
    def := replace(def, froms[i], tos[i]);
  END LOOP;
  EXECUTE def;
  -- CREATE OR REPLACE keeps grants; restate the 20260818170611 lock anyway.
  REVOKE EXECUTE ON FUNCTION public.seed_demo_extras() FROM authenticated, anon, PUBLIC;
END
$mig$;
