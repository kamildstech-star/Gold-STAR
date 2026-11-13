-- 1. Curated reference accounts: only privileged roles may set/unset is_reference
CREATE OR REPLACE FUNCTION public.guard_account_is_reference()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF COALESCE(NEW.is_reference, false) AND NOT public.is_privileged(auth.uid()) THEN
      NEW.is_reference := false;
    END IF;
  ELSIF COALESCE(NEW.is_reference, false) IS DISTINCT FROM COALESCE(OLD.is_reference, false)
        AND NOT public.is_privileged(auth.uid()) THEN
    RAISE EXCEPTION 'Only an admin or owner can change the shared reference flag';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.guard_account_is_reference() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS guard_account_is_reference ON public.accounts;
CREATE TRIGGER guard_account_is_reference
BEFORE INSERT OR UPDATE ON public.accounts
FOR EACH ROW EXECUTE FUNCTION public.guard_account_is_reference();

-- 2. Reference flag no longer grants write access to contacts
DROP POLICY IF EXISTS contacts_insert_reference ON public.contacts;
DROP POLICY IF EXISTS contacts_update_reference ON public.contacts;

-- 3. Storage: uploads must map to a document row or a visible office folder
DROP POLICY IF EXISTS documents_objects_insert ON storage.objects;
CREATE POLICY documents_objects_insert ON storage.objects
FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'documents'
  AND auth.uid() IS NOT NULL
  AND (
    public.can_access_document_object(auth.uid(), name)
    OR (
      split_part(name, '/', 1) ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      AND public.can_view_location(auth.uid(), split_part(name, '/', 1)::uuid)
    )
  )
);

-- 4. Translations must reference an entity the user can access
CREATE OR REPLACE FUNCTION public.can_write_translation(_user_id uuid, _entity_type text, _entity_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN _user_id IS NULL THEN false
    WHEN _entity_type = 'job' THEN public.can_view_job(_user_id, _entity_id)
    WHEN _entity_type = 'job_note' THEN EXISTS (
      SELECT 1 FROM public.job_notes n
      WHERE n.id = _entity_id AND public.can_view_job(_user_id, n.job_id)
    )
    WHEN _entity_type = 'quote' THEN EXISTS (
      SELECT 1 FROM public.quotes q
      WHERE q.id = _entity_id AND public.can_view_job(_user_id, q.job_id)
    )
    WHEN _entity_type = 'message' THEN EXISTS (
      SELECT 1 FROM public.messages m
      WHERE m.id = _entity_id AND public.is_conversation_member(m.conversation_id, _user_id)
    )
    ELSE public.is_privileged(_user_id)
  END;
$$;
GRANT EXECUTE ON FUNCTION public.can_write_translation(uuid, text, uuid) TO authenticated;

DROP POLICY IF EXISTS "translations writable" ON public.translations;
CREATE POLICY "translations writable" ON public.translations
FOR INSERT TO authenticated
WITH CHECK (public.can_write_translation((SELECT auth.uid()), entity_type::text, entity_id));

-- 5. Internal trigger routine should not be callable through the API
REVOKE EXECUTE ON FUNCTION public.incidents_classify() FROM PUBLIC, anon, authenticated;