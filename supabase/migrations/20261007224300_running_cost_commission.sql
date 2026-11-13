-- Running cost counts commission.
--
-- Mark, 7 Oct: "... commission amount, which will auto calculate as the
-- charges get added, or a flat fee, and running cost needs to add that into
-- its calculation as well". And: "it needs to be able to separate salesman
-- and referrers."
--
-- Two things:
--
-- 1. public.job_referrer_commission(_job_id, _revenue) — the SQL twin of
--    src/lib/job-commission.ts (resolveReferrerBasis + basisAmount). Same
--    precedence: this job's override (flat, then percent) → the referring
--    PERSON's rule → the referring COMPANY's rule → the "Came from" source's
--    rate in app_settings 'commission_rates'. A rule applies when its window
--    holds the job's office-calendar created date; the newest start wins. A
--    percentage is of the revenue passed in (never below zero); a flat fee is
--    the fee. No row when nothing applies — no deal is not a $0 deal.
--    supabase/tests/running-cost-commission.pglite.mjs runs it against the
--    same cases as src/lib/job-commission.test.ts.
--    SECURITY INVOKER and executable by no client role: it exists for
--    job_running_cost (a definer function) and the service role.
--
-- 2. job_running_cost gains three columns at the END —
--    referrer_commission_cost, salesman_commission_cost, commission_cost —
--    and total_cost, margin and margin_pct now include commission_cost.
--    Salesmen are the rep commission engine's payouts on the job
--    (commission_payouts, kind 'commission', not void). That engine prices
--    from job_cost_lines and never reads running cost, so there is no loop.
--
--    The body below is 20260927120000's, unchanged except where marked
--    20261007224300. The argument list (_job_id uuid), SECURITY DEFINER,
--    search_path = public, the can_view_finance gate and the grants (EXECUTE
--    to authenticated and service_role only, revoked from PUBLIC and anon)
--    are exactly as live. Adding OUT columns changes the return type, which
--    CREATE OR REPLACE cannot do, so the function is dropped and created in
--    this one transaction. running_cost_overview calls it by name from a
--    plain SQL body (no dependency is recorded) and reads its columns by
--    name, so it carries on unchanged — its company cost now includes
--    commission too.
--
-- Profit, traced, so nothing is taken off twice:
--   * the ledger strip's Total Profit subtracted commission itself; it now
--     takes the running cost as it comes once commission_cost is present
--     (src/lib/job-ledger.ts jobProfit), and still subtracts it on a
--     database where this migration is not applied yet.
--   * running_cost_overview and the Running cost card: total_cost and margin
--     straight from here — commission now in, once.
--   * the commissions report reads only revenue from here.
--   * rep_profitability / director_rep_cost charge a REP's commission against
--     that rep (money_events 'commission_issued'), not against a job's
--     margin; nothing adds the two together.
--
-- Depends on 20261007224100 (referral_commission_rules) and 20261007224200
-- (jobs.commission_flat_amount), which sort before it.

CREATE OR REPLACE FUNCTION public.job_referrer_commission(_job_id uuid, _revenue numeric)
RETURNS TABLE(origin text, kind text, value numeric, amount numeric)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  WITH j AS (
    SELECT jb.referred_by_account_id AS acc, jb.referred_by_contact_id AS con,
           jb.commission_source AS src, jb.commission_rate_pct AS pct,
           jb.commission_flat_amount AS flat,
           public.gsr_local_date(jb.created_at) AS on_day
    FROM public.jobs jb WHERE jb.id = _job_id
  ),
  person AS (
    SELECT r.kind, r.value FROM public.referral_commission_rules r, j
    WHERE j.con IS NOT NULL AND r.contact_id = j.con
      AND (r.effective_from IS NULL OR j.on_day IS NULL OR r.effective_from <= j.on_day)
      AND (r.effective_to IS NULL OR j.on_day IS NULL OR r.effective_to >= j.on_day)
    ORDER BY r.effective_from DESC NULLS LAST LIMIT 1
  ),
  company AS (
    SELECT r.kind, r.value FROM public.referral_commission_rules r, j
    WHERE j.acc IS NOT NULL AND r.account_id = j.acc
      AND (r.effective_from IS NULL OR j.on_day IS NULL OR r.effective_from <= j.on_day)
      AND (r.effective_to IS NULL OR j.on_day IS NULL OR r.effective_to >= j.on_day)
    ORDER BY r.effective_from DESC NULLS LAST LIMIT 1
  ),
  -- The "Came from" rate, read the way parseCommissionSources reads it: a
  -- key, and a pct between 0 and 100. Anything else is no rate.
  source AS (
    SELECT (s->>'pct')::numeric AS pct
    FROM public.app_settings a, j,
         jsonb_array_elements(CASE WHEN jsonb_typeof(a.value->'sources') = 'array'
                                   THEN a.value->'sources' ELSE '[]'::jsonb END) s
    WHERE a.key = 'commission_rates' AND j.src IS NOT NULL
      AND btrim(s->>'key') = j.src
      AND (s->>'pct') ~ '^[0-9]+(\.[0-9]+)?$'
      AND (s->>'pct')::numeric <= 100
    LIMIT 1
  ),
  pick AS (
    SELECT 1 AS rank, 'override'::text AS origin, 'flat'::text AS kind, j.flat AS value
      FROM j WHERE j.flat IS NOT NULL
    UNION ALL
    SELECT 2, 'override', 'percent', j.pct FROM j WHERE j.pct IS NOT NULL
    UNION ALL
    SELECT 3, 'person', person.kind, person.value FROM person
    UNION ALL
    SELECT 4, 'company', company.kind, company.value FROM company
    UNION ALL
    SELECT 5, 'source', 'percent', source.pct FROM source
  )
  SELECT p.origin, p.kind, p.value,
         CASE WHEN p.kind = 'flat' THEN ROUND(GREATEST(p.value, 0), 2)
              ELSE ROUND(GREATEST(COALESCE(_revenue, 0), 0) * p.value / 100.0, 2) END
  FROM pick p
  ORDER BY p.rank
  LIMIT 1;
