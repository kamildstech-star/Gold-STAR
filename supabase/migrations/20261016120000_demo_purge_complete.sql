-- Admin → Demo data → Remove: make it finish, and leave nothing demo behind.
--
-- UNAPPLIED when written (2026-10-16). David, 15 Oct: before production every
-- demo job and every demo CRM record must go, reliably. Read against the
-- migrations, the purge (purge_demo_data, 20260810182946) had one hard
-- failure and three leftovers:
--
--   1. IT COULD NOT FINISH. invoices_refuse_issued_delete (20261006181000)
--      refuses to delete any invoice that was sent, ruled on or paid unless
--      its job is already gone — and demo_tables() deletes invoices BEFORE
--      jobs. Every seeded demo invoice is sent, paid or partial, so the purge
--      raised "… can't be deleted — it has been sent, ruled on or paid" and
--      the whole transaction rolled back: nothing was removed. The guard now
--      lets a DEMO invoice through while the purge is running (a
--      transaction-local flag only this function sets). Real invoices are
--      exactly as protected as before.
--
--   2. A real incident linked to a demo job (incidents.job_id is NO ACTION)
--      would also have stopped the purge. Such incidents are detached
--      (job_id set null) first; the incident itself is real and is kept.
--
--   3. The Timeline (activity_log) has no foreign keys, so every demo job's,
--      account's and invoice's history stayed behind as orphan rows. Rows
--      whose record_id is a demo row, or whose detail names a demo job or
--      account, are now removed with it.
--
--   4. A few job-scoped tables with no is_demo column point at jobs with ON
--      DELETE SET NULL, so what was added on a demo job survived unlinked:
--      saved calculator estimates (job_calculations), equipment alerts and
--      customer-portal invitations. Those rows only ever meant something on
--      that demo job; they are removed with it. Inventory history
--      (supply_requests / receipts / stock moves) is deliberately NOT touched
--      — deleting a stock move would change stock counts — it is left
--      detached, as before.
--
--   And demo users still referenced by real rows through a NO ACTION foreign
--   key (a deal reassigned to a demo rep, say) no longer abort everything:
--   that user is kept and reported as "profiles (kept, still referenced)".
--
-- What it still does not do: delete files from Storage. Rows that pointed at
-- files (seeded documents under documents/demo/…, anything uploaded on a demo
-- job) are deleted; the files stay in the bucket. Supabase does not support
-- deleting storage objects from SQL; empty the "demo/" folder in the
-- dashboard if the space matters.
--
-- Same signature and return shape as before, so the Admin page and
-- purgeDemoData() need no change. Owners and admins only, as before.
-- Re-runnable.

-- 1. The invoice guard, with the purge's way through for demo rows only.
CREATE OR REPLACE FUNCTION public.refuse_deleting_issued_invoice()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_trail boolean := false;
BEGIN
  IF OLD.job_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = OLD.job_id) THEN
    RETURN OLD;
  END IF;
  -- purge_demo_data() sets this for its own transaction only; a demo invoice
  -- is demo data however far it got.
  IF coalesce(OLD.is_demo, false)
     AND coalesce(current_setting('app.demo_purge', true), '') = 'on' THEN
    RETURN OLD;
  END IF;
  -- Dynamic: the trail table arrives with 20260927121000.
  IF to_regclass('public.invoice_payment_changes') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.invoice_payment_changes c WHERE c.invoice_id = $1)'
      INTO v_trail USING OLD.id;
  END IF;
  IF OLD.status::text <> 'draft'
     OR OLD.sent_at IS NOT NULL
     OR OLD.approved_amount IS NOT NULL
     OR COALESCE(OLD.collected_amount, 0) <> 0
     OR EXISTS (SELECT 1 FROM public.invoice_payments p WHERE p.invoice_id = OLD.id)
     OR v_trail
  THEN
    RAISE EXCEPTION '% can''t be deleted — it has been sent, ruled on or paid. Set it to Written off, or edit it and resend.', OLD.invoice_number
      USING ERRCODE = 'P0001';
  END IF;
  RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION public.refuse_deleting_issued_invoice() FROM PUBLIC, anon, authenticated;

