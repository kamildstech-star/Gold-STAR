CREATE TABLE public.assistant_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid NOT NULL,
  effective_user_id uuid,
  effective_roles text[] NOT NULL DEFAULT '{}',
  impersonation_id uuid,
  feature text NOT NULL,
  question text,
  scope jsonb NOT NULL DEFAULT '{}'::jsonb,
  retrieved jsonb NOT NULL DEFAULT '{}'::jsonb,
  redactions text[] NOT NULL DEFAULT '{}',
  response_preview text,
  model text,
  outcome text NOT NULL DEFAULT 'ok',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX assistant_audit_actor_idx ON public.assistant_audit (actor_user_id, created_at DESC);
CREATE INDEX assistant_audit_created_idx ON public.assistant_audit (created_at DESC);

ALTER TABLE public.assistant_audit
  ADD CONSTRAINT assistant_audit_actor_profiles_fkey
  FOREIGN KEY (actor_user_id) REFERENCES public.profiles(user_id) ON DELETE CASCADE;

GRANT SELECT ON public.assistant_audit TO authenticated;
GRANT ALL ON public.assistant_audit TO service_role;

ALTER TABLE public.assistant_audit ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Own assistant audit rows are readable"
  ON public.assistant_audit FOR SELECT TO authenticated
  USING (actor_user_id = auth.uid());

CREATE POLICY "Owners admins and devs read all assistant audit"
  ON public.assistant_audit FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'owner')
    OR public.has_role(auth.uid(), 'admin')
    OR public.has_role(auth.uid(), 'dev')
  );

NOTIFY pgrst, 'reload schema';