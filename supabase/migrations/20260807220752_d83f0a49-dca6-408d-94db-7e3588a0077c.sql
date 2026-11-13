-- 1. Work component option list -------------------------------------------
INSERT INTO public.option_lists (key, label, description, allow_location_scope)
VALUES ('work_component', 'Work component', 'Revenue/cost split used on job cost breakdowns and commission plans', false)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.option_list_values (list_id, key, label, sort_order, active, is_default)
SELECT ol.id, v.key, v.label, v.sort_order, true, v.is_default
FROM public.option_lists ol
CROSS JOIN (VALUES
  ('mitigation','Mitigation',10,true),
  ('reconstruction','Reconstruction',20,false),
  ('dry_cleaning','Dry Cleaning',30,false)
) AS v(key,label,sort_order,is_default)
WHERE ol.key = 'work_component'
  AND NOT EXISTS (SELECT 1 FROM public.option_list_values x WHERE x.list_id = ol.id AND x.key = v.key);

-- 2. Job cost lines ---------------------------------------------------------
CREATE TABLE public.job_cost_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  work_component text NOT NULL,
  revenue numeric(14,2) NOT NULL DEFAULT 0,
  direct_cost numeric(14,2) NOT NULL DEFAULT 0,
  materials_cost numeric(14,2) NOT NULL DEFAULT 0,
  subcontractor_cost numeric(14,2) NOT NULL DEFAULT 0,
  equipment_cost numeric(14,2) NOT NULL DEFAULT 0,
  equipment_days integer NOT NULL DEFAULT 0,
  notes text,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  is_demo boolean NOT NULL DEFAULT false,
  UNIQUE (job_id, work_component)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.job_cost_lines TO authenticated;
GRANT ALL ON public.job_cost_lines TO service_role;
ALTER TABLE public.job_cost_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Finance roles read job cost lines" ON public.job_cost_lines
  FOR SELECT TO authenticated
  USING (public.has_any_role_text(auth.uid(), ARRAY['owner','admin','sales_head','dev']));
CREATE POLICY "Finance roles write job cost lines" ON public.job_cost_lines
  FOR ALL TO authenticated
  USING (public.has_any_role_text(auth.uid(), ARRAY['owner','admin','sales_head']))
  WITH CHECK (public.has_any_role_text(auth.uid(), ARRAY['owner','admin','sales_head']));
CREATE TRIGGER trg_job_cost_lines_updated BEFORE UPDATE ON public.job_cost_lines
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE INDEX idx_job_cost_lines_job ON public.job_cost_lines(job_id);

-- 3. Referral cost as a first-class line ------------------------------------
CREATE TABLE public.job_referral_costs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  work_component text,
  account_id uuid REFERENCES public.accounts(id) ON DELETE SET NULL,
  contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  source_name text,
  amount numeric(14,2) NOT NULL DEFAULT 0,
  basis text NOT NULL DEFAULT 'flat',
  rate_percent numeric(6,3),
  paid_on date,
  note text,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  is_demo boolean NOT NULL DEFAULT false
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.job_referral_costs TO authenticated;
GRANT ALL ON public.job_referral_costs TO service_role;
ALTER TABLE public.job_referral_costs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Finance roles read referral costs" ON public.job_referral_costs
  FOR SELECT TO authenticated
  USING (public.has_any_role_text(auth.uid(), ARRAY['owner','admin','sales_head','dev']));
CREATE POLICY "Finance roles write referral costs" ON public.job_referral_costs
  FOR ALL TO authenticated
  USING (public.has_any_role_text(auth.uid(), ARRAY['owner','admin','sales_head']))
  WITH CHECK (public.has_any_role_text(auth.uid(), ARRAY['owner','admin','sales_head']));
CREATE TRIGGER trg_job_referral_costs_updated BEFORE UPDATE ON public.job_referral_costs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE INDEX idx_job_referral_costs_job ON public.job_referral_costs(job_id);
CREATE INDEX idx_job_referral_costs_account ON public.job_referral_costs(account_id);

