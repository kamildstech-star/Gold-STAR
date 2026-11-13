-- Existing references are not grandfathered in: re-ingest them from Graph.
-- Deploy before the worker. An older schema makes the new worker fail closed.
BEGIN;
ALTER TABLE public.calendar_events
  ADD COLUMN push_identity_verified boolean NOT NULL DEFAULT false,
  ADD COLUMN push_actor_id uuid;

CREATE FUNCTION public.guard_calendar_push_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE actor uuid := auth.uid();
BEGIN
  -- Only the server may attest a provider identity. Never infer trust from a
  -- bookkeeping update: legacy rows remain false until explicitly verified.
  IF current_user IN ('service_role', 'postgres', 'supabase_admin') THEN
    RETURN NEW;
  END IF;
  IF actor IS NULL THEN
    RAISE EXCEPTION 'Calendar identity requires authentication' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.provider IS NOT NULL OR NEW.external_id IS NOT NULL
       OR NEW.mailbox_id IS NOT NULL OR NEW.organizer_email IS NOT NULL THEN
      RAISE EXCEPTION 'Provider identities are server managed' USING ERRCODE = '42501';
    END IF;
    NEW.created_by := actor;
    NEW.push_identity_verified := true;
  ELSE
    IF ROW(NEW.provider, NEW.external_id, NEW.mailbox_id, NEW.organizer_email,
           NEW.user_id, NEW.location_id, NEW.created_by)
       IS DISTINCT FROM
       ROW(OLD.provider, OLD.external_id, OLD.mailbox_id, OLD.organizer_email,
           OLD.user_id, OLD.location_id, OLD.created_by) THEN
      RAISE EXCEPTION 'Calendar identity and ownership are immutable' USING ERRCODE = '42501';
    END IF;
    NEW.push_identity_verified := OLD.push_identity_verified;
  END IF;
  -- Caller-supplied attribution is never used for privileged mailbox access.
  NEW.push_actor_id := actor;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_calendar_push_identity() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER z_guard_calendar_push_identity BEFORE INSERT OR UPDATE
  ON public.calendar_events FOR EACH ROW EXECUTE FUNCTION public.guard_calendar_push_identity();

-- Read a fresh, verified snapshot and authorize the recorded editor against
-- the current mailbox registry. The worker never resolves an organizer string.
CREATE FUNCTION public.calendar_push_authorized_event(_event_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE e public.calendar_events; m public.graph_mailboxes; actor uuid; privileged boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.calendar_events'::regclass
      AND tgname = 'z_guard_calendar_push_identity' AND tgenabled IN ('O', 'A')
      AND tgfoid = 'public.guard_calendar_push_identity()'::regprocedure
      AND tgtype = 23 AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'Calendar integrity guard is unavailable' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO e FROM public.calendar_events WHERE id = _event_id;
  IF NOT FOUND OR e.push_identity_verified IS NOT TRUE OR e.sync_state IS DISTINCT FROM 'pending_push'
     OR e.push_actor_id IS NULL THEN
    RAISE EXCEPTION 'Calendar push is not verified' USING ERRCODE = '42501';
  END IF;
  actor := e.push_actor_id;
  IF NOT EXISTS (SELECT 1 FROM public.profiles
    WHERE user_id = actor AND is_active = true AND approval_status = 'approved') THEN
    RAISE EXCEPTION 'Calendar editor is inactive or not approved' USING ERRCODE = '42501';
  END IF;
  privileged := public.has_role(actor, 'owner') OR public.has_role(actor, 'admin')
    OR public.has_role(actor, 'dev');
  IF e.mailbox_id IS NOT NULL THEN
    SELECT * INTO m FROM public.graph_mailboxes WHERE id = e.mailbox_id;
  ELSIF e.external_id IS NOT NULL OR e.provider IS NOT NULL THEN
    RAISE EXCEPTION 'Provider event has no verified mailbox' USING ERRCODE = '42501';
  ELSE
    -- Only own mailboxes or genuinely shared office mailboxes are candidates.
    SELECT * INTO m FROM public.graph_mailboxes
      WHERE enabled AND sync_calendar AND
        (user_id = e.user_id OR (user_id IS NULL AND location_id = e.location_id))
      ORDER BY (user_id = e.user_id) DESC NULLS LAST, id LIMIT 1;
  END IF;
  IF m.id IS NULL OR m.enabled IS NOT TRUE OR m.sync_calendar IS NOT TRUE OR (
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
