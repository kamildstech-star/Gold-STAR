-- The job's crew list: the names the T&M sign-in sheet offers under "Add person".
--
-- WRITTEN, NOT APPLIED. One new table. Nothing existing changes. Until this is
-- applied the sign-in sheet offers the job's crew chief only, and the Field
-- Form tab says the crew list upload is waiting on this migration
-- (src/lib/job-crew-list.ts treats a missing table as "not yet").
--
-- David, 12 Oct: the crew are hired labourers with no system account, so the
-- sign-in sheet must not list every user. The crew chief is the one system
-- user on the sheet; everybody else comes from a spreadsheet of names the
-- office uploads, and those names are the job's dropdown from then on.
--
-- ONE ROW PER JOB. `names` is the list as uploaded — names only, cleaned and
-- de-duplicated by the app — and an upload replaces it. These are not people
-- records: nobody here has a login, a profile or a pay rate, and the signed
-- sheet itself (job_tm_forms) is still the record of who was on site.
--
-- ACCESS: as job_tm_forms — whoever can see the job reads its crew list and
-- can set it (the crew chief on site as well as the office). DELETE is
-- is_privileged only; the app offers no delete.

CREATE TABLE IF NOT EXISTS public.job_crew_lists (
  job_id uuid PRIMARY KEY REFERENCES public.jobs(id) ON DELETE CASCADE,
  names text[] NOT NULL DEFAULT '{}'::text[]
    CHECK (cardinality(names) <= 200),
  created_by uuid DEFAULT auth.uid(),
  updated_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.tg_job_crew_lists_stamp()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := now();
  NEW.updated_by := COALESCE(auth.uid(), NEW.updated_by);
  IF TG_OP = 'UPDATE' THEN
    NEW.job_id := OLD.job_id;
    NEW.created_by := OLD.created_by;
    NEW.created_at := OLD.created_at;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.tg_job_crew_lists_stamp() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS job_crew_lists_stamp ON public.job_crew_lists;
CREATE TRIGGER job_crew_lists_stamp BEFORE INSERT OR UPDATE ON public.job_crew_lists
  FOR EACH ROW EXECUTE FUNCTION public.tg_job_crew_lists_stamp();

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------
REVOKE ALL ON public.job_crew_lists FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.job_crew_lists TO authenticated;
GRANT ALL ON public.job_crew_lists TO service_role;
ALTER TABLE public.job_crew_lists ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS job_crew_lists_select ON public.job_crew_lists;
CREATE POLICY job_crew_lists_select ON public.job_crew_lists
  FOR SELECT TO authenticated
  USING (public.can_view_job((SELECT auth.uid()), job_id));

DROP POLICY IF EXISTS job_crew_lists_insert ON public.job_crew_lists;
CREATE POLICY job_crew_lists_insert ON public.job_crew_lists
  FOR INSERT TO authenticated
  WITH CHECK (
    public.can_view_job((SELECT auth.uid()), job_id)
    AND created_by = (SELECT auth.uid())
  );

DROP POLICY IF EXISTS job_crew_lists_update ON public.job_crew_lists;
CREATE POLICY job_crew_lists_update ON public.job_crew_lists
  FOR UPDATE TO authenticated
  USING (public.can_view_job((SELECT auth.uid()), job_id))
  WITH CHECK (public.can_view_job((SELECT auth.uid()), job_id));

DROP POLICY IF EXISTS job_crew_lists_delete ON public.job_crew_lists;
CREATE POLICY job_crew_lists_delete ON public.job_crew_lists
  FOR DELETE TO authenticated
  USING (public.is_privileged((SELECT auth.uid())));

-- The convention 20260929121000 applies to every RLS table.
DROP POLICY IF EXISTS active_profile_required ON public.job_crew_lists;
CREATE POLICY active_profile_required ON public.job_crew_lists
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT goldstar_private.profile_is_active(auth.uid())))
  WITH CHECK ((SELECT goldstar_private.profile_is_active(auth.uid())));
DROP POLICY IF EXISTS anonymous_business_access_denied ON public.job_crew_lists;
CREATE POLICY anonymous_business_access_denied ON public.job_crew_lists
  AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'portal_customer') THEN
    DROP POLICY IF EXISTS portal_customer_denied ON public.job_crew_lists;
    CREATE POLICY portal_customer_denied ON public.job_crew_lists
      AS RESTRICTIVE FOR ALL TO portal_customer USING (false) WITH CHECK (false);
  END IF;
END $$;