-- 4. Commission tiers as configuration --------------------------------------
CREATE TABLE public.commission_tiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL,
  label text NOT NULL,
  rate_percent numeric(6,3) NOT NULL,
  min_amount numeric(14,2) NOT NULL DEFAULT 0,
  work_component text,
  sort_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  effective_from date NOT NULL DEFAULT CURRENT_DATE,
  effective_to date,
  note text,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  is_demo boolean NOT NULL DEFAULT false
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.commission_tiers TO authenticated;
GRANT ALL ON public.commission_tiers TO service_role;
ALTER TABLE public.commission_tiers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Finance roles read commission tiers" ON public.commission_tiers
  FOR SELECT TO authenticated
  USING (public.has_any_role_text(auth.uid(), ARRAY['owner','admin','sales_head','dev']));
CREATE POLICY "Finance roles write commission tiers" ON public.commission_tiers
  FOR ALL TO authenticated
  USING (public.has_any_role_text(auth.uid(), ARRAY['owner','admin','sales_head']))
  WITH CHECK (public.has_any_role_text(auth.uid(), ARRAY['owner','admin','sales_head']));
CREATE TRIGGER trg_commission_tiers_updated BEFORE UPDATE ON public.commission_tiers
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

INSERT INTO public.commission_tiers (key, label, rate_percent, min_amount, sort_order)
VALUES ('bronze','Bronze',5.000,0,10),
       ('silver','Silver',7.500,0,20),
       ('gold','Gold',10.000,0,30),
       ('platinum','Platinum',12.500,0,40);

ALTER TABLE public.commission_plans
  ADD COLUMN IF NOT EXISTS work_component text,
  ADD COLUMN IF NOT EXISTS tier_key text;

-- 5. Recurring expenses ------------------------------------------------------
ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS recurrence text NOT NULL DEFAULT 'one_off',
  ADD COLUMN IF NOT EXISTS recurring_from date,
  ADD COLUMN IF NOT EXISTS recurring_until date;

-- 6. Labour attribution -------------------------------------------------------
ALTER TABLE public.time_entries
  ADD COLUMN IF NOT EXISTS work_component text;