-- 2. The purge.
CREATE OR REPLACE FUNCTION public.purge_demo_data()
 RETURNS TABLE(table_name text, deleted_count bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  t text;
  n bigint;
  demo_users uuid[];
  demo_jobs uuid[];
  demo_ids uuid[] := '{}';
  ids uuid[];
  extra text;
  extras text[] := ARRAY['job_calculations', 'equipment_alerts', 'portal_invitations'];
  extra_ids jsonb := '{}'::jsonb;
BEGIN
  IF NOT (public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'owner')) THEN
    RAISE EXCEPTION 'Only owners and admins can remove demo data';
  END IF;

  -- Transaction-local: read by refuse_deleting_issued_invoice() above.
  PERFORM set_config('app.demo_purge', 'on', true);

  SELECT coalesce(array_agg(user_id), '{}') INTO demo_users
  FROM public.profiles WHERE is_demo;
  SELECT coalesce(array_agg(id), '{}') INTO demo_jobs
  FROM public.jobs WHERE is_demo;

  -- Every demo row's id, before anything is deleted, for the Timeline sweep.
  FOREACH t IN ARRAY public.demo_tables() LOOP
    IF t = 'profiles' THEN CONTINUE; END IF;
    BEGIN
      EXECUTE format('SELECT coalesce(array_agg(id), ''{}'') FROM public.%I WHERE is_demo', t) INTO ids;
      demo_ids := demo_ids || ids;
    EXCEPTION WHEN undefined_column OR datatype_mismatch OR cannot_coerce OR invalid_text_representation THEN
      NULL; -- a table without a uuid `id` has no Timeline rows of its own
    END;
  END LOOP;

  -- A real incident on a demo job: keep the incident, drop the link.
  IF to_regclass('public.incidents') IS NOT NULL THEN
    UPDATE public.incidents SET job_id = NULL
     WHERE NOT coalesce(is_demo, false) AND job_id = ANY(demo_jobs);
  END IF;

  -- Job-scoped rows with no is_demo column that SET NULL would leave behind.
  -- Their ids are taken now, while job_id still names the demo job, and the
  -- rows are deleted after the demo rows (a saved calculation is guarded
  -- while an invoice still bills it, and the demo invoices go first).
  FOREACH extra IN ARRAY extras LOOP
    IF to_regclass('public.' || extra) IS NOT NULL THEN
      BEGIN
        EXECUTE format('SELECT coalesce(array_agg(id), ''{}'') FROM public.%I WHERE job_id = ANY($1)', extra)
          INTO ids USING demo_jobs;
        extra_ids := extra_ids || jsonb_build_object(extra, to_jsonb(ids));
      EXCEPTION WHEN undefined_column OR datatype_mismatch OR cannot_coerce THEN
        NULL; -- shaped differently on this database: left as it was
      END;
    END IF;
  END LOOP;

  FOREACH t IN ARRAY public.demo_tables() LOOP
    IF t = 'profiles' THEN CONTINUE; END IF;
    IF t = 'accounts' THEN
      -- Reference accounts (carriers, public adjusting firms) are real shared
      -- data even when created while demo rows are around. Never purge them.
      EXECUTE 'WITH d AS (DELETE FROM public.accounts WHERE is_demo AND NOT coalesce(is_reference,false) RETURNING 1) SELECT count(*) FROM d' INTO n;
    ELSE
      EXECUTE format('WITH d AS (DELETE FROM public.%I WHERE is_demo RETURNING 1) SELECT count(*) FROM d', t) INTO n;
    END IF;
    IF n > 0 THEN table_name := t; deleted_count := n; RETURN NEXT; END IF;
  END LOOP;

  FOREACH extra IN ARRAY extras LOOP
    IF extra_ids ? extra AND jsonb_array_length(extra_ids->extra) > 0 THEN
      BEGIN
        EXECUTE format('WITH d AS (DELETE FROM public.%I WHERE id = ANY($1) RETURNING 1) SELECT count(*) FROM d', extra)
          INTO n
          USING ARRAY(SELECT jsonb_array_elements_text(extra_ids->extra)::uuid);
        IF n > 0 THEN table_name := extra; deleted_count := n; RETURN NEXT; END IF;
      EXCEPTION WHEN OTHERS THEN
        -- Still in use by something real (a real invoice billing a saved
        -- calculation): left detached, as before, rather than failing the purge.
        NULL;
      END;
    END IF;
  END LOOP;

  -- The Timeline of what was just removed.
  IF to_regclass('public.activity_log') IS NOT NULL AND array_length(demo_ids, 1) > 0 THEN
    WITH d AS (
      DELETE FROM public.activity_log a
       WHERE a.record_id = ANY(demo_ids)
          OR (a.detail ? 'job_id' AND a.detail->>'job_id' = ANY(demo_ids::text[]))
          OR (a.detail ? 'account_id' AND a.detail->>'account_id' = ANY(demo_ids::text[]))
      RETURNING 1)
    SELECT count(*) INTO n FROM d;
    IF n > 0 THEN table_name := 'activity_log'; deleted_count := n; RETURN NEXT; END IF;
  END IF;

  IF array_length(demo_users, 1) > 0 THEN
    BEGIN
      DELETE FROM auth.users WHERE id = ANY(demo_users);
      GET DIAGNOSTICS n = ROW_COUNT;
      DELETE FROM public.profiles WHERE is_demo;
      IF n > 0 THEN table_name := 'profiles'; deleted_count := n; RETURN NEXT; END IF;
    EXCEPTION WHEN foreign_key_violation THEN
      -- A real row still points at a demo user (a deal reassigned to a demo
      -- rep). Everything else is gone; the users are kept and said so.
      table_name := 'profiles (kept, still referenced)';
      deleted_count := array_length(demo_users, 1);
      RETURN NEXT;
    END;
  ELSE
    DELETE FROM public.profiles WHERE is_demo;
  END IF;
END $function$;

REVOKE ALL ON FUNCTION public.purge_demo_data() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.purge_demo_data() TO authenticated, service_role;
