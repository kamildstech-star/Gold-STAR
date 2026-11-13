-- Pipeline stage rules: Active Outreach and Conversation Established.
--
-- Mark's spec, 9 Sep 2026, the parts this file carries:
--
--   Ready -> Active Outreach   "the moment the rep logs their first attempt"
--   Outreach standard          five attempts, >= three methods, within thirty
--                              days, across >= five separate days
--   Active Outreach -> Ghosted "thirty days pass with no reply, or all five
--                              attempts are used with no reply ... warning
--                              around day twenty four ... snooze once"
--   Manual Ghost               allowed any time, quietly noted with the
--                              attempt count; a pattern shows for the manager
--   Outreach -> Conversation   "once anyone at the company responds"
--   Conversation -> Ghosted    thirty days with no new back and forth
--
-- SAFETY RULE (overrides the spec): no retroactive mass-ghosting. Every
-- account carries rule_clock_started_at, set to THIS migration's timestamp
-- for existing rows and to created_at for new ones. The silence timer and
-- the attempt window both start at greatest(stage entry, clock start), so
-- the first automatic ghost cannot happen before 30 days from deploy.
--
-- HOW IT IS BUILT — one engine, not two:
--   * stage_condition_met gains two condition kinds, attempt_logged and
--     reply_received, and the Ready / Active Outreach stages are re-armed to
--     use them. The existing stage_advance_evaluate + its touchpoint trigger
--     therefore do Ready -> Outreach and Outreach -> Conversation exactly as
--     they already do call -> Outreach and meeting -> Conversation.
--   * stage_advance_evaluate refuses (by design) to advance INTO a lost
--     stage, so ghosting is a sibling sweep, pipeline_ghost_sweep(), called
--     from the existing stage_advance_sweep() that pg_cron already runs
--     every ten minutes. No new cron job.
--   * The per-account verdict the card needs (days silent, attempts, methods,
--     exhausted, warning, auto_ghost_due, snooze) is ONE view,
--     public.pipeline_rule_state, computed from the same helper the sweep
--     and the ghost log use. security_invoker: the accounts RLS decides who
--     sees a row.
--
-- Nothing is dropped, no data is deleted, RLS is enabled on the new table.

-- ---------------------------------------------------------------------------
-- 1. Settings: one place for the numbers, editable in app_settings.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pipeline_rule_settings()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'attempts', 5,
    'methods', 3,
    'attempt_days', 5,
    'window_days', 30,
    'warn_days', 24,
    'ghost_days', 30,
    'snooze_default_days', 14,
    'snooze_max_days', 30,
    'day_timezone', 'America/New_York'
  ) || coalesce((SELECT value FROM public.app_settings WHERE key = 'pipeline_rules'), '{}'::jsonb);
$$;
REVOKE ALL ON FUNCTION public.pipeline_rule_settings() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pipeline_rule_settings() TO authenticated, service_role;

-- Which of the six methods a touchpoint type counts as. Mirrored in
-- src/lib/pipeline-rules.ts (touchpointMethod) — keep the two in step.
CREATE OR REPLACE FUNCTION public.touchpoint_method(_type public.touchpoint_type)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE _type::text
    WHEN 'call' THEN 'phone'
    WHEN 'email' THEN 'email'
    WHEN 'text' THEN 'text'
    WHEN 'meeting_in_person' THEN 'in_person'
    WHEN 'linkedin' THEN 'linkedin'
    WHEN 'mail' THEN 'mail'
    WHEN 'gift' THEN 'mail'
    WHEN 'seasonal_send' THEN 'mail'
    WHEN 'meeting_virtual' THEN 'video'
    ELSE 'other'
  END;
$$;
GRANT EXECUTE ON FUNCTION public.touchpoint_method(public.touchpoint_type) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Columns: the clock floor, the one-time snooze, the warning marker.
-- ---------------------------------------------------------------------------
ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS rule_clock_started_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS ghost_snoozed_at timestamptz,
  ADD COLUMN IF NOT EXISTS ghost_snoozed_by uuid,
  ADD COLUMN IF NOT EXISTS ghost_snoozed_until timestamptz,
  ADD COLUMN IF NOT EXISTS ghost_warning_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS no_service_retry_months smallint
    CHECK (no_service_retry_months IS NULL OR no_service_retry_months BETWEEN 1 AND 24),
  ADD COLUMN IF NOT EXISTS green_light_date date;

COMMENT ON COLUMN public.accounts.rule_clock_started_at IS
  'Floor for the pipeline silence timer and attempt window: the rules count from greatest(stage_changed_at, this). Set to the deploy timestamp on 2026-09-09 so nothing was ghosted retroactively.';
