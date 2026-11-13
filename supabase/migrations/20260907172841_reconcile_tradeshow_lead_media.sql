-- Reconcile the alternate booth-capture schema observed on 2026-09-08.
-- Apply this before the still-pending 20260903212000 migration on that database.
-- It is also safe after that migration on fresh/replayed databases.
-- No rows are rewritten or removed; invalid legacy rows abort the transaction.
-- Keep numeric[] waveform_peaks where already deployed. PostgREST serializes
-- both numeric[] and jsonb numeric arrays as JSON arrays; the app writes peaks
-- as number[] and reads them through Array.isArray. No JSON operators are used.
-- Keep the alternate writer's updated_at column and existing triggers intact.
-- Recovery: transaction rollback before commit. After commit, restore only
-- these constraints/defaults/policies from the saved preflight catalog if needed;
-- no data restoration is needed because this migration changes no row values.

BEGIN;
SET LOCAL lock_timeout = '5s';

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


-- Block concurrent inserts while checking the constraints we are restoring.
LOCK TABLE public.tradeshow_lead_media IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.tradeshow_lead_media
    WHERE mime IS NULL OR size_bytes IS NULL OR created_by IS NULL
  ) THEN
    RAISE EXCEPTION 'Lead media contains null required fields; reconcile owners and metadata explicitly before retrying';
  END IF;
  IF EXISTS (
    SELECT storage_path FROM public.tradeshow_lead_media
    GROUP BY storage_path HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Lead media contains duplicate storage paths; review existing records before retrying';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.tradeshow_lead_media'::regclass
      AND attname = 'waveform_peaks' AND NOT attisdropped
      AND atttypid IN ('jsonb'::regtype, 'numeric[]'::regtype)
  ) THEN
    RAISE EXCEPTION 'Unexpected lead media waveform type; review schema before retrying';
  END IF;
END;
$$;

ALTER TABLE public.tradeshow_lead_media
  ALTER COLUMN mime SET NOT NULL,
  ALTER COLUMN size_bytes SET NOT NULL,
  ALTER COLUMN size_bytes SET DEFAULT 0,
  ALTER COLUMN created_by SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attname = 'storage_path'
    WHERE c.conrelid = 'public.tradeshow_lead_media'::regclass
      AND c.contype = 'u' AND c.conkey = ARRAY[a.attnum]::smallint[]
  ) THEN
    ALTER TABLE public.tradeshow_lead_media
      ADD CONSTRAINT tradeshow_lead_media_storage_path_key UNIQUE (storage_path);
  END IF;
END;
$$;

-- Permissive policies combine with OR. Keeping the alternate broad ALL policy
-- would bypass the capture-owner/show-leadership policies installed below.
DROP POLICY IF EXISTS "Members of the show's office manage booth captures"
  ON public.tradeshow_lead_media;

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


COMMIT;
