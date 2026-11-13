DROP FUNCTION IF EXISTS public.leaderboard_standings(timestamptz, timestamptz, uuid[]);

CREATE OR REPLACE FUNCTION public.leaderboard_standings(
  _from timestamptz,
  _to timestamptz,
  _location_ids uuid[] DEFAULT NULL
)
RETURNS TABLE(
  user_id uuid,
  full_name text,
  roles app_role[],
  location_ids uuid[],
  touchpoints integer,
  meetings_held integer,
  accounts_advanced integer,
  accounts_owned integer,
  new_accounts integer,
  cadence_health numeric,
  jobs_won integer,
  billed_value numeric,
  collected_value numeric,
  incidents_dispatched integer,
  incidents_accepted integer,
  contracts_signed integer,
  chase_acceptance numeric,
  median_tta_minutes numeric,
  activity_events integer,
  money_visible boolean,
  calls_made integer,
  stage_advances integer,
  jobs_signed_insurance integer,
  jobs_signed_cash integer,
  jobs_signed_total integer
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH money AS (
    SELECT (
      public.is_privileged(auth.uid())
      OR public.has_role(auth.uid(), 'location_manager')
      OR public.has_role(auth.uid(), 'sales_manager')
      OR public.has_role(auth.uid(), 'regional')
    ) AS ok
  ),
  people AS (
    SELECT r.user_id, r.full_name, r.roles,
           COALESCE((SELECT array_agg(lm.location_id) FROM public.location_members lm
                      WHERE lm.user_id = r.user_id), ARRAY[]::uuid[]) AS location_ids
      FROM public.list_business_reps() r
     WHERE EXISTS (
       SELECT 1 FROM public.location_members lm
        WHERE lm.user_id = r.user_id
          AND public.can_view_location(auth.uid(), lm.location_id)
          AND (_location_ids IS NULL OR lm.location_id = ANY(_location_ids))
     )
  ),
  acct AS (
    SELECT a.assigned_rep AS uid,
           count(*)::int AS owned,
           count(*) FILTER (
             WHERE COALESCE(
               (SELECT max(t.occurred_at) FROM public.touchpoints t WHERE t.account_id = a.id),
               '-infinity'::timestamptz) < now() - interval '90 days'
           )::int AS overdue,
           count(*) FILTER (WHERE a.created_at >= _from AND a.created_at < _to)::int AS opened
      FROM public.accounts a
     WHERE a.assigned_rep IN (SELECT user_id FROM people)
     GROUP BY a.assigned_rep
  ),
  tp AS (
    SELECT t.created_by AS uid,
           count(*)::int AS n,
           count(*) FILTER (WHERE t.type = 'call')::int AS calls,
           count(*) FILTER (
             WHERE t.meeting_held IS TRUE OR t.type::text LIKE 'meeting%'
           )::int AS meetings
      FROM public.touchpoints t
     WHERE t.created_by IN (SELECT user_id FROM people)
       AND t.occurred_at >= _from AND t.occurred_at < _to
     GROUP BY t.created_by
  ),
  ca AS (
    SELECT c.author_id AS uid, count(*)::int AS calls
      FROM public.contact_attempts c
     WHERE c.author_id IN (SELECT user_id FROM people)
       AND c.channel = 'call'
       AND c.occurred_at >= _from AND c.occurred_at < _to
     GROUP BY c.author_id
  ),
  stage AS (
    SELECT h.changed_by AS uid,
           count(*)::int AS advanced,
           count(*) FILTER (WHERE h.to_stage = 'meeting_held')::int AS held
      FROM public.account_stage_history h
     WHERE h.changed_by IN (SELECT user_id FROM people)
       AND h.changed_at >= _from AND h.changed_at < _to
     GROUP BY h.changed_by
  ),
  -- Forward moves only, made by a person. Anything the auto-advance engine
  -- fired is excluded so the metric cannot be gamed by automation.
  fwd AS (
    SELECT h.changed_by AS uid, count(*)::int AS n
      FROM public.account_stage_history h
      JOIN public.pipeline_stages fs ON fs.id = h.from_stage_id
      JOIN public.pipeline_stages ts ON ts.id = h.to_stage_id
     WHERE h.changed_by IN (SELECT user_id FROM people)
       AND h.changed_at >= _from AND h.changed_at < _to
       AND ts.sort_order > fs.sort_order
       AND NOT EXISTS (
         SELECT 1 FROM public.stage_auto_advances sa
          WHERE sa.account_id = h.account_id
            AND sa.to_stage_id = h.to_stage_id
            AND sa.fired_at BETWEEN h.changed_at - interval '2 minutes'
                                AND h.changed_at + interval '2 minutes'
       )
     GROUP BY h.changed_by
  ),
  jb AS (
    SELECT a.assigned_rep AS uid,
           count(DISTINCT j.id)::int AS jobs,
           count(DISTINCT j.id) FILTER (
             WHERE j.insurance_carrier IS NOT NULL
                OR j.insurance_carrier_account_id IS NOT NULL
                OR COALESCE(j.insurance_kind, '') <> ''
           )::int AS jobs_ins,
           count(DISTINCT j.id) FILTER (
             WHERE j.insurance_carrier IS NULL
               AND j.insurance_carrier_account_id IS NULL
               AND COALESCE(j.insurance_kind, '') = ''
           )::int AS jobs_cash,
           COALESCE(sum(j.billed_amount), 0) AS billed,
           COALESCE(sum(j.collected_amount), 0) AS collected
      FROM public.jobs j
      JOIN public.accounts a ON a.id = j.account_id
     WHERE a.assigned_rep IN (SELECT user_id FROM people)
       AND j.created_at >= _from AND j.created_at < _to
       AND j.status <> 'cancelled'
     GROUP BY a.assigned_rep
  ),
  disp AS (
    SELECT p.user_id AS uid,
           (SELECT count(*) FROM public.incidents i
             WHERE i.reported_at >= _from AND i.reported_at < _to
               AND i.location_id IN (SELECT lm.location_id FROM public.location_members lm
                                      WHERE lm.user_id = p.user_id))::int AS dispatched
      FROM people p
  ),
  ch AS (
    SELECT i.accepted_by AS uid,
           count(*)::int AS accepted,
           count(*) FILTER (WHERE i.outcome = 'contract_signed')::int AS signed,
           percentile_cont(0.5) WITHIN GROUP (
             ORDER BY EXTRACT(EPOCH FROM (i.arrived_at - i.accepted_at)) / 60.0
           ) FILTER (WHERE i.arrived_at IS NOT NULL) AS tta
      FROM public.incidents i
     WHERE i.accepted_by IN (SELECT user_id FROM people)
       AND i.accepted_at >= _from AND i.accepted_at < _to
     GROUP BY i.accepted_by
  )
  SELECT p.user_id, p.full_name, p.roles, p.location_ids,
         COALESCE(tp.n, 0),
         GREATEST(COALESCE(tp.meetings, 0), COALESCE(stage.held, 0)),
         COALESCE(stage.advanced, 0),
         COALESCE(acct.owned, 0), COALESCE(acct.opened, 0),
         CASE WHEN COALESCE(acct.owned, 0) = 0 THEN NULL
              ELSE 1 - (acct.overdue::numeric / acct.owned::numeric) END,
         COALESCE(jb.jobs, 0),
         CASE WHEN (SELECT ok FROM money) THEN COALESCE(jb.billed, 0) ELSE NULL END,
         CASE WHEN (SELECT ok FROM money) THEN COALESCE(jb.collected, 0) ELSE NULL END,
         COALESCE(disp.dispatched, 0), COALESCE(ch.accepted, 0), COALESCE(ch.signed, 0),
         CASE WHEN COALESCE(disp.dispatched, 0) = 0 THEN NULL
              ELSE LEAST(1, COALESCE(ch.accepted, 0)::numeric / disp.dispatched::numeric) END,
         ch.tta,
         (COALESCE(tp.n,0) + COALESCE(stage.advanced,0) + COALESCE(jb.jobs,0)
          + COALESCE(ch.accepted,0))::int,
         (SELECT ok FROM money),
         (COALESCE(tp.calls, 0) + COALESCE(ca.calls, 0))::int,
         COALESCE(fwd.n, 0),
         COALESCE(jb.jobs_ins, 0),
         COALESCE(jb.jobs_cash, 0),
         COALESCE(jb.jobs, 0)
    FROM people p
    LEFT JOIN acct  ON acct.uid  = p.user_id
    LEFT JOIN tp    ON tp.uid    = p.user_id
    LEFT JOIN ca    ON ca.uid    = p.user_id
    LEFT JOIN fwd   ON fwd.uid   = p.user_id
    LEFT JOIN stage ON stage.uid = p.user_id
    LEFT JOIN jb    ON jb.uid    = p.user_id
    LEFT JOIN disp  ON disp.uid  = p.user_id
    LEFT JOIN ch    ON ch.uid    = p.user_id;
$function$;

REVOKE ALL ON FUNCTION public.leaderboard_standings(timestamptz, timestamptz, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.leaderboard_standings(timestamptz, timestamptz, uuid[]) TO authenticated;

-- Admin-editable scorecard weights for the four primary sales columns.
INSERT INTO public.scorecard_weights (role_group, component, weight, target, direction, enabled)
SELECT v.role_group, v.component, v.weight, v.target, 'higher', true
  FROM (VALUES
    ('sales', 'jobs_signed_total', 30, 6),
    ('sales', 'calls_made', 20, 200),
    ('sales', 'stage_advances', 20, 25),
    ('sales', 'meetings_held', 30, 12)
  ) AS v(role_group, component, weight, target)
 WHERE NOT EXISTS (
   SELECT 1 FROM public.scorecard_weights w
    WHERE w.role_group = v.role_group AND w.component = v.component AND w.location_id IS NULL
 );