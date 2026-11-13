-- 1. Automatic stage progression config
ALTER TABLE public.pipeline_stages
  ADD COLUMN IF NOT EXISTS auto_advance boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS advance_to_stage_id uuid REFERENCES public.pipeline_stages(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS advance_conditions jsonb NOT NULL DEFAULT '[]'::jsonb;

-- 2. Visit locations on touchpoints
ALTER TABLE public.touchpoints
  ADD COLUMN IF NOT EXISTS lat double precision,
  ADD COLUMN IF NOT EXISTS lon double precision,
  ADD COLUMN IF NOT EXISTS location_accuracy_m numeric,
  ADD COLUMN IF NOT EXISTS place_label text;

CREATE INDEX IF NOT EXISTS touchpoints_geo_idx ON public.touchpoints (created_by, occurred_at) WHERE lat IS NOT NULL;

-- 3. Tradeshows
CREATE TABLE IF NOT EXISTS public.tradeshows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid REFERENCES public.locations(id) ON DELETE SET NULL,
  name text NOT NULL,
  city text,
  state text,
  starts_on date,
  ends_on date,
  cost numeric NOT NULL DEFAULT 0,
  leads_captured integer NOT NULL DEFAULT 0,
  notes text,
  is_demo boolean NOT NULL DEFAULT false,
  archived_at timestamptz,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.tradeshows TO authenticated;
GRANT ALL ON public.tradeshows TO service_role;
ALTER TABLE public.tradeshows ENABLE ROW LEVEL SECURITY;

CREATE POLICY tradeshows_select ON public.tradeshows FOR SELECT TO authenticated
  USING (location_id IS NULL OR public.can_view_location(auth.uid(), location_id));
CREATE POLICY tradeshows_insert ON public.tradeshows FOR INSERT TO authenticated
  WITH CHECK (public.is_sales_lead(auth.uid()) OR (location_id IS NOT NULL AND public.can_manage_location(auth.uid(), location_id)));
CREATE POLICY tradeshows_update ON public.tradeshows FOR UPDATE TO authenticated
  USING (public.is_sales_lead(auth.uid()) OR (location_id IS NOT NULL AND public.can_manage_location(auth.uid(), location_id)))
  WITH CHECK (public.is_sales_lead(auth.uid()) OR (location_id IS NOT NULL AND public.can_manage_location(auth.uid(), location_id)));
CREATE POLICY tradeshows_delete ON public.tradeshows FOR DELETE TO authenticated
  USING (public.is_sales_lead(auth.uid()));

CREATE TRIGGER tradeshows_updated_at BEFORE UPDATE ON public.tradeshows
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS tradeshow_id uuid REFERENCES public.tradeshows(id) ON DELETE SET NULL;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS tradeshow_id uuid REFERENCES public.tradeshows(id) ON DELETE SET NULL;

-- 4. Tradeshow ROI
CREATE OR REPLACE FUNCTION public.tradeshow_roi()
RETURNS TABLE (
  tradeshow_id uuid,
  name text,
  starts_on date,
  cost numeric,
  leads_captured integer,
  accounts_created bigint,
  jobs_won bigint,
  billed_value numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT t.id,
         t.name,
         t.starts_on,
         t.cost,
         t.leads_captured,
         (SELECT count(*) FROM public.accounts a WHERE a.tradeshow_id = t.id),
         (SELECT count(*) FROM public.jobs j WHERE j.tradeshow_id = t.id AND j.status <> 'cancelled'),
         (SELECT coalesce(sum(j.billed_amount), 0) FROM public.jobs j WHERE j.tradeshow_id = t.id)
  FROM public.tradeshows t
  WHERE t.archived_at IS NULL
    AND (t.location_id IS NULL OR public.can_view_location(auth.uid(), t.location_id))
  ORDER BY t.starts_on DESC NULLS LAST;
$$;

REVOKE ALL ON FUNCTION public.tradeshow_roi() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tradeshow_roi() TO authenticated;

-- 5. Sales rep metrics
CREATE OR REPLACE FUNCTION public.sales_rep_metrics(_from timestamptz, _to timestamptz)
RETURNS TABLE (
  user_id uuid,
  full_name text,
  jobs_signed_insurance bigint,
  jobs_signed_cash bigint,
  calls_made bigint,
  stage_advances bigint,
  meetings_held bigint,
  proposals_sent bigint,
  accounts_closed bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH people AS (
    SELECT DISTINCT p.user_id AS id, p.full_name
    FROM public.profiles p
    JOIN public.user_roles ur ON ur.user_id = p.user_id
    JOIN public.location_members lm ON lm.user_id = p.user_id
    WHERE ur.role IN ('sales_person','sales_rep','outside_sales_rep','cold_caller','sales_manager','sales_head')
      AND public.can_view_location(auth.uid(), lm.location_id)
      AND coalesce(p.is_active, true)
  )
  SELECT pe.id,
         pe.full_name,
         (SELECT count(*) FROM public.jobs j
            JOIN public.accounts a ON a.id = j.account_id
            WHERE a.assigned_rep = pe.id AND j.created_at >= _from AND j.created_at <= _to
              AND coalesce(j.job_type, 'insurance') <> 'cash'),
         (SELECT count(*) FROM public.jobs j
            JOIN public.accounts a ON a.id = j.account_id
            WHERE a.assigned_rep = pe.id AND j.created_at >= _from AND j.created_at <= _to
              AND j.job_type = 'cash'),
         (SELECT count(*) FROM public.touchpoints t
            WHERE t.created_by = pe.id AND t.type = 'call'
              AND t.occurred_at >= _from AND t.occurred_at <= _to),
         (SELECT count(*) FROM public.account_stage_history h
            WHERE h.changed_by = pe.id AND h.changed_at >= _from AND h.changed_at <= _to),
         (SELECT count(*) FROM public.touchpoints t
            WHERE t.created_by = pe.id AND t.type IN ('meeting_in_person','meeting_virtual')
              AND coalesce(t.meeting_held, true)
              AND t.occurred_at >= _from AND t.occurred_at <= _to),
         (SELECT count(*) FROM public.quotes q
            WHERE q.created_by = pe.id AND q.status IN ('submitted','approved','rejected')
              AND q.created_at >= _from AND q.created_at <= _to),
         (SELECT count(*) FROM public.account_stage_history h
            JOIN public.pipeline_stages s ON s.id = h.to_stage_id
            WHERE h.changed_by = pe.id AND s.is_won AND h.changed_at >= _from AND h.changed_at <= _to)
  FROM people pe;
$$;

REVOKE ALL ON FUNCTION public.sales_rep_metrics(timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sales_rep_metrics(timestamptz, timestamptz) TO authenticated;