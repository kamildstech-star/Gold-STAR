-- Trade show lead capture: a selfie with the contact and a voice note, taken
-- on a tablet at the booth, attached to the account the capture creates.
--
-- The account itself is the lead (accounts.tradeshow_id already attributes it
-- to the show). What is new is somewhere to keep the two files and the row
-- that ties them to the account and the show.
--
-- A private bucket of its own: 'documents' is readable by everyone who can
-- view the row's location and 'chat-attachments' keys off conversation
-- membership. A photo of a prospect and a rep's spoken notes about them are
-- neither. The capturing rep reads their own; show leadership (the same people
-- who can edit the show) reads all of them.
--
-- Path convention: {user_id}/{account_id}/{file}. The leading segment is the
-- uploader, mirroring assistant-attachments and chat-attachments, so the
-- storage policy can be checked from the object name alone.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'tradeshow-leads',
  'tradeshow-leads',
  false,
  26214400,
  ARRAY[
    'image/webp','image/jpeg','image/png','image/heic','image/heif',
    'audio/webm','audio/ogg','audio/mp4','audio/mpeg','audio/wav','audio/x-m4a','audio/aac'
  ]
)
ON CONFLICT (id) DO UPDATE
  SET public = false,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

-- ---------------------------------------------------------------------------
-- The row that ties a file to the lead
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.tradeshow_lead_media (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tradeshow_id uuid NOT NULL REFERENCES public.tradeshows(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('photo', 'audio')),
  storage_path text NOT NULL UNIQUE,
  -- Photos carry a small WebP for the list; audio leaves this null.
  thumb_path text,
  mime text NOT NULL,
  size_bytes integer NOT NULL DEFAULT 0,
  width integer,
  height integer,
  duration_seconds numeric,
  waveform_peaks jsonb,
  -- When the rep tapped capture, not when the tablet found signal.
  captured_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  is_demo boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS tradeshow_lead_media_show_idx
  ON public.tradeshow_lead_media (tradeshow_id, created_at DESC);
CREATE INDEX IF NOT EXISTS tradeshow_lead_media_account_idx
  ON public.tradeshow_lead_media (account_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.tradeshow_lead_media TO authenticated;
GRANT ALL ON public.tradeshow_lead_media TO service_role;

ALTER TABLE public.tradeshow_lead_media ENABLE ROW LEVEL SECURITY;

-- Who may see a capture: whoever made it, or the show's leadership — the same
-- test tradeshows_update applies, so the audience for a lead's photo is the
-- audience that may edit the show it was captured at.
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

DROP POLICY IF EXISTS tradeshow_lead_media_select ON public.tradeshow_lead_media;
CREATE POLICY tradeshow_lead_media_select ON public.tradeshow_lead_media
  FOR SELECT TO authenticated
  USING (public.can_view_tradeshow_lead_media(auth.uid(), tradeshow_id, created_by));

-- Same gate as adding a note to the show: you must be able to see the show.
DROP POLICY IF EXISTS tradeshow_lead_media_insert ON public.tradeshow_lead_media;
CREATE POLICY tradeshow_lead_media_insert ON public.tradeshow_lead_media
  FOR INSERT TO authenticated
  WITH CHECK (
    created_by = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.tradeshows t
       WHERE t.id = tradeshow_lead_media.tradeshow_id
         AND (t.location_id IS NULL OR public.can_view_location(auth.uid(), t.location_id))
    )
  );

-- Update exists only so an offline replay can upsert the same row by id.
DROP POLICY IF EXISTS tradeshow_lead_media_update ON public.tradeshow_lead_media;
CREATE POLICY tradeshow_lead_media_update ON public.tradeshow_lead_media
  FOR UPDATE TO authenticated
  USING (created_by = auth.uid())
  WITH CHECK (created_by = auth.uid());

DROP POLICY IF EXISTS tradeshow_lead_media_delete ON public.tradeshow_lead_media;
CREATE POLICY tradeshow_lead_media_delete ON public.tradeshow_lead_media
  FOR DELETE TO authenticated
  USING (created_by = auth.uid() OR public.is_sales_lead(auth.uid()));

-- ---------------------------------------------------------------------------
-- Storage policies. Owner-scoped by path; leadership reads through the row.
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

-- Update is what `upsert: true` needs when a queued capture is replayed after
-- a lost response: the same path is written again by the same owner.
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
