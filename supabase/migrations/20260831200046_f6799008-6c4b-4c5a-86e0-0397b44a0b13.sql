CREATE TABLE public.field_work_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES public.locations(id),
  job_address text,
  unit_number text,
  work_date date NOT NULL DEFAULT current_date,
  job_start_time text,
  job_end_time text,
  crew_chief_name text,
  gsr_crew_size integer,
  temp_crew_size integer,
  job_types text[] NOT NULL DEFAULT '{}',
  scope_completed text[] NOT NULL DEFAULT '{}',
  materials_used text[] NOT NULL DEFAULT '{}',
  equip_dehumidifier integer,
  equip_air_mover integer,
  equip_scrubber integer,
  equip_injector integer,
  equip_ozone integer,
  equip_hydroxyl integer,
  equip_generator integer,
  work_notes text,
  trash_disposition text,
  job_completed boolean NOT NULL DEFAULT false,
  more_work_needed boolean NOT NULL DEFAULT false,
  source text NOT NULL DEFAULT 'digital',
  document_id uuid REFERENCES public.documents(id) ON DELETE SET NULL,
  captured_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX field_work_tickets_job_idx ON public.field_work_tickets (job_id, work_date DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.field_work_tickets TO authenticated;
GRANT ALL ON public.field_work_tickets TO service_role;

ALTER TABLE public.field_work_tickets ENABLE ROW LEVEL SECURITY;

CREATE POLICY field_work_tickets_select ON public.field_work_tickets
  FOR SELECT TO authenticated
  USING (public.can_view_job((SELECT auth.uid()), job_id));

CREATE POLICY field_work_tickets_insert ON public.field_work_tickets
  FOR INSERT TO authenticated
  WITH CHECK (public.can_view_job((SELECT auth.uid()), job_id));

CREATE POLICY field_work_tickets_update ON public.field_work_tickets
  FOR UPDATE TO authenticated
  USING (public.can_manage_job((SELECT auth.uid()), job_id) OR created_by = (SELECT auth.uid()))
  WITH CHECK (public.can_manage_job((SELECT auth.uid()), job_id) OR created_by = (SELECT auth.uid()));

CREATE POLICY field_work_tickets_delete ON public.field_work_tickets
  FOR DELETE TO authenticated
  USING (public.can_manage_job((SELECT auth.uid()), job_id));

CREATE TRIGGER field_work_tickets_updated_at
  BEFORE UPDATE ON public.field_work_tickets
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE OR REPLACE FUNCTION public.field_work_ticket_flag_more_work()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.more_work_needed THEN
    UPDATE public.jobs SET additional_work_pending = true WHERE id = NEW.job_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER field_work_tickets_more_work
  AFTER INSERT OR UPDATE ON public.field_work_tickets
  FOR EACH ROW EXECUTE FUNCTION public.field_work_ticket_flag_more_work();