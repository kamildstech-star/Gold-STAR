CREATE TABLE public.integration_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  key_name text NOT NULL,
  ciphertext text NOT NULL,
  iv text NOT NULL,
  hint text,
  is_public boolean NOT NULL DEFAULT false,
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, key_name)
);
GRANT ALL ON public.integration_credentials TO service_role;
ALTER TABLE public.integration_credentials ENABLE ROW LEVEL SECURITY;
CREATE POLICY "integration_credentials service only"
  ON public.integration_credentials FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE TABLE public.integration_credential_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  key_name text NOT NULL,
  action text NOT NULL,
  actor_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_email text,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.integration_credential_audit TO authenticated;
GRANT ALL ON public.integration_credential_audit TO service_role;
ALTER TABLE public.integration_credential_audit ENABLE ROW LEVEL SECURITY;
CREATE POLICY "integration_credential_audit admin read"
  ON public.integration_credential_audit FOR SELECT TO authenticated
  USING (public.is_privileged(auth.uid()));

CREATE TABLE public.integration_test_results (
  provider text PRIMARY KEY,
  ok boolean NOT NULL DEFAULT false,
  message text,
  tested_at timestamptz NOT NULL DEFAULT now(),
  tested_by uuid REFERENCES auth.users(id) ON DELETE SET NULL
);
GRANT SELECT ON public.integration_test_results TO authenticated;
GRANT ALL ON public.integration_test_results TO service_role;
ALTER TABLE public.integration_test_results ENABLE ROW LEVEL SECURITY;
CREATE POLICY "integration_test_results read"
  ON public.integration_test_results FOR SELECT TO authenticated
  USING (public.is_privileged(auth.uid()));