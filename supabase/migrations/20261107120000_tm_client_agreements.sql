-- Billing & Costs › T&M Rates › Client agreements (BC-TM-AGR-1).
--
-- The Regular Rates tab has had client agreements since 20261101120000; T&M
-- jobs billed every client the same T&M rates. Now a client can have a T&M
-- agreement too, shaped exactly like the regular one:
--
-- 1. AN AGREEMENT IS EXCEPTIONS ONLY over T&M Rates (money_values book
--    tm_rates, measure bill_rate). A line it names overrides the rate; silence
--    follows the office's T&M rate. Lines are keyed like T&M Rates: a catalog
--    code, or EQ:<type> for an equipment type. One agreement applies to one or
--    many clients (dated links, one primary per client). Owner and admin
--    write it, through tm_agreements_save only, with a note; every change is
--    in the money audit log (book tm_rates).
-- 2. JOBS. A new T&M job takes its client's primary T&M agreement in force
--    (jobs.tm_agreement_id) and freezes it into its sheet (job_tm_rates), like
--    the office rates. A job switched to T&M later picks it up the same way.
--    The office can change a job's agreement (job_tm_agreement_set); the
--    sheet is repriced as of the job's creation day, and every rate typed for
--    that job alone (job_tm_rates.source = 'job') is kept.
-- 3. THE RESOLVER, tm_bill_rates(): job's sheet → the job's T&M agreement →
--    office T&M rate → company T&M rate → none. Agreement rows on the sheet
--    say 'agreement'.
--
-- Re-runnable: IF NOT EXISTS, CREATE OR REPLACE, DROP … IF EXISTS.

-- ============================================================ 1. agreements

CREATE TABLE IF NOT EXISTS public.tm_agreements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  effective_from date NOT NULL DEFAULT current_date,
  note text,
  archived_at timestamptz,
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.tm_agreements IS
  'A client''s T&M agreement: exceptions over T&M Rates (20261107120000). Written only by tm_agreements_save.';
CREATE UNIQUE INDEX IF NOT EXISTS tm_agreements_live_name
  ON public.tm_agreements (lower(btrim(name))) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS public.tm_agreement_lines (
  agreement_id uuid NOT NULL REFERENCES public.tm_agreements(id) ON DELETE CASCADE,
  -- A catalog code, or EQ:<type> — the T&M Rates item key.
  item_key text NOT NULL,
  rate numeric(10,2) NOT NULL CHECK (rate >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agreement_id, item_key)
);

CREATE TABLE IF NOT EXISTS public.tm_agreement_clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agreement_id uuid NOT NULL REFERENCES public.tm_agreements(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  effective_from date NOT NULL DEFAULT current_date,
  effective_to date,
  is_primary boolean NOT NULL DEFAULT false,
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tm_agreement_clients_account
  ON public.tm_agreement_clients (account_id);

-- Everyone signed in reads them (a job shows its agreement); nobody writes
-- them directly.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tm_agreements', 'tm_agreement_lines', 'tm_agreement_clients'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
    EXECUTE format('DROP POLICY IF EXISTS tm_agreements_read ON public.%I', t);
    EXECUTE format('CREATE POLICY tm_agreements_read ON public.%I FOR SELECT TO authenticated USING (true)', t);
    EXECUTE format('DROP POLICY IF EXISTS active_profile_required ON public.%I', t);
    EXECUTE format($p$CREATE POLICY active_profile_required ON public.%I AS RESTRICTIVE FOR ALL TO authenticated
                      USING ((SELECT goldstar_private.profile_is_active(auth.uid())))
                      WITH CHECK ((SELECT goldstar_private.profile_is_active(auth.uid())))$p$, t);
  END LOOP;
END $$;

-- Every change in the money audit log, book tm_rates.
CREATE OR REPLACE FUNCTION public.tg_tm_agreements_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_TABLE_NAME = 'tm_agreement_lines' THEN
    PERFORM public.money_audit_write('tm_rates', 'tm_agreement_line',
      coalesce(NEW.agreement_id, OLD.agreement_id)::text || ':' || coalesce(NEW.item_key, OLD.item_key), 'rate',
      CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD.rate) END,
      CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW.rate) END);
  ELSIF TG_TABLE_NAME = 'tm_agreement_clients' THEN
    PERFORM public.money_audit_write('tm_rates', 'tm_agreement_client',
      coalesce(NEW.agreement_id, OLD.agreement_id)::text, 'applies_to',
      CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE jsonb_build_object(
        'account_id', OLD.account_id, 'effective_from', OLD.effective_from,
        'effective_to', OLD.effective_to, 'primary', OLD.is_primary) END,
      CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE jsonb_build_object(
        'account_id', NEW.account_id, 'effective_from', NEW.effective_from,
        'effective_to', NEW.effective_to, 'primary', NEW.is_primary) END);
  ELSIF TG_OP = 'INSERT' THEN
    PERFORM public.money_audit_write('tm_rates', 'tm_agreement', NEW.id::text, 'created', NULL,
      jsonb_build_object('name', NEW.name, 'effective_from', NEW.effective_from));
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.name IS DISTINCT FROM OLD.name THEN
      PERFORM public.money_audit_write('tm_rates', 'tm_agreement', NEW.id::text, 'name',
        to_jsonb(OLD.name), to_jsonb(NEW.name));
    END IF;
    IF (NEW.archived_at IS NULL) IS DISTINCT FROM (OLD.archived_at IS NULL) THEN
      PERFORM public.money_audit_write('tm_rates', 'tm_agreement', NEW.id::text, 'archived',
        to_jsonb(OLD.archived_at IS NOT NULL), to_jsonb(NEW.archived_at IS NOT NULL));
    END IF;
  END IF;
  RETURN coalesce(NEW, OLD);
