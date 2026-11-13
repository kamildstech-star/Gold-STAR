-- ---------------------------------------------------------------- toggles
ALTER TABLE public.pipelines
  ADD COLUMN IF NOT EXISTS auto_advance_enabled boolean NOT NULL DEFAULT true;

ALTER TABLE public.pipeline_stages
  ADD COLUMN IF NOT EXISTS advance_match text NOT NULL DEFAULT 'all',
  ADD COLUMN IF NOT EXISTS advance_min_count integer NOT NULL DEFAULT 1;

ALTER TABLE public.pipeline_stages
  DROP CONSTRAINT IF EXISTS pipeline_stages_advance_match_check;
ALTER TABLE public.pipeline_stages
  ADD CONSTRAINT pipeline_stages_advance_match_check
  CHECK (advance_match IN ('all', 'any'));

-- ------------------------------------------------------------- fire ledger
CREATE TABLE IF NOT EXISTS public.stage_auto_advances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  pipeline_id uuid REFERENCES public.pipelines(id) ON DELETE SET NULL,
  from_stage_id uuid REFERENCES public.pipeline_stages(id) ON DELETE SET NULL,
  to_stage_id uuid REFERENCES public.pipeline_stages(id) ON DELETE SET NULL,
  rule_fingerprint text NOT NULL,
  conditions_met jsonb NOT NULL DEFAULT '[]'::jsonb,
  note text,
  fired_at timestamptz NOT NULL DEFAULT now(),
  undone_at timestamptz,
  undone_by uuid REFERENCES public.profiles(user_id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.stage_auto_advances TO authenticated;
GRANT ALL ON public.stage_auto_advances TO service_role;

ALTER TABLE public.stage_auto_advances ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS stage_auto_advances_select ON public.stage_auto_advances;
CREATE POLICY stage_auto_advances_select ON public.stage_auto_advances
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.accounts a
    WHERE a.id = stage_auto_advances.account_id
      AND (a.created_by = (SELECT auth.uid())
           OR a.assigned_rep = (SELECT auth.uid())
           OR public.can_view_location((SELECT auth.uid()), a.location_id))
  ));

CREATE UNIQUE INDEX IF NOT EXISTS stage_auto_advances_once_idx
  ON public.stage_auto_advances (account_id, from_stage_id, rule_fingerprint);
CREATE INDEX IF NOT EXISTS stage_auto_advances_account_idx
  ON public.stage_auto_advances (account_id, fired_at DESC);

DROP TRIGGER IF EXISTS trg_stage_auto_advances_updated_at ON public.stage_auto_advances;
CREATE TRIGGER trg_stage_auto_advances_updated_at
  BEFORE UPDATE ON public.stage_auto_advances
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ------------------------------------------------------- condition testing
CREATE OR REPLACE FUNCTION public.stage_condition_met(
  _account_id uuid,
  _since timestamptz,
  _cond jsonb
) RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
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
$$;

