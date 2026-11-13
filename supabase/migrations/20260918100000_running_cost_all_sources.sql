-- Running cost: every source of cost on a job, each as its own column.
--
-- Mark, looking at the Billing tab of 24 Lodz Drive (Mold Remediation, Cash)
-- — three estimates on the left, two calculator results on the right, and a
-- Running cost tile reading COST $0.00 · REVENUE — · MARGIN —:
--
--   "the right side should show a runnign cost adding up all costs added in
--    from alal sources of costs from the project"
--
-- DEPENDS ON: 20260917120000 (job_cost_lines.field_work_ticket_id) and
-- 20260918090000 (supply_stock_moves). Both are referenced by name below, so
-- this file fails at CREATE FUNCTION if either is missing — check the ledger
-- before applying.
--
-- WHY THAT JOB READ $0.00
-- -----------------------
-- The 20260818175846 job_running_cost summed five things — equipment
-- placements, time-clock entries, supply requests, cost lines, referral costs
-- — and this job had none of them. What it DID have was invisible to the
-- function:
--
--   * Daily field work tickets. A ticket writes neither time_entries nor
--     equipment_placements. 48fbbc1f (PR #205) answered that by having the
--     app file one job_cost_lines row per ticket, keyed on
--     field_work_ticket_id, priced from the hours, crew and machines on the
--     form. That is kept, and it is the ticket's cost whenever it exists.
--     But it is posted from the browser of whoever saved the ticket, and
--     job_cost_lines is writable by owner / admin / sales_head only
--     (20260807220752), so a crew chief's save is refused by RLS and the
--     error is swallowed on purpose ("the shift is safe"). A ticket saved by
--     the crew — the normal case — still reached nothing. So: a ticket with
--     NO posted line is priced here, server-side, by the same arithmetic
--     (person-hours × crew rate, machines × the type's daily rate for the
--     one day), applying the office's accept / dismiss / override decisions
--     from field_ticket_crew_reviews and the per-class rates crew_rate_for()
--     was built for. One column either way: field_ticket_cost.
--   * Expenses. expenses.job_id has existed since 20260806173113 and a charge
--     logged against a job was counted nowhere on the job.
--   * The Job Calculator. Its internal_cost is a projection, not money spent
--     (see "not counted"), but a $0 beside a calculator that says $X is a
--     mystery unless the $X is shown and named.
--
-- The revenue side read "—" because the old fallback only counted estimates
-- in ('approved','sent','accepted') — 'accepted' is not even a value of
-- estimate_status — so a job whose only priced estimate is a draft
-- (ESTIMATE-1, $872, beside two empty drafts) had no revenue at all.
--
-- NO DOUBLE COUNTING, the rules:
--   * A ticket line vs. a time entry on the same day. The ticket says "two
--     people, eight hours" without naming them, so the clock entries for a
--     date whose ticket carries labour money are SUPERSEDED — not added.
--     This is rollUpLabour()'s rule (src/lib/job-labour-rollup.ts), applied
--     to money; the old function added both. Where the ticket could not
--     price its labour (no crew rate), the clock's money stands, so known
--     money is never hidden by an unpriced form.
--   * A posted ticket line vs. this function pricing the same ticket: a
--     ticket is priced here ONLY when it has no posted line.
--   * Ticket equipment vs. the drying log: a ticket charges its machines for
--     the one day it covers; equipment_placements accrues the stay. Same
--     rule as priceFieldTicket(), unchanged.
--   * A manual cost line is a SOURCE, added to the derived figures, never an
--     override of them. Labour cannot double because the Cost line form has
--     no labour box ("Labor is not entered here"). Equipment and materials
--     typed on a line are for things the drying log and supply request
--     cannot know — a rented pump, a Home Depot run — and the drawer prints
--     typed and derived as separate rows with their provenance, so a line
--     somebody typed to duplicate the drying log is visible to a human
--     rather than silently replacing it.
--
-- WHAT IS COUNTED, one column each:
--   equipment_cost       equipment_placements × equipment.daily_rate_cents ×
--                        GREATEST(1, days on site). Units with no rate are
--                        counted in equipment_unpriced_units.
--   labour_cost          time_entries (not rejected) on dates no ticket
--                        priced, × the person's pay_structures hourly_rate in
--                        force that day, else rate_for() (personal labour
--                        rate, then role rate). The old fallback
--                        `lr.user_id = te.user_id OR lr.user_id IS NULL`
--                        matched ANY subject-less labour_rates row — since
--                        20260902200000 that includes the 'gsr'/'temp' crew
--                        rates — so a technician without a personal rate
--                        could be priced at the temp agency rate. Entries
--                        with no rate at all are labour_uncosted_minutes.
--   field_ticket_cost    posted ticket lines (all four cost boxes) plus
--                        tickets priced here; split as
--                        field_ticket_labour_cost / field_ticket_equipment_cost;
--                        field_tickets_unposted says how many were priced
--                        here, field_ticket_uncosted_minutes how many
--                        person-minutes had no crew rate.
--   materials_cost       supply_requests (not denied) lines × unit_cost.
--   stock_used_cost      supply_stock_moves with this job_id and qty < 0 —
--                        stock taken off the shelf for the job — × unit_cost.
--                        A request delivered straight to a job is priced as
--                        a request; stock used on a job is priced here; the
--                        same box is not both.
--   subcontractor_cost   job_cost_lines.subcontractor_cost on hand-typed
--                        lines (ticket lines write 0 there).
--   expenses_cost        expenses.amount where expenses.job_id is this job:
--                        money already spent. expense_requests are NOT
--                        counted — a request, approved or not, is permission
--                        to spend; the spend arrives as an expenses row.
--   referral_cost        job_referral_costs.amount.
--   manual_cost          hand-typed job_cost_lines direct + materials +
--                        equipment.
--
-- NOT COUNTED, and why:
--   calculator_cost      The newest Job Calculator result's internal_cost
--                        (by job_date, then last saved). Returned so the
--                        drawer prints "Calculator projection · not in
--                        total"; NOT summed — it is what the job was expected
--                        to cost before anyone clocked in, and adding it to
--                        actual hours would count the same crew twice.
--   account_referral_fees  Referral TERMS on an account. The charge on a job
--                        is job_referral_costs.
--   expense_requests     Permission to spend; see expenses_cost.
--   supply_purchases     What the office paid a supplier for stock; reaches
--                        a job through the request or the stock move, both
--                        priced at catalogue unit_cost. Pricing job use at
--                        the purchase price is a report of its own.
--   commission_payouts   Rep pay, tracked on the rep.
--   field_work_tickets.materials_used  Free text, no quantity or price.
--   vehicle_positions    Positions only; no mileage cost lands on a job.
--   Purchase orders / subcontractor invoices  No such tables.
--
-- REVENUE, the fallback ladder (revenue_basis names the rung):
--   invoice         non-draft invoices, approved_amount else billed_amount.
--   estimate        every APPROVED estimate, summed — each is a scope the
--                   customer said yes to.
--   agreed_price    jobs.agreed_price — the cash job's agreed figure.
--   estimate_sent   the newest SENT estimate with a total (highest seq), one
--                   only: a re-sent revision supersedes, it does not add.
--   estimate_draft  the newest DRAFT with a total, one only. An empty draft
--                   never wins over a priced one — ESTIMATE-2 and -3 at $0
--                   do not hide ESTIMATE-1 at $872.
--   cost_lines      revenue typed on cost lines.
--   none            nothing yet.
--
-- GATE: can_view_finance(auth.uid()), as before — but the old function
-- returned a row of zeros to a rep (its aggregates produced a row even when
-- the guard was false) and its revenue subqueries had no guard at all, so a
-- SECURITY DEFINER call from any signed-in user returned invoice and
-- estimate totals for any job id. Now the guard is on the final SELECT:
-- whoever cannot see finance gets NO ROW, which the client renders as
-- nothing.
--
-- The return type changes, so the function is dropped and recreated;
-- running_cost_overview is recreated after it with the same body so nothing
-- holds a stale plan. Re-runnable.

DROP FUNCTION IF EXISTS public.job_running_cost(uuid);

CREATE FUNCTION public.job_running_cost(_job_id uuid)
RETURNS TABLE(
  equipment_cost numeric, equipment_days integer, equipment_units integer,
  equipment_unpriced_units integer,
  labour_cost numeric, labour_minutes bigint, labour_uncosted_minutes bigint,
  field_ticket_cost numeric, field_ticket_labour_cost numeric, field_ticket_equipment_cost numeric,
  field_tickets integer, field_tickets_unposted integer, field_ticket_uncosted_minutes bigint,
  materials_cost numeric,
  stock_used_cost numeric,
  subcontractor_cost numeric,
  expenses_cost numeric, expenses_count integer,
  referral_cost numeric,
  manual_cost numeric,
  calculator_cost numeric,
  total_cost numeric, revenue numeric, revenue_basis text,
  margin numeric, margin_pct numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  WITH guard AS (SELECT public.can_view_finance(auth.uid()) AS ok),

  -- Drying log: every placement, daily rate × days on site (at least one).
  eq AS (
    SELECT
      COALESCE(SUM((GREATEST(1, (COALESCE(p.retrieved_at, now())::date - p.placed_at::date) + 1))
                   * COALESCE(e.daily_rate_cents, 0) / 100.0), 0)::numeric AS cost,
      COALESCE(SUM(GREATEST(1, (COALESCE(p.retrieved_at, now())::date - p.placed_at::date) + 1)), 0)::int AS days,
      COUNT(*)::int AS units,
      COUNT(*) FILTER (WHERE e.daily_rate_cents IS NULL)::int AS unpriced
    FROM public.equipment_placements p
    JOIN public.equipment e ON e.id = p.equipment_id
    WHERE p.job_id = _job_id
  ),

  -- Field tickets the app has already filed as a cost line (PR #205's path).
  -- Their four cost boxes are the ticket's cost, as filed.
  posted AS (
    SELECT cl.field_work_ticket_id AS ticket_id, t.work_date,
           cl.direct_cost AS labour, cl.equipment_cost AS equipment,
           cl.direct_cost + cl.materials_cost + cl.subcontractor_cost + cl.equipment_cost AS cost
    FROM public.job_cost_lines cl
    JOIN public.field_work_tickets t ON t.id = cl.field_work_ticket_id
    WHERE cl.job_id = _job_id
  ),
  -- Tickets nobody could file a line for: priced here.
  unposted AS (
    SELECT t.*
    FROM public.field_work_tickets t
    WHERE t.job_id = _job_id
      AND NOT EXISTS (SELECT 1 FROM posted p WHERE p.ticket_id = t.id)
  ),
  -- One labour line per crew class per unposted ticket, with the office's
  -- accept / dismiss / override decisions applied — the same lines
  -- job_ticket_crew_hours returns.
  form_lines AS (
    SELECT t.id AS ticket_id, t.work_date, t.location_id, c.crew_class,
           COALESCE(r.headcount_override, c.crew_size) AS head,
           COALESCE(r.minutes_each_override,
                    public.field_ticket_crew_minutes(t.job_start_time, t.job_end_time)) AS mins
    FROM unposted t
    CROSS JOIN LATERAL (
      VALUES ('gsr'::text, t.gsr_crew_size), ('temp'::text, t.temp_crew_size)
    ) AS c(crew_class, crew_size)
    LEFT JOIN public.field_ticket_crew_reviews r
      ON r.ticket_id = t.id AND r.crew_class = c.crew_class
    WHERE COALESCE(r.review_state, 'proposed') <> 'dismissed'
  ),
  form_counting AS (
    SELECT l.*, public.crew_rate_for(l.crew_class, l.location_id, l.work_date) AS rate
    FROM form_lines l
    WHERE l.head > 0 AND l.mins IS NOT NULL
  ),
  form AS (
    SELECT COALESCE(SUM(head * mins / 60.0 * rate), 0)::numeric AS cost,
           COALESCE(SUM(head * mins) FILTER (WHERE rate IS NULL), 0)::bigint AS uncosted_minutes
    FROM form_counting
  ),
  -- Machines on an unposted ticket, by type, for the one day: the same
  -- vocabulary map as priceFieldTicket(), the type's highest catalogue rate.
  ticket_equipment AS (
    SELECT COALESCE(SUM(u.n * COALESCE(rate.dollars, 0)), 0)::numeric AS cost
    FROM unposted t
    CROSS JOIN LATERAL (
      VALUES ('dehumidifier'::text, t.equip_dehumidifier), ('air_mover', t.equip_air_mover),
             ('scrubber', t.equip_scrubber), ('injector', t.equip_injector),
             ('ozone', t.equip_ozone), ('hydroxyl', t.equip_hydroxyl),
             ('generator', t.equip_generator)
    ) AS u(key, n)
    LEFT JOIN LATERAL (
      SELECT MAX(e.daily_rate_cents) / 100.0 AS dollars
      FROM public.equipment e
      WHERE e.equipment_type::text = ANY (
        CASE u.key WHEN 'scrubber' THEN ARRAY['air_scrubber', 'hepa'] ELSE ARRAY[u.key] END)
    ) rate ON true
    WHERE COALESCE(u.n, 0) > 0
  ),
  tickets AS (
    SELECT COUNT(*)::int AS n,
           COUNT(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM posted p WHERE p.ticket_id = t.id))::int AS unposted
    FROM public.field_work_tickets t WHERE t.job_id = _job_id
  ),
  -- Dates a ticket priced labour on. The clock is superseded there.
  covered AS (
    SELECT work_date FROM posted WHERE labour > 0
    UNION
    SELECT work_date FROM form_counting WHERE rate IS NOT NULL
  ),

  -- Time clock, on every other date.
  clock AS (
    SELECT COALESCE(SUM(COALESCE(te.minutes, 0)), 0)::bigint AS minutes,
           COALESCE(SUM(COALESCE(te.minutes, 0) / 60.0 * COALESCE(r.rate, 0)), 0)::numeric AS cost,
           COALESCE(SUM(COALESCE(te.minutes, 0)) FILTER (WHERE r.rate IS NULL), 0)::bigint AS uncosted_minutes
    FROM public.time_entries te
    LEFT JOIN LATERAL (
      SELECT COALESCE(
        (SELECT ps.hourly_rate FROM public.pay_structures ps
          WHERE ps.user_id = te.user_id AND ps.hourly_rate IS NOT NULL
            AND ps.effective_from <= COALESCE(te.work_date, te.started_at::date)
            AND (ps.effective_to IS NULL OR ps.effective_to >= COALESCE(te.work_date, te.started_at::date))
          ORDER BY ps.effective_from DESC LIMIT 1),
        public.rate_for(te.user_id, COALESCE(te.work_date, te.started_at::date))
      ) AS rate
    ) r ON true
    WHERE te.job_id = _job_id
      AND te.status <> 'rejected'
      AND NOT EXISTS (
        SELECT 1 FROM covered c WHERE c.work_date = COALESCE(te.work_date, te.started_at::date)
      )
  ),

  -- Supplies requested for the job, priced off the catalogue.
  sup AS (
    SELECT COALESCE(SUM(l.quantity * COALESCE(i.unit_cost, 0)), 0)::numeric AS cost
    FROM public.supply_requests sr
    JOIN public.supply_request_lines l ON l.request_id = sr.id
    LEFT JOIN public.supply_items i ON i.id = l.item_id
    WHERE sr.job_id = _job_id AND sr.status::text <> 'denied'
  ),
  -- Stock taken off the shelf for the job.
  stock AS (
    SELECT COALESCE(SUM(-m.qty * COALESCE(i.unit_cost, 0)), 0)::numeric AS cost
    FROM public.supply_stock_moves m
    LEFT JOIN public.supply_items i ON i.id = m.item_id
    WHERE m.job_id = _job_id AND m.qty < 0
  ),

  -- What a person typed on the Cost by work component card.
  man AS (
    SELECT COALESCE(SUM(cl.direct_cost + cl.materials_cost + cl.equipment_cost), 0)::numeric AS cost,
           COALESCE(SUM(cl.subcontractor_cost), 0)::numeric AS subs,
           COALESCE(SUM(cl.revenue), 0)::numeric AS revenue
    FROM public.job_cost_lines cl
    WHERE cl.job_id = _job_id AND cl.field_work_ticket_id IS NULL
  ),

  -- Money already spent and logged against the job.
  exp AS (
    SELECT COALESCE(SUM(x.amount), 0)::numeric AS cost, COUNT(*)::int AS n
    FROM public.expenses x WHERE x.job_id = _job_id
  ),

  ref AS (
    SELECT COALESCE(SUM(rc.amount), 0)::numeric AS cost
    FROM public.job_referral_costs rc WHERE rc.job_id = _job_id
  ),

  -- The calculator's projection: shown, never summed.
  calc_snapshot AS (
    SELECT COALESCE((
      SELECT c.internal_cost FROM public.job_calculations c
      WHERE c.job_id = _job_id
      ORDER BY c.job_date DESC, c.updated_at DESC
      LIMIT 1), 0)::numeric AS cost
  ),

  rev AS (
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
         ORDER BY e.seq DESC NULLS LAST, e.updated_at DESC LIMIT 1) AS est_draft
  ),

  posted_sum AS (
    SELECT COALESCE(SUM(cost), 0)::numeric AS cost,
           COALESCE(SUM(labour), 0)::numeric AS labour,
           COALESCE(SUM(equipment), 0)::numeric AS equipment
    FROM posted
  ),

  calc AS (
    SELECT
      eq.cost AS eq_cost, eq.days AS eq_days, eq.units AS eq_units, eq.unpriced AS eq_unpriced,
      clock.cost AS lab_cost, clock.minutes AS lab_minutes, clock.uncosted_minutes AS lab_uncosted,
      posted_sum.cost + form.cost + ticket_equipment.cost AS ticket_cost,
      posted_sum.labour + form.cost AS ticket_labour,
      posted_sum.equipment + ticket_equipment.cost AS ticket_equipment,
      tickets.n AS ticket_n, tickets.unposted AS ticket_unposted,
      form.uncosted_minutes AS ticket_uncosted,
      sup.cost AS mat_cost,
      stock.cost AS stock_cost,
      man.subs AS sub_cost,
      exp.cost AS exp_cost, exp.n AS exp_n,
      ref.cost AS ref_cost,
      man.cost AS man_cost,
      calc_snapshot.cost AS calculator_cost,
      eq.cost + clock.cost
        + posted_sum.cost + form.cost + ticket_equipment.cost
        + sup.cost + stock.cost + man.subs + exp.cost + ref.cost + man.cost AS total,
      CASE WHEN rev.inv > 0 THEN rev.inv
           WHEN rev.est_approved > 0 THEN rev.est_approved
           WHEN COALESCE(rev.agreed, 0) > 0 THEN rev.agreed
           WHEN COALESCE(rev.est_sent, 0) > 0 THEN rev.est_sent
           WHEN COALESCE(rev.est_draft, 0) > 0 THEN rev.est_draft
           ELSE man.revenue END AS revenue,
      CASE WHEN rev.inv > 0 THEN 'invoice'
           WHEN rev.est_approved > 0 THEN 'estimate'
           WHEN COALESCE(rev.agreed, 0) > 0 THEN 'agreed_price'
           WHEN COALESCE(rev.est_sent, 0) > 0 THEN 'estimate_sent'
           WHEN COALESCE(rev.est_draft, 0) > 0 THEN 'estimate_draft'
           WHEN man.revenue > 0 THEN 'cost_lines'
           ELSE 'none' END AS basis
    FROM eq, clock, posted_sum, form, ticket_equipment, tickets, sup, stock, man, exp, ref,
         calc_snapshot, rev
  )
  SELECT ROUND(eq_cost, 2), eq_days, eq_units, eq_unpriced,
         ROUND(lab_cost, 2), lab_minutes, lab_uncosted,
         ROUND(ticket_cost, 2), ROUND(ticket_labour, 2), ROUND(ticket_equipment, 2),
         ticket_n, ticket_unposted, ticket_uncosted,
         ROUND(mat_cost, 2),
         ROUND(stock_cost, 2),
         ROUND(sub_cost, 2),
         ROUND(exp_cost, 2), exp_n,
         ROUND(ref_cost, 2),
         ROUND(man_cost, 2),
         ROUND(calculator_cost, 2),
         ROUND(total, 2), ROUND(revenue, 2), basis,
         ROUND(revenue - total, 2),
         CASE WHEN revenue > 0 THEN ROUND(((revenue - total) / revenue) * 100, 1) END
  FROM calc, guard
  WHERE guard.ok;
$$;

COMMENT ON FUNCTION public.job_running_cost(uuid) IS
  'Cost to date on one job, one column per source: drying log, time clock (superseded on days a field ticket priced), field tickets (the posted cost line, else priced here), supply requests, stock used, hand-typed cost lines, expenses, referral. calculator_cost is the Job Calculator projection and is NOT in total_cost. Revenue on a fallback ladder named by revenue_basis. No row unless can_view_finance().';

REVOKE ALL ON FUNCTION public.job_running_cost(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.job_running_cost(uuid) TO authenticated, service_role;

-- Same body as 20260818180332; recreated so it is planned against the new
-- job_running_cost. It reads total_cost / revenue / margin / margin_pct only,
-- so the jobs-list and dashboard figures ARE the per-job figure.
CREATE OR REPLACE FUNCTION public.running_cost_overview(_location_id uuid DEFAULT NULL, _limit integer DEFAULT 8)
RETURNS TABLE(
  job_id uuid, job_number text, title text, location_id uuid, status text,
  total_cost numeric, revenue numeric, margin numeric, margin_pct numeric,
  company_cost numeric, company_revenue numeric, active_jobs integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  WITH guard AS (SELECT public.can_view_finance(auth.uid()) AS ok),
  rc AS (
    SELECT j.id, j.job_number, j.address AS title, j.location_id, j.status::text AS status,
           c.total_cost, c.revenue, c.margin, c.margin_pct
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

REVOKE ALL ON FUNCTION public.running_cost_overview(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.running_cost_overview(uuid, integer) TO authenticated, service_role;
