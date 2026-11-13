-- The Critical workflow (Phase 3 of the two-track health model).
--
-- Melly, GSR Edits, "When a client goes Critical":
--
--   "Any Critical counts — the relationship track or the paperwork track,
--    either one. The day an account goes Critical, three things happen
--    automatically. A recovery task is created and assigned to the rep with a
--    hard deadline. The account lands on the manager's Critical list and
--    cannot be dismissed. And the account stops counting toward the rep's
--    leaderboard numbers until it is fixed.
--
--    The rep then has thirty days. Only a real acknowledged response fixes
--    it. They cannot clear it by claiming they called.
--
--    On day thirty the manager must pick one of four things ... Extend the
--    cure window, but they have to write down why ... Reassign it to a
--    different rep ... Demote it to Dormant ... Close it out as No Service
--    Needed.
--
--    There is also a cap on the rep, not just the account. If more than
--    twenty percent of a rep's clients are Critical at once, they stop
--    getting new accounts assigned until they clean it up."
--
-- WHERE THE BAND COMES FROM. Health is computed in TypeScript
-- (src/lib/client-health.ts, client-health-tracks.ts) and nowhere else; this
-- migration does not restate a threshold. The nightly cadence sweep
-- (src/routes/api/public/hooks/cadence-sweep.ts) computes every active
-- client's band with the same code the board uses, OPENS an episode here
-- when the band is Critical and no episode is open, and CLOSES it as
-- `recovered` when the band drops. A rep completing the recovery task does
-- not close anything: the episode is the truth, the task is the reminder.
--
-- WHAT THE DATABASE OWNS. The episode itself, because three things read it
-- without the TypeScript: the leaderboard function (exclusion), the
-- assignment trigger (the 20% cap) and the manager's decision function.

-- ---------------------------------------------------------------- tables

CREATE TABLE IF NOT EXISTS public.client_critical_episodes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  -- The rep who owns the cure window. Set at open; a reassign closes this
  -- episode and opens a fresh one for the new rep.
  assigned_rep      uuid,
  location_id       uuid,
  track             text NOT NULL CHECK (track IN ('relationship', 'compliance')),
  reason            text NOT NULL,
  opened_at         timestamptz NOT NULL DEFAULT now(),
  -- Day 30. Moves only through an `extend` decision.
  deadline          date NOT NULL,
  extended_count    integer NOT NULL DEFAULT 0,
  recovery_task_id  uuid REFERENCES public.tasks(id) ON DELETE SET NULL,
  resolved_at       timestamptz,
  resolution        text CHECK (resolution IN ('recovered', 'reassigned', 'dormant', 'no_service', 'closed')),
  resolved_by       uuid,
  is_demo           boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK ((resolved_at IS NULL) = (resolution IS NULL))
);

-- One open episode per account. The sweep relies on this.
CREATE UNIQUE INDEX IF NOT EXISTS client_critical_episodes_open_uniq
  ON public.client_critical_episodes (account_id) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS client_critical_episodes_rep_idx
  ON public.client_critical_episodes (assigned_rep) WHERE resolved_at IS NULL;

COMMENT ON TABLE public.client_critical_episodes IS
  'One row per stretch of time an active client sits in the Critical band. Opened and closed (recovered) by the nightly cadence sweep from the TypeScript health verdict; closed by a manager decision otherwise. Melly: "The day an account goes Critical, three things happen automatically."';

CREATE TABLE IF NOT EXISTS public.client_critical_decisions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id       uuid NOT NULL REFERENCES public.client_critical_episodes(id) ON DELETE CASCADE,
  decision         text NOT NULL CHECK (decision IN ('extend', 'reassign', 'dormant', 'no_service')),
  note             text,
  decided_by       uuid NOT NULL,
  decided_at       timestamptz NOT NULL DEFAULT now(),
  reassigned_from  uuid,
  reassigned_to    uuid,
  new_deadline     date,
  is_demo          boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS client_critical_decisions_episode_idx
  ON public.client_critical_decisions (episode_id);

COMMENT ON TABLE public.client_critical_decisions IS
  'The manager''s day-30 decisions, one row each, so an extension written down stays written down.';

