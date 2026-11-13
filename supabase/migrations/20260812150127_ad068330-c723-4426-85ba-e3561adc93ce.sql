-- ============ LIFECYCLES ============
DO $$ BEGIN
  CREATE TYPE public.incident_lifecycle AS ENUM ('live','claimed','dead','won');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TYPE public.dispatch_response ADD VALUE IF NOT EXISTS 'no_action';

ALTER TABLE public.incidents
  ADD COLUMN IF NOT EXISTS lifecycle public.incident_lifecycle NOT NULL DEFAULT 'live',
  ADD COLUMN IF NOT EXISTS bad_data boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS worth_another_try boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS revisit_after timestamptz;

ALTER TABLE public.incident_dispatches
  ADD COLUMN IF NOT EXISTS decline_reason text;

CREATE INDEX IF NOT EXISTS incidents_lifecycle_idx ON public.incidents(lifecycle);

-- ============ REASON TREES (editable without a deploy) ============
CREATE TABLE public.incident_outcome_reasons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id uuid REFERENCES public.incident_outcome_reasons(id) ON DELETE CASCADE,
  key text NOT NULL,
  label text NOT NULL,
  -- What the top-level reason does to the lead. Children inherit the parent's.
  kills_lead boolean NOT NULL DEFAULT true,
  flags_bad_data boolean NOT NULL DEFAULT false,
  allows_another_try boolean NOT NULL DEFAULT false,
  wins_lead boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (parent_id, key)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.incident_outcome_reasons TO authenticated;
GRANT ALL ON public.incident_outcome_reasons TO service_role;
ALTER TABLE public.incident_outcome_reasons ENABLE ROW LEVEL SECURITY;
CREATE POLICY incident_outcome_reasons_select ON public.incident_outcome_reasons
  FOR SELECT TO authenticated USING (true);
CREATE POLICY incident_outcome_reasons_manage ON public.incident_outcome_reasons
  FOR ALL TO authenticated
  USING (public.is_privileged((SELECT auth.uid())))
  WITH CHECK (public.is_privileged((SELECT auth.uid())));
CREATE INDEX incident_outcome_reasons_parent_idx ON public.incident_outcome_reasons(parent_id);
CREATE TRIGGER incident_outcome_reasons_updated BEFORE UPDATE ON public.incident_outcome_reasons
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============ ATTEMPT HISTORY ============
-- Travels with a living lead: the next chaser must see what already failed.
CREATE TABLE public.incident_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id uuid NOT NULL REFERENCES public.incidents(id) ON DELETE CASCADE,
  chaser_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  attended_at timestamptz NOT NULL DEFAULT now(),
  reason_id uuid REFERENCES public.incident_outcome_reasons(id) ON DELETE SET NULL,
  sub_reason_id uuid REFERENCES public.incident_outcome_reasons(id) ON DELETE SET NULL,
  reason_label text,
  sub_reason_label text,
  note text,
  kept_live boolean NOT NULL DEFAULT false,
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.incident_attempts TO authenticated;
GRANT ALL ON public.incident_attempts TO service_role;
ALTER TABLE public.incident_attempts ENABLE ROW LEVEL SECURITY;
-- Attempts are visible to anyone who can see the incident, which already
-- carries the market wall.
CREATE POLICY incident_attempts_select ON public.incident_attempts FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.incidents i WHERE i.id = incident_id));
CREATE POLICY incident_attempts_insert ON public.incident_attempts FOR INSERT TO authenticated
  WITH CHECK (chaser_id = (SELECT auth.uid()) OR public.is_privileged((SELECT auth.uid())));
CREATE POLICY incident_attempts_manage ON public.incident_attempts FOR ALL TO authenticated
  USING (public.is_privileged((SELECT auth.uid())))
  WITH CHECK (public.is_privileged((SELECT auth.uid())));
CREATE INDEX incident_attempts_incident_idx ON public.incident_attempts(incident_id, attended_at DESC);

