-- FE12 (28 Oct 2026): room sketches — a raw sketch per room or floor, marked
-- up on a phone or desktop, exported as a clean client-friendly PDF plan.
--
-- The sketch image itself is an ordinary job document (documents bucket,
-- the same storage policies and authorised file route as every upload); this
-- table links it to a room or a floor and holds the markup: shaded affected
-- areas, equipment markers and labels, as JSON in image-relative (0..1)
-- coordinates. One table, no functions.
--
-- Anyone who can see the job reads and marks up its sketches (the people
-- marking them are on site); a sketch is removed by whoever added it or by a
-- job manager. Removing a room keeps its sketches, unlinked.

CREATE TABLE IF NOT EXISTS public.job_room_sketches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  room_id uuid REFERENCES public.job_rooms(id) ON DELETE SET NULL,
  floor_label text,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  width integer NOT NULL CHECK (width > 0),
  height integer NOT NULL CHECK (height > 0),
  annotations jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(annotations) = 'array'),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS job_room_sketches_job_idx
  ON public.job_room_sketches (job_id, room_id);

ALTER TABLE public.job_room_sketches ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.job_room_sketches FROM anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.job_room_sketches TO authenticated;
GRANT UPDATE (room_id, floor_label, name, annotations) ON public.job_room_sketches TO authenticated;
GRANT ALL ON public.job_room_sketches TO service_role;

DROP POLICY IF EXISTS job_room_sketches_read ON public.job_room_sketches;
CREATE POLICY job_room_sketches_read ON public.job_room_sketches
  FOR SELECT TO authenticated
  USING (public.can_view_job(auth.uid(), job_id));

DROP POLICY IF EXISTS job_room_sketches_insert ON public.job_room_sketches;
CREATE POLICY job_room_sketches_insert ON public.job_room_sketches
  FOR INSERT TO authenticated
  WITH CHECK (public.can_view_job(auth.uid(), job_id) AND created_by = auth.uid());

DROP POLICY IF EXISTS job_room_sketches_update ON public.job_room_sketches;
CREATE POLICY job_room_sketches_update ON public.job_room_sketches
  FOR UPDATE TO authenticated
  USING (public.can_view_job(auth.uid(), job_id))
  WITH CHECK (public.can_view_job(auth.uid(), job_id));

DROP POLICY IF EXISTS job_room_sketches_delete ON public.job_room_sketches;
CREATE POLICY job_room_sketches_delete ON public.job_room_sketches
  FOR DELETE TO authenticated
  USING (
    (created_by = auth.uid() AND public.can_view_job(auth.uid(), job_id))
    OR public.can_manage_job(auth.uid(), job_id)
  );

DROP TRIGGER IF EXISTS job_room_sketches_set_updated_at ON public.job_room_sketches;
CREATE TRIGGER job_room_sketches_set_updated_at
  BEFORE UPDATE ON public.job_room_sketches
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
