CREATE TABLE public.compliance_requirement_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requirement_id uuid NOT NULL REFERENCES public.account_compliance_requirements(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  slot text NOT NULL CHECK (slot IN ('sample','certificate')),
  storage_path text NOT NULL,
  file_name text NOT NULL,
  mime_type text,
  size_bytes bigint,
  version integer NOT NULL DEFAULT 1,
  is_current boolean NOT NULL DEFAULT true,
  superseded_at timestamptz,
  superseded_by uuid REFERENCES public.compliance_requirement_files(id) ON DELETE SET NULL,
  issuer text,
  policy_number text,
  effective_date date,
  expiry_date date,
  covered_amount numeric,
  currency text NOT NULL DEFAULT 'USD',
  notes text,
  sent_to_agent_at timestamptz,
  sent_to_agent_by uuid REFERENCES public.profiles(user_id) ON DELETE SET NULL,
  uploaded_by uuid REFERENCES public.profiles(user_id) ON DELETE SET NULL,
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX crf_requirement_idx ON public.compliance_requirement_files (requirement_id, slot, is_current);
CREATE INDEX crf_account_idx ON public.compliance_requirement_files (account_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.compliance_requirement_files TO authenticated;
GRANT ALL ON public.compliance_requirement_files TO service_role;

ALTER TABLE public.compliance_requirement_files ENABLE ROW LEVEL SECURITY;

CREATE POLICY crf_select ON public.compliance_requirement_files
FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.accounts a
  WHERE a.id = compliance_requirement_files.account_id
    AND (a.created_by = (SELECT auth.uid())
      OR a.assigned_rep = (SELECT auth.uid())
      OR public.can_view_location((SELECT auth.uid()), a.location_id))
));

CREATE POLICY crf_insert ON public.compliance_requirement_files
FOR INSERT TO authenticated
WITH CHECK (EXISTS (
  SELECT 1 FROM public.accounts a
  WHERE a.id = compliance_requirement_files.account_id
    AND (a.assigned_rep = (SELECT auth.uid())
      OR public.can_manage_location((SELECT auth.uid()), a.location_id))
));

CREATE POLICY crf_update ON public.compliance_requirement_files
FOR UPDATE TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.accounts a
  WHERE a.id = compliance_requirement_files.account_id
    AND (a.assigned_rep = (SELECT auth.uid())
      OR public.can_manage_location((SELECT auth.uid()), a.location_id))
));

CREATE POLICY crf_delete ON public.compliance_requirement_files
FOR DELETE TO authenticated
USING (public.is_privileged((SELECT auth.uid())));

CREATE TRIGGER crf_updated_at
BEFORE UPDATE ON public.compliance_requirement_files
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Storage: path is <account_id>/<requirement_id>/<slot>/<file>. Visibility of
-- the object follows visibility of the account that owns the folder.
CREATE OR REPLACE FUNCTION public.can_view_compliance_file_path(_path text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.accounts a
    WHERE a.id = NULLIF(split_part(_path, '/', 1), '')::uuid
      AND (a.created_by = (SELECT auth.uid())
        OR a.assigned_rep = (SELECT auth.uid())
        OR public.can_view_location((SELECT auth.uid()), a.location_id))
  )
$$;

CREATE OR REPLACE FUNCTION public.can_manage_compliance_file_path(_path text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.accounts a
    WHERE a.id = NULLIF(split_part(_path, '/', 1), '')::uuid
      AND (a.assigned_rep = (SELECT auth.uid())
        OR public.can_manage_location((SELECT auth.uid()), a.location_id))
  )
$$;

REVOKE EXECUTE ON FUNCTION public.can_view_compliance_file_path(text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.can_manage_compliance_file_path(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_view_compliance_file_path(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.can_manage_compliance_file_path(text) TO authenticated, service_role;

CREATE POLICY compliance_files_read ON storage.objects
FOR SELECT TO authenticated
USING (bucket_id = 'compliance-files' AND public.can_view_compliance_file_path(name));

CREATE POLICY compliance_files_write ON storage.objects
FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'compliance-files' AND public.can_manage_compliance_file_path(name));

CREATE POLICY compliance_files_update ON storage.objects
FOR UPDATE TO authenticated
USING (bucket_id = 'compliance-files' AND public.can_manage_compliance_file_path(name));

CREATE POLICY compliance_files_delete ON storage.objects
FOR DELETE TO authenticated
USING (bucket_id = 'compliance-files' AND public.can_manage_compliance_file_path(name));