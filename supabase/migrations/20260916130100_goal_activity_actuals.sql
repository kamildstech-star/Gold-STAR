-- APPLIED to production on 2026-09-16 and ledgered as 20260916130100; verified live afterwards.
-- The paragraph below was written before it ran and is kept as the record of what
-- was weighed.
--
-- 
-- =====================================================================
-- NOT APPLIED. Written in the goal-metrics worktree and left for the main
-- session to apply, per the standing rule that agents do not run migrations.
-- Apply 20260916130000_goal_metric_six_activity_values.sql first (it adds the
-- enum values this file's sales_director_reps compares against).
--
-- The actuals behind Mark's six new goal metrics. Mark, 16 Sep 2026,
-- verbatim:
--
--   "add fires chased, cold leak converted, cold calls, new deals worked on,
--    active client reach out (code it to understand this is acctive client
--    messaging, emails, texts, calls, etc), cold email outreach"
--
-- A goal is a promise about work the rep goes and does, and attainment is
-- actual over target. Every existing actual a goal is measured against comes
-- out of `leaderboard_standings` (the dashboard card, My Goals, Team Goals)
-- or `sales_director_reps` (the rep diagnostic), so the six new ones are
-- computed here, once, in `goal_activity_actuals`, and both of those functions
-- read it. Nothing in TypeScript recomputes a rule this file owns.
--
-- THE RULES
-- ---------
-- The full text of each is on its GOAL_METRICS entry in src/lib/goals.ts;
-- the short form, and the judgement calls:
--
--   cold_calls        `touchpoints.type = 'call'` (any direction but inbound)
--                     + `contact_attempts.channel = 'call'`, by the rep, to an
--                     account that was NOT a client at that moment.
--   cold_emails       the same for email. Outlook-synced mail lands in
--                     touchpoints as type 'email' under the mailbox owner's
--                     user id (graph-sync.server.ts), outbound and inbound
--                     alike, which is why direction is checked.
--   new_deals_worked  distinct accounts where the rep's FIRST-EVER outbound
--                     touch falls in the window and the account was not a
--                     client at that moment.
--   cold_leads_converted
--                     distinct accounts moved into a won stage in the window
--                     that had earlier passed through Active Outreach — the
--                     stage entered "the moment the rep logs their first
--                     attempt" (20260909120100). Said plainly: the data
--                     cannot tell a cold origin from a warm one (the
--                     lead-source list has no cold value, and a lead that
--                     called in is logged as an outbound touch like any
--                     other), so the passage is the closest thing recorded
--                     to "the rep had to open the conversation". Dropping
--                     the EXISTS in `converted` gives the wider number,
--                     every prospect activated in the window. Credited to
--                     the account's assigned rep, not to whoever clicked
--                     Activate, because a manager may click on the rep's
--                     behalf.
--   active_client_reach_outs
--                     every outbound touch of ANY type from touchpoints plus
--                     every contact_attempts row, by the rep, to an account
--                     that WAS an active client at that moment.
--   fires_chased      incidents the rep accepted in the window — the chase
--                     cockpit's own "active chases — accepted". Identical to
--                     the existing incidents_accepted, under Mark's name.
--
-- Two rules run through all of them:
--
--   * House accounts never count toward a rep (Mark, 10 Sep: "House accounts
--     belong to the company rather than a rep"), by the same
--     `account_is_house_account` predicate the rest of the standings use.
--     Applied to the touch-based metrics too — a call to a house account is
--     company work, not the rep's cold call.
--   * "Was a client at that moment" is judged at the time of the touch, not
--     today, through `account_client_since`. January's cold calls stay cold
--     calls when the account signs in February; February's calls to it are
--     client reach-outs. "Active client" itself is the board's rule
--     (`isActiveClient` in src/lib/pipeline-reversion.ts), mirrored in
--     `account_is_active_client` below, never a hand-written condition.
--
-- The two tables are summed, not de-duplicated, exactly as the leaderboard's
-- `calls_made` already sums them: a call logged in both counts twice there
-- and so it does here, on purpose, so the two screens cannot disagree.
--
-- `leaderboard_standings` is its 20260912103000 definition verbatim plus one
-- CTE and six columns; `sales_director_reps` is its 20260913090000 definition
-- verbatim plus one CTE and twelve columns. Both are DROP + CREATE because
-- CREATE OR REPLACE cannot change a return type (20260820083748 precedent).
-- Every existing column keeps its position; the new ones are appended.
-- =====================================================================

-- ---------------------------------------------------------------------------
-- 1. What "active client" means, in SQL. Mirrors isActiveClient() in
--    src/lib/pipeline-reversion.ts — health stage set, or a won stage, or
--    status active/onboarding. Rename there, rename here.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.account_is_active_client(_account_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.accounts a
      LEFT JOIN public.pipeline_stages s ON s.id = a.stage_id
     WHERE a.id = _account_id
       AND (
         a.health_stage_id IS NOT NULL
         OR a.status IN ('active', 'onboarding')
         OR a.stage IN ('active_client', 'won')
         OR COALESCE(s.is_won, false)
       )
  );
$$;

COMMENT ON FUNCTION public.account_is_active_client(uuid) IS
  'True when the account is an active client by the board''s rule: a health stage is set, or the prospecting stage is a won one, or status is active/onboarding. Mirrors isActiveClient() in src/lib/pipeline-reversion.ts.';

-- ---------------------------------------------------------------------------
-- 2. When the current client relationship started, or NULL for a prospect.
--    The green-light date the rep stated wins ("reps often log something on
--    Tuesday that happened last Thursday"); otherwise the latest move into a
--    won stage; otherwise the health clock; otherwise the stage clock. A
--    touch at or after this instant is a touch to a client.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.account_client_since(_account_id uuid)
RETURNS timestamptz
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT CASE
           WHEN NOT public.account_is_active_client(a.id) THEN NULL
           ELSE COALESCE(
             a.green_light_date::timestamptz,
             (SELECT max(h.changed_at)
                FROM public.account_stage_history h
                LEFT JOIN public.pipeline_stages hs ON hs.id = h.to_stage_id
               WHERE h.account_id = a.id
                 AND (COALESCE(hs.is_won, false) OR h.to_stage IN ('active_client', 'won'))),
             a.health_changed_at,
             a.stage_changed_at,
             a.created_at
           )
         END
    FROM public.accounts a
   WHERE a.id = _account_id;
$$;

COMMENT ON FUNCTION public.account_client_since(uuid) IS
  'The instant the account became its current active client, or NULL while it is a prospect. Used to judge whether a touch was to a prospect or to a client at the time it happened.';

-- ---------------------------------------------------------------------------
-- 3. The six actuals, per rep, over a window. SECURITY INVOKER and not
--    granted to authenticated: it is reached only from inside the two
--    SECURITY DEFINER functions below, which already decide who may see whom.
--    A direct call by a rep would run under their RLS and answer a partial
--    question, so it is not offered.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.goal_activity_actuals(
  _from timestamptz,
  _to timestamptz,
  _users uuid[]
)
RETURNS TABLE(
  user_id uuid,
  cold_calls integer,
  cold_emails integer,
  new_deals_worked integer,
  cold_leads_converted integer,
  active_client_reach_outs integer,
  fires_chased integer
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH people AS (
    SELECT DISTINCT u AS uid FROM unnest(COALESCE(_users, '{}'::uuid[])) AS u
  ),
  -- Every outbound touch a rep made, from both tables, over all time — the
  -- "first touch" rule below has to look before the window. `direction <>
  -- 'inbound'` rather than `= 'outbound'`: several writers never set direction
  -- and leave the default 'not_applicable'; only the mailbox sync and the
  -- dialer write 'inbound', and those are the ones that must not count.
  -- Rows with no account are left out — there is no account to say "not yet
  -- a client" about, and a fire-lead attempt is chase work.
  touches AS (
    SELECT t.created_by AS uid, t.account_id, t.occurred_at,
           CASE t.type::text WHEN 'call' THEN 'call' WHEN 'email' THEN 'email' ELSE 'other' END AS channel
      FROM public.touchpoints t
     WHERE t.created_by IN (SELECT uid FROM people)
       AND t.account_id IS NOT NULL
       AND t.direction <> 'inbound'
    UNION ALL
    SELECT c.author_id, c.account_id, c.occurred_at,
           CASE c.channel::text WHEN 'call' THEN 'call' WHEN 'email' THEN 'email' ELSE 'other' END
      FROM public.contact_attempts c
     WHERE c.author_id IN (SELECT uid FROM people)
       AND c.account_id IS NOT NULL
  ),
  -- The two account-level facts, asked once per distinct account rather than
  -- once per touch.
  acct AS (
    SELECT d.account_id,
           public.account_is_house_account(d.account_id) AS house,
           public.account_client_since(d.account_id) AS client_since
      FROM (SELECT DISTINCT account_id FROM touches) d
  ),
  classified AS (
    SELECT t.uid, t.account_id, t.occurred_at, t.channel,
           (ac.client_since IS NOT NULL AND ac.client_since <= t.occurred_at) AS was_client
      FROM touches t
      JOIN acct ac ON ac.account_id = t.account_id
     WHERE NOT ac.house
  ),
  in_window AS (
    SELECT * FROM classified WHERE occurred_at >= _from AND occurred_at < _to
  ),
  reach AS (
    SELECT uid,
           count(*) FILTER (WHERE channel = 'call'  AND NOT was_client)::int AS cold_calls,
           count(*) FILTER (WHERE channel = 'email' AND NOT was_client)::int AS cold_emails,
           count(*) FILTER (WHERE was_client)::int                          AS client_reach
      FROM in_window
     GROUP BY uid
  ),
  -- The rep's earliest touch on each account, with what the account was then.
  first_touch AS (
    SELECT DISTINCT ON (uid, account_id) uid, account_id, occurred_at, was_client
      FROM classified
     ORDER BY uid, account_id, occurred_at
  ),
  deals AS (
    SELECT uid, count(*)::int AS n
      FROM first_touch
     WHERE occurred_at >= _from AND occurred_at < _to AND NOT was_client
     GROUP BY uid
  ),
  -- Moves into a won stage inside the window, on accounts that had passed
  -- through Active Outreach before that move.
  won_moves AS (
    SELECT h.account_id, h.changed_at
      FROM public.account_stage_history h
      LEFT JOIN public.pipeline_stages s ON s.id = h.to_stage_id
     WHERE h.changed_at >= _from AND h.changed_at < _to
       AND (COALESCE(s.is_won, false) OR h.to_stage IN ('active_client', 'won'))
  ),
  converted AS (
    SELECT a.assigned_rep AS uid, count(DISTINCT w.account_id)::int AS n
      FROM won_moves w
      JOIN public.accounts a ON a.id = w.account_id
     WHERE a.assigned_rep IN (SELECT uid FROM people)
       AND NOT public.account_is_house_account(a.id)
       AND EXISTS (
         SELECT 1 FROM public.account_stage_history o
          WHERE o.account_id = w.account_id
            AND o.to_stage = 'active_outreach'
            AND o.changed_at <= w.changed_at
       )
     GROUP BY a.assigned_rep
  ),
  -- Verbatim the `ch` CTE's count from leaderboard_standings: a chase starts
  -- at acceptance.
  fires AS (
    SELECT i.accepted_by AS uid, count(*)::int AS n
      FROM public.incidents i
     WHERE i.accepted_by IN (SELECT uid FROM people)
       AND i.accepted_at >= _from AND i.accepted_at < _to
     GROUP BY i.accepted_by
  )
  SELECT p.uid,
         COALESCE(reach.cold_calls, 0),
         COALESCE(reach.cold_emails, 0),
         COALESCE(deals.n, 0),
         COALESCE(converted.n, 0),
         COALESCE(reach.client_reach, 0),
         COALESCE(fires.n, 0)
    FROM people p
    LEFT JOIN reach     ON reach.uid     = p.uid
    LEFT JOIN deals     ON deals.uid     = p.uid
    LEFT JOIN converted ON converted.uid = p.uid
    LEFT JOIN fires     ON fires.uid     = p.uid;
$$;

REVOKE ALL ON FUNCTION public.goal_activity_actuals(timestamptz, timestamptz, uuid[]) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.goal_activity_actuals(timestamptz, timestamptz, uuid[]) IS
  'Per-rep actuals for the six activity goal metrics Mark added on 16 Sep 2026 (cold calls, cold emails, new deals worked on, cold leads converted, active client reach-outs, fires chased). Read by leaderboard_standings and sales_director_reps; the rule text is in src/lib/goals.ts.';


-- ---------------------------------------------------------------------------
-- 4. The leaderboard standings — every goal screen's actuals. 20260912103000
--    verbatim, plus the `act` CTE and six appended columns.
-- ---------------------------------------------------------------------------
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
  jobs_signed_total integer,
  cold_calls integer,
  cold_emails integer,
  new_deals_worked integer,
  cold_leads_converted integer,
  active_client_reach_outs integer,
  fires_chased integer
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
       AND NOT public.account_is_house_account(a.id)
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
       AND NOT public.account_is_house_account(a.id)
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
  ),
  -- Mark's six activity actuals (16 Sep 2026). One rule, one function; see
  -- goal_activity_actuals above and GOAL_METRICS in src/lib/goals.ts.
  act AS (
    SELECT * FROM public.goal_activity_actuals(
      _from, _to, ARRAY(SELECT user_id FROM people)
    )
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
         COALESCE(jb.jobs, 0),
         COALESCE(act.cold_calls, 0),
         COALESCE(act.cold_emails, 0),
         COALESCE(act.new_deals_worked, 0),
         COALESCE(act.cold_leads_converted, 0),
         COALESCE(act.active_client_reach_outs, 0),
         COALESCE(act.fires_chased, 0)
    FROM people p
    LEFT JOIN acct  ON acct.uid  = p.user_id
    LEFT JOIN tp    ON tp.uid    = p.user_id
    LEFT JOIN ca    ON ca.uid    = p.user_id
    LEFT JOIN fwd   ON fwd.uid   = p.user_id
    LEFT JOIN stage ON stage.uid = p.user_id
    LEFT JOIN jb    ON jb.uid    = p.user_id
    LEFT JOIN disp  ON disp.uid  = p.user_id
    LEFT JOIN ch    ON ch.uid    = p.user_id
    LEFT JOIN act   ON act.user_id = p.user_id;
$function$;

REVOKE ALL ON FUNCTION public.leaderboard_standings(timestamptz, timestamptz, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.leaderboard_standings(timestamptz, timestamptz, uuid[]) TO authenticated;


-- ---------------------------------------------------------------------------
-- 5. The Sales Director dashboard's per-rep row, which the rep diagnostic
--    reads. 20260913090000 verbatim, plus the `act` CTE, the six actuals and
--    their six targets read off `goals` by metric name like the four before.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.sales_director_reps(date, date);

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
  jobs_target numeric,
  cold_calls integer,
  cold_emails integer,
  new_deals_worked integer,
  cold_leads_converted integer,
  active_client_reach_outs integer,
  fires_chased integer,
  cold_calls_target numeric,
  cold_emails_target numeric,
  new_deals_worked_target numeric,
  cold_leads_converted_target numeric,
  active_client_reach_outs_target numeric,
  fires_chased_target numeric
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
  ),
  -- Mark's six activity actuals (16 Sep 2026), by the one rule in
  -- goal_activity_actuals. The dashboard takes dates; the rule takes
  -- instants, so the window is midnight-to-midnight around the two dates.
  act AS (
    SELECT * FROM public.goal_activity_actuals(
      _from::timestamptz, (_to + 1)::timestamptz, ARRAY(SELECT id FROM people)
    )
  )
  SELECT pe.id,
         pe.full_name,
         pe.location_id,
         coalesce((
           SELECT sum(coalesce(j.collected_amount, j.billed_amount, j.approved_amount, 0))
           FROM public.jobs j
           JOIN public.accounts a ON a.id = j.account_id
           WHERE a.assigned_rep = pe.id
             AND NOT public.account_is_house_account(a.id)
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
              AND NOT public.account_is_house_account(a.id)
              AND j.created_at::date BETWEEN _from AND _to)::integer,
         (SELECT max(target) FROM goal WHERE uid = pe.id AND metric IN ('billed_value','collected_value')),
         (SELECT max(target) FROM goal WHERE uid = pe.id AND metric = 'touchpoints'),
         (SELECT max(target) FROM goal WHERE uid = pe.id AND metric = 'meetings_held'),
         (SELECT max(target) FROM goal WHERE uid = pe.id AND metric IN ('jobs_won','contracts_signed')),
         coalesce(act.cold_calls, 0),
         coalesce(act.cold_emails, 0),
         coalesce(act.new_deals_worked, 0),
         coalesce(act.cold_leads_converted, 0),
         coalesce(act.active_client_reach_outs, 0),
         coalesce(act.fires_chased, 0),
         (SELECT max(target) FROM goal WHERE uid = pe.id AND metric = 'cold_calls'),
         (SELECT max(target) FROM goal WHERE uid = pe.id AND metric = 'cold_emails'),
         (SELECT max(target) FROM goal WHERE uid = pe.id AND metric = 'new_deals_worked'),
         (SELECT max(target) FROM goal WHERE uid = pe.id AND metric = 'cold_leads_converted'),
         (SELECT max(target) FROM goal WHERE uid = pe.id AND metric = 'active_client_reach_outs'),
         (SELECT max(target) FROM goal WHERE uid = pe.id AND metric = 'fires_chased')
  FROM people pe
  LEFT JOIN act ON act.user_id = pe.id
  WHERE public.has_permission(auth.uid(), 'sales_director.view');
$$;

GRANT EXECUTE ON FUNCTION public.sales_director_reps(date, date) TO authenticated;


-- ===========================================================================
-- Verification after applying
-- ===========================================================================
--
--   -- 1. Both readers carry the six columns.
--   SELECT proname, pg_get_function_result(p.oid) LIKE '%fires_chased%' AS has_six
--     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public'
--      AND p.proname IN ('leaderboard_standings', 'sales_director_reps');
--   -- expected: true, true
--
--   -- 2. The rule function is not callable by a rep directly.
--   SELECT has_function_privilege('authenticated',
--     'public.goal_activity_actuals(timestamptz, timestamptz, uuid[])', 'EXECUTE');
--   -- expected: false
--
--   -- 3. A prospect is not a client and has no client-since; an activated
--   --    account has one.
--   SELECT a.name, public.account_is_active_client(a.id), public.account_client_since(a.id)
--     FROM public.accounts a ORDER BY a.created_at DESC LIMIT 20;
