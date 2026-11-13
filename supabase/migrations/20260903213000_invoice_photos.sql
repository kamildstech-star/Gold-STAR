-- Photographs on an invoice.
--
-- The client's request, verbatim: "to be able to attach images to an invoice
-- ... the option to add physical images to an invoice AND the option to add a
-- link of the selected images to the invoice."
--
-- Two columns, nothing else. The pictures already live in `photos` (album
-- photographs, ULID ids) and `documents` (image files, uuid ids); an invoice
-- only has to remember WHICH ones, in the order the office arranged them.
--
--   photo_ids            The job grid's own ids -- a ULID for an album photo,
--                        `doc:<uuid>` for an image filed as a document. text[]
--                        for the same reason job_reports.photo_ids is text[]
--                        (see 20260903131000): photos.id is text and will not
--                        cast to uuid.
--   photo_share_link_id  The `share_links` row (kind 'job_photos') minted for
--                        exactly this selection when "Include link to photos"
--                        is on. Null means no link. SET NULL on delete so a
--                        purged link never orphans the invoice.
--
-- Depends on 20260903131000_job_photo_share_links (the 'job_photos' kind and
-- the job-scoped policies the link is created under).
--
-- Re-runnable: migrations here are applied by hand and sometimes by Lovable,
-- so a second pass must be a no-op.

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS photo_ids text[];

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS photo_share_link_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'invoices_photo_share_link_id_fkey'
      AND conrelid = 'public.invoices'::regclass
  ) THEN
    ALTER TABLE public.invoices
      ADD CONSTRAINT invoices_photo_share_link_id_fkey
      FOREIGN KEY (photo_share_link_id)
      REFERENCES public.share_links (id)
      ON DELETE SET NULL;
  END IF;
END $$;

COMMENT ON COLUMN public.invoices.photo_ids IS
  'Job Pictures grid ids (photos.id ULID, or doc:<documents.id>) printed as a photo grid on the invoice PDF, in order.';
COMMENT ON COLUMN public.invoices.photo_share_link_id IS
  'share_links row (kind job_photos) for exactly photo_ids, when the invoice carries a link to the photos. Null when no link.';
