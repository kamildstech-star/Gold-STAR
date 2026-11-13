-- Files a user hands to Polaris in the composer.
--
-- A private bucket of its own, because none of the existing buckets has the
-- right audience: 'documents' grants read to everyone who can view the row's
-- location, 'chat-attachments' keys off internal chat membership, and
-- 'feature-requests' is readable by every authenticated user. An attachment to
-- an assistant question is not a business document — it must not inherit a
-- job's, a location's or a conversation's audience. Only the asker reads it.
--
-- Path convention: {user_id}/{uuid}-{filename}, mirroring the leading-segment
-- guard already used by chat-attachments.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'assistant-attachments',
  'assistant-attachments',
  false,
  10485760,
  ARRAY[
    'image/png','image/jpeg','image/webp','image/gif',
    'application/pdf',
    'text/plain','text/csv','text/tab-separated-values','text/markdown','application/json'
  ]
)
ON CONFLICT (id) DO UPDATE
  SET public = false,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS assistant_attachments_own_read ON storage.objects;
CREATE POLICY assistant_attachments_own_read
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'assistant-attachments'
  AND owner = auth.uid()
  AND split_part(name, '/', 1) = auth.uid()::text
);

DROP POLICY IF EXISTS assistant_attachments_own_insert ON storage.objects;
CREATE POLICY assistant_attachments_own_insert
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'assistant-attachments'
  AND owner = auth.uid()
  AND split_part(name, '/', 1) = auth.uid()::text
);

-- No UPDATE policy: an attachment is what the model was shown at the time, so
-- it is immutable once written. Delete and re-attach instead.
DROP POLICY IF EXISTS assistant_attachments_own_delete ON storage.objects;
CREATE POLICY assistant_attachments_own_delete
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'assistant-attachments'
  AND owner = auth.uid()
  AND split_part(name, '/', 1) = auth.uid()::text
);
