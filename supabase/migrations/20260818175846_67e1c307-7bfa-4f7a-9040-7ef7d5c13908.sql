-- 1. Equipment daily rate ------------------------------------------------
ALTER TABLE public.equipment ADD COLUMN IF NOT EXISTS daily_rate_cents integer;

UPDATE public.equipment SET daily_rate_cents = CASE equipment_type::text
  WHEN 'dehumidifier'   THEN 6500
  WHEN 'air_mover'      THEN 2500
  WHEN 'air_scrubber'   THEN 7500
  WHEN 'hepa'           THEN 7500
  WHEN 'heater'         THEN 5500
  WHEN 'generator'      THEN 9500
  WHEN 'moisture_meter' THEN 1500
  ELSE NULL END
WHERE daily_rate_cents IS NULL;

COMMENT ON COLUMN public.equipment.daily_rate_cents IS
  'Billable/accrual rate per day on a job. NULL = unpriced, flagged in admin.';

-- 2. Supply item unit cost -------------------------------------------------
ALTER TABLE public.supply_items ADD COLUMN IF NOT EXISTS unit_cost numeric(12,2);

-- 3. Margin threshold setting ---------------------------------------------
INSERT INTO public.app_settings (key, value)
VALUES ('finance', '{"margin_threshold_pct": 25}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- 4. Running cost for one job ---------------------------------------------
CREATE OR REPLACE FUNCTION public.job_running_cost(_job_id uuid)
RETURNS TABLE(
  equipment_cost numeric, equipment_days integer, equipment_units integer,
  labour_cost numeric, labour_minutes bigint,
  materials_cost numeric, manual_cost numeric, referral_cost numeric,
  total_cost numeric, revenue numeric, revenue_basis text,
  margin numeric, margin_pct numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  WITH guard AS (SELECT public.can_view_finance(auth.uid()) AS ok),
  eq AS (
    SELECT
      COALESCE(SUM((GREATEST(1, (COALESCE(p.retrieved_at, now())::date - p.placed_at::date) + 1))
                   * COALESCE(e.daily_rate_cents,0) / 100.0), 0)::numeric AS cost,
      COALESCE(SUM(GREATEST(1, (COALESCE(p.retrieved_at, now())::date - p.placed_at::date) + 1)), 0)::int AS days,
      COUNT(*)::int AS units
    FROM public.equipment_placements p
    JOIN public.equipment e ON e.id = p.equipment_id
    CROSS JOIN guard
    WHERE guard.ok AND p.job_id = _job_id
  ),
  lab AS (
    SELECT COALESCE(SUM(COALESCE(te.minutes,0)),0)::bigint AS minutes,
           COALESCE(SUM(COALESCE(te.minutes,0) / 60.0 * COALESCE(r.rate,0)),0)::numeric AS cost
    FROM public.time_entries te
    CROSS JOIN guard
    LEFT JOIN LATERAL (
      SELECT COALESCE(
        (SELECT ps.hourly_rate FROM public.pay_structures ps
          WHERE ps.user_id = te.user_id AND ps.hourly_rate IS NOT NULL
            AND ps.effective_from <= COALESCE(te.work_date, te.started_at::date)
            AND (ps.effective_to IS NULL OR ps.effective_to >= COALESCE(te.work_date, te.started_at::date))
          ORDER BY ps.effective_from DESC LIMIT 1),
        (SELECT lr.hourly_rate FROM public.labour_rates lr
          WHERE (lr.user_id = te.user_id OR lr.user_id IS NULL)
            AND lr.effective_from <= COALESCE(te.work_date, te.started_at::date)
            AND (lr.effective_to IS NULL OR lr.effective_to >= COALESCE(te.work_date, te.started_at::date))
          ORDER BY (lr.user_id = te.user_id) DESC, lr.effective_from DESC LIMIT 1)
      ) AS rate
    ) r ON true
    WHERE guard.ok AND te.job_id = _job_id AND te.status <> 'rejected'
  ),
  sup AS (
    SELECT COALESCE(SUM(l.quantity * COALESCE(i.unit_cost,0)),0)::numeric AS cost
    FROM public.supply_requests sr
    JOIN public.supply_request_lines l ON l.request_id = sr.id
    LEFT JOIN public.supply_items i ON i.id = l.item_id
    CROSS JOIN guard
    WHERE guard.ok AND sr.job_id = _job_id AND sr.status::text <> 'denied'
  ),
  man AS (
    SELECT COALESCE(SUM(cl.direct_cost + cl.materials_cost + cl.subcontractor_cost + cl.equipment_cost),0)::numeric AS cost,
           COALESCE(SUM(cl.materials_cost),0)::numeric AS materials,
           COALESCE(SUM(cl.revenue),0)::numeric AS revenue
    FROM public.job_cost_lines cl, guard WHERE guard.ok AND cl.job_id = _job_id
  ),
  ref AS (
    SELECT COALESCE(SUM(rc.amount),0)::numeric AS cost
    FROM public.job_referral_costs rc, guard WHERE guard.ok AND rc.job_id = _job_id
  ),
  rev AS (
    SELECT
      (SELECT COALESCE(SUM(COALESCE(i.approved_amount, i.billed_amount)),0)
         FROM public.invoices i WHERE i.job_id = _job_id AND i.status::text <> 'draft') AS inv,
      (SELECT COALESCE(SUM(e.total),0) FROM public.estimates e
         WHERE e.job_id = _job_id AND e.status::text IN ('approved','sent','accepted')) AS est
  ),
  calc AS (
    SELECT eq.cost AS eq_cost, eq.days, eq.units, lab.cost AS lab_cost, lab.minutes,
           sup.cost + man.materials AS mat_cost,
           man.cost - man.materials AS man_cost,
           ref.cost AS ref_cost,
           CASE WHEN rev.inv > 0 THEN rev.inv
                WHEN rev.est > 0 THEN rev.est
                ELSE man.revenue END AS revenue,
           CASE WHEN rev.inv > 0 THEN 'invoice'
                WHEN rev.est > 0 THEN 'estimate'
                WHEN man.revenue > 0 THEN 'cost_lines' ELSE 'none' END AS basis
    FROM eq, lab, sup, man, ref, rev
  )
  SELECT ROUND(eq_cost,2), days, units, ROUND(lab_cost,2), minutes,
         ROUND(mat_cost,2), ROUND(man_cost,2), ROUND(ref_cost,2),
         ROUND(eq_cost + lab_cost + mat_cost + man_cost + ref_cost, 2),
         ROUND(revenue,2), basis,
         ROUND(revenue - (eq_cost + lab_cost + mat_cost + man_cost + ref_cost), 2),
         CASE WHEN revenue > 0 THEN
           ROUND(((revenue - (eq_cost + lab_cost + mat_cost + man_cost + ref_cost)) / revenue) * 100, 1) END
  FROM calc;
$$;

REVOKE EXECUTE ON FUNCTION public.job_running_cost(uuid) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.job_running_cost(uuid) TO authenticated;

-- 5. Roll-up across active jobs -------------------------------------------
CREATE OR REPLACE FUNCTION public.running_cost_overview(_location_id uuid DEFAULT NULL, _limit integer DEFAULT 8)
RETURNS TABLE(
  job_id uuid, job_number text, title text, location_id uuid, status text,
  total_cost numeric, revenue numeric, margin numeric, margin_pct numeric,
  company_cost numeric, company_revenue numeric, active_jobs integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_cost numeric := 0; v_rev numeric := 0; v_n integer := 0;
BEGIN
  IF NOT public.can_view_finance(auth.uid()) THEN RETURN; END IF;

  CREATE TEMP TABLE _rc ON COMMIT DROP AS
  SELECT j.id, j.job_number, j.title, j.location_id, j.status::text AS status, c.*
  FROM public.jobs j
  CROSS JOIN LATERAL public.job_running_cost(j.id) c
  WHERE j.status::text IN ('new','scheduled','in_progress','drying','invoiced')
    AND (_location_id IS NULL OR j.location_id = _location_id)
    AND public.can_view_location(auth.uid(), j.location_id);

  SELECT COALESCE(SUM(r.total_cost),0), COALESCE(SUM(r.revenue),0), COUNT(*)
    INTO v_cost, v_rev, v_n FROM _rc r;

  RETURN QUERY
  SELECT r.id, r.job_number, r.title, r.location_id, r.status,
         r.total_cost, r.revenue, r.margin, r.margin_pct,
         v_cost, v_rev, v_n
  FROM _rc r
  WHERE r.total_cost > 0
  ORDER BY r.margin_pct NULLS LAST, r.margin
  LIMIT GREATEST(_limit, 1);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.running_cost_overview(uuid, integer) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.running_cost_overview(uuid, integer) TO authenticated;