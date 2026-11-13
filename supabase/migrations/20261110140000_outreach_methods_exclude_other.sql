-- "Other" is not one of the six outreach methods.
--
-- Melly (29 Oct 2026): the outreach standard is five attempts "using at least
-- three different methods ... The methods are phone, email, text, showing up
-- in person, LinkedIn, and mail." A touchpoint of type `other` has no method;
-- it was still being counted as one, so two real methods plus a catch-all
-- entry met the three-method bar.
--
-- `pipeline_outreach_stats` is 20260909120100 verbatim except the FILTER on
-- the methods array, which now leaves `other` out. Attempts and attempt days
-- still count every outbound touchpoint, whatever its type: the attempt was
-- made, it just does not add a method. The TypeScript mirror is
-- `evaluatePipelineRule` in src/lib/pipeline-rules.ts.
CREATE OR REPLACE FUNCTION public.pipeline_outreach_stats(_account_id uuid, _since timestamptz)
RETURNS TABLE (
  attempts integer,
  attempt_days integer,
  methods text[],
  last_touch_at timestamptz,
  last_task_done_at timestamptz,
  replied boolean,
  last_reply_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  WITH cfg AS (SELECT public.pipeline_rule_settings() s),
  win AS (
    SELECT greatest(_since, now() - make_interval(days => (s->>'window_days')::int)) AS from_at,
           (s->>'day_timezone') AS tz
    FROM cfg
  ),
  tp AS (
    SELECT
      (count(*) FILTER (WHERE t.direction = 'outbound' AND t.occurred_at >= win.from_at))::int AS attempts,
      (count(DISTINCT (t.occurred_at AT TIME ZONE win.tz)::date)
        FILTER (WHERE t.direction = 'outbound' AND t.occurred_at >= win.from_at))::int AS attempt_days,
      coalesce(array_agg(DISTINCT public.touchpoint_method(t.type))
        FILTER (WHERE t.direction = 'outbound' AND t.occurred_at >= win.from_at
                  AND public.touchpoint_method(t.type) <> 'other'), '{}'::text[]) AS methods,
      max(t.occurred_at) AS last_touch_at,
      coalesce(bool_or((t.direction = 'inbound' AND t.occurred_at >= _since)
                       OR (t.replied_at IS NOT NULL AND t.replied_at >= _since)), false) AS replied,
      max(CASE WHEN t.direction = 'inbound' AND t.occurred_at >= _since THEN t.occurred_at
               WHEN t.replied_at IS NOT NULL AND t.replied_at >= _since THEN t.replied_at END) AS last_reply_at
    FROM win, public.touchpoints t
    WHERE t.account_id = _account_id
  ),
  tk AS (
    SELECT max(k.completed_at) AS last_task_done_at
    FROM public.tasks k
    WHERE k.account_id = _account_id AND k.status = 'done'
  )
  SELECT tp.attempts, tp.attempt_days, tp.methods, tp.last_touch_at, tk.last_task_done_at, tp.replied, tp.last_reply_at
  FROM tp, tk;
$$;
REVOKE ALL ON FUNCTION public.pipeline_outreach_stats(uuid, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pipeline_outreach_stats(uuid, timestamptz) TO authenticated, service_role;
