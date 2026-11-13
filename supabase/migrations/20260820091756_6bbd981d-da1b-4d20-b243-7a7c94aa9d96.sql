INSERT INTO public.permissions (key, label, perm_group, description, sort_order)
VALUES ('sales_director.view', 'View sales director dashboard', 'Reporting',
        'Team-wide sales director dashboard: rep KPIs against goal, sales intelligence, task board, affiliates and campaign results.', 117)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.role_permissions (role, permission_key)
SELECT r, 'sales_director.view'
FROM unnest(ARRAY['owner','admin','dev','sales_head']::app_role[]) r
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION public.sales_director_reps(_from date, _to date)
RETURNS TABLE (
  user_id uuid,
  full_name text,
  location_id uuid,
  revenue numeric,
  calls integer,
  appointments integer,
  jobs_won integer,
  revenue_target numeric,
  calls_target numeric,
  appointments_target numeric,
  jobs_target numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH people AS (
    SELECT DISTINCT ON (p.user_id) p.user_id AS id, p.full_name, lm.location_id
    FROM public.profiles p
    JOIN public.user_roles ur ON ur.user_id = p.user_id
    JOIN public.location_members lm ON lm.user_id = p.user_id
    WHERE ur.role IN ('sales_person','sales_rep','outside_sales_rep','cold_caller','sales_manager','sales_head')
      AND public.can_view_location(auth.uid(), lm.location_id)
      AND coalesce(p.is_active, true)
    ORDER BY p.user_id, lm.location_id
  ),
  goal AS (
    SELECT g.subject_user_id AS uid, g.metric, sum(g.target_value) AS target
    FROM public.goals g
    WHERE g.is_active
      AND g.subject_user_id IS NOT NULL
      AND g.starts_on <= _to
      AND g.ends_on >= _from
    GROUP BY 1, 2
  )
  SELECT pe.id,
         pe.full_name,
         pe.location_id,
         coalesce((
           SELECT sum(coalesce(j.collected_amount, j.billed_amount, j.approved_amount, 0))
           FROM public.jobs j
           JOIN public.accounts a ON a.id = j.account_id
           WHERE a.assigned_rep = pe.id
             AND j.created_at::date BETWEEN _from AND _to
         ), 0)::numeric,
         (SELECT count(*) FROM public.touchpoints t
            WHERE t.created_by = pe.id AND t.type = 'call'
              AND t.occurred_at::date BETWEEN _from AND _to)::integer,
         (SELECT count(*) FROM public.touchpoints t
            WHERE t.created_by = pe.id
              AND t.type IN ('meeting_in_person','meeting_virtual')
              AND coalesce(t.meeting_held, true)
              AND t.occurred_at::date BETWEEN _from AND _to)::integer,
         (SELECT count(*) FROM public.jobs j
            JOIN public.accounts a ON a.id = j.account_id
            WHERE a.assigned_rep = pe.id
              AND j.created_at::date BETWEEN _from AND _to)::integer,
         (SELECT max(target) FROM goal WHERE uid = pe.id AND metric IN ('billed_value','collected_value')),
         (SELECT max(target) FROM goal WHERE uid = pe.id AND metric = 'touchpoints'),
         (SELECT max(target) FROM goal WHERE uid = pe.id AND metric = 'meetings_held'),
         (SELECT max(target) FROM goal WHERE uid = pe.id AND metric IN ('jobs_won','contracts_signed'))
  FROM people pe
  WHERE public.has_permission(auth.uid(), 'sales_director.view');
$$;

GRANT EXECUTE ON FUNCTION public.sales_director_reps(date, date) TO authenticated;

CREATE OR REPLACE FUNCTION public.sales_director_rep_deals(_user_id uuid, _stale_days integer DEFAULT 14)
RETURNS TABLE (
  account_id uuid,
  name text,
  stage text,
  stage_changed_at timestamptz,
  lost_reason text,
  status text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT a.id, a.name, a.stage, a.stage_changed_at, a.lost_reason, a.status::text
  FROM public.accounts a
  WHERE a.assigned_rep = _user_id
    AND a.archived_at IS NULL
    AND public.can_view_location(auth.uid(), a.location_id)
    AND public.has_permission(auth.uid(), 'sales_director.view')
    AND (
      a.lost_reason IS NOT NULL
      OR coalesce(a.stage_changed_at, a.created_at) < now() - make_interval(days => _stale_days)
    )
  ORDER BY coalesce(a.stage_changed_at, a.created_at) ASC
  LIMIT 25;
$$;

GRANT EXECUTE ON FUNCTION public.sales_director_rep_deals(uuid, integer) TO authenticated;