$$;

COMMENT ON FUNCTION public.job_referrer_commission(uuid, numeric) IS
  'The referrer commission on one job at a given revenue: override (flat, then percent) > person rule > company rule > commission_rates source pct. SQL twin of src/lib/job-commission.ts. No row when nothing applies.';

REVOKE ALL ON FUNCTION public.job_referrer_commission(uuid, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.job_referrer_commission(uuid, numeric) TO service_role;

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
  margin numeric, margin_pct numeric,
  -- 20261007224300: commission is a cost. Appended, so every column above
  -- keeps its name, type and position.
  referrer_commission_cost numeric, salesman_commission_cost numeric,
  commission_cost numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  WITH guard AS (SELECT public.can_view_finance(auth.uid()) AS ok),

  -- Drying log: every placement, daily rate × days on site (at least one).
  eq AS (
    SELECT
      COALESCE(SUM((GREATEST(1, (public.gsr_local_date(COALESCE(p.retrieved_at, now())) - public.gsr_local_date(p.placed_at)) + 1))
                   * COALESCE(e.daily_rate_cents, 0) / 100.0), 0)::numeric AS cost,
      COALESCE(SUM(GREATEST(1, (public.gsr_local_date(COALESCE(p.retrieved_at, now())) - public.gsr_local_date(p.placed_at)) + 1)), 0)::int AS days,
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

  -- 20261007224300. What the rep commission engine owes Gold Star's own
  -- salesmen on this job (commission_payouts; a voided payout is no
  -- commission). The engine decides the amount; it is only summed here.
  sal AS (
    SELECT COALESCE(SUM(cp.amount), 0)::numeric AS cost
    FROM public.commission_payouts cp
    WHERE cp.job_id = _job_id AND cp.kind = 'commission' AND cp.status <> 'void'
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
  ),

  -- 20261007224300. The referrer's commission is a share of the revenue just
  -- worked out (or a flat fee), so it is taken after calc, from the one SQL
  -- twin of src/lib/job-commission.ts. Commission is on the CALCULATED
  -- revenue: a figure typed over Billed on the ledger strip
  -- (job_ledger_overrides) never touches an invoice, so it never moves a
  -- commission either.
  comm AS (
    SELECT COALESCE((SELECT rc.amount FROM public.job_referrer_commission(_job_id, calc.revenue) rc), 0)::numeric AS referrer,
           sal.cost AS salesman
    FROM calc, sal
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
         -- 20261007224300. Commission is counted ONCE, here. Every consumer
         -- (the drawer, the ledger strip's Total Expenses and Total Profit,
         -- the overview) takes total_cost and margin as they come.
         ROUND(total + comm.referrer + comm.salesman, 2), ROUND(revenue, 2), basis,
         ROUND(revenue - (total + comm.referrer + comm.salesman), 2),
         CASE WHEN revenue > 0
              THEN ROUND(((revenue - (total + comm.referrer + comm.salesman)) / revenue) * 100, 1) END,
         ROUND(comm.referrer, 2), ROUND(comm.salesman, 2),
         ROUND(comm.referrer + comm.salesman, 2)
  FROM calc, comm, guard
  WHERE guard.ok;
$$;

COMMENT ON FUNCTION public.job_running_cost(uuid) IS
  'Cost to date on one job, one column per source: drying log, time clock (superseded on days a field ticket priced), field tickets (the posted cost line, else priced here), supply requests, stock used, hand-typed cost lines, expenses, referral, and commission (the referrer deal via job_referrer_commission plus the salesmen''s commission_payouts). calculator_cost is the Job Calculator projection and is NOT in total_cost. Revenue on a fallback ladder named by revenue_basis. No row unless can_view_finance().';

REVOKE ALL ON FUNCTION public.job_running_cost(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.job_running_cost(uuid) TO authenticated, service_role;