END;
$$;
REVOKE ALL ON FUNCTION public.tg_tm_agreements_audit() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS tm_agreements_audit ON public.tm_agreements;
CREATE TRIGGER tm_agreements_audit AFTER INSERT OR UPDATE ON public.tm_agreements
  FOR EACH ROW EXECUTE FUNCTION public.tg_tm_agreements_audit();
DROP TRIGGER IF EXISTS tm_agreement_lines_audit ON public.tm_agreement_lines;
CREATE TRIGGER tm_agreement_lines_audit AFTER INSERT OR UPDATE OR DELETE ON public.tm_agreement_lines
  FOR EACH ROW EXECUTE FUNCTION public.tg_tm_agreements_audit();
DROP TRIGGER IF EXISTS tm_agreement_clients_audit ON public.tm_agreement_clients;
CREATE TRIGGER tm_agreement_clients_audit AFTER INSERT OR UPDATE OR DELETE ON public.tm_agreement_clients
  FOR EACH ROW EXECUTE FUNCTION public.tg_tm_agreements_audit();

-- A client's T&M agreement on a day: the primary in force, else the newest.
CREATE OR REPLACE FUNCTION public.tm_agreement_for(_account_id uuid, _on date)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT c.agreement_id
    FROM public.tm_agreement_clients c
    JOIN public.tm_agreements a ON a.id = c.agreement_id
   WHERE c.account_id = _account_id AND a.archived_at IS NULL
     AND c.effective_from <= _on AND (c.effective_to IS NULL OR c.effective_to >= _on)
   ORDER BY c.is_primary DESC, c.effective_from DESC, c.created_at DESC, c.id DESC
   LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public.tm_agreement_for(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tm_agreement_for(uuid, date) TO authenticated, service_role;

/*
 * The T&M Rates › Client agreements Save (owner/admin), all or nothing, one note:
 *   { op: 'create', name, effective_from? }          → later ops may say agreement_id "new"
 *   { op: 'rename', agreement_id, name } | { op: 'archive', agreement_id }
 *   { op: 'line', agreement_id, code, value }        value null = back to the T&M rate
 *   { op: 'link', agreement_id, account_id, effective_from?, primary? }
 *   { op: 'unlink', assignment_id, effective_to? }   ends it (yesterday by default), never deletes
 *   { op: 'strip_standard', agreement_id }           drops lines equal to the company T&M rate today
 */
CREATE OR REPLACE FUNCTION public.tm_agreements_save(_changes jsonb, _note text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  c jsonb;
  created uuid;
  agr uuid;
  k text;
  v numeric;
  acc uuid;
BEGIN
  IF NOT public.can_manage_agreements(auth.uid()) THEN
    RAISE EXCEPTION 'Only an owner or admin can change client agreements.' USING ERRCODE = '42501';
  END IF;
  IF nullif(btrim(_note), '') IS NULL THEN
    RAISE EXCEPTION 'Say why — every agreement change needs a note.' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(_changes) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Nothing to save.' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('gsr.money_note', btrim(_note), true);
  FOR c IN SELECT * FROM jsonb_array_elements(_changes) LOOP
    agr := CASE WHEN c->>'agreement_id' = 'new' THEN created ELSE nullif(c->>'agreement_id', '')::uuid END;
    IF c->>'op' IN ('rename', 'line', 'link', 'strip_standard')
       AND NOT EXISTS (SELECT 1 FROM public.tm_agreements WHERE id = agr AND archived_at IS NULL) THEN
      RAISE EXCEPTION 'No open T&M agreement %.', coalesce(agr::text, 'given') USING ERRCODE = 'P0002';
    END IF;
    IF c->>'op' IN ('create', 'rename') AND EXISTS (
         SELECT 1 FROM public.tm_agreements a
          WHERE a.archived_at IS NULL AND a.id IS DISTINCT FROM agr
            AND lower(btrim(a.name)) = lower(btrim(c->>'name'))) THEN
      RAISE EXCEPTION 'There is already a T&M agreement called %.', btrim(c->>'name') USING ERRCODE = '23505';
    END IF;

    IF c->>'op' = 'create' THEN
      INSERT INTO public.tm_agreements (name, effective_from, note)
      VALUES (btrim(c->>'name'), coalesce(nullif(c->>'effective_from', '')::date, current_date), btrim(_note))
      RETURNING id INTO created;
    ELSIF c->>'op' = 'rename' THEN
      UPDATE public.tm_agreements SET name = btrim(c->>'name') WHERE id = agr;
    ELSIF c->>'op' = 'archive' THEN
      UPDATE public.tm_agreements SET archived_at = now() WHERE id = agr AND archived_at IS NULL;
      UPDATE public.tm_agreement_clients
         SET effective_to = greatest(effective_from, current_date - 1), is_primary = false
       WHERE agreement_id = agr AND (effective_to IS NULL OR effective_to >= current_date);
    ELSIF c->>'op' = 'line' THEN
      k := c->>'code';
      IF NOT EXISTS (SELECT 1 FROM public.catalog_items WHERE code = k AND in_tm)
         AND NOT EXISTS (SELECT 1 FROM public.equipment_types WHERE 'EQ:' || key = k) THEN
        RAISE EXCEPTION 'No T&M item %.', k USING ERRCODE = 'P0002';
      END IF;
      v := CASE WHEN jsonb_typeof(c->'value') = 'number' THEN (c->>'value')::numeric END;
      IF v IS NOT NULL AND (v < 0 OR v <> round(v, 2)) THEN
        RAISE EXCEPTION 'Rates are dollars and cents, 0 or more (% for %).', v, k USING ERRCODE = '22023';
      END IF;
      IF v IS NULL THEN
        DELETE FROM public.tm_agreement_lines WHERE agreement_id = agr AND item_key = k;
      ELSE
        INSERT INTO public.tm_agreement_lines (agreement_id, item_key, rate)
        VALUES (agr, k, v)
        ON CONFLICT (agreement_id, item_key) DO UPDATE
          SET rate = EXCLUDED.rate, updated_at = now()
          WHERE public.tm_agreement_lines.rate IS DISTINCT FROM EXCLUDED.rate;
      END IF;
    ELSIF c->>'op' = 'link' THEN
      acc := (c->>'account_id')::uuid;
      IF EXISTS (SELECT 1 FROM public.tm_agreement_clients
                  WHERE agreement_id = agr AND account_id = acc
                    AND (effective_to IS NULL OR effective_to >= current_date)) THEN
        CONTINUE;
      END IF;
      IF coalesce((c->>'primary')::boolean, false) THEN
        UPDATE public.tm_agreement_clients SET is_primary = false WHERE account_id = acc AND is_primary;
      END IF;
      INSERT INTO public.tm_agreement_clients (agreement_id, account_id, effective_from, is_primary)
      VALUES (agr, acc, coalesce(nullif(c->>'effective_from', '')::date, current_date),
              coalesce((c->>'primary')::boolean, false)
                OR NOT EXISTS (SELECT 1 FROM public.tm_agreement_clients p
                                WHERE p.account_id = acc
                                  AND (p.effective_to IS NULL OR p.effective_to >= current_date)));
    ELSIF c->>'op' = 'unlink' THEN
      UPDATE public.tm_agreement_clients
         SET effective_to = greatest(effective_from, coalesce(nullif(c->>'effective_to', '')::date, current_date - 1)),
             is_primary = false
       WHERE id = (c->>'assignment_id')::uuid;
    ELSIF c->>'op' = 'strip_standard' THEN
      DELETE FROM public.tm_agreement_lines l
       WHERE l.agreement_id = agr
         AND l.rate = (SELECT r.value FROM public.resolve_money_value(
               'tm_rates', l.item_key, 'bill_rate', NULL, current_date) r);
    ELSE
      RAISE EXCEPTION 'Unknown agreement change %.', coalesce(c->>'op', 'blank') USING ERRCODE = '22023';
    END IF;
  END LOOP;
  RETURN created;
END;
$$;
REVOKE ALL ON FUNCTION public.tm_agreements_save(jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tm_agreements_save(jsonb, text) TO authenticated, service_role;

-- ======================================================= 2. jobs and their sheet

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS tm_agreement_id uuid REFERENCES public.tm_agreements(id) ON DELETE SET NULL;
COMMENT ON COLUMN public.jobs.tm_agreement_id IS
  'The T&M agreement this T&M job bills at (NULL = T&M Rates). Set from the client''s primary at creation; changed with job_tm_agreement_set.';

-- Where each line of a job's T&M sheet came from. 'job' = typed for this job
-- alone; a reprice never touches it.
ALTER TABLE public.job_tm_rates ADD COLUMN IF NOT EXISTS source text;
DO $$
BEGIN
  -- Rows already there: a rate equal to what the office charged the day the
  -- job was made is the frozen sheet; anything else was typed for the job.
  UPDATE public.job_tm_rates jr
     SET source = CASE
           WHEN jr.rate IS NULL OR jr.rate IS NOT DISTINCT FROM (
             SELECT r.value FROM public.jobs j,
                    LATERAL public.resolve_money_value('tm_rates', jr.code, 'bill_rate',
                      coalesce(j.billing_location_id, j.location_id), j.created_at::date) r
              WHERE j.id = jr.job_id)
           THEN 'standard' ELSE 'job' END
   WHERE jr.source IS NULL;
  ALTER TABLE public.job_tm_rates ALTER COLUMN source SET DEFAULT 'job';
  ALTER TABLE public.job_tm_rates ALTER COLUMN source SET NOT NULL;
  ALTER TABLE public.job_tm_rates ADD CONSTRAINT job_tm_rates_source_known
    CHECK (source IN ('standard', 'agreement', 'job'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- A rate changed by anyone but a reprice is the job's own from then on.
CREATE OR REPLACE FUNCTION public.tg_job_tm_rates_source()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF coalesce(current_setting('gsr.tm_reprice', true), '') <> 'on' THEN
    IF TG_OP = 'INSERT' THEN
      NEW.source := 'job';
    ELSIF NEW.rate IS DISTINCT FROM OLD.rate THEN
      NEW.source := 'job';
    ELSE
      NEW.source := OLD.source;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.tg_job_tm_rates_source() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS job_tm_rates_source ON public.job_tm_rates;
CREATE TRIGGER job_tm_rates_source BEFORE INSERT OR UPDATE ON public.job_tm_rates
  FOR EACH ROW EXECUTE FUNCTION public.tg_job_tm_rates_source();

-- A job's sheet from its source: the agreement's line, else the office's
-- T&M rate as of the day the job was made. Lines typed for the job stay.
CREATE OR REPLACE FUNCTION public.job_tm_rates_reprice(_job_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  j record;
  n integer;
BEGIN
  SELECT id, tm_agreement_id, coalesce(billing_location_id, location_id) AS office,
         coalesce(created_at::date, current_date) AS on_day
    INTO j FROM public.jobs WHERE id = _job_id;
  IF j.id IS NULL THEN RETURN 0; END IF;
  PERFORM set_config('gsr.tm_reprice', 'on', true);
  INSERT INTO public.job_tm_rates (job_id, code, rate, cost_rate, source)
  SELECT j.id, t.code, coalesce(al.rate, r.value), cr.value,
         CASE WHEN al.rate IS NOT NULL THEN 'agreement' ELSE 'standard' END
    FROM public.catalog_items t
    LEFT JOIN public.tm_agreement_lines al ON al.agreement_id = j.tm_agreement_id AND al.item_key = t.code
    LEFT JOIN LATERAL public.resolve_money_value('tm_rates', t.code, 'bill_rate', j.office, j.on_day) r ON true
    LEFT JOIN LATERAL public.resolve_money_value('cost', t.code, 'cost_rate', j.office, j.on_day) cr ON true
   WHERE t.in_tm AND t.active AND t.archived_at IS NULL
     AND (al.rate IS NOT NULL OR r.value IS NOT NULL OR cr.value IS NOT NULL)
  ON CONFLICT (job_id, code) DO UPDATE
    SET rate = EXCLUDED.rate, source = EXCLUDED.source
    WHERE public.job_tm_rates.source <> 'job'
      AND (public.job_tm_rates.rate IS DISTINCT FROM EXCLUDED.rate
           OR public.job_tm_rates.source IS DISTINCT FROM EXCLUDED.source);
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM set_config('gsr.tm_reprice', '', true);
  RETURN n;
END;
$$;
REVOKE ALL ON FUNCTION public.job_tm_rates_reprice(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.job_tm_rates_reprice(uuid) TO service_role;

-- A T&M job takes its client's T&M agreement when it is made, or when it
-- becomes T&M. Changing it by hand is the office's (job_tm_agreement_set).
CREATE OR REPLACE FUNCTION public.tg_jobs_tm_agreement()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.tm_agreement_id IS DISTINCT FROM OLD.tm_agreement_id
     AND auth.uid() IS NOT NULL AND NOT public.can_set_job_rates(auth.uid()) THEN
    RAISE EXCEPTION 'Only the office or a manager sets a job''s rates.' USING ERRCODE = '42501';
  END IF;
  IF NEW.job_type = 't_m' AND NEW.tm_agreement_id IS NULL AND NEW.account_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR OLD.job_type IS DISTINCT FROM 't_m') THEN
    NEW.tm_agreement_id := public.tm_agreement_for(NEW.account_id, current_date);
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.tg_jobs_tm_agreement() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS jobs_tm_agreement ON public.jobs;
CREATE TRIGGER jobs_tm_agreement BEFORE INSERT OR UPDATE OF job_type, tm_agreement_id ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.tg_jobs_tm_agreement();

CREATE OR REPLACE FUNCTION public.tg_jobs_tm_agreement_reprice()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.job_tm_rates_reprice(NEW.id);
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.tg_jobs_tm_agreement_reprice() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS jobs_tm_agreement_reprice ON public.jobs;
-- OF job_type too: becoming T&M sets the agreement in the BEFORE trigger,
-- which an OF tm_agreement_id trigger would not see.
CREATE TRIGGER jobs_tm_agreement_reprice AFTER UPDATE OF job_type, tm_agreement_id ON public.jobs
  FOR EACH ROW WHEN (OLD.tm_agreement_id IS DISTINCT FROM NEW.tm_agreement_id)
  EXECUTE FUNCTION public.tg_jobs_tm_agreement_reprice();

-- New jobs freeze their sheet the day they are made: the agreement's lines
-- over the office's T&M rates.
CREATE OR REPLACE FUNCTION public.tg_jobs_snapshot_tm_rates()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM set_config('gsr.tm_reprice', 'on', true);
  INSERT INTO public.job_tm_rates (job_id, code, rate, cost_rate, source)
  SELECT NEW.id, t.code, coalesce(al.rate, r.value), cr.value,
         CASE WHEN al.rate IS NOT NULL THEN 'agreement' ELSE 'standard' END
    FROM public.catalog_items t
    LEFT JOIN public.tm_agreement_lines al ON al.agreement_id = NEW.tm_agreement_id AND al.item_key = t.code
    LEFT JOIN LATERAL public.resolve_money_value('tm_rates', t.code, 'bill_rate',
      coalesce(NEW.billing_location_id, NEW.location_id), current_date) r ON true
    LEFT JOIN LATERAL public.resolve_money_value('cost', t.code, 'cost_rate',
      coalesce(NEW.billing_location_id, NEW.location_id), current_date) cr ON true
   WHERE t.in_tm AND t.active AND t.archived_at IS NULL
     AND (al.rate IS NOT NULL OR r.value IS NOT NULL OR cr.value IS NOT NULL)
  ON CONFLICT (job_id, code) DO NOTHING;
  PERFORM set_config('gsr.tm_reprice', '', true);
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.tg_jobs_snapshot_tm_rates() FROM PUBLIC, anon, authenticated;

/*
 * The office picks a T&M job's agreement (NULL = T&M Rates). The agreement
 * must be one of the job's client's; the sheet is repriced by the trigger.
 */
CREATE OR REPLACE FUNCTION public.job_tm_agreement_set(_job_id uuid, _agreement_id uuid, _note text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  old record;
BEGIN
  IF NOT public.can_set_job_rates(auth.uid()) OR NOT public.can_view_job(auth.uid(), _job_id) THEN
    RAISE EXCEPTION 'Only the office or a manager sets a job''s rates.' USING ERRCODE = '42501';
  END IF;
  SELECT tm_agreement_id, account_id INTO old FROM public.jobs WHERE id = _job_id;
  IF _agreement_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.tm_agreement_clients c JOIN public.tm_agreements a ON a.id = c.agreement_id
        WHERE c.agreement_id = _agreement_id AND c.account_id = old.account_id AND a.archived_at IS NULL) THEN
    RAISE EXCEPTION 'That T&M agreement is not one of this client''s.' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('gsr.money_note', coalesce(btrim(_note), ''), true);
  UPDATE public.jobs SET tm_agreement_id = _agreement_id WHERE id = _job_id;
  PERFORM public.money_audit_write('tm_rates', 'job_rates', _job_id::text, 'tm_agreement',
    to_jsonb(old.tm_agreement_id), to_jsonb(_agreement_id));
END;
$$;
REVOKE ALL ON FUNCTION public.job_tm_agreement_set(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.job_tm_agreement_set(uuid, uuid, text) TO authenticated, service_role;

-- ======================================================= 3. the resolver

CREATE OR REPLACE FUNCTION public.tm_bill_rates(_job_id uuid)
RETURNS TABLE (item_key text, rate numeric, source text, effective_from date)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH j AS (
    SELECT jb.id, jb.tm_agreement_id,
           coalesce(jb.billing_location_id, jb.location_id) AS office,
           jb.created_at::date AS on_day
      FROM public.jobs jb
     WHERE jb.id = _job_id
       AND public.can_view_job(auth.uid(), _job_id)
  ), keys AS (
    SELECT ci.code AS item_key FROM public.catalog_items ci WHERE ci.in_tm
    UNION ALL
    SELECT 'EQ:' || e.key FROM public.equipment_types e
  )
  SELECT k.item_key,
         coalesce(jr.rate, al.rate, r.value),
         CASE WHEN jr.rate IS NOT NULL THEN CASE WHEN jr.source = 'agreement' THEN 'agreement' ELSE 'job' END
              WHEN al.rate IS NOT NULL THEN 'agreement'
              WHEN r.value IS NOT NULL THEN r.source
              ELSE 'none' END,
         CASE WHEN jr.rate IS NULL AND al.rate IS NULL THEN r.effective_from END
    FROM j
    CROSS JOIN keys k
    LEFT JOIN public.job_tm_rates jr ON jr.job_id = j.id AND jr.code = k.item_key
    LEFT JOIN public.tm_agreement_lines al ON al.agreement_id = j.tm_agreement_id AND al.item_key = k.item_key
    LEFT JOIN LATERAL public.resolve_money_value('tm_rates', k.item_key, 'bill_rate', j.office, j.on_day) r
      ON true;
$$;
REVOKE ALL ON FUNCTION public.tm_bill_rates(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tm_bill_rates(uuid) TO authenticated, service_role;

-- Clients on a T&M agreement with T&M jobs already running: those jobs keep
-- their sheet; the office can move one with job_tm_agreement_set.
DO $$
BEGIN
  RAISE NOTICE 'T&M client agreements ready: % agreement(s), % job(s) on one.',
    (SELECT count(*) FROM public.tm_agreements),
    (SELECT count(*) FROM public.jobs WHERE tm_agreement_id IS NOT NULL);
END $$;
