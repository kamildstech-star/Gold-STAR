ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS important_instructions text;

CREATE TABLE public.job_section_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  section_key text NOT NULL,
  body text NOT NULL,
  author_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_job_section_notes_job ON public.job_section_notes (job_id, section_key, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.job_section_notes TO authenticated;
GRANT ALL ON public.job_section_notes TO service_role;

ALTER TABLE public.job_section_notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "View section notes on visible jobs"
  ON public.job_section_notes FOR SELECT TO authenticated
  USING (public.can_view_job((SELECT auth.uid()), job_id));

CREATE POLICY "Add section notes on visible jobs"
  ON public.job_section_notes FOR INSERT TO authenticated
  WITH CHECK (public.can_view_job((SELECT auth.uid()), job_id) AND author_id = (SELECT auth.uid()));

CREATE POLICY "Authors and managers edit section notes"
  ON public.job_section_notes FOR UPDATE TO authenticated
  USING (author_id = (SELECT auth.uid()) OR public.can_manage_job((SELECT auth.uid()), job_id))
  WITH CHECK (author_id = (SELECT auth.uid()) OR public.can_manage_job((SELECT auth.uid()), job_id));

CREATE POLICY "Authors and managers delete section notes"
  ON public.job_section_notes FOR DELETE TO authenticated
  USING (author_id = (SELECT auth.uid()) OR public.can_manage_job((SELECT auth.uid()), job_id));

CREATE TRIGGER trg_job_section_notes_updated_at
  BEFORE UPDATE ON public.job_section_notes
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();