DROP TRIGGER IF EXISTS set_updated_at ON public.client_critical_episodes;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.client_critical_episodes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ------------------------------------------------------------------ RLS
-- Read like accounts are read (shared across offices since 20260911120000).
-- Nobody writes these rows from the app: the sweep runs as service_role and
-- the decision goes through client_critical_decide() below.

ALTER TABLE public.client_critical_episodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_critical_decisions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS client_critical_episodes_select ON public.client_critical_episodes;
CREATE POLICY client_critical_episodes_select ON public.client_critical_episodes
  FOR SELECT TO authenticated USING (public.is_employee((SELECT auth.uid())));

DROP POLICY IF EXISTS client_critical_decisions_select ON public.client_critical_decisions;
CREATE POLICY client_critical_decisions_select ON public.client_critical_decisions
  FOR SELECT TO authenticated USING (public.is_employee((SELECT auth.uid())));

GRANT SELECT ON public.client_critical_episodes, public.client_critical_decisions TO authenticated;
GRANT ALL ON public.client_critical_episodes, public.client_critical_decisions TO service_role;

-- -------------------------------------------------------------- helpers

CREATE OR REPLACE FUNCTION public.account_in_critical(_account_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.client_critical_episodes e
     WHERE e.account_id = _account_id AND e.resolved_at IS NULL
  );
