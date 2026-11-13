
-- 1. Touchpoints: auto-capture provenance + cadence determination
DO $$ BEGIN
  CREATE TYPE public.capture_source AS ENUM ('dialer','mailbox','calendar','sms','voice_note','manual','gift_engine');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.comm_direction AS ENUM ('outbound','inbound','not_applicable');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE public.touchpoints
  ADD COLUMN IF NOT EXISTS capture_source public.capture_source NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS direction public.comm_direction NOT NULL DEFAULT 'not_applicable',
  ADD COLUMN IF NOT EXISTS is_self_reported boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS duration_seconds integer,
  ADD COLUMN IF NOT EXISTS replied_at timestamptz,
  ADD COLUMN IF NOT EXISTS meeting_held boolean,
  ADD COLUMN IF NOT EXISTS external_ref text,
  ADD COLUMN IF NOT EXISTS counts_toward_cadence boolean NOT NULL DEFAULT false;

-- A cold email or text with no response is not a touchpoint.
CREATE OR REPLACE FUNCTION public.tg_touchpoint_cadence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.is_self_reported := (NEW.capture_source = 'manual');

  IF NEW.direction = 'inbound' THEN
    NEW.counts_toward_cadence := true;
  ELSIF NEW.type IN ('meeting_in_person','meeting_virtual') THEN
    -- calendar-derived meetings count when held; manual ones count unless marked not held
    NEW.counts_toward_cadence := COALESCE(NEW.meeting_held, NEW.capture_source <> 'calendar');
  ELSIF NEW.type = 'call' THEN
    NEW.counts_toward_cadence := COALESCE(NEW.duration_seconds, 0) >= 30 OR NEW.replied_at IS NOT NULL;
  ELSIF NEW.type IN ('email','seasonal_send','gift','other') THEN
    NEW.counts_toward_cadence := NEW.replied_at IS NOT NULL;
  ELSE
    NEW.counts_toward_cadence := NEW.replied_at IS NOT NULL;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_touchpoint_cadence ON public.touchpoints;
CREATE TRIGGER trg_touchpoint_cadence
  BEFORE INSERT OR UPDATE ON public.touchpoints
  FOR EACH ROW EXECUTE FUNCTION public.tg_touchpoint_cadence();

UPDATE public.touchpoints SET id = id;

-- 2. Account notes: pinned to top, or triggered by a future event
DO $$ BEGIN
  CREATE TYPE public.note_trigger AS ENUM ('none','next_call','next_meeting','next_stage_change','on_date');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.account_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  body text NOT NULL,
  is_pinned boolean NOT NULL DEFAULT false,
  trigger_type public.note_trigger NOT NULL DEFAULT 'none',
  trigger_on date,
  fired_at timestamptz,
  acknowledged_at timestamptz,
  acknowledged_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.account_notes TO authenticated;
GRANT ALL ON public.account_notes TO service_role;
ALTER TABLE public.account_notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY account_notes_select ON public.account_notes FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = account_id
  AND (public.can_view_location(auth.uid(), a.location_id) OR a.assigned_rep = auth.uid() OR a.created_by = auth.uid())));

CREATE POLICY account_notes_insert ON public.account_notes FOR INSERT TO authenticated
WITH CHECK (created_by = auth.uid() AND EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = account_id
  AND (public.can_view_location(auth.uid(), a.location_id) OR a.assigned_rep = auth.uid() OR a.created_by = auth.uid())));

CREATE POLICY account_notes_update ON public.account_notes FOR UPDATE TO authenticated
USING (created_by = auth.uid() OR public.is_privileged(auth.uid())
  OR EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = account_id AND public.can_manage_location(auth.uid(), a.location_id)));

CREATE POLICY account_notes_delete ON public.account_notes FOR DELETE TO authenticated
USING (created_by = auth.uid() OR public.is_privileged(auth.uid()));

