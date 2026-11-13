-- T11 (27 Oct 2026): salespeople see billed and paid — never cost.
--
-- WRITTEN, NOT APPLIED. Run by hand against the project.
--
-- The seller roles are sales_person, outside_sales_rep, cold_caller and the
-- legacy sales_rep (there is no "salesman" role). Until now one capability,
-- job.view_costs, gated billing and cost alike, so sellers saw no money at
-- all. This splits them:
--
--   job.view_billing  billed / paid (collected) — every job.view_costs holder
--                     plus the four seller roles.
--   job.view_costs    unchanged: cost lines, rates, labor cost, margin.
--
-- And it closes three cost leaks at the data layer: job_labour_summary,
-- job_person_hours and job_profitability were SECURITY DEFINER and gated only
-- by can_view_job, so any seller who could open a job could read its labor
-- cost, per-person cost and margin straight from the API.

-- 1. The capability ----------------------------------------------------------
INSERT INTO public.permissions (key, label, perm_group, description, sort_order) VALUES
  ('job.view_billing', 'View job billing', 'Money',
   'See billed and paid amounts on jobs. No cost, rates or margin.', 25)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.role_permissions (role, permission_key)
SELECT DISTINCT rp.role, 'job.view_billing'
  FROM public.role_permissions rp
 WHERE rp.permission_key = 'job.view_costs'
ON CONFLICT DO NOTHING;

INSERT INTO public.role_permissions (role, permission_key) VALUES
  ('sales_person', 'job.view_billing'),
  ('outside_sales_rep', 'job.view_billing'),
  ('cold_caller', 'job.view_billing'),
  ('sales_rep', 'job.view_billing')
ON CONFLICT DO NOTHING;

-- 2. Cost never goes to a seller role through the role matrix ---------------
-- A per-person grant still works (an owner can decide that for one person);
-- the role default cannot quietly re-open cost to every seller.
CREATE OR REPLACE FUNCTION goldstar_private.refuse_seller_cost_permission()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.role::text IN ('sales_person', 'outside_sales_rep', 'cold_caller', 'sales_rep')
     AND NEW.permission_key IN ('job.view_costs', 'job.view_margin', 'labour_rates.view', 'rep_cost.view')
  THEN
    RAISE EXCEPTION 'Seller roles never see cost: % cannot be given to %', NEW.permission_key, NEW.role
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION goldstar_private.refuse_seller_cost_permission() FROM PUBLIC, anon;

DROP TRIGGER IF EXISTS role_permissions_no_seller_cost ON public.role_permissions;
CREATE TRIGGER role_permissions_no_seller_cost
  BEFORE INSERT OR UPDATE ON public.role_permissions
  FOR EACH ROW EXECUTE FUNCTION goldstar_private.refuse_seller_cost_permission();

-- 3. One answer to "may this caller see this job's cost?" --------------------
CREATE OR REPLACE FUNCTION public.can_view_job_costs(_job_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.jobs j
     WHERE j.id = _job_id
       AND public.can_view_job(auth.uid(), j.id)
       AND (public.can_view_finance(auth.uid())
            OR public.has_permission(auth.uid(), 'job.view_costs', j.location_id))
  );