$$;
REVOKE ALL ON FUNCTION public.account_in_critical(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.account_in_critical(uuid) TO authenticated, service_role;
COMMENT ON FUNCTION public.account_in_critical(uuid) IS
  'True while the account has an open Critical episode. The leaderboard leaves such accounts out of the rep''s numbers until it is fixed.';

CREATE OR REPLACE FUNCTION public.is_sales_manager(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT public.is_privileged(_user_id)
      OR public.has_role(_user_id, 'sales_head')
      OR public.has_role(_user_id, 'sales_manager')
      OR public.has_role(_user_id, 'regional')
      OR public.has_role(_user_id, 'location_manager');
$$;
REVOKE ALL ON FUNCTION public.is_sales_manager(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_sales_manager(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------- the 20% cap

-- "If more than twenty percent of a rep's clients are Critical at once, they
-- stop getting new accounts assigned until they clean it up."
--
-- A client, for the cap: an account the rep is assigned to that is on the
-- client side of the line — a health stage set, an active/onboarding status,
-- or a won pipeline stage — the same three signals the Active Clients board
-- lists by. House accounts belong to the company and count for nobody.
CREATE OR REPLACE FUNCTION public.rep_critical_share(_user_id uuid)
RETURNS TABLE(clients integer, critical integer, over_cap boolean)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH book AS (
    SELECT a.id
      FROM public.accounts a
     WHERE a.assigned_rep = _user_id
       AND a.archived_at IS NULL
       AND a.status <> 'lost'
       AND (a.health_stage_id IS NOT NULL
            OR a.status IN ('active', 'onboarding')
            OR a.stage IN ('active_client', 'won'))
       AND NOT public.account_is_house_account(a.id)
  ),
  n AS (
    SELECT count(*)::int AS clients,
           count(*) FILTER (WHERE public.account_in_critical(id))::int AS critical
      FROM book
  )
  SELECT clients, critical,
         (clients > 0 AND critical::numeric > clients::numeric * 0.2) AS over_cap
    FROM n;
$$;
REVOKE ALL ON FUNCTION public.rep_critical_share(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rep_critical_share(uuid) TO authenticated, service_role;

-- Every business rep's share, for the manager's list.
CREATE OR REPLACE FUNCTION public.rep_critical_caps()
RETURNS TABLE(user_id uuid, full_name text, clients integer, critical integer, over_cap boolean)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT r.user_id, r.full_name, s.clients, s.critical, s.over_cap
    FROM public.list_business_reps() r
    CROSS JOIN LATERAL public.rep_critical_share(r.user_id) s
   WHERE public.is_sales_manager(auth.uid())
     AND s.clients > 0
   ORDER BY s.over_cap DESC, s.critical DESC, r.full_name;
$$;
REVOKE ALL ON FUNCTION public.rep_critical_caps() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rep_critical_caps() TO authenticated;

CREATE OR REPLACE FUNCTION public.tg_accounts_critical_cap()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  s record;
BEGIN
  IF NEW.assigned_rep IS NULL OR NEW.is_demo THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND NEW.assigned_rep IS NOT DISTINCT FROM OLD.assigned_rep THEN RETURN NEW; END IF;
  SELECT * INTO s FROM public.rep_critical_share(NEW.assigned_rep);
  IF s.over_cap THEN
    RAISE EXCEPTION 'This rep is over the Critical cap (% of % clients Critical). Clear Critical accounts before assigning new ones.',
      s.critical, s.clients
      USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.tg_accounts_critical_cap() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS accounts_critical_cap ON public.accounts;
CREATE TRIGGER accounts_critical_cap
  BEFORE INSERT OR UPDATE OF assigned_rep ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public.tg_accounts_critical_cap();

-- --------------------------------------------------- the day-30 decision

CREATE OR REPLACE FUNCTION public.client_critical_decide(
  _episode_id uuid,
  _decision text,
  _note text DEFAULT NULL,
  _reassign_to uuid DEFAULT NULL,
  _retry_months integer DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  e record;
  a record;
  note text := nullif(btrim(coalesce(_note, '')), '');
  new_deadline date;
  new_ep uuid;
  task_id uuid;
  rep_name text;
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'Sign in to decide on a Critical client.' USING ERRCODE = '42501';
  END IF;
  IF NOT public.is_sales_manager(uid) THEN
    RAISE EXCEPTION 'Only a manager can make the day-30 decision.' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO e FROM public.client_critical_episodes WHERE id = _episode_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That Critical episode no longer exists.' USING ERRCODE = '22023';
  END IF;
  IF e.resolved_at IS NOT NULL THEN
    RAISE EXCEPTION 'This Critical episode is already closed.' USING ERRCODE = '22023';
  END IF;

  SELECT id, name, location_id, assigned_rep, is_demo INTO a FROM public.accounts WHERE id = e.account_id;
  IF NOT (public.is_privileged(uid) OR public.has_role(uid, 'sales_head')
          OR public.can_manage_location(uid, a.location_id)) THEN
    RAISE EXCEPTION 'You do not manage this client''s office.' USING ERRCODE = '42501';
  END IF;

  IF _decision = 'extend' THEN
    IF note IS NULL THEN
      RAISE EXCEPTION 'Write down why the cure window is being extended.' USING ERRCODE = '22023';
    END IF;
    new_deadline := GREATEST(e.deadline, current_date) + 30;
    UPDATE public.client_critical_episodes
       SET deadline = new_deadline, extended_count = extended_count + 1
     WHERE id = e.id;
    UPDATE public.tasks SET due_date = new_deadline
     WHERE id = e.recovery_task_id AND status IN ('open', 'in_progress');
    INSERT INTO public.client_critical_decisions (episode_id, decision, note, decided_by, new_deadline, is_demo)
    VALUES (e.id, 'extend', note, uid, new_deadline, e.is_demo);
    RETURN e.id;

  ELSIF _decision = 'reassign' THEN
    IF _reassign_to IS NULL OR _reassign_to = a.assigned_rep THEN
      RAISE EXCEPTION 'Pick a different rep to reassign this client to.' USING ERRCODE = '22023';
    END IF;
    -- The cap trigger on accounts fires here and refuses an over-cap rep.
    UPDATE public.accounts SET assigned_rep = _reassign_to WHERE id = a.id;

    UPDATE public.client_critical_episodes
       SET resolved_at = now(), resolution = 'reassigned', resolved_by = uid
     WHERE id = e.id;
    UPDATE public.tasks SET status = 'cancelled'
     WHERE id = e.recovery_task_id AND status IN ('open', 'in_progress');
    INSERT INTO public.client_critical_decisions
      (episode_id, decision, note, decided_by, reassigned_from, reassigned_to, is_demo)
    VALUES (e.id, 'reassign', note, uid, a.assigned_rep, _reassign_to, e.is_demo);

    -- The new rep gets a fresh thirty days and their own recovery task. The
    -- account is still Critical — nobody has answered yet — so the episode
    -- continues under the new owner rather than disappearing.
    new_deadline := current_date + 30;
    INSERT INTO public.client_critical_episodes
      (account_id, assigned_rep, location_id, track, reason, opened_at, deadline, is_demo)
    VALUES (a.id, _reassign_to, a.location_id, e.track,
            e.reason || ' · reassigned from the previous rep', now(), new_deadline, a.is_demo)
    RETURNING id INTO new_ep;

    INSERT INTO public.tasks
      (title, description, assignee, due_date, priority, status, entity_type, entity_id,
       account_id, location_id, source, cadence_key, automation_reason, created_by, is_demo)
    VALUES
      ('Recover critical client — ' || a.name,
       'This client was reassigned to you while Critical (' || e.track || ': ' || e.reason
         || '). You have thirty days. Only a real acknowledged response — or the missing paperwork landing — clears it; completing this task does not.',
       _reassign_to, new_deadline, 'urgent', 'open', 'account', a.id,
       a.id, a.location_id, 'critical', 'critical:' || new_ep::text,
       'Created automatically: the client was reassigned while Critical.', uid, a.is_demo)
    RETURNING id INTO task_id;
    UPDATE public.client_critical_episodes SET recovery_task_id = task_id WHERE id = new_ep;

    INSERT INTO public.notifications (user_id, type, title, body, entity_type, entity_id, href, priority, is_demo)
    VALUES (_reassign_to, 'automation_task', 'Critical client reassigned to you — ' || a.name,
            'Thirty days to recover the relationship. The recovery task is on your list.',
            'account', a.id, '/accounts/' || a.id::text, 'high', a.is_demo);
    RETURN new_ep;

  ELSIF _decision = 'dormant' THEN
    -- Off the client screen, into a light win-back rotation: the No Service
    -- return sweep brings a dormant account back to Active Outreach with a
    -- "Reach out again" task when the retry date comes — six months, the
    -- "maybe twice a year" of the spec.
    UPDATE public.accounts
       SET status = 'dormant',
           health_stage_id = NULL,
           reactivate_on = (current_date + interval '6 months')::date,
           no_service_retry_months = 6,
           no_service_reason_detail = coalesce(note, no_service_reason_detail)
     WHERE id = a.id;
    UPDATE public.client_critical_episodes
       SET resolved_at = now(), resolution = 'dormant', resolved_by = uid
     WHERE id = e.id;
    UPDATE public.tasks SET status = 'cancelled'
     WHERE id = e.recovery_task_id AND status IN ('open', 'in_progress');
    INSERT INTO public.client_critical_decisions (episode_id, decision, note, decided_by, is_demo)
    VALUES (e.id, 'dormant', note, uid, e.is_demo);
    RETURN e.id;

  ELSIF _decision = 'no_service' THEN
    PERFORM public.pipeline_mark_no_service(a.id, note, _retry_months, 'other');
    UPDATE public.accounts SET health_stage_id = NULL WHERE id = a.id;
    UPDATE public.client_critical_episodes
       SET resolved_at = now(), resolution = 'no_service', resolved_by = uid
     WHERE id = e.id;
    UPDATE public.tasks SET status = 'cancelled'
     WHERE id = e.recovery_task_id AND status IN ('open', 'in_progress');
    INSERT INTO public.client_critical_decisions (episode_id, decision, note, decided_by, is_demo)
    VALUES (e.id, 'no_service', note, uid, e.is_demo);
    RETURN e.id;

  ELSE
    RAISE EXCEPTION 'Unknown decision "%".', _decision USING ERRCODE = '22023';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.client_critical_decide(uuid, text, text, uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.client_critical_decide(uuid, text, text, uuid, integer) TO authenticated;

-- ---------------------------------------------- dormant joins the win-back

-- The No Service return sweep (20260909140200) now also returns a DORMANT
-- account on its retry date: back to Active Outreach, status back to
-- prospect, "Reach out again" task for the rep. Same function, one more
-- branch in the WHERE, so the two rotations cannot drift apart.
CREATE OR REPLACE FUNCTION public.pipeline_no_service_return_sweep()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  r record;
  outreach uuid;
  assignee uuid;
  moved int := 0;
  ck text;
BEGIN
  FOR r IN
    SELECT a.id, a.name, a.location_id, a.assigned_rep, a.created_by, a.reactivate_on,
           a.no_service_retry_months, a.is_demo, a.stage_id, a.status, s.pipeline_id
      FROM public.accounts a
      JOIN public.pipeline_stages s ON s.id = a.stage_id
      JOIN public.pipelines p ON p.id = s.pipeline_id
     WHERE (s.key = 'no_service_needed' OR a.status = 'dormant')
       AND a.archived_at IS NULL
       AND a.reactivate_on IS NOT NULL
       AND a.reactivate_on <= current_date
       AND p.auto_advance_enabled AND p.is_active
     LIMIT 500
  LOOP
    SELECT id INTO outreach FROM public.pipeline_stages
     WHERE pipeline_id = r.pipeline_id AND key = 'active_outreach' AND is_active LIMIT 1;
    CONTINUE WHEN outreach IS NULL;

    UPDATE public.accounts
       SET stage_id = outreach,
           status = CASE WHEN r.status = 'dormant' THEN 'prospect'::public.account_status ELSE status END,
           lost_reason = CASE WHEN r.status = 'dormant'
                              THEN 'Back to Active Outreach — dormant win-back date ' || to_char(r.reactivate_on, 'YYYY-MM-DD') || ' reached'
                              ELSE 'Back to Active Outreach — retry date ' || to_char(r.reactivate_on, 'YYYY-MM-DD') || ' reached' END,
           reactivate_on = NULL,
           no_service_retry_months = NULL
     WHERE id = r.id AND stage_id = r.stage_id;
    IF NOT FOUND THEN CONTINUE; END IF;
    UPDATE public.accounts SET lost_reason = NULL WHERE id = r.id;
    moved := moved + 1;

    assignee := coalesce(r.assigned_rep, r.created_by);
    ck := 'no_service_retry:' || r.id::text || ':' || to_char(r.reactivate_on, 'YYYY-MM-DD');
    IF assignee IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.tasks WHERE cadence_key = ck) THEN
      INSERT INTO public.tasks
        (title, description, assignee, due_date, priority, status, entity_type, entity_id,
         account_id, location_id, source, cadence_key, automation_reason, created_by, is_demo)
      VALUES
        ('Reach out again — ' || r.name,
         CASE WHEN r.status = 'dormant'
              THEN 'Demoted to Dormant from Critical. The win-back date has come and the record is back in Active Outreach.'
              ELSE 'Marked No Service Needed' || coalesce(' with a retry in ' || r.no_service_retry_months || ' months', '')
                   || '. The date has come and the record is back in Active Outreach.' END,
         assignee, current_date, 'high', 'open', 'account', r.id,
         r.id, r.location_id, 'pipeline_rule', ck,
         'Created automatically: the retry date was reached.',
         assignee, r.is_demo);

      INSERT INTO public.notifications (user_id, type, title, body, entity_type, entity_id, href, priority, is_demo)
      VALUES (assignee, 'automation_task', 'Reach out again — ' || r.name,
              CASE WHEN r.status = 'dormant'
                   THEN 'The win-back date on this dormant client has come. It is back in Active Outreach.'
                   ELSE 'The retry date on this No Service Needed record has come. It is back in Active Outreach.' END,
              'account', r.id, '/accounts/' || r.id::text, 'normal', r.is_demo);
    END IF;
  END LOOP;
  RETURN moved;
END;
$$;

-- ------------------------------------------- the leaderboard exclusion

-- "The account stops counting toward the rep's leaderboard numbers until it is
-- fixed." Same function as 20261110130000 with one more filter on every CTE
-- that is keyed by account: owned accounts, touchpoints, stage moves and
-- jobs on an account with an open Critical episode are left out of the
-- rep's row. Nothing else changes.

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
  -- One money rule for the whole scorecard: scorecard_money_visible(),
  -- defined above in this migration. This function is SECURITY DEFINER, so the
  -- revoked helper is reachable from here and nowhere else.
  WITH money AS (
    SELECT public.scorecard_money_visible() AS ok
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
       AND NOT public.account_in_critical(a.id)
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
       AND (t.account_id IS NULL OR NOT public.account_in_critical(t.account_id))
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
       AND NOT public.account_in_critical(h.account_id)
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
       AND NOT public.account_in_critical(h.account_id)
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
       AND NOT public.account_in_critical(a.id)
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