COMMENT ON COLUMN public.accounts.ghost_snoozed_until IS
  'One-time snooze of the automatic ghost (pipeline_snooze_ghost). Cleared when the stage changes.';

-- Existing rows: ADD COLUMN ... DEFAULT now() stamps every existing row with
-- this migration's timestamp — the clock starts at deploy, never earlier. No
-- UPDATE, so no account trigger runs over rows this migration does not own.

-- ---------------------------------------------------------------------------
-- 3. Ghost log: every move into Ghosted, automatic or by hand, with the
--    attempt count at that moment. This is what the manager signal reads.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pipeline_ghost_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  location_id uuid,
  from_stage_id uuid,
  ghosted_at timestamptz NOT NULL DEFAULT now(),
  ghosted_by uuid,
  source text NOT NULL CHECK (source IN ('auto', 'manual')),
  attempts integer NOT NULL DEFAULT 0,
  attempt_days integer NOT NULL DEFAULT 0,
  methods text[] NOT NULL DEFAULT '{}',
  days_since_activity integer,
  reason text,
  is_demo boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS pipeline_ghost_events_account_idx ON public.pipeline_ghost_events(account_id, ghosted_at DESC);
CREATE INDEX IF NOT EXISTS pipeline_ghost_events_by_idx ON public.pipeline_ghost_events(ghosted_by, ghosted_at DESC);

ALTER TABLE public.pipeline_ghost_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pipeline_ghost_events FROM PUBLIC, anon;
GRANT SELECT ON public.pipeline_ghost_events TO authenticated;
GRANT ALL ON public.pipeline_ghost_events TO service_role;

DROP POLICY IF EXISTS pipeline_ghost_events_select ON public.pipeline_ghost_events;
CREATE POLICY pipeline_ghost_events_select ON public.pipeline_ghost_events
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.accounts a
    WHERE a.id = pipeline_ghost_events.account_id
      AND (a.assigned_rep = (SELECT auth.uid())
           OR a.created_by = (SELECT auth.uid())
           OR public.can_view_location((SELECT auth.uid()), a.location_id))
  ));
-- Writes happen only through the SECURITY DEFINER trigger below.

-- ---------------------------------------------------------------------------
-- 4. The shared evaluator: attempts, methods, days, last activity, reply.
--    `_since` is the clock start (stage entry floored by rule_clock_started_at).
-- ---------------------------------------------------------------------------
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
        FILTER (WHERE t.direction = 'outbound' AND t.occurred_at >= win.from_at), '{}'::text[]) AS methods,
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

