CREATE TABLE public.intake_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prompt text NOT NULL,
  help_text text,
  answer_type text NOT NULL DEFAULT 'text',
  choices jsonb NOT NULL DEFAULT '[]'::jsonb,
  sort_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  location_id uuid REFERENCES public.locations(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT intake_questions_answer_type_chk
    CHECK (answer_type IN ('text','long_text','yes_no','choice','date','reported_source'))
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.intake_questions TO authenticated;
GRANT ALL ON public.intake_questions TO service_role;
ALTER TABLE public.intake_questions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "intake_questions_select" ON public.intake_questions
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "intake_questions_admin_write" ON public.intake_questions
  FOR ALL TO authenticated
  USING (
    public.has_role((SELECT auth.uid()), 'admin'::app_role)
    OR public.has_role((SELECT auth.uid()), 'owner'::app_role)
    OR public.has_role((SELECT auth.uid()), 'dev'::app_role)
  )
  WITH CHECK (
    public.has_role((SELECT auth.uid()), 'admin'::app_role)
    OR public.has_role((SELECT auth.uid()), 'owner'::app_role)
    OR public.has_role((SELECT auth.uid()), 'dev'::app_role)
  );

CREATE TRIGGER trg_intake_questions_updated_at
  BEFORE UPDATE ON public.intake_questions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.job_intake_answers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  question_id uuid NOT NULL REFERENCES public.intake_questions(id) ON DELETE CASCADE,
  answer_text text,
  answer_bool boolean,
  answer_date date,
  answered_by uuid REFERENCES public.profiles(user_id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, question_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.job_intake_answers TO authenticated;
GRANT ALL ON public.job_intake_answers TO service_role;
ALTER TABLE public.job_intake_answers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "job_intake_answers_select" ON public.job_intake_answers
  FOR SELECT TO authenticated
  USING (public.can_view_job((SELECT auth.uid()), job_id));
CREATE POLICY "job_intake_answers_write" ON public.job_intake_answers
  FOR ALL TO authenticated
  USING (public.can_manage_job((SELECT auth.uid()), job_id))
  WITH CHECK (public.can_manage_job((SELECT auth.uid()), job_id));

CREATE TRIGGER trg_job_intake_answers_updated_at
  BEFORE UPDATE ON public.job_intake_answers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX job_intake_answers_job_idx ON public.job_intake_answers (job_id);

INSERT INTO public.intake_questions (prompt, help_text, answer_type, sort_order) VALUES
  ('How did this job arrive?', 'Feeds reported-source reporting.', 'reported_source', 10),
  ('Is the property occupied?', NULL, 'yes_no', 20),
  ('Is the power on?', NULL, 'yes_no', 30),
  ('Is there standing water present?', NULL, 'yes_no', 40),
  ('Has the insurance carrier been contacted?', NULL, 'yes_no', 50);