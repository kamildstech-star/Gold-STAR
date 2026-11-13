-- Days on site: one convention, in the office's own calendar.
--
-- David, 24 Sep: "You see this piece of equipment here I scanned... it's out
-- zero days. I dropped it off [yesterday]... the scanner part is functioning,
-- but it's not reading how long it's there for."
--
-- The money already billed INCLUSIVE CALENDAR DAYS with the drop-off day as
-- day 1 (GREATEST(1, retrieved_or_today - placed + 1), 20260818175846 and
-- 20260918100000). What was wrong was the screen: the job's Equipment tab
-- counted whole 24-hour periods rounded down, so a unit dropped yesterday
-- afternoon read "Out 0d" this morning while the job was charged 2 days for
-- it. The screen now uses the billing rule (equipmentDaysOnSite in
-- src/lib/equipment.ts).
--
-- One thing the SQL got wrong too: `timestamptz::date` takes the date in the
-- DATABASE's time zone, which is UTC. A unit dropped at 9pm in New Jersey is
-- already "tomorrow" in UTC, so it was billed from the next day. Every Gold
-- Star office is on Eastern time, so both the screen and this function now
-- take the calendar date in America/New_York. Nothing else in the function
-- changes — the body below is 20260918100000's, with those two casts swapped.

-- The office calendar date of an instant. One place, so the screen's rule and
-- this one cannot drift; if an office ever opens in another zone this is where
-- a per-location zone goes.
CREATE OR REPLACE FUNCTION public.gsr_local_date(_at timestamptz)
RETURNS date
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$ SELECT (_at AT TIME ZONE 'America/New_York')::date $$;

REVOKE ALL ON FUNCTION public.gsr_local_date(timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gsr_local_date(timestamptz) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.job_running_cost(_job_id uuid)
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
