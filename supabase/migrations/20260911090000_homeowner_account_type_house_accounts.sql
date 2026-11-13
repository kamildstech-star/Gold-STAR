-- Account types decide whether the follow-up clocks run.
--
-- Mark, 10 Sep 2026: "The type decides whether the follow-up clock runs at all.
-- Management companies, brokers, TPAs, and commercial property owners all get
-- both clocks and can go Critical. Homeowners get neither clock. They are a one
-- time job. There is no future sale to protect, so there is nothing to follow
-- up on. A homeowner can never go Critical. ... House accounts belong to the
-- company rather than a rep."
--
-- The rule itself lives in src/lib/account-clocks.ts. This migration gives the
-- database the two things the rule needs to be usable and the one thing it
-- needs to be safe:
--
--   1. a `homeowner` account type to select,
--   2. a `House Account` label to put on,
--   3. the ghost timer taught to skip an account whose type has no clock.
--
-- WHY A NEW TYPE RATHER THAN REUSING `residential`
-- ------------------------------------------------
-- `residential` looks like the obvious home for homeowners and is not one.
-- Every account carrying it today is a business working in the residential
-- sector — "Brooklyn Realty 3", "Flatbush Co-op Board Alliance", "Triangle
-- Student Housing". Reusing the key would have switched both clocks off on
-- thirteen live B2B prospects, which is the same false-quiet mistake this
-- change exists to prevent, pointed the other way. Nothing below reclassifies
-- an existing account: a homeowner is only ever a record somebody deliberately
-- types as one, so the behaviour of every row in the table today is unchanged.

-- ---------------------------------------------------------------------------
-- 1. The type. Sorted next to Residential and Commercial, where somebody
--    choosing between the three will be looking.
-- ---------------------------------------------------------------------------
INSERT INTO public.option_list_values (list_id, key, label, sort_order, active)
SELECT ol.id, 'homeowner', 'Homeowner', 35, true
FROM public.option_lists ol
WHERE ol.key = 'account_type'
  -- An office that already added their own "homeowner" keeps theirs; two
  -- values of one key would make accounts.account_type ambiguous, and the
  -- sync trigger picks whichever row it finds first.
  AND NOT EXISTS (
    SELECT 1 FROM public.option_list_values v
    WHERE v.list_id = ol.id AND lower(v.key) = 'homeowner'
  );

-- ---------------------------------------------------------------------------
-- 2. The label. House accounts are declared, never inferred: a quarter of the
--    book has no `assigned_rep` simply because nobody has picked it up yet, so
--    guessing from an empty rep would rename accounts that are just new.
-- ---------------------------------------------------------------------------
INSERT INTO public.tags (name, color, scopes, sort_order)
SELECT 'House Account', '#4A5A70', ARRAY['account']::public.tag_scope[], 16
WHERE NOT EXISTS (
  SELECT 1 FROM public.tags t WHERE lower(t.name) = 'house account'
);

-- ---------------------------------------------------------------------------
-- 3. The rule, in SQL, mirroring HOMEOWNER_TYPE_KEYS in
--    src/lib/account-clocks.ts. Keep the two in step — rename here, rename
--    there. Default TRUE for everything else, including a type nobody has
--    thought of yet: this function can only ever quieten a homeowner, never
--    start a clock that was not already ticking.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.account_clocks_run(_account_type text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT coalesce(
    lower(replace(btrim(coalesce(_account_type, '')), '-', '_'))
      NOT IN ('homeowner', 'home_owner', 'homeowners'),
    true);
$$;
COMMENT ON FUNCTION public.account_clocks_run(text) IS
  'Whether an account type runs the follow-up clocks. False for homeowners only — Mark: "Homeowners get neither clock ... A homeowner can never go Critical." Mirrors HOMEOWNER_TYPE_KEYS in src/lib/account-clocks.ts.';
REVOKE ALL ON FUNCTION public.account_clocks_run(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.account_clocks_run(text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. The ghost timer.
--
--    This is the part that matters. `pipeline_ghost_sweep()` reads
--    `auto_ghost_due` off this view every ten minutes and moves the record; a
--    homeowner sitting in Active Outreach would be chased and then ghosted by
--    a clock Mark says should not be running on it at all. The TypeScript
--    mirror (`evaluatePipelineRule`) already refuses; the sweep has to as
--    well, or the two disagree and the database wins.
--
--    The view is REPLACED with the same columns, in the same order, of the
--    same types — the only change is that `in_rule_stage` is now conjoined
--    with the clock rule, which drops `warning`, `auto_ghost_due` and
--    `ghost_due_at` out for a clock-less account without touching anything
--    else. Attempts and methods are still counted and still shown: "we called
--    them twice" stays true and worth reading, it just is not overdue.
--
--    Recreated wholesale (rather than patched) because CREATE OR REPLACE VIEW
--    takes the whole definition. This body is 20260909120100's, with `calc`
--    carrying one extra condition. Keep it beside that migration when either
--    changes.
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
         public.account_clocks_run(a.account_type) AS clocks_run,
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
         -- The type gate. A homeowner is treated exactly as if it were parked
         -- on a stage that has no ghost timer, which is a state this view and
         -- the sweep already handle correctly everywhere.
         (ev.clocks_run AND ev.stage_key IN ('active_outreach', 'conversation_established'))
           AS in_rule_stage,
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
  (c.in_rule_stage AND c.stage_key = 'active_outreach' AND c.standard_met AND NOT c.replied)
    AS exhausted,
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
