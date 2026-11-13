-- Outbound calendar sync: give the pending_push queue somewhere to record why
-- a row has not reached Microsoft yet.
--
-- sync_state has existed since 20260820085202 and nothing ever read it back,
-- so an edit or a cancellation stopped at our own table. The drain
-- (src/lib/calendar-push.server.ts) needs three more facts per row to retry
-- with backoff instead of hammering the tenant, and to show a human the
-- provider's own words when a row gives up.
--
-- Every read and write of these columns falls back to the older shape, so the
-- queue keeps working until this is applied.

ALTER TABLE public.calendar_events
  ADD COLUMN IF NOT EXISTS sync_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_push_at timestamptz,
  ADD COLUMN IF NOT EXISTS sync_error text;

COMMENT ON COLUMN public.calendar_events.sync_attempts IS
  'Consecutive failed outbound pushes. Reset to 0 on success; at 5 the row goes to sync_state = ''error''.';
COMMENT ON COLUMN public.calendar_events.last_push_at IS
  'When the outbound push was last attempted — the backoff clock.';
COMMENT ON COLUMN public.calendar_events.sync_error IS
  'Microsoft Graph''s own message for the last failed push. Shown on the Microsoft 365 admin screen.';

-- The drain reads the queue oldest-first and the admin screen counts what is
-- stuck; both are sync_state lookups over a table that is otherwise queried by
-- date, so they get their own partial index rather than a full scan.
CREATE INDEX IF NOT EXISTS calendar_events_sync_queue_idx
  ON public.calendar_events (sync_state, updated_at)
  WHERE sync_state IN ('pending_push', 'error');