-- ---------------------------------------------------------------------------
-- 5. The verdict, one row per un-archived account on an account pipeline.
--    Everything the card and the popups need; the sweep reads the same rows.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.pipeline_rule_state
WITH (security_invoker = true) AS
WITH cfg AS (SELECT public.pipeline_rule_settings() s),
base AS (
  SELECT a.id AS account_id, a.name, a.location_id, a.assigned_rep, a.pipeline_id, a.stage_id,
         s.key AS stage_key, a.stage_changed_at, a.rule_clock_started_at,
         greatest(a.stage_changed_at, a.rule_clock_started_at) AS clock_started_at,
         a.approval_state, a.is_demo,
         a.ghost_snoozed_at, a.ghost_snoozed_by, a.ghost_snoozed_until, a.ghost_warning_sent_at,
         a.goasted_at, a.reactivate_on, a.no_service_reason_detail, a.no_service_reason_code,
         a.green_light_date,
         coalesce(p.auto_advance_enabled, true) AS auto_advance_enabled
  FROM public.accounts a
  JOIN public.pipeline_stages s ON s.id = a.stage_id
  JOIN public.pipelines p ON p.id = s.pipeline_id
  WHERE a.archived_at IS NULL AND p.entity_type = 'account'
),
ev AS (
  SELECT b.*, st.*,
         greatest(b.clock_started_at, st.last_touch_at, st.last_task_done_at) AS last_activity_at,
         (cfg.s->>'attempts')::int AS need_attempts,
         (cfg.s->>'methods')::int AS need_methods,
         (cfg.s->>'attempt_days')::int AS need_days,
         (cfg.s->>'warn_days')::int AS warn_days,
         (cfg.s->>'ghost_days')::int AS ghost_days
  FROM base b
  CROSS JOIN cfg
  CROSS JOIN LATERAL public.pipeline_outreach_stats(b.account_id, b.clock_started_at) st
),
calc AS (
  SELECT ev.*,
         floor(extract(epoch FROM (now() - ev.last_activity_at)) / 86400)::int AS days_since_activity,
         coalesce(array_length(ev.methods, 1), 0) AS methods_count,
         (ev.attempts >= ev.need_attempts AND ev.attempt_days >= ev.need_days
          AND coalesce(array_length(ev.methods, 1), 0) >= ev.need_methods) AS standard_met,
         ev.stage_key IN ('active_outreach', 'conversation_established') AS in_rule_stage,
         (ev.ghost_snoozed_until IS NOT NULL AND ev.ghost_snoozed_until > now()) AS snoozed
  FROM ev
)
SELECT
  c.account_id, c.name, c.location_id, c.assigned_rep, c.pipeline_id, c.stage_id, c.stage_key,
  c.stage_changed_at, c.rule_clock_started_at, c.clock_started_at, c.is_demo,
  c.attempts, c.attempt_days, c.methods, c.methods_count,
  c.need_attempts, c.need_methods, c.need_days, c.warn_days, c.ghost_days,
  c.standard_met,
  -- "all five attempts are used with no reply": the standard is met and nobody answered.
  (c.stage_key = 'active_outreach' AND c.standard_met AND NOT c.replied) AS exhausted,
  c.replied, c.last_reply_at, c.last_touch_at, c.last_task_done_at,
  c.last_activity_at, c.days_since_activity,
  c.in_rule_stage,
  c.ghost_snoozed_at, c.ghost_snoozed_by, c.ghost_snoozed_until,
  (c.ghost_snoozed_at IS NOT NULL) AS snooze_used,
  c.snoozed,
  c.ghost_warning_sent_at,
  (c.in_rule_stage
     AND NOT (c.stage_key = 'active_outreach' AND c.replied)
     AND (c.days_since_activity >= c.warn_days
          OR (c.stage_key = 'active_outreach' AND c.standard_met))) AS warning,
  (c.in_rule_stage
     AND c.auto_advance_enabled
     AND c.approval_state NOT IN ('pending', 'escalated')
     AND NOT c.snoozed
     AND NOT (c.stage_key = 'active_outreach' AND c.replied)
     AND (c.days_since_activity >= c.ghost_days
          OR (c.stage_key = 'active_outreach' AND c.standard_met))) AS auto_ghost_due,
  -- When the automatic ghost will fire if nothing changes (already past = due now).
  CASE WHEN NOT c.in_rule_stage THEN NULL
       ELSE greatest(
              CASE WHEN c.stage_key = 'active_outreach' AND c.standard_met AND NOT c.replied
                   THEN now()
                   ELSE c.last_activity_at + make_interval(days => c.ghost_days) END,
              coalesce(c.ghost_snoozed_until, '-infinity'::timestamptz))
  END AS ghost_due_at,
  c.goasted_at,
  c.reactivate_on AS retry_at,
  c.no_service_reason_detail AS no_service_reason,
  c.no_service_reason_code,
  c.green_light_date
FROM calc c;

GRANT SELECT ON public.pipeline_rule_state TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Stage-change housekeeping on accounts (BEFORE UPDATE, after normalize —
--    trigger names run alphabetically and 'stage_r' > 'stage_n').
--    A new stage stay gets a fresh snooze and warning; entering Ghosted
--    stamps goasted_at; leaving No Service Needed drops a pending retry so
--    the sweep cannot return an account someone already moved by hand.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tg_account_stage_rules_reset()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  new_key text;
  old_key text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.stage_id IS DISTINCT FROM OLD.stage_id THEN
    SELECT key INTO new_key FROM public.pipeline_stages WHERE id = NEW.stage_id;
    SELECT key INTO old_key FROM public.pipeline_stages WHERE id = OLD.stage_id;
    NEW.ghost_snoozed_at := NULL;
    NEW.ghost_snoozed_by := NULL;
    NEW.ghost_snoozed_until := NULL;
    NEW.ghost_warning_sent_at := NULL;
    IF new_key = 'goasted' THEN
      NEW.goasted_at := now();
    END IF;
    IF old_key = 'no_service_needed' AND new_key IS DISTINCT FROM 'no_service_needed'
       AND NEW.reactivate_on IS NOT DISTINCT FROM OLD.reactivate_on THEN
      NEW.reactivate_on := NULL;
      NEW.no_service_retry_months := NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_accounts_stage_rules_reset ON public.accounts;
CREATE TRIGGER trg_accounts_stage_rules_reset
  BEFORE UPDATE ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public.tg_account_stage_rules_reset();

