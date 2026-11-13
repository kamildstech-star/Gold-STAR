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
  money_visible boolean
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
    SELECT t.created_by AS uid, count(*)::int AS n
      FROM public.touchpoints t
     WHERE t.created_by IN (SELECT user_id FROM people)
       AND t.occurred_at >= _from AND t.occurred_at < _to
     GROUP BY t.created_by
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
  jb AS (
    SELECT a.assigned_rep AS uid,
           count(DISTINCT j.id)::int AS jobs,
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
         COALESCE(tp.n, 0), COALESCE(stage.held, 0), COALESCE(stage.advanced, 0),
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
         (SELECT ok FROM money)
    FROM people p
    LEFT JOIN acct  ON acct.uid  = p.user_id
    LEFT JOIN tp    ON tp.uid    = p.user_id
    LEFT JOIN stage ON stage.uid = p.user_id
    LEFT JOIN jb    ON jb.uid    = p.user_id
    LEFT JOIN disp  ON disp.uid  = p.user_id
    LEFT JOIN ch    ON ch.uid    = p.user_id;
$function$;

REVOKE ALL ON FUNCTION public.leaderboard_standings(timestamptz, timestamptz, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.leaderboard_standings(timestamptz, timestamptz, uuid[]) TO authenticated;