REVOKE ALL ON FUNCTION public.stage_condition_met(uuid, timestamptz, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.stage_condition_met(uuid, timestamptz, jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.stage_condition_label(_cond jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE coalesce(_cond->>'kind', '')
    WHEN 'call_logged' THEN 'call logged'
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
$$;

REVOKE ALL ON FUNCTION public.stage_condition_label(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.stage_condition_label(jsonb) TO authenticated, service_role;

-- ------------------------------------------------------------- the engine
CREATE OR REPLACE FUNCTION public.stage_advance_evaluate(_account_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
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

  fp := md5(st.id::text || '|' || conds::text);
  -- Fired once already (even if undone) — never fire twice for the same set.
  IF EXISTS (
    SELECT 1 FROM public.stage_auto_advances
     WHERE account_id = a.id AND from_stage_id = st.id AND rule_fingerprint = fp
  ) THEN RETURN NULL; END IF;

  since := coalesce(a.stage_changed_at, a.created_at, now() - interval '3650 days');

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
$$;

REVOKE ALL ON FUNCTION public.stage_advance_evaluate(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.stage_advance_evaluate(uuid) TO authenticated, service_role;

-- ------------------------------------------------------------------- undo
CREATE OR REPLACE FUNCTION public.undo_stage_auto_advance(_advance_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  adv public.stage_auto_advances;
  a public.accounts;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;

  SELECT * INTO adv FROM public.stage_auto_advances WHERE id = _advance_id;
  IF NOT FOUND OR adv.undone_at IS NOT NULL THEN RETURN false; END IF;

  SELECT * INTO a FROM public.accounts WHERE id = adv.account_id;
  IF NOT FOUND THEN RETURN false; END IF;

  -- Only someone who could move this record by hand may undo the engine.
  IF NOT (public.is_privileged(auth.uid())
          OR a.assigned_rep = auth.uid()
          OR a.created_by = auth.uid()
          OR public.can_manage_location(auth.uid(), a.location_id)) THEN
    RAISE EXCEPTION 'not permitted to undo this move';
  END IF;

  UPDATE public.accounts
     SET stage_id = adv.from_stage_id, stage_changed_at = now()
   WHERE id = adv.account_id AND stage_id = adv.to_stage_id;

  UPDATE public.account_stage_history h
     SET reason = 'Automatic advance undone'
   WHERE h.id = (
     SELECT id FROM public.account_stage_history
      WHERE account_id = adv.account_id AND to_stage_id = adv.from_stage_id
      ORDER BY changed_at DESC LIMIT 1
   );

  -- The ledger row stays: its fingerprint is what stops the rule re-firing.
  UPDATE public.stage_auto_advances
     SET undone_at = now(), undone_by = auth.uid()
   WHERE id = adv.id;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.undo_stage_auto_advance(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.undo_stage_auto_advance(uuid) TO authenticated, service_role;

-- --------------------------------------------------- time-based rule sweep
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
  RETURN moved;
END;
$$;

REVOKE ALL ON FUNCTION public.stage_advance_sweep() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.stage_advance_sweep() TO authenticated, service_role;

-- --------------------------------------------------------------- triggers
CREATE OR REPLACE FUNCTION public.tg_stage_advance_touch()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  acc uuid;
BEGIN
  IF TG_TABLE_NAME = 'documents' THEN
    IF NEW.status IS DISTINCT FROM 'signed' THEN RETURN NULL; END IF;
  END IF;

  acc := NULL;
  BEGIN
    EXECUTE format('SELECT ($1).account_id') INTO acc USING NEW;
  EXCEPTION WHEN OTHERS THEN
    acc := NULL;
  END;

  IF acc IS NOT NULL THEN
    PERFORM public.stage_advance_evaluate(acc);
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_stage_advance_touchpoints ON public.touchpoints;
CREATE TRIGGER trg_stage_advance_touchpoints
  AFTER INSERT OR UPDATE ON public.touchpoints
  FOR EACH ROW EXECUTE FUNCTION public.tg_stage_advance_touch();

DROP TRIGGER IF EXISTS trg_stage_advance_calendar ON public.calendar_events;
CREATE TRIGGER trg_stage_advance_calendar
  AFTER INSERT OR UPDATE ON public.calendar_events
  FOR EACH ROW EXECUTE FUNCTION public.tg_stage_advance_touch();

DROP TRIGGER IF EXISTS trg_stage_advance_estimates ON public.estimates;
CREATE TRIGGER trg_stage_advance_estimates
  AFTER INSERT OR UPDATE ON public.estimates
  FOR EACH ROW EXECUTE FUNCTION public.tg_stage_advance_touch();

DROP TRIGGER IF EXISTS trg_stage_advance_documents ON public.documents;
CREATE TRIGGER trg_stage_advance_documents
  AFTER INSERT OR UPDATE ON public.documents
  FOR EACH ROW EXECUTE FUNCTION public.tg_stage_advance_touch();

-- ------------------------------------------------- the client's own example
UPDATE public.pipeline_stages
   SET auto_advance = true,
       advance_match = 'all',
       advance_min_count = 3,
       advance_to_stage_id = '99a32fcd-1d05-47e0-936a-54bbdcde49be',
       advance_conditions = '[{"kind":"call_logged","min_count":1},
                              {"kind":"touch_logged","min_count":1},
                              {"kind":"meeting_scheduled","min_count":1}]'::jsonb
 WHERE id = 'fc9ba1aa-3c2d-4d82-9280-63933c27e173';