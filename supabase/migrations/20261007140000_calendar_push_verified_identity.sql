-- Calendar push: give every pushable event a verified identity, so the worker
-- can let the database decide (calendar_push_authorized_event) without that
-- stopping every push.
--
-- WRITTEN, NOT APPLIED. Re-runnable: every statement is idempotent and the
-- backfill only touches rows that still need it.
--
-- ---------------------------------------------------------------------------
-- 1. Why
-- ---------------------------------------------------------------------------
-- 20260908012000 added the guard: trigger z_guard_calendar_push_identity and
-- calendar_push_authorized_event(), which refuses any row whose
-- push_identity_verified is not true. #328 kept the worker off that function
-- because nothing on the server ever set the flag. This file and the PR that
-- carries it settle what "verified" means for each way an event is born, and
-- set it there:
--
--   origin                              verified when                     set by
--   ----------------------------------  --------------------------------  -----------------------
--   synced from Outlook (ingestEvents)  the sync wrote mailbox_id +        the sync (service role),
--                                       external_id from the mailbox it    on every upsert
--                                       just read                          (push_actor_id untouched)
--   meeting booked in the app           assertCanSendAs passed for that    createGraphMeeting:
--   (createGraphMeeting)                mailbox and Graph made the id      verified + push_actor_id
--                                       there                              = the session user
--   created in the CRM calendar         always: it has no provider         the trigger (as before):
--   (client insert)                     identity to forge, and the actor   verified, push_actor_id
--                                       is the session user                = auth.uid()
--   edited in the CRM (client update)   unchanged; identity is immutable   the trigger: push_actor_id
--                                                                          = auth.uid()
--   pushed as a new Outlook event       the mailbox came from this         the worker, on success
--   (worker create)                     function and Graph made the id
--
-- The function then authorises the push against push_actor_id: their own
-- mailbox, a shared office mailbox for a location they manage, or any mailbox
-- for owner/admin/dev -- the same three doors as assertCanSendAs.
--
-- ---------------------------------------------------------------------------
-- 2. What this changes on live
-- ---------------------------------------------------------------------------
-- (a) calendar_events.provider loses its DEFAULT 'outlook'. A local event has
--     no provider. With the default, every calendar insert from the CRM
--     arrives at the guard with provider = 'outlook' and is refused
--     ("Provider identities are server managed"), so creating an event in the
--     calendar has failed since the guard went live; and #328's worker, and
--     the function, refuse a never-pushed row that has a provider. The app now
--     sends provider: null as well, so this is not the only fix, but replays
--     and any other writer get the right default.
-- (b) Rows that got provider only from that default -- provider set, and no
--     external_id, mailbox_id or organizer_email -- are local events: provider
--     is set back to NULL. Live on 2026-10-07: 1 row.
-- (c) Rows with no provider identity at all (provider, external_id,
--     mailbox_id and organizer_email all NULL) are marked verified. They hold
--     nothing a client could have forged that the function trusts: the
--     mailbox is chosen from user_id/location_id and then checked against the
--     actor. push_actor_id is NOT backfilled -- before the guard, created_by
--     was whatever the client sent, so it is no proof of who acted. The next
--     edit in the CRM stamps the real actor (the same edit that queues a
--     push). Live: 1 row (the row from (b)); it has no attendees, so the
--     worker settles it without asking Outlook anything.
-- (d) Rows that carry a provider identity are left exactly as they are.
--     Unverified ones become verified the next time the sync reads them (the
--     upsert sets the flag); one the sync never sees again stays unpushable,
--     which is what 20260908012000 asked for ("re-ingest them from Graph").
--     Live: 8 rows, all is_demo seed rows with an external_id and no mailbox,
--     which the worker never pushes. 0 rows with a mailbox: live has no
--     connected Microsoft 365 mailbox at all.
-- (e) calendar_push_authorized_event() is replaced with the same rules and
--     clearer refusals. One is new: a never-pushed event for which no mailbox
--     exists at all raises SQLSTATE P0002 ("No connected mailbox for this
--     event") instead of the generic refusal, so the worker can keep its old
--     answer for that case -- the event stays in Recovery Hub only -- rather
--     than retrying it five times into the error list. Every other refusal is
--     still 42501. Grants as live: EXECUTE to service_role only.
--
-- Not changed: the trigger function guard_calendar_push_identity() (its body
-- already does what the table above says for client writes; service-role
-- writes are the server's own attestation), RLS, grants on the table.
--
-- The proof is supabase/tests/calendar-push-verified.pglite.mjs.

BEGIN;

-- (a)
ALTER TABLE public.calendar_events ALTER COLUMN provider DROP DEFAULT;

-- (b) and (c). A repair is not an edit: it must not bump updated_at (the
-- push queue is ordered by it) or re-run stage auto-advance for the linked
-- account. Both triggers come back on before COMMIT.
ALTER TABLE public.calendar_events DISABLE TRIGGER calendar_events_updated_at;
ALTER TABLE public.calendar_events DISABLE TRIGGER trg_stage_advance_calendar;

UPDATE public.calendar_events
   SET provider = NULL
 WHERE provider IS NOT NULL
   AND external_id IS NULL
   AND mailbox_id IS NULL
   AND organizer_email IS NULL;

UPDATE public.calendar_events
   SET push_identity_verified = true
 WHERE push_identity_verified IS NOT TRUE
   AND provider IS NULL
   AND external_id IS NULL
   AND mailbox_id IS NULL
   AND organizer_email IS NULL;

ALTER TABLE public.calendar_events ENABLE TRIGGER calendar_events_updated_at;
ALTER TABLE public.calendar_events ENABLE TRIGGER trg_stage_advance_calendar;

-- (e)
CREATE OR REPLACE FUNCTION public.calendar_push_authorized_event(_event_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE e public.calendar_events; m public.graph_mailboxes; actor uuid; privileged boolean;
BEGIN
  -- The verified flag means nothing unless the guard that maintains it is the
  -- one attached and enabled.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.calendar_events'::regclass
      AND tgname = 'z_guard_calendar_push_identity' AND tgenabled IN ('O', 'A')
      AND tgfoid = 'public.guard_calendar_push_identity()'::regprocedure
      AND tgtype = 23 AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'Calendar integrity guard is unavailable' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO e FROM public.calendar_events WHERE id = _event_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Calendar event not found' USING ERRCODE = '42501';
  END IF;
  IF e.sync_state IS DISTINCT FROM 'pending_push' THEN
    RAISE EXCEPTION 'Calendar event is not waiting to be pushed' USING ERRCODE = '42501';
  END IF;
  IF e.push_identity_verified IS NOT TRUE THEN
    RAISE EXCEPTION 'Calendar push is not verified: its Outlook identity was never confirmed by a sync'
      USING ERRCODE = '42501';
  END IF;
  IF e.push_actor_id IS NULL THEN
    RAISE EXCEPTION 'Calendar push is not verified: nobody signed in has edited it since it was recorded'
      USING ERRCODE = '42501';
  END IF;
  actor := e.push_actor_id;
  IF NOT EXISTS (SELECT 1 FROM public.profiles
    WHERE user_id = actor AND is_active = true AND approval_status = 'approved') THEN
    RAISE EXCEPTION 'Calendar editor is inactive or not approved' USING ERRCODE = '42501';
  END IF;
  privileged := public.has_role(actor, 'owner') OR public.has_role(actor, 'admin')
    OR public.has_role(actor, 'dev');
  IF e.mailbox_id IS NOT NULL THEN
    -- An event that has a home never moves, whatever state that home is in.
    SELECT * INTO m FROM public.graph_mailboxes WHERE id = e.mailbox_id;
  ELSIF e.external_id IS NOT NULL OR e.provider IS NOT NULL THEN
    RAISE EXCEPTION 'Provider event has no verified mailbox' USING ERRCODE = '42501';
  ELSE
    -- Only own mailboxes or genuinely shared office mailboxes are candidates.
    SELECT * INTO m FROM public.graph_mailboxes
      WHERE enabled AND sync_calendar AND
        (user_id = e.user_id OR (user_id IS NULL AND location_id = e.location_id))
      ORDER BY (user_id = e.user_id) DESC NULLS LAST, id LIMIT 1;
    IF m.id IS NULL THEN
      RAISE EXCEPTION 'No connected mailbox for this event' USING ERRCODE = 'P0002';
    END IF;
  END IF;
  IF m.id IS NULL THEN
    RAISE EXCEPTION 'The mailbox this event belongs to is no longer connected' USING ERRCODE = '42501';
  END IF;
  IF m.enabled IS NOT TRUE OR m.sync_calendar IS NOT TRUE THEN
    RAISE EXCEPTION 'The mailbox this event belongs to is disabled or has calendar sync off'
      USING ERRCODE = '42501';
  END IF;
  IF (
    m.user_id = actor OR privileged OR
    (m.user_id IS NULL AND m.location_id IS NOT NULL
      AND public.can_manage_location(actor, m.location_id))
  ) IS NOT TRUE THEN
    RAISE EXCEPTION 'Calendar editor cannot act as this mailbox' USING ERRCODE = '42501';
  END IF;
  RETURN jsonb_build_object('row', to_jsonb(e), 'mailbox', jsonb_build_object('id', m.id, 'upn', m.upn));
END;
$$;
REVOKE ALL ON FUNCTION public.calendar_push_authorized_event(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.calendar_push_authorized_event(uuid) TO service_role;

COMMIT;
