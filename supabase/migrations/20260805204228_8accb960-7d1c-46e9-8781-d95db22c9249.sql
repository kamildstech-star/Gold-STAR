CREATE TYPE public.goal_metric AS ENUM (
  'meetings_held',
  'touchpoints',
  'accounts_advanced',
  'new_accounts',
  'contracts_signed',
  'jobs_won',
  'billed_value',
  'collected_value',
  'median_tta_minutes'
);

CREATE TYPE public.goal_period AS ENUM ('month', 'quarter', 'year');

CREATE TABLE public.goals (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  -- Exactly one subject: a person, or the location as a team.
  subject_user_id uuid REFERENCES public.profiles(user_id) ON DELETE CASCADE,
  subject_location_id uuid REFERENCES public.locations(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  metric public.goal_metric NOT NULL,
  target_value numeric NOT NULL CHECK (target_value > 0),
  period_type public.goal_period NOT NULL,
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  notes text,
  set_by uuid REFERENCES public.profiles(user_id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT goals_one_subject CHECK (
    (subject_user_id IS NOT NULL AND subject_location_id IS NULL)
    OR (subject_user_id IS NULL AND subject_location_id IS NOT NULL)
  ),
  CONSTRAINT goals_window CHECK (ends_on >= starts_on)
);

CREATE INDEX goals_subject_user_idx ON public.goals (subject_user_id, is_active, starts_on, ends_on);
CREATE INDEX goals_location_idx ON public.goals (location_id, is_active, starts_on, ends_on);

-- One active goal per subject, metric and window: attainment must be unambiguous.
CREATE UNIQUE INDEX goals_unique_user_window
  ON public.goals (subject_user_id, metric, period_type, starts_on)
  WHERE subject_user_id IS NOT NULL AND is_active;
CREATE UNIQUE INDEX goals_unique_location_window
  ON public.goals (subject_location_id, metric, period_type, starts_on)
  WHERE subject_location_id IS NOT NULL AND is_active;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.goals TO authenticated;
GRANT ALL ON public.goals TO service_role;

ALTER TABLE public.goals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Goals are visible to the subject and to their location"
  ON public.goals FOR SELECT TO authenticated
  USING (
    subject_user_id = auth.uid()
    OR public.can_view_location(auth.uid(), location_id)
  );

CREATE POLICY "Managers set goals for their location"
  ON public.goals FOR INSERT TO authenticated
  WITH CHECK (public.can_manage_location(auth.uid(), location_id));

CREATE POLICY "Managers adjust goals for their location"
  ON public.goals FOR UPDATE TO authenticated
  USING (public.can_manage_location(auth.uid(), location_id))
  WITH CHECK (public.can_manage_location(auth.uid(), location_id));

CREATE POLICY "Managers remove goals for their location"
  ON public.goals FOR DELETE TO authenticated
  USING (public.can_manage_location(auth.uid(), location_id));

CREATE TRIGGER update_goals_updated_at
  BEFORE UPDATE ON public.goals
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();