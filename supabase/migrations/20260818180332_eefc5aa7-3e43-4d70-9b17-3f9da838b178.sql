CREATE OR REPLACE FUNCTION public.running_cost_overview(_location_id uuid DEFAULT NULL, _limit integer DEFAULT 8)
RETURNS TABLE(
  job_id uuid, job_number text, title text, location_id uuid, status text,
  total_cost numeric, revenue numeric, margin numeric, margin_pct numeric,
  company_cost numeric, company_revenue numeric, active_jobs integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  WITH guard AS (SELECT public.can_view_finance(auth.uid()) AS ok),
  rc AS (
    SELECT j.id, j.job_number, j.address AS title, j.location_id, j.status::text AS status, c.*
    FROM public.jobs j
    CROSS JOIN guard
    CROSS JOIN LATERAL public.job_running_cost(j.id) c
    WHERE guard.ok
      AND j.status::text IN ('new','scheduled','in_progress','drying','invoiced')
      AND (_location_id IS NULL OR j.location_id = _location_id)
      AND public.can_view_location(auth.uid(), j.location_id)
  ),
  agg AS (
    SELECT COALESCE(SUM(total_cost),0) AS cost, COALESCE(SUM(revenue),0) AS rev, COUNT(*)::int AS n
    FROM rc
  )
  SELECT rc.id, rc.job_number, rc.title, rc.location_id, rc.status,
         rc.total_cost, rc.revenue, rc.margin, rc.margin_pct,
         agg.cost, agg.rev, agg.n
  FROM rc, agg
  WHERE rc.total_cost > 0
  ORDER BY rc.margin_pct NULLS LAST, rc.margin
  LIMIT GREATEST(_limit, 1);
$$;

REVOKE EXECUTE ON FUNCTION public.running_cost_overview(uuid, integer) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.running_cost_overview(uuid, integer) TO authenticated;