-- 7. Finance visibility helper -------------------------------------------------
CREATE OR REPLACE FUNCTION public.can_view_finance(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT public.has_any_role_text(_user_id, ARRAY['owner','admin','sales_head','dev']);
$$;
REVOKE ALL ON FUNCTION public.can_view_finance(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_view_finance(uuid) TO authenticated, service_role;

-- helper: number of occurrences of a recurrence inside a window
CREATE OR REPLACE FUNCTION public.recurrence_occurrences(_freq text, _from date, _to date)
RETURNS numeric LANGUAGE sql IMMUTABLE SET search_path TO 'public'
AS $$
  SELECT CASE
    WHEN _to < _from THEN 0
    WHEN _freq = 'weekly' THEN GREATEST(0, FLOOR(((_to - _from) + 1) / 7.0))
    WHEN _freq = 'biweekly' THEN GREATEST(0, FLOOR(((_to - _from) + 1) / 14.0))
    WHEN _freq = 'monthly' THEN GREATEST(0, ROUND(((_to - _from) + 1) / 30.4375, 2))
    WHEN _freq = 'quarterly' THEN GREATEST(0, ROUND(((_to - _from) + 1) / 91.3125, 2))
    WHEN _freq = 'yearly' THEN GREATEST(0, ROUND(((_to - _from) + 1) / 365.25, 2))
    ELSE 0 END::numeric;
$$;
REVOKE ALL ON FUNCTION public.recurrence_occurrences(text,date,date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.recurrence_occurrences(text,date,date) TO authenticated, service_role;

-- 8. Job cost breakdown ---------------------------------------------------------
CREATE OR REPLACE FUNCTION public.job_cost_breakdown(_job_id uuid)
RETURNS TABLE(
  work_component text,
  revenue numeric,
  direct_cost numeric,
  materials_cost numeric,
  subcontractor_cost numeric,
  equipment_cost numeric,
  equipment_days integer,
  labour_cost numeric,
  labour_minutes bigint,
  referral_cost numeric,
  total_cost numeric,
  margin numeric,
  margin_pct numeric
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  WITH guard AS (SELECT public.can_view_finance(auth.uid()) AS ok),
  lines AS (
    SELECT l.work_component, l.revenue, l.direct_cost, l.materials_cost,
           l.subcontractor_cost, l.equipment_cost, l.equipment_days
    FROM public.job_cost_lines l, guard WHERE guard.ok AND l.job_id = _job_id
  ),
  lab AS (
    SELECT COALESCE(te.work_component, 'unassigned') AS comp,
           SUM(COALESCE(te.minutes,0))::bigint AS minutes,
           SUM(COALESCE(te.minutes,0) / 60.0 * COALESCE(r.hourly_rate, 0))::numeric AS cost
    FROM public.time_entries te
    CROSS JOIN guard
    LEFT JOIN LATERAL (
      SELECT lr.hourly_rate FROM public.labour_rates lr
       WHERE (lr.user_id = te.user_id OR lr.user_id IS NULL)
         AND lr.effective_from <= COALESCE(te.work_date, te.started_at::date)
         AND (lr.effective_to IS NULL OR lr.effective_to >= COALESCE(te.work_date, te.started_at::date))
       ORDER BY (lr.user_id = te.user_id) DESC, lr.effective_from DESC
       LIMIT 1
    ) r ON true
    WHERE guard.ok AND te.job_id = _job_id AND te.status <> 'rejected'
    GROUP BY 1
  ),
  ref AS (
    SELECT COALESCE(rc.work_component,'unassigned') AS comp, SUM(rc.amount)::numeric AS amount
    FROM public.job_referral_costs rc, guard
    WHERE guard.ok AND rc.job_id = _job_id GROUP BY 1
  ),
  comps AS (
    SELECT work_component AS comp FROM lines
    UNION SELECT comp FROM lab
    UNION SELECT comp FROM ref
  ),
  joined AS (
    SELECT c.comp,
      COALESCE(l.revenue,0) AS revenue,
      COALESCE(l.direct_cost,0) AS direct_cost,
      COALESCE(l.materials_cost,0) AS materials_cost,
      COALESCE(l.subcontractor_cost,0) AS subcontractor_cost,
      COALESCE(l.equipment_cost,0) AS equipment_cost,
      COALESCE(l.equipment_days,0) AS equipment_days,
      COALESCE(lb.cost,0) AS labour_cost,
      COALESCE(lb.minutes,0)::bigint AS labour_minutes,
      COALESCE(rf.amount,0) AS referral_cost
    FROM comps c
    LEFT JOIN lines l ON l.work_component = c.comp
    LEFT JOIN lab lb ON lb.comp = c.comp
    LEFT JOIN ref rf ON rf.comp = c.comp
  )
  SELECT comp, revenue, direct_cost, materials_cost, subcontractor_cost, equipment_cost,
         equipment_days, ROUND(labour_cost,2), labour_minutes, referral_cost,
         ROUND(direct_cost + materials_cost + subcontractor_cost + equipment_cost + labour_cost + referral_cost, 2) AS total_cost,
         ROUND(revenue - (direct_cost + materials_cost + subcontractor_cost + equipment_cost + labour_cost + referral_cost), 2) AS margin,
         CASE WHEN revenue > 0 THEN ROUND(((revenue - (direct_cost + materials_cost + subcontractor_cost + equipment_cost + labour_cost + referral_cost)) / revenue) * 100, 1) END
  FROM joined
  ORDER BY revenue DESC, comp;
$$;
REVOKE ALL ON FUNCTION public.job_cost_breakdown(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.job_cost_breakdown(uuid) TO authenticated, service_role;

-- 9. Company money summary --------------------------------------------------------
CREATE OR REPLACE FUNCTION public.company_money_summary(_from date, _to date, _location_id uuid DEFAULT NULL)
RETURNS TABLE(
  total_revenue numeric,
  received numeric,
  open_claims_value numeric,
  open_claims_count integer,
  direct_costs numeric,
  labour_cost numeric,
  referral_cost numeric,
  rep_cost numeric,
  net_profit numeric
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  WITH guard AS (SELECT public.can_view_finance(auth.uid()) AS ok),
  jb AS (
    SELECT j.id, j.billed_amount, j.collected_amount
    FROM public.jobs j, guard
    WHERE guard.ok
      AND (_location_id IS NULL OR j.location_id = _location_id)
      AND COALESCE(j.loss_date, j.created_at::date) BETWEEN _from AND _to
  ),
  inv AS (
    SELECT COALESCE(SUM(i.billed_amount),0) AS billed,
           COALESCE(SUM(i.collected_amount),0) AS collected,
           COALESCE(SUM(CASE WHEN i.status <> 'paid' THEN COALESCE(i.billed_amount,0) - COALESCE(i.collected_amount,0) ELSE 0 END),0) AS open_value,
           COUNT(DISTINCT CASE WHEN i.status <> 'paid' THEN i.job_id END)::int AS open_count
    FROM public.invoices i WHERE i.job_id IN (SELECT id FROM jb)
  ),
  costs AS (
    SELECT COALESCE(SUM(l.direct_cost + l.materials_cost + l.subcontractor_cost + l.equipment_cost),0) AS direct
    FROM public.job_cost_lines l WHERE l.job_id IN (SELECT id FROM jb)
  ),
  lab AS (
    SELECT COALESCE(SUM(COALESCE(te.minutes,0) / 60.0 * COALESCE(r.hourly_rate,0)),0)::numeric AS cost
    FROM public.time_entries te
    LEFT JOIN LATERAL (
      SELECT lr.hourly_rate FROM public.labour_rates lr
       WHERE (lr.user_id = te.user_id OR lr.user_id IS NULL)
         AND lr.effective_from <= COALESCE(te.work_date, te.started_at::date)
         AND (lr.effective_to IS NULL OR lr.effective_to >= COALESCE(te.work_date, te.started_at::date))
       ORDER BY (lr.user_id = te.user_id) DESC, lr.effective_from DESC LIMIT 1
    ) r ON true
    WHERE te.job_id IN (SELECT id FROM jb) AND te.status <> 'rejected'
  ),
  ref AS (
    SELECT COALESCE(SUM(rc.amount),0) AS cost FROM public.job_referral_costs rc
    WHERE rc.job_id IN (SELECT id FROM jb)
  ),
  exp AS (
    SELECT COALESCE(SUM(e.amount),0) AS cost FROM public.expenses e, guard
    WHERE guard.ok AND e.recurrence = 'one_off' AND e.spent_on BETWEEN _from AND _to
      AND (_location_id IS NULL OR e.location_id = _location_id)
  ),
  rec AS (
    SELECT COALESCE(SUM(e.amount * public.recurrence_occurrences(e.recurrence,
            GREATEST(COALESCE(e.recurring_from, e.spent_on), _from),
            LEAST(COALESCE(e.recurring_until, _to), _to))),0) AS cost
    FROM public.expenses e, guard
    WHERE guard.ok AND e.recurrence <> 'one_off'
      AND COALESCE(e.recurring_from, e.spent_on) <= _to
      AND COALESCE(e.recurring_until, _to) >= _from
      AND (_location_id IS NULL OR e.location_id = _location_id)
  )
  SELECT ROUND(inv.billed,2), ROUND(inv.collected,2), ROUND(inv.open_value,2), inv.open_count,
         ROUND(costs.direct,2), ROUND(lab.cost,2), ROUND(ref.cost,2),
         ROUND(exp.cost + rec.cost,2),
         ROUND(inv.collected - costs.direct - lab.cost - ref.cost - exp.cost - rec.cost, 2)
  FROM inv, costs, lab, ref, exp, rec, guard WHERE guard.ok;
$$;
REVOKE ALL ON FUNCTION public.company_money_summary(date,date,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.company_money_summary(date,date,uuid) TO authenticated, service_role;

-- 10. Rep profitability ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rep_profitability(_from date, _to date, _location_id uuid DEFAULT NULL)
RETURNS TABLE(
  user_id uuid,
  full_name text,
  revenue numeric,
  collected numeric,
  salary_cost numeric,
  commission_cost numeric,
  expense_cost numeric,
  total_rep_cost numeric,
  net_contribution numeric,
  job_count integer
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
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
           COALESCE(SUM(COALESCE(ps.base_salary_annual,0) / 365.25
             * (LEAST(COALESCE(ps.effective_to, _to), _to) - GREATEST(ps.effective_from, _from) + 1)),0) AS cost
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
REVOKE ALL ON FUNCTION public.rep_profitability(date,date,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rep_profitability(date,date,uuid) TO authenticated, service_role;