CREATE INDEX IF NOT EXISTS account_notes_account_idx ON public.account_notes (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS account_notes_pending_idx ON public.account_notes (trigger_type) WHERE fired_at IS NULL AND trigger_type <> 'none';

CREATE TRIGGER trg_account_notes_updated BEFORE UPDATE ON public.account_notes
  FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();

-- 3. Call recording consent, per state. Never a global switch.
CREATE TABLE IF NOT EXISTS public.recording_consent_rules (
  state_code text PRIMARY KEY,
  state_name text NOT NULL,
  consent_type text NOT NULL CHECK (consent_type IN ('one_party','all_party','unclear')),
  requires_spoken_disclosure boolean NOT NULL DEFAULT true,
  disclosure_text text NOT NULL,
  notes text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.recording_consent_rules TO authenticated;
GRANT ALL ON public.recording_consent_rules TO service_role;
ALTER TABLE public.recording_consent_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY recording_rules_select ON public.recording_consent_rules FOR SELECT TO authenticated USING (true);
CREATE POLICY recording_rules_write ON public.recording_consent_rules FOR ALL TO authenticated
USING (public.is_privileged(auth.uid())) WITH CHECK (public.is_privileged(auth.uid()));

INSERT INTO public.recording_consent_rules (state_code, state_name, consent_type, requires_spoken_disclosure, disclosure_text, notes) VALUES
 ('CA','California','all_party',true,'This call is being recorded for quality and training purposes. Do you consent to being recorded?','All-party consent. Verbal consent must be captured on the recording.'),
 ('MI','Michigan','all_party',true,'This call is being recorded for quality and training purposes. Do you consent to being recorded?','Treated as all-party for participant recording; take consent.'),
 ('PA','Pennsylvania','all_party',true,'This call is being recorded for quality and training purposes. Do you consent to being recorded?','All-party consent.'),
 ('MD','Maryland','all_party',true,'This call is being recorded for quality and training purposes. Do you consent to being recorded?','All-party consent.'),
 ('MA','Massachusetts','all_party',true,'This call is being recorded for quality and training purposes. Do you consent to being recorded?','All-party consent.'),
 ('IL','Illinois','all_party',true,'This call is being recorded for quality and training purposes. Do you consent to being recorded?','All-party consent for private conversations.'),
 ('FL','Florida','all_party',true,'This call is being recorded for quality and training purposes. Do you consent to being recorded?','All-party consent.'),
 ('WA','Washington','all_party',true,'This call is being recorded for quality and training purposes. Do you consent to being recorded?','All-party consent.'),
 ('CT','Connecticut','all_party',true,'This call is being recorded for quality and training purposes. Do you consent to being recorded?','All-party for civil liability.'),
 ('DE','Delaware','all_party',true,'This call is being recorded for quality and training purposes. Do you consent to being recorded?','All-party consent.'),
 ('NH','New Hampshire','all_party',true,'This call is being recorded for quality and training purposes. Do you consent to being recorded?','All-party consent.'),
 ('MT','Montana','all_party',true,'This call is being recorded for quality and training purposes. Do you consent to being recorded?','Notification required.'),
 ('NV','Nevada','all_party',true,'This call is being recorded for quality and training purposes. Do you consent to being recorded?','All-party for telephone calls.'),
 ('OR','Oregon','unclear',true,'This call is being recorded for quality and training purposes.','One-party for phone, all-party for in-person. Disclose.'),
 ('NY','New York','one_party',true,'This call may be recorded for quality and training purposes.','One-party consent; disclosure still recommended.'),
 ('NJ','New Jersey','one_party',true,'This call may be recorded for quality and training purposes.','One-party consent.'),
 ('NC','North Carolina','one_party',true,'This call may be recorded for quality and training purposes.','One-party consent.'),
 ('GA','Georgia','one_party',true,'This call may be recorded for quality and training purposes.','One-party consent.'),
 ('TX','Texas','one_party',true,'This call may be recorded for quality and training purposes.','One-party consent.'),
 ('OH','Ohio','one_party',true,'This call may be recorded for quality and training purposes.','One-party consent.')
ON CONFLICT (state_code) DO NOTHING;

-- 4. Captured communications inbox (dialer / mailbox / sms), the raw side of auto-capture
CREATE TABLE IF NOT EXISTS public.captured_communications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  external_id text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('call','email','sms')),
  direction public.comm_direction NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  duration_seconds integer,
  from_address text,
  to_address text,
  subject text,
  body_preview text,
  outcome text,
  recording_url text,
  recording_consent_state text,
  account_id uuid REFERENCES public.accounts(id) ON DELETE SET NULL,
  contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  touchpoint_id uuid REFERENCES public.touchpoints(id) ON DELETE SET NULL,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, external_id)
);

GRANT SELECT ON public.captured_communications TO authenticated;
GRANT ALL ON public.captured_communications TO service_role;
ALTER TABLE public.captured_communications ENABLE ROW LEVEL SECURITY;

CREATE POLICY captured_comms_select ON public.captured_communications FOR SELECT TO authenticated
USING (user_id = auth.uid() OR EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = account_id
  AND (public.can_view_location(auth.uid(), a.location_id) OR a.assigned_rep = auth.uid())));

CREATE INDEX IF NOT EXISTS captured_comms_account_idx ON public.captured_communications (account_id, occurred_at DESC);
