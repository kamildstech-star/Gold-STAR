-- Files in the private `documents` bucket are reachable only through a
-- document row the user can already see.
CREATE OR REPLACE FUNCTION public.can_access_document_object(_user_id uuid, _path text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.documents d
    WHERE (d.storage_path = _path OR _path LIKE d.id::text || '/%')
      AND (public.can_view_location(_user_id, d.location_id) OR d.created_by = _user_id)
  );
$$;

CREATE POLICY "documents_objects_read" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'documents' AND public.can_access_document_object(auth.uid(), name));

CREATE POLICY "documents_objects_insert" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'documents' AND auth.uid() IS NOT NULL);

CREATE POLICY "documents_objects_update" ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'documents'
    AND public.can_access_document_object(auth.uid(), name)
    AND NOT EXISTS (
      SELECT 1 FROM public.documents d
      WHERE (d.storage_path = name OR name LIKE d.id::text || '/%')
        AND d.status = 'signed'
    )
  );

CREATE POLICY "documents_objects_delete" ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'documents'
    AND public.can_access_document_object(auth.uid(), name)
    AND NOT EXISTS (
      SELECT 1 FROM public.documents d
      WHERE (d.storage_path = name OR name LIKE d.id::text || '/%')
        AND d.status = 'signed'
    )
  );