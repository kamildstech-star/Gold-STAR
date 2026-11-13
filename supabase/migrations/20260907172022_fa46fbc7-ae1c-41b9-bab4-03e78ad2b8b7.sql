-- The tradeshow_lead_media table exists, but its visibility helper does not.
-- Create it first, then install the storage policies that depend on it.

CREATE OR REPLACE FUNCTION public.can_view_tradeshow_lead_media(_user_id uuid, _tradeshow_id uuid, _created_by uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT _created_by = _user_id
    OR public.is_sales_lead(_user_id)
    OR EXISTS (
      SELECT 1 FROM public.tradeshows t
       WHERE t.id = _tradeshow_id
         AND t.location_id IS NOT NULL
         AND public.can_manage_location(_user_id, t.location_id)
    );
$$;

GRANT EXECUTE ON FUNCTION public.can_view_tradeshow_lead_media(uuid, uuid, uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- drying-photos: meter photographs tied to job_drying_readings
-- Path convention: {user_id}/{job_id}/{reading_id}.{ext}
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS drying_photos_read ON storage.objects;
CREATE POLICY drying_photos_read
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'drying-photos'
  AND (
    (owner = auth.uid() AND split_part(name, '/', 1) = auth.uid()::text)
    OR EXISTS (
      SELECT 1 FROM public.job_drying_readings r
       WHERE (r.photo_path = storage.objects.name OR r.photo_thumb_path = storage.objects.name)
         AND public.can_view_job(auth.uid(), r.job_id)
    )
  )
);

DROP POLICY IF EXISTS drying_photos_insert ON storage.objects;
CREATE POLICY drying_photos_insert
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'drying-photos'
  AND owner = auth.uid()
  AND split_part(name, '/', 1) = auth.uid()::text
);

DROP POLICY IF EXISTS drying_photos_update ON storage.objects;
CREATE POLICY drying_photos_update
ON storage.objects FOR UPDATE TO authenticated
USING (
  bucket_id = 'drying-photos'
  AND owner = auth.uid()
  AND split_part(name, '/', 1) = auth.uid()::text
)
WITH CHECK (
  bucket_id = 'drying-photos'
  AND owner = auth.uid()
  AND split_part(name, '/', 1) = auth.uid()::text
);

DROP POLICY IF EXISTS drying_photos_delete ON storage.objects;
CREATE POLICY drying_photos_delete
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'drying-photos'
  AND (
    (owner = auth.uid() AND split_part(name, '/', 1) = auth.uid()::text)
    OR public.is_privileged(auth.uid())
  )
);

-- ---------------------------------------------------------------------------
-- tradeshow-leads: booth selfies, badge scans and voice notes
-- Path convention: {user_id}/{account_id}/{file}
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS tradeshow_leads_read ON storage.objects;
CREATE POLICY tradeshow_leads_read
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'tradeshow-leads'
  AND (
    (owner = auth.uid() AND split_part(name, '/', 1) = auth.uid()::text)
    OR EXISTS (
      SELECT 1 FROM public.tradeshow_lead_media m
       WHERE (m.storage_path = storage.objects.name OR m.thumb_path = storage.objects.name)
         AND public.can_view_tradeshow_lead_media(auth.uid(), m.tradeshow_id, m.created_by)
    )
  )
);

DROP POLICY IF EXISTS tradeshow_leads_insert ON storage.objects;
CREATE POLICY tradeshow_leads_insert
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'tradeshow-leads'
  AND owner = auth.uid()
  AND split_part(name, '/', 1) = auth.uid()::text
);

DROP POLICY IF EXISTS tradeshow_leads_update ON storage.objects;
CREATE POLICY tradeshow_leads_update
ON storage.objects FOR UPDATE TO authenticated
USING (
  bucket_id = 'tradeshow-leads'
  AND owner = auth.uid()
  AND split_part(name, '/', 1) = auth.uid()::text
)
WITH CHECK (
  bucket_id = 'tradeshow-leads'
  AND owner = auth.uid()
  AND split_part(name, '/', 1) = auth.uid()::text
);

DROP POLICY IF EXISTS tradeshow_leads_delete ON storage.objects;
CREATE POLICY tradeshow_leads_delete
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'tradeshow-leads'
  AND owner = auth.uid()
  AND split_part(name, '/', 1) = auth.uid()::text
);