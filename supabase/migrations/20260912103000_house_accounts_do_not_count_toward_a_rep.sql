-- =====================================================================
-- House accounts belong to the company, not to a rep's numbers.
--
-- Mark, 10 Sep 2026, verbatim:
--
--   "House accounts belong to the company rather than a rep. Owner level
--    relationships, TPA work that already does not count toward any rep, and
--    accounts sitting between reps."
--
-- The label has existed since 20260911090000 and nothing read it. A house
-- account with a rep's name on it still fed that rep's `accounts_owned`,
-- `new_accounts`, `jobs_won`, `billed_value` and `collected_value` — on their
-- scorecard, on the leaderboard everyone can see, and therefore in every goal
-- whose attainment is actual over target. "Already does not count toward any
-- rep" was a description of how the business works, not of what the database
-- did.
--
-- This migration takes house accounts out of the per-rep totals and out of the
-- drill-throughs behind them, together, so a manager who clicks "12 accounts
-- owned" is not shown fourteen rows.
--
-- WHAT IS DELIBERATELY NOT DONE HERE
-- ----------------------------------
-- `assigned_rep` is left alone. Somebody still has to be the person who picks
-- up the phone on a house account, and the record must keep saying who that
-- is. Ownership is a label, not an empty column — an account with no rep is
-- unclaimed (about a quarter of the book), and nothing here may treat those as
-- the company's. Only the label decides.
--
-- Office and location totals are untouched: the work was done, it was Gold
-- Star's, and it belongs in the office's numbers. It is the *individual's*
-- credit the sentence is about.
--
-- Every function below is its previous definition verbatim, plus one
-- `AND NOT public.account_is_house_account(a.id)` per rep-attributed account
-- scan. Sources: scorecard_metrics, scorecard_metrics_raw, person_accounts and
-- person_jobs from 20260805201804; leaderboard_standings from 20260820083748.
-- Keep them beside those migrations when either changes.
-- =====================================================================

-- ---------------------------------------------------------------------------
-- The predicate, mirroring HOUSE_ACCOUNT_LABEL and isHouseAccount() in
-- src/lib/account-clocks.ts. Rename there, rename here.
--
-- SECURITY INVOKER on purpose. It is called from inside SECURITY DEFINER
-- functions, so it already runs with whatever rights those have; making it a
-- definer of its own would add a privileged entry point that answers questions
-- about accounts, for no gain. Matched case-insensitively because the label is
-- typed by a human in the admin screen.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.account_is_house_account(_account_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.account_tags atg
      JOIN public.tags t ON t.id = atg.tag_id
     WHERE atg.account_id = _account_id
       AND lower(t.name) = 'house account'
  );
$$;

COMMENT ON FUNCTION public.account_is_house_account(uuid) IS
  'True when the account carries the "House Account" label. Mark: "House accounts belong to the company rather than a rep." Declared by label only — never inferred from an empty assigned_rep, because a quarter of the book is simply unclaimed.';


