-- Calendar: allow locally created events, richer typing and record links.
ALTER TABLE public.calendar_events
  ALTER COLUMN provider DROP NOT NULL,
  ALTER COLUMN external_id DROP NOT NULL;

ALTER TABLE public.calendar_events
  ADD COLUMN IF NOT EXISTS event_type text NOT NULL DEFAULT 'meeting',
  ADD COLUMN IF NOT EXISTS job_id uuid REFERENCES public.jobs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS location_id uuid REFERENCES public.locations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS created_by uuid,
  ADD COLUMN IF NOT EXISTS sync_direction text NOT NULL DEFAULT 'local',
  ADD COLUMN IF NOT EXISTS sync_state text NOT NULL DEFAULT 'clean',
  ADD COLUMN IF NOT EXISTS notes text;

DO $$ BEGIN
  ALTER TABLE public.calendar_events
    ADD CONSTRAINT calendar_events_event_type_chk
    CHECK (event_type IN ('meeting','inspection','job','task','tradeshow','shift','other'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.calendar_events
    ADD CONSTRAINT calendar_events_sync_direction_chk
    CHECK (sync_direction IN ('local','inbound','outbound','two_way'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.calendar_events
    ADD CONSTRAINT calendar_events_sync_state_chk
    CHECK (sync_state IN ('clean','pending_push','pushed','error'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS calendar_events_starts_at_idx ON public.calendar_events (starts_at);
CREATE INDEX IF NOT EXISTS calendar_events_job_idx ON public.calendar_events (job_id);
CREATE INDEX IF NOT EXISTS calendar_events_account_idx ON public.calendar_events (account_id);

-- Rows already in the table came from Outlook.
UPDATE public.calendar_events SET sync_direction = 'inbound' WHERE provider IS NOT NULL AND sync_direction = 'local';

GRANT SELECT, INSERT, UPDATE, DELETE ON public.calendar_events TO authenticated;
GRANT ALL ON public.calendar_events TO service_role;

DROP POLICY IF EXISTS "calendar insert own" ON public.calendar_events;
CREATE POLICY "calendar insert own" ON public.calendar_events
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = (SELECT auth.uid())
    OR is_privileged((SELECT auth.uid()))
    OR has_role((SELECT auth.uid()), 'location_manager'::app_role)
    OR has_role((SELECT auth.uid()), 'sales_manager'::app_role)
  );

DROP POLICY IF EXISTS "calendar update own" ON public.calendar_events;
CREATE POLICY "calendar update own" ON public.calendar_events
  FOR UPDATE TO authenticated
  USING (
    user_id = (SELECT auth.uid())
    OR created_by = (SELECT auth.uid())
    OR is_privileged((SELECT auth.uid()))
    OR has_role((SELECT auth.uid()), 'location_manager'::app_role)
    OR has_role((SELECT auth.uid()), 'sales_manager'::app_role)
  )
  WITH CHECK (true);

DROP POLICY IF EXISTS "calendar delete own" ON public.calendar_events;
CREATE POLICY "calendar delete own" ON public.calendar_events
  FOR DELETE TO authenticated
  USING (
    user_id = (SELECT auth.uid())
    OR created_by = (SELECT auth.uid())
    OR is_privileged((SELECT auth.uid()))
  );

-- Calls: the in-app dialer needs to be able to write its own log rows.
GRANT SELECT, INSERT, UPDATE ON public.captured_communications TO authenticated;
GRANT ALL ON public.captured_communications TO service_role;

DROP POLICY IF EXISTS captured_comms_insert ON public.captured_communications;
CREATE POLICY captured_comms_insert ON public.captured_communications
  FOR INSERT TO authenticated
  WITH CHECK (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS captured_comms_update ON public.captured_communications;
CREATE POLICY captured_comms_update ON public.captured_communications
  FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid()) OR is_privileged((SELECT auth.uid())))
  WITH CHECK (true);