-- AFTER the move: log the ghost with the attempt count at that moment.
-- Source is 'manual' unless the sweep has set pipeline.ghost_source = 'auto'
-- for its transaction. Any path into Ghosted — drag, RPC, sweep — is noted.
CREATE OR REPLACE FUNCTION public.tg_account_ghost_log()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  new_key text;
  old_key text;
  clock timestamptz;
  st record;
  src text;
BEGIN
  IF NEW.stage_id IS NOT DISTINCT FROM OLD.stage_id THEN RETURN NULL; END IF;
  SELECT key INTO new_key FROM public.pipeline_stages WHERE id = NEW.stage_id;
  IF new_key IS DISTINCT FROM 'goasted' THEN RETURN NULL; END IF;
  SELECT key INTO old_key FROM public.pipeline_stages WHERE id = OLD.stage_id;
  IF old_key = 'goasted' THEN RETURN NULL; END IF;

  clock := greatest(OLD.stage_changed_at, OLD.rule_clock_started_at);
  SELECT * INTO st FROM public.pipeline_outreach_stats(NEW.id, clock);
  src := coalesce(nullif(current_setting('pipeline.ghost_source', true), ''), 'manual');

  INSERT INTO public.pipeline_ghost_events
    (account_id, location_id, from_stage_id, ghosted_by, source, attempts, attempt_days, methods,
     days_since_activity, reason, is_demo)
  VALUES
    (NEW.id, NEW.location_id, OLD.stage_id,
     CASE WHEN src = 'auto' THEN NULL ELSE auth.uid() END,
     src, coalesce(st.attempts, 0), coalesce(st.attempt_days, 0), coalesce(st.methods, '{}'),
     floor(extract(epoch FROM (now() - greatest(clock, st.last_touch_at, st.last_task_done_at))) / 86400)::int,
     NEW.lost_reason, coalesce(NEW.is_demo, false));
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_accounts_ghost_log ON public.accounts;
CREATE TRIGGER trg_accounts_ghost_log
  AFTER UPDATE OF stage_id ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public.tg_account_ghost_log();

-- ---------------------------------------------------------------------------
-- 7. Two new condition kinds for the existing auto-advance engine.
--      attempt_logged  — an outbound touchpoint of any method since stage entry
--      reply_received  — an inbound touchpoint, or an outbound one marked
--                        replied, since stage entry ("even a receptionist")
--    The rest of the function is unchanged from 20260820065154.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.stage_condition_met(_account_id uuid, _since timestamptz, _cond jsonb)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  kind text := coalesce(_cond->>'kind', '');
  need integer := greatest(coalesce((_cond->>'min_count')::int, 1), 1);
  n integer := 0;
BEGIN
  IF kind IN ('call_logged', 'touch_logged', 'activity_logged') THEN
    SELECT count(*) INTO n
      FROM public.touchpoints t
     WHERE t.account_id = _account_id
       AND t.occurred_at >= _since
       AND (
         kind = 'touch_logged'
         OR (kind = 'call_logged' AND t.type = 'call')
         OR (kind = 'activity_logged'
             AND (coalesce(_cond->>'activity_type', 'any') = 'any'
                  OR t.type::text = _cond->>'activity_type'))
       );
    RETURN n >= need;

  ELSIF kind = 'attempt_logged' THEN
    SELECT count(*) INTO n
      FROM public.touchpoints t
     WHERE t.account_id = _account_id
       AND t.direction = 'outbound'
       AND t.occurred_at >= _since;
    RETURN n >= need;

  ELSIF kind = 'reply_received' THEN
    SELECT count(*) INTO n
      FROM public.touchpoints t
     WHERE t.account_id = _account_id
       AND ((t.direction = 'inbound' AND t.occurred_at >= _since)
            OR (t.replied_at IS NOT NULL AND t.replied_at >= _since));
    RETURN n >= need;

  ELSIF kind = 'meeting_scheduled' THEN
    SELECT count(*) INTO n
      FROM public.calendar_events e
     WHERE e.account_id = _account_id
       AND coalesce(e.is_cancelled, false) = false
       AND coalesce(e.created_at, e.starts_at) >= _since;
    RETURN n >= need;

  ELSIF kind = 'meeting_held' THEN
    SELECT count(*) INTO n
      FROM public.calendar_events e
     WHERE e.account_id = _account_id
       AND coalesce(e.meeting_held, false)
       AND coalesce(e.starts_at, e.created_at) >= _since;
    IF n >= need THEN RETURN true; END IF;
    SELECT count(*) INTO n
      FROM public.touchpoints t
     WHERE t.account_id = _account_id
       AND t.type IN ('meeting_in_person', 'meeting_virtual')
       AND coalesce(t.meeting_held, true)
       AND t.occurred_at >= _since;
    RETURN n >= need;

  ELSIF kind = 'estimate_sent' THEN
    SELECT count(*) INTO n
      FROM public.estimates es
     WHERE es.account_id = _account_id
       AND es.sent_at IS NOT NULL
       AND es.sent_at >= _since;
    RETURN n >= need;

  ELSIF kind IN ('contract_signed', 'document_signed') THEN
    SELECT count(*) INTO n
      FROM public.documents d
     WHERE d.account_id = _account_id
       AND d.status = 'signed'
       AND coalesce(d.signed_at, now()) >= _since;
    RETURN n >= need;

  ELSIF kind = 'days_in_stage' THEN
    RETURN now() >= _since + make_interval(days => greatest(coalesce((_cond->>'days')::int, 1), 1));

  ELSIF kind = 'field_populated' THEN
    EXECUTE format(
      'SELECT count(*) FROM public.accounts a WHERE a.id = $1 AND a.%I IS NOT NULL AND btrim(a.%I::text) <> %L',
      coalesce(_cond->>'field', 'name'), coalesce(_cond->>'field', 'name'), ''
    ) INTO n USING _account_id;
    RETURN n > 0;
  END IF;

  RETURN false;