-- ============ OUTCOME ============
-- One place decides whether a lead survives. The reason row carries the rule,
-- so the lists stay editable without a deploy.
CREATE OR REPLACE FUNCTION public.log_incident_outcome(
  _incident_id uuid,
  _reason_id uuid,
  _sub_reason_id uuid DEFAULT NULL,
  _note text DEFAULT NULL,
  _worth_another_try boolean DEFAULT false,
  _revisit_after timestamptz DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  uid uuid := auth.uid();
  inc public.incidents%ROWTYPE;
  reason public.incident_outcome_reasons%ROWTYPE;
  sub public.incident_outcome_reasons%ROWTYPE;
  keep_live boolean;
  next_life public.incident_lifecycle;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT * INTO inc FROM public.incidents WHERE id = _incident_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Incident not found'; END IF;
  IF NOT public.incident_market_allowed(uid, inc.market_id) THEN
    RAISE EXCEPTION 'Out of market';
  END IF;

  SELECT * INTO reason FROM public.incident_outcome_reasons WHERE id = _reason_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown outcome reason'; END IF;
  IF _sub_reason_id IS NOT NULL THEN
    SELECT * INTO sub FROM public.incident_outcome_reasons WHERE id = _sub_reason_id;
  END IF;

  -- Nobody home / not the owner keep the lead alive. Homeowner declined can be
  -- kept alive only when the chaser explicitly says it is worth another try.
  keep_live := (NOT reason.kills_lead)
               OR (reason.allows_another_try AND COALESCE(_worth_another_try, false));

  IF reason.wins_lead THEN
    next_life := 'won';
  ELSIF keep_live THEN
    next_life := 'live';
  ELSE
    next_life := 'dead';
  END IF;

  INSERT INTO public.incident_attempts
    (incident_id, chaser_id, reason_id, sub_reason_id, reason_label, sub_reason_label, note, kept_live)
  VALUES
    (_incident_id, uid, reason.id, sub.id, reason.label, sub.label, nullif(btrim(coalesce(_note,'')), ''), keep_live);

  UPDATE public.incidents
     SET lifecycle = next_life,
         bad_data = bad_data OR reason.flags_bad_data,
         worth_another_try = COALESCE(_worth_another_try, false),
         revisit_after = CASE WHEN keep_live THEN _revisit_after ELSE NULL END,
         outcome_notes = COALESCE(nullif(btrim(coalesce(_note,'')), ''), outcome_notes),
         outcome_at = now(),
         -- A living lead goes back on the board, unlocked, at tier zero.
         status = CASE WHEN next_life = 'live' THEN 'dispatched'::incident_status
                       WHEN next_life = 'won' THEN 'closed'::incident_status
                       ELSE 'closed'::incident_status END,
         locked_by = CASE WHEN next_life = 'live' THEN NULL ELSE locked_by END,
         locked_at = CASE WHEN next_life = 'live' THEN NULL ELSE locked_at END,
         accepted_by = CASE WHEN next_life = 'live' THEN NULL ELSE accepted_by END,
         accepted_at = CASE WHEN next_life = 'live' THEN NULL ELSE accepted_at END,
         arrived_at = CASE WHEN next_life = 'live' THEN NULL ELSE arrived_at END,
         eta_at = CASE WHEN next_life = 'live' THEN NULL ELSE eta_at END,
         needs_backup = false,
         escalation_tier = CASE WHEN next_life = 'live' THEN 0 ELSE escalation_tier END,
         escalated_at = CASE WHEN next_life = 'live' THEN NULL ELSE escalated_at END
   WHERE id = _incident_id;

  -- A revived lead is offered afresh: prior dispatch rows would otherwise
  -- suppress re-notification, but the chaser who attended keeps their record.
  IF next_life = 'live' THEN
    DELETE FROM public.incident_dispatches
     WHERE incident_id = _incident_id AND user_id <> uid;
  END IF;

  RETURN jsonb_build_object('lifecycle', next_life, 'kept_live', keep_live);
END;
$$;
GRANT EXECUTE ON FUNCTION public.log_incident_outcome(uuid, uuid, uuid, text, boolean, timestamptz) TO authenticated;

-- Per-chaser decline: clears their board only, incident stays live for others.
CREATE OR REPLACE FUNCTION public.decline_incident_with_reason(_incident_id uuid, _reason text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE uid uuid := auth.uid();
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  INSERT INTO public.incident_dispatches (incident_id, user_id, tier, responded_at, response, decline_reason)
  VALUES (_incident_id, uid,
          COALESCE((SELECT escalation_tier FROM public.incidents WHERE id = _incident_id), 0),
          now(), 'declined', nullif(btrim(coalesce(_reason,'')), ''))
  ON CONFLICT (incident_id, user_id) DO UPDATE
    SET response = 'declined', responded_at = now(), decline_reason = EXCLUDED.decline_reason;
END;
$$;
GRANT EXECUTE ON FUNCTION public.decline_incident_with_reason(uuid, text) TO authenticated;

-- 24 hours with no response is its own state, not a decline.
CREATE OR REPLACE FUNCTION public.expire_stale_dispatches()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n integer;
BEGIN
  WITH expired AS (
    UPDATE public.incident_dispatches
       SET response = 'no_action', responded_at = now()
     WHERE response = 'pending' AND notified_at < now() - interval '24 hours'
    RETURNING id
  ) SELECT count(*) INTO n FROM expired;
  RETURN n;
END;
$$;
GRANT EXECUTE ON FUNCTION public.expire_stale_dispatches() TO authenticated;