-- ---------------------------------------------------------------------------
-- 1. The scorecard. `acct` (accounts owned / overdue, and the cadence health
--    derived from them) and `jb` (jobs won, billed, collected).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.scorecard_metrics(
  _from timestamptz, _to timestamptz, _user_id uuid DEFAULT NULL
)
RETURNS TABLE(
  user_id uuid, full_name text, email text, roles app_role[], location_ids uuid[],
  touchpoints integer, meetings_logged integer, meetings_booked integer, meetings_held integer,
  accounts_advanced integer, accounts_owned integer, accounts_overdue integer,
  cadence_health numeric,
  contact_attempts integer, attempts_call integer, attempts_sms integer,
  attempts_email integer, attempts_door integer,
  gifts_sent integer,
  jobs_won integer, billed_value numeric, collected_value numeric,
  incidents_dispatched integer, incidents_accepted integer, contracts_signed integer,
  chase_acceptance numeric, median_tta_minutes numeric,
  activity_events integer
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  WITH people AS (
    SELECT * FROM public.scorecard_people() p
     WHERE _user_id IS NULL OR p.user_id = _user_id
  ),
  acct AS (
    SELECT a.assigned_rep AS uid,
           count(*)::int AS owned,
           count(*) FILTER (
             WHERE COALESCE(
               (SELECT max(t.occurred_at) FROM public.touchpoints t WHERE t.account_id = a.id),
               '-infinity'::timestamptz) < now() - interval '90 days'
           )::int AS overdue
      FROM public.accounts a
     WHERE a.assigned_rep IN (SELECT user_id FROM people)
       AND NOT public.account_is_house_account(a.id)
     GROUP BY a.assigned_rep
  ),
  tp AS (
    SELECT t.created_by AS uid,
           count(*)::int AS n,
           count(*) FILTER (WHERE t.type IN ('meeting_in_person','meeting_virtual'))::int AS meetings,
           count(*) FILTER (WHERE t.type = 'gift')::int AS gifts
      FROM public.touchpoints t
     WHERE t.created_by IN (SELECT user_id FROM people)
       AND t.occurred_at >= _from AND t.occurred_at < _to
     GROUP BY t.created_by
  ),
  stage AS (
    SELECT h.changed_by AS uid,
           count(*)::int AS advanced,
           count(*) FILTER (WHERE h.to_stage = 'meeting_booked')::int AS booked,
           count(*) FILTER (WHERE h.to_stage = 'meeting_held')::int AS held
      FROM public.account_stage_history h
     WHERE h.changed_by IN (SELECT user_id FROM people)
       AND h.changed_at >= _from AND h.changed_at < _to
     GROUP BY h.changed_by
  ),
  att AS (
    SELECT c.author_id AS uid,
           count(*)::int AS n,
           count(*) FILTER (WHERE c.channel = 'call')::int  AS c_call,
           count(*) FILTER (WHERE c.channel = 'sms')::int   AS c_sms,
           count(*) FILTER (WHERE c.channel = 'email')::int AS c_email,
           count(*) FILTER (WHERE c.channel = 'door')::int  AS c_door
      FROM public.contact_attempts c
     WHERE c.author_id IN (SELECT user_id FROM people)
       AND c.occurred_at >= _from AND c.occurred_at < _to
     GROUP BY c.author_id
  ),
  jb AS (
    SELECT a.assigned_rep AS uid,
           count(DISTINCT j.id)::int AS jobs,
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
  )
  SELECT p.user_id, p.full_name, p.email, p.roles, p.location_ids,
         COALESCE(tp.n, 0), COALESCE(tp.meetings, 0),
         COALESCE(stage.booked, 0), COALESCE(stage.held, 0),
         COALESCE(stage.advanced, 0), COALESCE(acct.owned, 0), COALESCE(acct.overdue, 0),
         CASE WHEN COALESCE(acct.owned, 0) = 0 THEN NULL
              ELSE 1 - (acct.overdue::numeric / acct.owned::numeric) END,
         COALESCE(att.n, 0), COALESCE(att.c_call, 0), COALESCE(att.c_sms, 0),
         COALESCE(att.c_email, 0), COALESCE(att.c_door, 0),
         COALESCE(tp.gifts, 0),
         COALESCE(jb.jobs, 0), COALESCE(jb.billed, 0), COALESCE(jb.collected, 0),
         COALESCE(disp.dispatched, 0), COALESCE(ch.accepted, 0), COALESCE(ch.signed, 0),
         CASE WHEN COALESCE(disp.dispatched, 0) = 0 THEN NULL
              ELSE LEAST(1, COALESCE(ch.accepted, 0)::numeric / disp.dispatched::numeric) END,
         ch.tta,
         (COALESCE(tp.n,0) + COALESCE(att.n,0) + COALESCE(stage.advanced,0)
          + COALESCE(jb.jobs,0) + COALESCE(ch.accepted,0))::int
    FROM people p
    LEFT JOIN acct  ON acct.uid  = p.user_id
    LEFT JOIN tp    ON tp.uid    = p.user_id
    LEFT JOIN stage ON stage.uid = p.user_id
    LEFT JOIN att   ON att.uid   = p.user_id
    LEFT JOIN jb    ON jb.uid    = p.user_id
    LEFT JOIN disp  ON disp.uid  = p.user_id
    LEFT JOIN ch    ON ch.uid    = p.user_id;
$$;

-- ---------------------------------------------------------------------------
-- 2. The team medians a rep is compared against. Left as it was, a rep whose
--    own billed value now excludes house accounts would be measured against a
--    median that still includes everyone else's — a comparison against a
--    number that is no longer the same number.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.scorecard_metrics_raw(
  _from timestamptz, _to timestamptz, _users uuid[]
)
RETURNS TABLE(
  touchpoints numeric, meetings_held numeric, accounts_advanced numeric,
  cadence_health numeric, contact_attempts numeric, jobs_won numeric,
  billed_value numeric, chase_acceptance numeric, median_tta_minutes numeric
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT
    (SELECT count(*) FROM public.touchpoints t
      WHERE t.created_by = u AND t.occurred_at >= _from AND t.occurred_at < _to)::numeric,
    (SELECT count(*) FROM public.account_stage_history h
      WHERE h.changed_by = u AND h.changed_at >= _from AND h.changed_at < _to
        AND h.to_stage = 'meeting_held')::numeric,
    (SELECT count(*) FROM public.account_stage_history h
      WHERE h.changed_by = u AND h.changed_at >= _from AND h.changed_at < _to)::numeric,
    (SELECT CASE WHEN count(*) = 0 THEN NULL ELSE
       1 - (count(*) FILTER (WHERE COALESCE(
              (SELECT max(t.occurred_at) FROM public.touchpoints t WHERE t.account_id = a.id),
              '-infinity'::timestamptz) < now() - interval '90 days')::numeric / count(*)::numeric)
     END FROM public.accounts a WHERE a.assigned_rep = u AND NOT public.account_is_house_account(a.id)),
    (SELECT count(*) FROM public.contact_attempts c
      WHERE c.author_id = u AND c.occurred_at >= _from AND c.occurred_at < _to)::numeric,
    (SELECT count(DISTINCT j.id) FROM public.jobs j JOIN public.accounts a ON a.id = j.account_id
      WHERE a.assigned_rep = u AND NOT public.account_is_house_account(a.id) AND j.created_at >= _from AND j.created_at < _to
        AND j.status <> 'cancelled')::numeric,
    (SELECT COALESCE(sum(j.billed_amount), 0) FROM public.jobs j
       JOIN public.accounts a ON a.id = j.account_id
      WHERE a.assigned_rep = u AND NOT public.account_is_house_account(a.id) AND j.created_at >= _from AND j.created_at < _to
        AND j.status <> 'cancelled'),
    (SELECT CASE WHEN d.n = 0 THEN NULL ELSE LEAST(1, acc.n::numeric / d.n::numeric) END
       FROM (SELECT count(*) n FROM public.incidents i
              WHERE i.reported_at >= _from AND i.reported_at < _to
                AND i.location_id IN (SELECT lm.location_id FROM public.location_members lm
                                       WHERE lm.user_id = u)) d,
            (SELECT count(*) n FROM public.incidents i
              WHERE i.accepted_by = u AND i.accepted_at >= _from AND i.accepted_at < _to) acc),
    (SELECT percentile_cont(0.5) WITHIN GROUP (
              ORDER BY EXTRACT(EPOCH FROM (i.arrived_at - i.accepted_at)) / 60.0)
       FROM public.incidents i
      WHERE i.accepted_by = u AND i.accepted_at >= _from AND i.accepted_at < _to
        AND i.arrived_at IS NOT NULL)
  FROM unnest(_users) AS u;
$$;

-- ---------------------------------------------------------------------------
-- 3. The leaderboard, which is peer-visible and so the one where a wrong
--    number gets argued about. Same two CTEs, same one condition.
-- ---------------------------------------------------------------------------
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


-- ---------------------------------------------------------------------------
-- 4. The drill-throughs. These are what a manager sees after clicking the
--    number, so they have to move with it or the two disagree out loud.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.person_accounts(_user_id uuid)
RETURNS TABLE(
  -- `stage` is text, not the account_stage enum. The live function returns
  -- text, and CREATE OR REPLACE cannot change a return type -- copying the
  -- enum out of an older migration made this whole file fail to apply until it
  -- was read off pg_proc. Check the deployed signature, not an ancestor file.
  id uuid, name text, stage text, status public.account_status,
  location_id uuid, last_touch timestamptz, days_since_touch integer, overdue boolean
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT a.id, a.name, a.stage, a.status, a.location_id, lt.last_touch,
         CASE WHEN lt.last_touch IS NULL THEN NULL
              ELSE EXTRACT(DAY FROM now() - lt.last_touch)::int END,
         (lt.last_touch IS NULL OR lt.last_touch < now() - interval '90 days')
    FROM public.accounts a
    LEFT JOIN LATERAL (
      SELECT max(t.occurred_at) AS last_touch FROM public.touchpoints t WHERE t.account_id = a.id
    ) lt ON true
   WHERE public.can_view_person_scorecard(_user_id)
     AND a.assigned_rep = _user_id
     AND NOT public.account_is_house_account(a.id)
   ORDER BY lt.last_touch NULLS FIRST;
$$;

CREATE OR REPLACE FUNCTION public.person_jobs(_user_id uuid, _from timestamptz, _to timestamptz)
RETURNS TABLE(
  id uuid, job_number text, job_name text, address text, status public.job_status,
  loss_type text, account_id uuid, account_name text,
  estimated_amount numeric, billed_amount numeric, collected_amount numeric, created_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT j.id, j.job_number, j.job_name, j.address, j.status, j.loss_type::text,
         a.id, a.name, j.estimated_amount, j.billed_amount, j.collected_amount, j.created_at
    FROM public.jobs j
    JOIN public.accounts a ON a.id = j.account_id
   WHERE public.can_view_person_scorecard(_user_id)
     AND a.assigned_rep = _user_id
     AND NOT public.account_is_house_account(a.id)
     AND j.created_at >= _from AND j.created_at < _to
   ORDER BY j.created_at DESC;
$$;
