-- FE11 (28 Oct 2026): write-up sheet — completed work logged room by room.
--
-- A field inspector logs what was done as line items: which room, what
-- (description), how much (quantity + unit), on which visit date. The lines
-- feed the job's Scope of work card under each room. One table, no functions.
--
-- Who writes: anyone who can see the job adds lines as themselves (crew on
-- site are the people writing them up); a line is changed or removed by the
-- person who wrote it, or by someone who manages the job. Nothing here
-- touches job records — a deleted room leaves its lines with no room.

CREATE TABLE IF NOT EXISTS public.job_write_up_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  room_id uuid REFERENCES public.job_rooms(id) ON DELETE SET NULL,
  visit_date date NOT NULL DEFAULT current_date,
  description text NOT NULL CHECK (length(btrim(description)) > 0),
  quantity numeric(12,2) CHECK (quantity IS NULL OR quantity >= 0),
  unit text,
  sort_order integer NOT NULL DEFAULT 0,
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS job_write_up_items_job_idx
  ON public.job_write_up_items (job_id, visit_date, room_id);

ALTER TABLE public.job_write_up_items ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.job_write_up_items FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.job_write_up_items TO authenticated;
GRANT ALL ON public.job_write_up_items TO service_role;

DROP POLICY IF EXISTS job_write_up_items_read ON public.job_write_up_items;
CREATE POLICY job_write_up_items_read ON public.job_write_up_items
  FOR SELECT TO authenticated
  USING (public.can_view_job(auth.uid(), job_id));

DROP POLICY IF EXISTS job_write_up_items_insert ON public.job_write_up_items;
CREATE POLICY job_write_up_items_insert ON public.job_write_up_items
  FOR INSERT TO authenticated
  WITH CHECK (public.can_view_job(auth.uid(), job_id) AND created_by = auth.uid());

DROP POLICY IF EXISTS job_write_up_items_update ON public.job_write_up_items;
CREATE POLICY job_write_up_items_update ON public.job_write_up_items
  FOR UPDATE TO authenticated
  USING (
    (created_by = auth.uid() AND public.can_view_job(auth.uid(), job_id))
    OR public.can_manage_job(auth.uid(), job_id)
  )
  WITH CHECK (public.can_view_job(auth.uid(), job_id));

DROP POLICY IF EXISTS job_write_up_items_delete ON public.job_write_up_items;
CREATE POLICY job_write_up_items_delete ON public.job_write_up_items
  FOR DELETE TO authenticated
  USING (
    (created_by = auth.uid() AND public.can_view_job(auth.uid(), job_id))
    OR public.can_manage_job(auth.uid(), job_id)
  );

DROP TRIGGER IF EXISTS job_write_up_items_set_updated_at ON public.job_write_up_items;
CREATE TRIGGER job_write_up_items_set_updated_at
  BEFORE UPDATE ON public.job_write_up_items
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