$$;
REVOKE ALL ON FUNCTION public.can_view_job_costs(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_view_job_costs(uuid) TO authenticated, service_role;

-- 4. The three roll-ups: hours for anyone on the job, cost only for cost ----
CREATE OR REPLACE FUNCTION public.job_labour_summary(_job_id uuid)
RETURNS TABLE (
  total_minutes bigint,
  approved_minutes bigint,
  days_on_site integer,
  headcount integer,
  crew_days integer,
  labour_cost numeric
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT
    COALESCE(SUM(te.minutes),0)::bigint,
    COALESCE(SUM(te.minutes) FILTER (WHERE te.status = 'approved'),0)::bigint,
    COUNT(DISTINCT te.work_date)::int,
    COUNT(DISTINCT te.user_id)::int,
    COALESCE(COUNT(DISTINCT (te.user_id::text || te.work_date::text)),0)::int,
    CASE WHEN public.can_view_job_costs(_job_id)
         THEN COALESCE(SUM((te.minutes::numeric / 60) * COALESCE(public.rate_for(te.user_id, te.work_date), 0)), 0)
         ELSE NULL END
  FROM public.time_entries te
  WHERE te.job_id = _job_id
    AND public.can_view_job(auth.uid(), _job_id)
$$;

CREATE OR REPLACE FUNCTION public.job_person_hours(_job_id uuid)
RETURNS TABLE (user_id uuid, full_name text, minutes bigint, days integer, cost numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT te.user_id,
         p.full_name,
         SUM(te.minutes)::bigint,
         COUNT(DISTINCT te.work_date)::int,
         CASE WHEN public.can_view_job_costs(_job_id)
              THEN SUM((te.minutes::numeric / 60) * COALESCE(public.rate_for(te.user_id, te.work_date), 0))
              ELSE NULL END
  FROM public.time_entries te
  LEFT JOIN public.profiles p ON p.user_id = te.user_id
  WHERE te.job_id = _job_id
    AND public.can_view_job(auth.uid(), _job_id)
  GROUP BY te.user_id, p.full_name
  ORDER BY 3 DESC
$$;

CREATE OR REPLACE FUNCTION public.job_profitability(_job_id uuid)
RETURNS TABLE (
  billed numeric,
  collected numeric,
  labour_cost numeric,
  equipment_days integer,
  total_minutes bigint,
  margin numeric,
  margin_pct numeric
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH lab AS (SELECT * FROM public.job_labour_summary(_job_id)),
  inv AS (
    SELECT COALESCE(SUM(i.billed_amount),0) AS billed,
           COALESCE(SUM(i.collected_amount),0) AS collected
    FROM public.invoices i WHERE i.job_id = _job_id
  ),
  eq AS (
    SELECT COALESCE(SUM(
      GREATEST(1, CEIL(EXTRACT(EPOCH FROM (COALESCE(ep.retrieved_at, now()) - ep.placed_at)) / 86400))
    ),0)::int AS equipment_days
    FROM public.equipment_placements ep WHERE ep.job_id = _job_id
  ),
  gate AS (SELECT public.can_view_job_costs(_job_id) AS costs)
  SELECT inv.billed, inv.collected,
         CASE WHEN gate.costs THEN lab.labour_cost END,
         eq.equipment_days, lab.total_minutes,
         CASE WHEN gate.costs THEN inv.billed - lab.labour_cost END,
         CASE WHEN gate.costs AND inv.billed > 0
              THEN ROUND(((inv.billed - lab.labour_cost) / inv.billed) * 100, 1)
              ELSE NULL END
  FROM lab, inv, eq, gate
  WHERE public.can_view_job(auth.uid(), _job_id)
$$;

REVOKE ALL ON FUNCTION public.job_labour_summary(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.job_person_hours(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.job_profitability(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.job_labour_summary(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.job_person_hours(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.job_profitability(uuid) TO authenticated, service_role;

-- 5. Typed Billed / Paid ledger cells read with billing, not cost -----------
CREATE OR REPLACE FUNCTION public.job_ledger_cell_readable(_job_id uuid, _cell_key text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.jobs j
     WHERE j.id = _job_id
       AND public.can_view_job(auth.uid(), j.id)
       AND (
         _cell_key IN ('days', 'guys', 'hours')
         OR (_cell_key IN ('billed', 'paid')
             AND public.has_permission(auth.uid(), 'job.view_billing', j.location_id))
         OR (public.can_view_finance(auth.uid())
             AND public.has_permission(auth.uid(), 'job.view_costs', j.location_id))
       )
  );
$$;
REVOKE ALL ON FUNCTION public.job_ledger_cell_readable(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.job_ledger_cell_readable(uuid, text) TO authenticated, service_role;

-- Invoices / estimates: unchanged. A seller already reads billed and
-- collected on their own book (assigned_rep or creator) through
-- invoices_select (20260823090000_close_money_leaks.sql); line cost stays
-- withheld by the column grants of 20260909100000_line_cost_policy.sql.
