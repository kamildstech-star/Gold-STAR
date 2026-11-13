ALTER TABLE public.pay_structures
  ADD COLUMN IF NOT EXISTS salary_basis text NOT NULL DEFAULT 'annual',
  ADD COLUMN IF NOT EXISTS hourly_rate numeric,
  ADD COLUMN IF NOT EXISTS hours_per_week numeric;

ALTER TABLE public.pay_structures
  DROP CONSTRAINT IF EXISTS pay_structures_salary_basis_check;
ALTER TABLE public.pay_structures
  ADD CONSTRAINT pay_structures_salary_basis_check CHECK (salary_basis IN ('annual','hourly'));

-- Reps may read their own commission payouts (own rows only).
DROP POLICY IF EXISTS commission_payouts_own_select ON public.commission_payouts;
CREATE POLICY commission_payouts_own_select ON public.commission_payouts
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- Tier ladder for the caller's own plan, so a rep can see their own progress
-- without gaining sight of anyone else's terms.
CREATE OR REPLACE FUNCTION public.my_commission_tiers()
RETURNS TABLE(key text, label text, rate_percent numeric, min_amount numeric, work_component text, sort_order integer)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT t.key, t.label, t.rate_percent, t.min_amount, t.work_component, t.sort_order
  FROM public.commission_tiers t
  WHERE t.active
    AND (t.effective_to IS NULL OR t.effective_to >= CURRENT_DATE)
    AND t.effective_from <= CURRENT_DATE
    AND (
      t.work_component IS NULL
      OR EXISTS (
        SELECT 1 FROM public.commission_plans p
        WHERE p.user_id = auth.uid()
          AND p.effective_from <= CURRENT_DATE
          AND (p.effective_to IS NULL OR p.effective_to >= CURRENT_DATE)
          AND (p.work_component IS NULL OR p.work_component = t.work_component)
      )
    )
  ORDER BY t.work_component NULLS FIRST, t.sort_order;
$$;
GRANT EXECUTE ON FUNCTION public.my_commission_tiers() TO authenticated;

-- Salary cost now understands hourly people too.
CREATE OR REPLACE FUNCTION public.rep_profitability(_from date, _to date, _location_id uuid DEFAULT NULL::uuid)
RETURNS TABLE(user_id uuid, full_name text, revenue numeric, collected numeric, salary_cost numeric, commission_cost numeric, expense_cost numeric, total_rep_cost numeric, net_contribution numeric, job_count integer)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH guard AS (SELECT public.can_view_finance(auth.uid()) AS ok),
  people AS (
    SELECT p.user_id AS id, p.full_name FROM public.profiles p, guard
    WHERE guard.ok
      AND (_location_id IS NULL OR EXISTS (
        SELECT 1 FROM public.location_members lm
         WHERE lm.user_id = p.user_id AND lm.location_id = _location_id))
  ),
  won AS (
    SELECT j.created_by AS uid,
           COALESCE(SUM(j.billed_amount),0) AS billed,
           COALESCE(SUM(j.collected_amount),0) AS collected,
           COUNT(*)::int AS jobs
    FROM public.jobs j
    WHERE COALESCE(j.loss_date, j.created_at::date) BETWEEN _from AND _to
      AND (_location_id IS NULL OR j.location_id = _location_id)
    GROUP BY 1
  ),
  sal AS (
    SELECT ps.user_id AS uid,
           COALESCE(SUM(
             CASE WHEN ps.salary_basis = 'hourly'
               THEN COALESCE(ps.hourly_rate,0) * (COALESCE(ps.hours_per_week,40) / 7.0)
               ELSE COALESCE(ps.base_salary_annual,0) / 365.25
             END
             * (LEAST(COALESCE(ps.effective_to, _to), _to) - GREATEST(ps.effective_from, _from) + 1)
           ),0) AS cost
    FROM public.pay_structures ps
    WHERE ps.effective_from <= _to AND COALESCE(ps.effective_to, _to) >= _from
    GROUP BY 1
  ),
  comm AS (
    SELECT me.rep_user_id AS uid, COALESCE(SUM(me.amount),0) AS cost
    FROM public.money_events me
    WHERE me.event_type = 'commission_issued'
      AND me.created_at::date BETWEEN _from AND _to
      AND me.rep_user_id IS NOT NULL
    GROUP BY 1
  ),
  exp AS (
    SELECT e.user_id AS uid,
      COALESCE(SUM(CASE WHEN e.recurrence = 'one_off' AND e.spent_on BETWEEN _from AND _to THEN e.amount ELSE 0 END),0)
      + COALESCE(SUM(CASE WHEN e.recurrence <> 'one_off' THEN e.amount * public.recurrence_occurrences(e.recurrence,
            GREATEST(COALESCE(e.recurring_from, e.spent_on), _from),
            LEAST(COALESCE(e.recurring_until, _to), _to)) ELSE 0 END),0) AS cost
    FROM public.expenses e
    WHERE (e.spent_on BETWEEN _from AND _to)
       OR (e.recurrence <> 'one_off' AND COALESCE(e.recurring_from, e.spent_on) <= _to AND COALESCE(e.recurring_until, _to) >= _from)
    GROUP BY 1
  )
  SELECT p.id, p.full_name,
    ROUND(COALESCE(w.billed,0),2),
    ROUND(COALESCE(w.collected,0),2),
    ROUND(COALESCE(s.cost,0),2),
    ROUND(COALESCE(c.cost,0),2),
    ROUND(COALESCE(x.cost,0),2),
    ROUND(COALESCE(s.cost,0) + COALESCE(c.cost,0) + COALESCE(x.cost,0),2),
    ROUND(COALESCE(w.collected,0) - (COALESCE(s.cost,0) + COALESCE(c.cost,0) + COALESCE(x.cost,0)),2),
    COALESCE(w.jobs,0)
  FROM people p
  LEFT JOIN won w ON w.uid = p.id
  LEFT JOIN sal s ON s.uid = p.id
  LEFT JOIN comm c ON c.uid = p.id
  LEFT JOIN exp x ON x.uid = p.id
  WHERE COALESCE(w.jobs,0) > 0 OR COALESCE(s.cost,0) > 0 OR COALESCE(c.cost,0) > 0 OR COALESCE(x.cost,0) > 0
  ORDER BY 9 DESC;
$$;