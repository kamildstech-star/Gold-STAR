-- =====================================================================
-- Sales Intelligence: configurable scorecard weights + scoped reporting
-- =====================================================================

CREATE TABLE public.scorecard_weights (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid REFERENCES public.locations(id) ON DELETE CASCADE,
  role_group text NOT NULL CHECK (role_group IN ('sales','chase')),
  component text NOT NULL,
  weight numeric NOT NULL DEFAULT 0 CHECK (weight >= 0),
  target numeric NOT NULL DEFAULT 1 CHECK (target > 0),
  direction text NOT NULL DEFAULT 'higher' CHECK (direction IN ('higher','lower')),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.scorecard_weights TO authenticated;
GRANT ALL ON public.scorecard_weights TO service_role;
ALTER TABLE public.scorecard_weights ENABLE ROW LEVEL SECURITY;

CREATE UNIQUE INDEX scorecard_weights_global_uq
  ON public.scorecard_weights (role_group, component) WHERE location_id IS NULL;
CREATE UNIQUE INDEX scorecard_weights_loc_uq
  ON public.scorecard_weights (location_id, role_group, component) WHERE location_id IS NOT NULL;

CREATE POLICY "Signed-in users can read scorecard weights"
  ON public.scorecard_weights FOR SELECT TO authenticated USING (true);
CREATE POLICY "Owners and admins manage scorecard weights"
  ON public.scorecard_weights FOR ALL TO authenticated
  USING (public.is_privileged(auth.uid()))
  WITH CHECK (public.is_privileged(auth.uid()));

CREATE TABLE public.scorecard_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid REFERENCES public.locations(id) ON DELETE CASCADE,
  min_activity_events integer NOT NULL DEFAULT 8 CHECK (min_activity_events >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.scorecard_settings TO authenticated;
GRANT ALL ON public.scorecard_settings TO service_role;
ALTER TABLE public.scorecard_settings ENABLE ROW LEVEL SECURITY;

CREATE UNIQUE INDEX scorecard_settings_global_uq
  ON public.scorecard_settings ((1)) WHERE location_id IS NULL;
CREATE UNIQUE INDEX scorecard_settings_loc_uq
  ON public.scorecard_settings (location_id) WHERE location_id IS NOT NULL;

CREATE POLICY "Signed-in users can read scorecard settings"
  ON public.scorecard_settings FOR SELECT TO authenticated USING (true);
CREATE POLICY "Owners and admins manage scorecard settings"
  ON public.scorecard_settings FOR ALL TO authenticated
  USING (public.is_privileged(auth.uid()))
  WITH CHECK (public.is_privileged(auth.uid()));

CREATE TRIGGER scorecard_weights_updated_at BEFORE UPDATE ON public.scorecard_weights
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER scorecard_settings_updated_at BEFORE UPDATE ON public.scorecard_settings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Default global weighting -------------------------------------------------
INSERT INTO public.scorecard_weights (location_id, role_group, component, weight, target, direction) VALUES
  (NULL,'sales','touchpoints',        20, 30, 'higher'),
  (NULL,'sales','meetings_held',      15,  4, 'higher'),
  (NULL,'sales','accounts_advanced',  15,  6, 'higher'),
  (NULL,'sales','cadence_health',     25,  1, 'higher'),
  (NULL,'sales','contact_attempts',   10, 20, 'higher'),
  (NULL,'sales','jobs_won',           15,  3, 'higher'),
  (NULL,'chase','chase_acceptance',   30,  1, 'higher'),
  (NULL,'chase','chase_tta',          25, 20, 'lower'),
  (NULL,'chase','contracts_signed',   25,  5, 'higher'),
  (NULL,'chase','touchpoints',        10, 10, 'higher'),
  (NULL,'chase','jobs_won',           10,  3, 'higher');

INSERT INTO public.scorecard_settings (location_id, min_activity_events) VALUES (NULL, 8);

-- =====================================================================
-- Effective identity (mirrors View As narrowing, server side)
-- =====================================================================

CREATE OR REPLACE FUNCTION public.scorecard_identity()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  actor uuid := auth.uid();
  actor_roles text[];
  actor_privileged boolean;
  real_locs uuid[];
  imp public.impersonation_audit%ROWTYPE;
  eff_user uuid;
  eff_roles text[];
  eff_locs uuid[];
  tgt_locs uuid[];
BEGIN
  IF actor IS NULL THEN RETURN NULL; END IF;

  SELECT COALESCE(array_agg(role::text), ARRAY[]::text[]) INTO actor_roles
    FROM public.user_roles WHERE user_id = actor;
  actor_privileged := public.is_privileged(actor);

  IF actor_privileged THEN
    SELECT COALESCE(array_agg(id), ARRAY[]::uuid[]) INTO real_locs FROM public.locations;
  ELSE
    SELECT COALESCE(array_agg(l.id), ARRAY[]::uuid[]) INTO real_locs
      FROM public.locations l
     WHERE public.is_member_of(actor, l.id) OR public.is_regional_for(actor, l.id);
  END IF;

  eff_user := actor; eff_roles := actor_roles; eff_locs := real_locs;

  SELECT * INTO imp FROM public.impersonation_audit
   WHERE actor_id = actor AND ended_at IS NULL LIMIT 1;

  IF FOUND THEN
    IF imp.target_user_id IS NOT NULL THEN
      eff_user := imp.target_user_id;
      SELECT COALESCE(array_agg(role::text), ARRAY[]::text[]) INTO eff_roles
        FROM public.user_roles WHERE user_id = imp.target_user_id;
      SELECT COALESCE(array_agg(l.id), ARRAY[]::uuid[]) INTO tgt_locs
        FROM public.locations l
       WHERE (public.is_member_of(imp.target_user_id, l.id)
              OR public.is_regional_for(imp.target_user_id, l.id))
         AND l.id = ANY(real_locs);
      eff_locs := tgt_locs;
      IF cardinality(eff_locs) = 0 AND public.is_privileged(imp.target_user_id) THEN
        eff_locs := real_locs;
      END IF;
    ELSIF imp.preview_role IS NOT NULL THEN
      eff_roles := CASE WHEN actor_privileged
                        THEN ARRAY[imp.preview_role::text]
                        ELSE ARRAY(SELECT r FROM unnest(actor_roles) r WHERE r = imp.preview_role::text) END;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'viewer_id', eff_user,
    'actor_id', actor,
    'roles', to_jsonb(eff_roles),
    'location_ids', to_jsonb(eff_locs),
    'impersonating', FOUND
  );
END $$;

GRANT EXECUTE ON FUNCTION public.scorecard_identity() TO authenticated;

CREATE OR REPLACE FUNCTION public.can_view_person_scorecard(_target uuid)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  ident jsonb := public.scorecard_identity();
  roles text[];
  locs uuid[];
  viewer uuid;
BEGIN
  IF ident IS NULL OR _target IS NULL THEN RETURN false; END IF;
  viewer := (ident->>'viewer_id')::uuid;
  SELECT array_agg(value::text) INTO roles FROM jsonb_array_elements_text(ident->'roles') value;
  SELECT COALESCE(array_agg(value::uuid), ARRAY[]::uuid[]) INTO locs
    FROM jsonb_array_elements_text(ident->'location_ids') value;
  roles := COALESCE(roles, ARRAY[]::text[]);

  IF viewer = _target THEN RETURN true; END IF;
  IF roles && ARRAY['owner','admin','dev'] THEN RETURN true; END IF;
  IF roles && ARRAY['regional','location_manager','sales_manager','office'] THEN
    RETURN EXISTS (
      SELECT 1 FROM public.location_members lm
       WHERE lm.user_id = _target AND lm.location_id = ANY(locs)
    );
  END IF;
  RETURN false;
END $$;

GRANT EXECUTE ON FUNCTION public.can_view_person_scorecard(uuid) TO authenticated;

-- =====================================================================
-- People visible on the scorecard list
-- =====================================================================

CREATE OR REPLACE FUNCTION public.scorecard_people()
RETURNS TABLE(user_id uuid, full_name text, email text, roles app_role[], location_ids uuid[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT r.user_id, r.full_name, r.email, r.roles,
         COALESCE((SELECT array_agg(lm.location_id) FROM public.location_members lm
                    WHERE lm.user_id = r.user_id), ARRAY[]::uuid[])
    FROM public.list_business_reps() r
   WHERE public.can_view_person_scorecard(r.user_id);
$$;

GRANT EXECUTE ON FUNCTION public.scorecard_people() TO authenticated;

-- =====================================================================
-- Metrics for a period
-- =====================================================================

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

GRANT EXECUTE ON FUNCTION public.scorecard_metrics(timestamptz, timestamptz, uuid) TO authenticated;

-- =====================================================================
-- Team medians. Cohort must be >= 3 people or nothing is returned, so a
-- median can never be used to reconstruct one colleague's numbers.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.scorecard_team_medians(
  _from timestamptz, _to timestamptz, _location_id uuid DEFAULT NULL
)
RETURNS TABLE(
  cohort_size integer,
  touchpoints numeric, meetings_held numeric, accounts_advanced numeric,
  cadence_health numeric, contact_attempts numeric, jobs_won numeric,
  billed_value numeric, chase_acceptance numeric, median_tta_minutes numeric
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  ident jsonb := public.scorecard_identity();
  locs uuid[];
  viewer uuid;
  cohort uuid[];
  n integer;
BEGIN
  IF ident IS NULL THEN RETURN; END IF;
  viewer := (ident->>'viewer_id')::uuid;
  SELECT COALESCE(array_agg(value::uuid), ARRAY[]::uuid[]) INTO locs
    FROM jsonb_array_elements_text(ident->'location_ids') value;

  -- Cohort = business people in the viewer's location scope. This is a
  -- deliberately wider set than the viewer may inspect individually: a rep
  -- gets context without gaining access to any individual row.
  SELECT COALESCE(array_agg(DISTINCT r.user_id), ARRAY[]::uuid[]) INTO cohort
    FROM public.list_business_reps() r
    JOIN public.location_members lm ON lm.user_id = r.user_id
   WHERE lm.location_id = ANY(locs)
     AND (_location_id IS NULL OR lm.location_id = _location_id);

  n := cardinality(cohort);
  IF n < 3 THEN RETURN; END IF;

  RETURN QUERY
  WITH m AS (
    SELECT * FROM public.scorecard_metrics_raw(_from, _to, cohort)
  )
  SELECT n,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY m.touchpoints),
         percentile_cont(0.5) WITHIN GROUP (ORDER BY m.meetings_held),
         percentile_cont(0.5) WITHIN GROUP (ORDER BY m.accounts_advanced),
         percentile_cont(0.5) WITHIN GROUP (ORDER BY m.cadence_health),
         percentile_cont(0.5) WITHIN GROUP (ORDER BY m.contact_attempts),
         percentile_cont(0.5) WITHIN GROUP (ORDER BY m.jobs_won),
         percentile_cont(0.5) WITHIN GROUP (ORDER BY m.billed_value),
         percentile_cont(0.5) WITHIN GROUP (ORDER BY m.chase_acceptance),
         percentile_cont(0.5) WITHIN GROUP (ORDER BY m.median_tta_minutes)
    FROM m;
END $$;

-- Aggregate-only helper. NOT granted to clients: it bypasses per-person
-- visibility on purpose and is only reachable through the median function.
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
     END FROM public.accounts a WHERE a.assigned_rep = u),
    (SELECT count(*) FROM public.contact_attempts c
      WHERE c.author_id = u AND c.occurred_at >= _from AND c.occurred_at < _to)::numeric,
    (SELECT count(DISTINCT j.id) FROM public.jobs j JOIN public.accounts a ON a.id = j.account_id
      WHERE a.assigned_rep = u AND j.created_at >= _from AND j.created_at < _to
        AND j.status <> 'cancelled')::numeric,
    (SELECT COALESCE(sum(j.billed_amount), 0) FROM public.jobs j
       JOIN public.accounts a ON a.id = j.account_id
      WHERE a.assigned_rep = u AND j.created_at >= _from AND j.created_at < _to
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

REVOKE ALL ON FUNCTION public.scorecard_metrics_raw(timestamptz, timestamptz, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.scorecard_team_medians(timestamptz, timestamptz, uuid) TO authenticated;

-- =====================================================================
-- Drill-down
-- =====================================================================

CREATE OR REPLACE FUNCTION public.person_timeline(
  _user_id uuid, _from timestamptz, _to timestamptz, _limit integer DEFAULT 200
)
RETURNS TABLE(
  kind text, occurred_at timestamptz, title text, detail text,
  entity_type text, entity_id uuid, link_id uuid
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT * FROM (
    SELECT 'touchpoint'::text, t.occurred_at, t.type::text, COALESCE(t.notes,''),
           'account'::text, t.account_id, t.id
      FROM public.touchpoints t
     WHERE public.can_view_person_scorecard(_user_id)
       AND t.created_by = _user_id AND t.occurred_at >= _from AND t.occurred_at < _to
    UNION ALL
    SELECT 'contact_attempt', c.occurred_at, c.channel::text,
           COALESCE(c.outcome, '') || CASE WHEN c.notes IS NULL THEN '' ELSE ' · ' || c.notes END,
           'lead', c.lead_id, c.id
      FROM public.contact_attempts c
     WHERE public.can_view_person_scorecard(_user_id)
       AND c.author_id = _user_id AND c.occurred_at >= _from AND c.occurred_at < _to
    UNION ALL
    SELECT 'stage_change', h.changed_at,
           COALESCE(h.from_stage::text,'—') || ' → ' || h.to_stage::text,
           COALESCE(h.reason,''), 'account', h.account_id, h.id
      FROM public.account_stage_history h
     WHERE public.can_view_person_scorecard(_user_id)
       AND h.changed_by = _user_id AND h.changed_at >= _from AND h.changed_at < _to
    UNION ALL
    SELECT 'gift_send', g.sent_at, 'Gift sent', COALESCE(g.notes,''),
           'account', g.account_id, g.id
      FROM public.gift_sends g
     WHERE public.can_view_person_scorecard(_user_id)
       AND g.created_by = _user_id AND g.sent_at >= _from AND g.sent_at < _to
    UNION ALL
    SELECT 'job_note', n.created_at, 'Job note', left(n.body, 240), 'job', n.job_id, n.id
      FROM public.job_notes n
     WHERE public.can_view_person_scorecard(_user_id)
       AND n.author_id = _user_id AND n.created_at >= _from AND n.created_at < _to
    UNION ALL
    SELECT 'job', j.created_at, COALESCE(j.job_number,'Job') || ' · ' || j.status::text,
           COALESCE(j.address,''), 'job', j.id, j.id
      FROM public.jobs j
     WHERE public.can_view_person_scorecard(_user_id)
       AND j.created_by = _user_id AND j.created_at >= _from AND j.created_at < _to
    UNION ALL
    SELECT 'incident', i.accepted_at, 'Chase accepted' ||
           CASE WHEN i.outcome IS NULL THEN '' ELSE ' · ' || i.outcome::text END,
           COALESCE(i.address,''), 'incident', i.id, i.id
      FROM public.incidents i
     WHERE public.can_view_person_scorecard(_user_id)
       AND i.accepted_by = _user_id AND i.accepted_at >= _from AND i.accepted_at < _to
  ) s
  ORDER BY s.occurred_at DESC NULLS LAST
  LIMIT GREATEST(_limit, 1);
$$;

GRANT EXECUTE ON FUNCTION public.person_timeline(uuid, timestamptz, timestamptz, integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.person_accounts(_user_id uuid)
RETURNS TABLE(
  id uuid, name text, stage account_stage, status account_status,
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
   ORDER BY lt.last_touch NULLS FIRST;
$$;

GRANT EXECUTE ON FUNCTION public.person_accounts(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.person_jobs(_user_id uuid, _from timestamptz, _to timestamptz)
RETURNS TABLE(
  id uuid, job_number text, job_name text, address text, status job_status,
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
     AND j.created_at >= _from AND j.created_at < _to
   ORDER BY j.created_at DESC;
$$;

GRANT EXECUTE ON FUNCTION public.person_jobs(uuid, timestamptz, timestamptz) TO authenticated;

CREATE OR REPLACE FUNCTION public.person_chase(_user_id uuid, _from timestamptz, _to timestamptz)
RETURNS TABLE(
  id uuid, address text, accepted_at timestamptz, arrived_at timestamptz,
  tta_minutes numeric, outcome incident_outcome, job_id uuid
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT i.id, i.address, i.accepted_at, i.arrived_at,
         CASE WHEN i.arrived_at IS NULL THEN NULL
              ELSE EXTRACT(EPOCH FROM (i.arrived_at - i.accepted_at)) / 60.0 END,
         i.outcome, i.job_id
    FROM public.incidents i
   WHERE public.can_view_person_scorecard(_user_id)
     AND i.accepted_by = _user_id
     AND i.accepted_at >= _from AND i.accepted_at < _to
   ORDER BY i.accepted_at DESC;
$$;

GRANT EXECUTE ON FUNCTION public.person_chase(uuid, timestamptz, timestamptz) TO authenticated;

CREATE OR REPLACE FUNCTION public.person_stalled(_user_id uuid)
RETURNS TABLE(
  id uuid, record_type escalation_record_type, record_id uuid, record_label text,
  record_status text, days_stale integer, step smallint, notified_at timestamptz,
  location_id uuid
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT e.id, e.record_type, e.record_id, e.record_label, e.record_status,
         e.days_stale, e.step, e.notified_at, e.location_id
    FROM public.escalation_events e
   WHERE public.can_view_person_scorecard(_user_id)
     AND e.state = 'open'
     AND (e.owner_user_id = _user_id OR e.notified_user_id = _user_id)
   ORDER BY e.days_stale DESC NULLS LAST;
$$;

GRANT EXECUTE ON FUNCTION public.person_stalled(uuid) TO authenticated;
