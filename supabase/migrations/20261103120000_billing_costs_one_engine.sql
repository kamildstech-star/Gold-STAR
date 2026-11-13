-- Billing & Costs, prompt 5: one money engine in SQL.
--
-- One REVENUE rule, job_revenue(): the running cost's ladder — non-draft
-- invoices (approved amount, else billed), else approved estimates, else the
-- agreed price, else the latest sent then draft estimate, else typed cost-line
-- revenue. job_profitability's billed/margin and company_money_summary's
-- billed now follow it (drafts no longer count as revenue). Commission bases
-- (compute_job_commissions, rep_profitability) are contractual and are NOT
-- changed here — see the P5 report.
--
-- One EQUIPMENT-DAY rule: Eastern (America/New_York) calendar days, the
-- drop-off day is day 1, at least 1 — gsr_local_date(), as job_running_cost
-- and equipmentDaysOnSite already count. job_profitability moves off CEIL of
-- 24-hour periods.
--
-- One LABOR RATE: rate_for(user, work_date) — the person's own rate, else
-- their role's, on the day worked. job_cost_breakdown and
-- company_money_summary move off "any rate with no person". A rejected time
-- entry costs nothing (job_labour_summary now agrees with the running cost).
--
-- Rounding stays where it was: once, at the output column, ROUND(x, 2) —
-- PostgreSQL rounds numeric half away from zero, like src/lib/money.ts.

CREATE OR REPLACE FUNCTION public.job_revenue(_job_id uuid)
RETURNS TABLE (revenue numeric, basis text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH rev AS (
    SELECT
      (SELECT COALESCE(SUM(COALESCE(i.approved_amount, i.billed_amount)), 0)
         FROM public.invoices i
        WHERE i.job_id = _job_id AND i.status::text <> 'draft') AS inv,
      (SELECT COALESCE(SUM(e.total), 0) FROM public.estimates e
        WHERE e.job_id = _job_id AND e.status::text = 'approved') AS est_approved,
      (SELECT j.agreed_price FROM public.jobs j WHERE j.id = _job_id) AS agreed,
      (SELECT e.total FROM public.estimates e
        WHERE e.job_id = _job_id AND e.status::text = 'sent' AND e.total > 0
        ORDER BY e.seq DESC NULLS LAST, e.updated_at DESC LIMIT 1) AS est_sent,
      (SELECT e.total FROM public.estimates e
        WHERE e.job_id = _job_id AND e.status::text = 'draft' AND e.total > 0
        ORDER BY e.seq DESC NULLS LAST, e.updated_at DESC LIMIT 1) AS est_draft,
      (SELECT COALESCE(SUM(l.revenue), 0) FROM public.job_cost_lines l WHERE l.job_id = _job_id) AS lines
  )
  SELECT CASE WHEN rev.inv > 0 THEN rev.inv
              WHEN rev.est_approved > 0 THEN rev.est_approved
              WHEN COALESCE(rev.agreed, 0) > 0 THEN rev.agreed
              WHEN COALESCE(rev.est_sent, 0) > 0 THEN rev.est_sent
              WHEN COALESCE(rev.est_draft, 0) > 0 THEN rev.est_draft
              ELSE rev.lines END,
         CASE WHEN rev.inv > 0 THEN 'invoice'
              WHEN rev.est_approved > 0 THEN 'estimate'
              WHEN COALESCE(rev.agreed, 0) > 0 THEN 'agreed_price'
              WHEN COALESCE(rev.est_sent, 0) > 0 THEN 'estimate_sent'
              WHEN COALESCE(rev.est_draft, 0) > 0 THEN 'estimate_draft'
              WHEN rev.lines > 0 THEN 'cost_lines'
              ELSE 'none' END
    FROM rev
   WHERE public.can_view_job(auth.uid(), _job_id);
$$;
REVOKE ALL ON FUNCTION public.job_revenue(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.job_revenue(uuid) TO authenticated, service_role;

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
         -- A rejected entry costs nothing, as in the running cost (P5).
         THEN COALESCE(SUM((te.minutes::numeric / 60) * COALESCE(public.rate_for(te.user_id, te.work_date), 0))
                       FILTER (WHERE te.status::text <> 'rejected'), 0)
         ELSE NULL END
  FROM public.time_entries te
  WHERE te.job_id = _job_id
    AND public.can_view_job(auth.uid(), _job_id)
$$;
REVOKE ALL ON FUNCTION public.job_labour_summary(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.job_labour_summary(uuid) TO authenticated, service_role;

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
  -- One revenue rule (P5): job_revenue(), the running cost's ladder.
  inv AS (
    SELECT (SELECT r.revenue FROM public.job_revenue(_job_id) r) AS billed,
           COALESCE(SUM(i.collected_amount),0) AS collected
    FROM public.invoices i WHERE i.job_id = _job_id
  ),
  eq AS (
    SELECT COALESCE(SUM(
      -- One equipment-day rule (P5): Eastern calendar days, drop-off = day 1.
      GREATEST(1, public.gsr_local_date(COALESCE(ep.retrieved_at, now())) - public.gsr_local_date(ep.placed_at) + 1)
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
REVOKE ALL ON FUNCTION public.job_profitability(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.job_profitability(uuid) TO authenticated, service_role;

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
    -- One labor rate everywhere (P5): the person's own rate, else their
    -- role's, on the work date — rate_for(), as the running cost reads it.
    LEFT JOIN LATERAL (
      SELECT public.rate_for(te.user_id, COALESCE(te.work_date, te.started_at::date)) AS hourly_rate
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
    -- One revenue rule (P5): a draft is not revenue; an approved amount
    -- wins over the billed one — job_revenue()'s first step.
    SELECT COALESCE(SUM(COALESCE(i.approved_amount, i.billed_amount)) FILTER (WHERE i.status::text <> 'draft'),0) AS billed,
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
    -- One labor rate everywhere (P5): the person's own rate, else their
    -- role's, on the work date — rate_for(), as the running cost reads it.
    LEFT JOIN LATERAL (
      SELECT public.rate_for(te.user_id, COALESCE(te.work_date, te.started_at::date)) AS hourly_rate
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