END;
$function$;

CREATE OR REPLACE FUNCTION public.stage_condition_label(_cond jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $function$
  SELECT CASE coalesce(_cond->>'kind', '')
    WHEN 'call_logged' THEN 'call logged'
    WHEN 'attempt_logged' THEN 'first attempt logged'
    WHEN 'reply_received' THEN 'reply received'
    WHEN 'touch_logged' THEN 'conversation logged'
    WHEN 'activity_logged' THEN 'activity logged'
    WHEN 'meeting_scheduled' THEN 'meeting scheduled'
    WHEN 'meeting_held' THEN 'meeting held'
    WHEN 'estimate_sent' THEN 'estimate sent'
    WHEN 'contract_signed' THEN 'contract signed'
    WHEN 'document_signed' THEN 'document signed'
    WHEN 'days_in_stage' THEN coalesce(_cond->>'days', '0') || ' days in stage'
    WHEN 'field_populated' THEN coalesce(_cond->>'field', 'field') || ' populated'
    ELSE coalesce(_cond->>'kind', 'condition')
  END;
$function$;

-- ---------------------------------------------------------------------------
-- 8. stage_advance_evaluate: one change. The "never fire twice for the same
--    rule" guard compared only the fingerprint, so an account moved back to a
--    stage by hand (the documented reversion path) could never auto-advance
--    out of it again. It now means "never twice in the same stay": a firing
--    only blocks while it is newer than the current stage entry.
--    Everything else is the deployed body verbatim.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.stage_advance_evaluate(_account_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  a public.accounts;
  st public.pipeline_stages;
  tgt public.pipeline_stages;
  pl public.pipelines;
  cond jsonb;
  conds jsonb;
  since timestamptz;
  total int := 0;
  met int := 0;
  labels text[] := '{}';
  met_json jsonb := '[]'::jsonb;
  required int;
  fp text;
  note text;
  advance_id uuid;
BEGIN
  SELECT * INTO a FROM public.accounts WHERE id = _account_id;
  IF NOT FOUND OR a.archived_at IS NOT NULL OR a.stage_id IS NULL THEN RETURN NULL; END IF;
  -- Accounts still waiting on a human decision are never moved by the engine.
  IF a.approval_state IN ('pending', 'escalated') THEN RETURN NULL; END IF;

  SELECT * INTO st FROM public.pipeline_stages
   WHERE id = a.stage_id AND is_active AND auto_advance;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT * INTO pl FROM public.pipelines WHERE id = st.pipeline_id;
  IF NOT FOUND OR NOT pl.auto_advance_enabled OR NOT pl.is_active THEN RETURN NULL; END IF;

  conds := coalesce(st.advance_conditions, '[]'::jsonb);
  IF jsonb_typeof(conds) <> 'array' OR jsonb_array_length(conds) = 0 THEN RETURN NULL; END IF;

  IF st.advance_to_stage_id IS NOT NULL THEN
    SELECT * INTO tgt FROM public.pipeline_stages WHERE id = st.advance_to_stage_id;
  ELSE
    SELECT * INTO tgt FROM public.pipeline_stages
     WHERE pipeline_id = st.pipeline_id AND is_active AND sort_order > st.sort_order
     ORDER BY sort_order LIMIT 1;
  END IF;
  IF NOT FOUND OR tgt.id = st.id THEN RETURN NULL; END IF;

  -- Guards: forward only, and never into or over a stage that needs a human.
  IF NOT tgt.is_active OR tgt.sort_order <= st.sort_order THEN RETURN NULL; END IF;
  IF tgt.requires_reason OR tgt.is_lost THEN RETURN NULL; END IF;
  IF EXISTS (
    SELECT 1 FROM public.pipeline_stages s
     WHERE s.pipeline_id = st.pipeline_id AND s.is_active
       AND s.sort_order > st.sort_order AND s.sort_order < tgt.sort_order
       AND (s.requires_reason OR s.is_lost)
  ) THEN RETURN NULL; END IF;

  since := coalesce(a.stage_changed_at, a.created_at, now() - interval '3650 days');

  fp := md5(st.id::text || '|' || conds::text);
  -- Fired once already during THIS stay in the stage (even if undone) — never
  -- fire twice for the same set. An earlier stay does not count.
  IF EXISTS (
    SELECT 1 FROM public.stage_auto_advances
     WHERE account_id = a.id AND from_stage_id = st.id AND rule_fingerprint = fp
       AND fired_at >= since
  ) THEN RETURN NULL; END IF;

  FOR cond IN SELECT jsonb_array_elements(conds) LOOP
    total := total + 1;
    IF public.stage_condition_met(a.id, since, cond) THEN
      met := met + 1;
      labels := labels || public.stage_condition_label(cond);
      met_json := met_json || jsonb_build_array(cond);
    END IF;
  END LOOP;

  required := CASE WHEN st.advance_match = 'any'
                   THEN least(greatest(coalesce(st.advance_min_count, 1), 1), total)
                   ELSE total END;
  IF met < required THEN RETURN NULL; END IF;

  note := 'Advanced to ' || tgt.name || ' automatically — ' || array_to_string(labels, ', ');

  UPDATE public.accounts
     SET stage_id = tgt.id, stage_changed_at = now()
   WHERE id = a.id AND stage_id = st.id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  UPDATE public.account_stage_history h
     SET reason = note
   WHERE h.id = (
     SELECT id FROM public.account_stage_history
      WHERE account_id = a.id AND to_stage_id = tgt.id
      ORDER BY changed_at DESC LIMIT 1
   );

  INSERT INTO public.stage_auto_advances
    (account_id, pipeline_id, from_stage_id, to_stage_id, rule_fingerprint, conditions_met, note)
  VALUES (a.id, st.pipeline_id, st.id, tgt.id, fp, met_json, note)
  RETURNING id INTO advance_id;

  IF a.assigned_rep IS NOT NULL THEN
    INSERT INTO public.notifications (user_id, type, title, body, entity_type, entity_id, href, priority)
    VALUES (a.assigned_rep, 'automation_task', a.name || ' advanced to ' || tgt.name,
            note, 'account', a.id, '/accounts/' || a.id::text, 'normal');
  END IF;

  RETURN advance_id;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 9. Re-arm the stages, by key, on every active account pipeline.
--      Ready            -> Active Outreach on the first attempt of ANY method
--                          (was: first call only)
--      Active Outreach  -> Conversation Established on a reply, a meeting
--                          scheduled, or a meeting held (any one)
-- ---------------------------------------------------------------------------
WITH pairs AS (
  SELECT ready.id AS ready_id, outreach.id AS outreach_id, conv.id AS conv_id
    FROM public.pipelines p
    JOIN public.pipeline_stages ready ON ready.pipeline_id = p.id AND ready.key = 'ready' AND ready.is_active
    JOIN public.pipeline_stages outreach ON outreach.pipeline_id = p.id AND outreach.key = 'active_outreach' AND outreach.is_active
    LEFT JOIN public.pipeline_stages conv ON conv.pipeline_id = p.id AND conv.key = 'conversation_established' AND conv.is_active
   WHERE p.entity_type = 'account' AND p.is_active
), ready_upd AS (
  UPDATE public.pipeline_stages s
     SET auto_advance = true, advance_match = 'all', advance_min_count = 1,
         advance_to_stage_id = pairs.outreach_id,
         advance_conditions = '[{"kind":"attempt_logged","min_count":1}]'::jsonb
    FROM pairs WHERE s.id = pairs.ready_id
  RETURNING s.id
)
UPDATE public.pipeline_stages s
   SET auto_advance = true, advance_match = 'any', advance_min_count = 1,
       advance_to_stage_id = pairs.conv_id,
       advance_conditions = '[{"kind":"reply_received","min_count":1},{"kind":"meeting_scheduled","min_count":1},{"kind":"meeting_held","min_count":1}]'::jsonb
  FROM pairs WHERE s.id = pairs.outreach_id AND pairs.conv_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 10. The ghost sweep: warnings at day 24 (once per silence), the move at
--     day 30 or on exhaustion. Only rows the view says are due; the view
--     already respects the clock floor, the snooze, approval holds and the
--     pipeline's auto-advance master switch.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pipeline_ghost_sweep()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  r record;
  ghost_stage uuid;
  moved int := 0;
  why text;
BEGIN
  -- Day-24 warning to the rep, once per stretch of silence.
  FOR r IN
    SELECT v.* FROM public.pipeline_rule_state v
     WHERE v.warning AND NOT v.auto_ghost_due AND v.assigned_rep IS NOT NULL
       AND (v.ghost_warning_sent_at IS NULL OR v.ghost_warning_sent_at < v.last_activity_at)
     LIMIT 500
  LOOP
    INSERT INTO public.notifications (user_id, type, title, body, entity_type, entity_id, href, priority, is_demo)
    VALUES (r.assigned_rep, 'record_stalled',
            r.name || ' will be ghosted ' || to_char(r.ghost_due_at, 'Mon DD'),
            CASE WHEN r.stage_key = 'active_outreach' AND r.standard_met
                 THEN 'All ' || r.need_attempts || ' attempts used across ' || r.attempt_days || ' days and ' || r.methods_count || ' methods with no reply.'
                 ELSE 'No activity for ' || r.days_since_activity || ' days. It moves to Ghosted by itself at ' || r.ghost_days || ' — log an attempt, a reply or a task, or snooze once.' END,
            'account', r.account_id, '/accounts/' || r.account_id::text, 'normal', r.is_demo);
    UPDATE public.accounts SET ghost_warning_sent_at = now() WHERE id = r.account_id;
  END LOOP;

  PERFORM set_config('pipeline.ghost_source', 'auto', true);
  FOR r IN
    SELECT v.* FROM public.pipeline_rule_state v WHERE v.auto_ghost_due LIMIT 500
  LOOP
    SELECT id INTO ghost_stage FROM public.pipeline_stages
     WHERE pipeline_id = r.pipeline_id AND key = 'goasted' AND is_active LIMIT 1;
    CONTINUE WHEN ghost_stage IS NULL;

    why := CASE WHEN r.stage_key = 'active_outreach' AND r.standard_met
                THEN 'Ghosted automatically — ' || r.attempts || ' attempts over ' || r.attempt_days || ' days by ' || r.methods_count || ' methods, no reply'
                ELSE 'Ghosted automatically — no activity for ' || r.days_since_activity || ' days' END;

    UPDATE public.accounts
       SET stage_id = ghost_stage, lost_reason = why
     WHERE id = r.account_id AND stage_id = r.stage_id;
    IF NOT FOUND THEN CONTINUE; END IF;
    moved := moved + 1;

    IF r.assigned_rep IS NOT NULL THEN
      INSERT INTO public.notifications (user_id, type, title, body, entity_type, entity_id, href, priority, is_demo)
      VALUES (r.assigned_rep, 'record_stalled', r.name || ' moved to Ghosted', why,
              'account', r.account_id, '/accounts/' || r.account_id::text, 'normal', r.is_demo);
    END IF;
  END LOOP;
  PERFORM set_config('pipeline.ghost_source', '', true);

  RETURN moved;
END;
$$;
REVOKE ALL ON FUNCTION public.pipeline_ghost_sweep() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pipeline_ghost_sweep() TO service_role;

-- ---------------------------------------------------------------------------
-- 11. The existing ten-minute sweep now also runs the ghost rules.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.stage_advance_sweep()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  r record;
  moved int := 0;
BEGIN
  FOR r IN
    SELECT a.id
      FROM public.accounts a
      JOIN public.pipeline_stages s ON s.id = a.stage_id
      JOIN public.pipelines p ON p.id = s.pipeline_id
     WHERE a.archived_at IS NULL
       AND s.auto_advance AND s.is_active
       AND p.auto_advance_enabled AND p.is_active
     LIMIT 5000
  LOOP
    IF public.stage_advance_evaluate(r.id) IS NOT NULL THEN moved := moved + 1; END IF;
  END LOOP;
  moved := moved + public.pipeline_ghost_sweep();
  RETURN moved;
END;
$$;

-- ---------------------------------------------------------------------------
-- 12. Rep-facing RPCs. SECURITY INVOKER like move_account_back_to_pipeline:
--     the accounts RLS policy decides who may do this.
-- ---------------------------------------------------------------------------

-- Snooze the automatic ghost once. A second snooze in the same stage stay is
-- refused; the stage-reset trigger clears it on the next stage change.
CREATE OR REPLACE FUNCTION public.pipeline_snooze_ghost(_account_id uuid, _days integer DEFAULT NULL)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  cfg jsonb := public.pipeline_rule_settings();
  days integer;
  acct record;
  until_at timestamptz;
BEGIN
  days := least(greatest(coalesce(_days, (cfg->>'snooze_default_days')::int), 1), (cfg->>'snooze_max_days')::int);

  SELECT acc.id, acc.ghost_snoozed_at, s.key AS stage_key
    INTO acct
    FROM public.accounts acc JOIN public.pipeline_stages s ON s.id = acc.stage_id
   WHERE acc.id = _account_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The account could not be found.' USING ERRCODE = '42501';
  END IF;
  IF acct.stage_key NOT IN ('active_outreach', 'conversation_established') THEN
    RAISE EXCEPTION 'Only Active Outreach and Conversation Established records have a ghost timer.' USING ERRCODE = '22023';
  END IF;
  IF acct.ghost_snoozed_at IS NOT NULL THEN
    RAISE EXCEPTION 'This record has already been snoozed once in this stage.' USING ERRCODE = '22023';
  END IF;

  until_at := now() + make_interval(days => days);
  UPDATE public.accounts
     SET ghost_snoozed_at = now(), ghost_snoozed_by = auth.uid(), ghost_snoozed_until = until_at
   WHERE id = _account_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The account could not be updated.' USING ERRCODE = '42501';
  END IF;
  RETURN until_at;
END;
$$;
REVOKE ALL ON FUNCTION public.pipeline_snooze_ghost(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pipeline_snooze_ghost(uuid, integer) TO authenticated, service_role;

-- Move to Ghosted by hand. Never blocked; the ghost-log trigger notes the
-- attempt count. A plain stage_id update does the same — this is the tidy door.
CREATE OR REPLACE FUNCTION public.pipeline_ghost_manual(_account_id uuid, _reason text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  ghost_stage uuid;
BEGIN
  SELECT g.id INTO ghost_stage
    FROM public.accounts a
    JOIN public.pipeline_stages s ON s.id = a.stage_id
    JOIN public.pipeline_stages g ON g.pipeline_id = s.pipeline_id AND g.key = 'goasted' AND g.is_active
   WHERE a.id = _account_id;
  IF ghost_stage IS NULL THEN
    RAISE EXCEPTION 'This pipeline has no Ghosted stage.' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (SELECT 1 FROM public.accounts WHERE id = _account_id AND stage_id = ghost_stage) THEN
    RETURN; -- already there; nothing to note
  END IF;

  UPDATE public.accounts
     SET stage_id = ghost_stage,
         lost_reason = coalesce(nullif(btrim(_reason), ''), 'Ghosted by the rep')
   WHERE id = _account_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The account could not be moved.' USING ERRCODE = '42501';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.pipeline_ghost_manual(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pipeline_ghost_manual(uuid, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 13. The manager signal: reps whose manual ghosts mostly came after barely
--     trying. Reads the ghost log under the caller's RLS, so a manager sees
--     their offices. Threshold defaults to the outreach standard's attempts.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pipeline_manual_ghost_signal(_days integer DEFAULT 90, _min_attempts integer DEFAULT NULL)
RETURNS TABLE (
  user_id uuid,
  manual_ghosts integer,
  low_effort_ghosts integer,
  low_effort_share numeric,
  avg_attempts numeric,
  last_ghost_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  WITH cfg AS (SELECT coalesce(_min_attempts, (public.pipeline_rule_settings()->>'attempts')::int) AS min_attempts)
  SELECT e.ghosted_by AS user_id,
         count(*)::int AS manual_ghosts,
         (count(*) FILTER (WHERE e.attempts < cfg.min_attempts))::int AS low_effort_ghosts,
         round((count(*) FILTER (WHERE e.attempts < cfg.min_attempts))::numeric / count(*), 2) AS low_effort_share,
         round(avg(e.attempts), 1) AS avg_attempts,
         max(e.ghosted_at) AS last_ghost_at
    FROM public.pipeline_ghost_events e, cfg
   WHERE e.source = 'manual' AND e.ghosted_by IS NOT NULL AND NOT e.is_demo
     AND e.ghosted_at >= now() - make_interval(days => greatest(coalesce(_days, 90), 1))
   GROUP BY e.ghosted_by, cfg.min_attempts
   ORDER BY low_effort_share DESC, manual_ghosts DESC;
$$;
REVOKE ALL ON FUNCTION public.pipeline_manual_ghost_signal(integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pipeline_manual_ghost_signal(integer, integer) TO authenticated, service_role;
