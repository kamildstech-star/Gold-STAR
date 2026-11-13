-- share links for a job's schedule
ALTER TYPE public.share_link_kind ADD VALUE IF NOT EXISTS 'job_schedule';

ALTER TABLE public.share_links
  ADD COLUMN IF NOT EXISTS job_id uuid REFERENCES public.jobs(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS display_options jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS share_links_job_id_idx ON public.share_links(job_id);

CREATE POLICY share_links_select_job ON public.share_links
  FOR SELECT TO authenticated
  USING (job_id IS NOT NULL AND public.can_manage_job((SELECT auth.uid()), job_id));

CREATE POLICY share_links_insert_job ON public.share_links
  FOR INSERT TO authenticated
  WITH CHECK (
    job_id IS NOT NULL
    AND public.can_manage_job((SELECT auth.uid()), job_id)
    AND created_by = (SELECT auth.uid())
  );

CREATE POLICY share_links_update_job ON public.share_links
  FOR UPDATE TO authenticated
  USING (job_id IS NOT NULL AND public.can_manage_job((SELECT auth.uid()), job_id))
  WITH CHECK (job_id IS NOT NULL AND public.can_manage_job((SELECT auth.uid()), job_id));

-- closing statement on financial documents
ALTER TABLE public.estimates ADD COLUMN IF NOT EXISTS closing_statement text;
ALTER TABLE public.invoices  ADD COLUMN IF NOT EXISTS closing_statement text;

-- office groups
CREATE TABLE IF NOT EXISTS public.location_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.location_group_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES public.location_groups(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (group_id, location_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.location_groups TO authenticated;
GRANT ALL ON public.location_groups TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.location_group_members TO authenticated;
GRANT ALL ON public.location_group_members TO service_role;

ALTER TABLE public.location_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.location_group_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY location_groups_select ON public.location_groups
  FOR SELECT TO authenticated USING (true);
CREATE POLICY location_groups_write ON public.location_groups
  FOR ALL TO authenticated
  USING (public.is_privileged((SELECT auth.uid())))
  WITH CHECK (public.is_privileged((SELECT auth.uid())));

CREATE POLICY location_group_members_select ON public.location_group_members
  FOR SELECT TO authenticated USING (true);
CREATE POLICY location_group_members_write ON public.location_group_members
  FOR ALL TO authenticated
  USING (public.is_privileged((SELECT auth.uid())))
  WITH CHECK (public.is_privileged((SELECT auth.uid())));

CREATE TRIGGER location_groups_updated_at
  BEFORE UPDATE ON public.location_groups
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();