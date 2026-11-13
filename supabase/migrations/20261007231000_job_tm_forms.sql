-- Gold Star's three daily T&M sheets, as records on the job.
--
-- WRITTEN, NOT APPLIED. One new table. Nothing existing changes. Until this is
-- applied the job's Field Form tab on a T&M job says the forms are not
-- available yet (src/lib/tm-forms.ts treats a missing table as "not yet"),
-- and the blank PDFs still download.
--
-- Mark: "for a T&M job, there is a sign in sheet, rate codes and the three
-- pages that are used for each day. can we have these pdfs, fillable,
-- available under field form, only when T&M is selected, and the new ticket
-- currently there should be for insurance and cash jobs."
--
-- One row per sheet: kind = 'sign_in' (Crew Sign In/Out Sheet), 'crew_chief'
-- (Daily Crew Chief) or 'supply_list' (Daily Supply List), for one job and
-- one day. The sheet's boxes are a jsonb payload, as the field work ticket
-- keeps its checkbox lists as slugs: the paper changes when Gold Star
-- reprints it, and a payload absorbs that without a migration per box.
-- Billing reads none of it — T&M Pro does the billing — so no column is
-- promoted out of it yet.
--
-- ONE PER KIND PER JOB PER DAY (the unique key): there is one sign-in sheet
-- on the clipboard each day and everybody signs it. The app writes with
-- ON CONFLICT on that key, so a second phone opening today's sheet edits the
-- same row, and two phones saving offline land on one row. The trigger keeps
-- the stored row's id, job, kind, day and author on every update.
--
-- ACCESS: the field work ticket's (field_work_tickets_select / _insert, live
-- policies) — whoever can see the job reads its sheets and can start one,
-- as themselves. UPDATE differs from the ticket on purpose: a ticket is one
-- crew chief's report, but the sign-in sheet is signed by the whole crew,
-- each on whichever phone is to hand, so anyone who can see the job can add
-- to that day's sheet (can_view_job), not only its author. DELETE is
-- is_privileged only, as for tickets; the app offers no delete.
--
-- Signatures are small PNG data URLs inside the payload (360 x 108, a few KB
-- each); the size CHECK keeps a runaway payload out of the table.
--
-- Not covered by record_history, like field work tickets (see the header of
-- 20261006200000): there is no delete in the app, and the filed PDF on the
-- job's Documents is the signed record of each day.
--
-- Re-runnable: IF NOT EXISTS / CREATE OR REPLACE / DROP POLICY IF EXISTS.

CREATE TABLE IF NOT EXISTS public.job_tm_forms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('sign_in', 'crew_chief', 'supply_list')),
  form_date date NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 3000000),
  -- The newest PDF filed from this sheet. SET NULL, never CASCADE: deleting
  -- the PDF must not delete what the crew entered.
  document_id uuid REFERENCES public.documents(id) ON DELETE SET NULL,
  -- When the crew pressed save, not when it reached the server.
  captured_at timestamptz,
  created_by uuid DEFAULT auth.uid(),
  updated_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT job_tm_forms_one_per_day UNIQUE (job_id, kind, form_date)
);
CREATE INDEX IF NOT EXISTS job_tm_forms_job_day_idx
  ON public.job_tm_forms (job_id, form_date DESC);

CREATE OR REPLACE FUNCTION public.tg_job_tm_forms_stamp()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := now();
  NEW.updated_by := COALESCE(auth.uid(), NEW.updated_by);
  IF TG_OP = 'UPDATE' THEN
    -- An upsert from a second phone carries its own id and author; the sheet
    -- keeps the ones it was started with.
    NEW.id := OLD.id;
    NEW.job_id := OLD.job_id;
    NEW.kind := OLD.kind;
    NEW.form_date := OLD.form_date;
    NEW.created_by := OLD.created_by;
    NEW.created_at := OLD.created_at;
    -- A save that does not mention the PDF keeps the one already filed.
    NEW.document_id := COALESCE(NEW.document_id, OLD.document_id);
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.tg_job_tm_forms_stamp() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS job_tm_forms_stamp ON public.job_tm_forms;
CREATE TRIGGER job_tm_forms_stamp BEFORE INSERT OR UPDATE ON public.job_tm_forms
  FOR EACH ROW EXECUTE FUNCTION public.tg_job_tm_forms_stamp();

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------
-- Supabase grants every new public table to the client roles by default.
REVOKE ALL ON public.job_tm_forms FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.job_tm_forms TO authenticated;
GRANT ALL ON public.job_tm_forms TO service_role;
ALTER TABLE public.job_tm_forms ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS job_tm_forms_select ON public.job_tm_forms;
CREATE POLICY job_tm_forms_select ON public.job_tm_forms
  FOR SELECT TO authenticated
  USING (public.can_view_job((SELECT auth.uid()), job_id));

DROP POLICY IF EXISTS job_tm_forms_insert ON public.job_tm_forms;
CREATE POLICY job_tm_forms_insert ON public.job_tm_forms
  FOR INSERT TO authenticated
  WITH CHECK (
    public.can_view_job((SELECT auth.uid()), job_id)
    AND created_by = (SELECT auth.uid())
  );

DROP POLICY IF EXISTS job_tm_forms_update ON public.job_tm_forms;
CREATE POLICY job_tm_forms_update ON public.job_tm_forms
  FOR UPDATE TO authenticated
  USING (public.can_view_job((SELECT auth.uid()), job_id))
  WITH CHECK (public.can_view_job((SELECT auth.uid()), job_id));

DROP POLICY IF EXISTS job_tm_forms_delete ON public.job_tm_forms;
CREATE POLICY job_tm_forms_delete ON public.job_tm_forms
  FOR DELETE TO authenticated
  USING (public.is_privileged((SELECT auth.uid())));

-- The convention 20260929121000 applies to every RLS table.
DROP POLICY IF EXISTS active_profile_required ON public.job_tm_forms;
CREATE POLICY active_profile_required ON public.job_tm_forms
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT goldstar_private.profile_is_active(auth.uid())))
  WITH CHECK ((SELECT goldstar_private.profile_is_active(auth.uid())));
DROP POLICY IF EXISTS anonymous_business_access_denied ON public.job_tm_forms;
CREATE POLICY anonymous_business_access_denied ON public.job_tm_forms
  AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'portal_customer') THEN
    DROP POLICY IF EXISTS portal_customer_denied ON public.job_tm_forms;
    CREATE POLICY portal_customer_denied ON public.job_tm_forms
      AS RESTRICTIVE FOR ALL TO portal_customer USING (false) WITH CHECK (false);
  END IF;
END $$;
