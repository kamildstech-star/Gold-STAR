-- Let relationship-owning sellers file the account half of a tablet-captured
-- Trade Show lead without granting them general office-management powers.
-- Contacts, touchpoints and media continue through their existing RLS after
-- this function has created an account assigned to the caller.

-- Production may not yet have the later active-profile hardening migration.
-- Keep this migration independently installable while retaining the private,
-- non-PostgREST implementation boundary.
CREATE SCHEMA IF NOT EXISTS goldstar_private;
REVOKE ALL ON SCHEMA goldstar_private FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA goldstar_private TO authenticated, service_role;

CREATE OR REPLACE FUNCTION goldstar_private.capture_tradeshow_lead_account(
  _account_id uuid,
  _tradeshow_id uuid,
  _location_id uuid,
  _name text,
  _captured_at timestamptz,
  _phone text DEFAULT NULL,
  _email text DEFAULT NULL,
  _notes text DEFAULT NULL,
  _lead_source_id uuid DEFAULT NULL,
  _pipeline_id uuid DEFAULT NULL,
  _stage_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  caller uuid := auth.uid();
  existing public.accounts%ROWTYPE;
  saved_id uuid;
BEGIN
  IF caller IS NULL OR NOT EXISTS (
    SELECT 1
     FROM public.profiles p
     WHERE p.user_id = caller
       AND p.is_active = true
       AND p.approval_status = 'approved'
       AND p.deactivated_at IS NULL
  ) THEN
    RAISE EXCEPTION 'An active signed-in user is required.' USING ERRCODE = '42501';
  END IF;

  IF NOT (
    public.has_any_role_text(caller, ARRAY['sales_person', 'sales_rep', 'outside_sales_rep'])
    OR public.can_manage_location(caller, _location_id)
  ) THEN
    RAISE EXCEPTION 'Only a relationship seller or office manager may capture a Trade Show lead.'
      USING ERRCODE = '42501';
  END IF;

  IF NOT public.can_view_location(caller, _location_id) THEN
    RAISE EXCEPTION 'The selected office is outside your access.' USING ERRCODE = '42501';
  END IF;

  IF btrim(coalesce(_name, '')) = '' THEN
    RAISE EXCEPTION 'A lead name is required.' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.tradeshows t
     WHERE t.id = _tradeshow_id
       AND (t.location_id IS NULL OR t.location_id = _location_id)
       AND (t.location_id IS NULL OR public.can_view_location(caller, t.location_id))
  ) THEN
    RAISE EXCEPTION 'The Trade Show is unavailable for the selected office.'
      USING ERRCODE = '42501';
  END IF;

  IF _pipeline_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
      FROM public.pipelines p
     WHERE p.id = _pipeline_id
       AND p.entity_type = 'account'
       AND p.is_active
       AND (p.location_id IS NULL OR p.location_id = _location_id)
  ) THEN
    RAISE EXCEPTION 'The selected account pipeline is unavailable.' USING ERRCODE = '22023';
  END IF;

  IF _stage_id IS NOT NULL AND (
    _pipeline_id IS NULL OR NOT EXISTS (
      SELECT 1
        FROM public.pipeline_stages s
       WHERE s.id = _stage_id
         AND s.pipeline_id = _pipeline_id
         AND s.is_active
         AND NOT s.is_won
         AND NOT s.is_lost
    )
  ) THEN
    RAISE EXCEPTION 'The selected pipeline stage is unavailable.' USING ERRCODE = '22023';
  END IF;

  IF _lead_source_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
      FROM public.option_list_values v
      JOIN public.option_lists l ON l.id = v.option_list_id
     WHERE v.id = _lead_source_id
       AND v.active
       AND l.key = 'lead_source'
  ) THEN
    RAISE EXCEPTION 'The selected lead source is unavailable.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO existing FROM public.accounts WHERE id = _account_id;
  IF FOUND AND (
    existing.created_by IS DISTINCT FROM caller
    OR existing.assigned_rep IS DISTINCT FROM caller
    OR existing.location_id IS DISTINCT FROM _location_id
    OR existing.tradeshow_id IS DISTINCT FROM _tradeshow_id
  ) THEN
    RAISE EXCEPTION 'That account id is already in use.' USING ERRCODE = '23505';
  END IF;

  INSERT INTO public.accounts (
    id, name, location_id, tradeshow_id, lead_source_id, lead_source_detail,
    assigned_rep, created_by, created_at, phone, email, notes, stage_id, pipeline_id
  )
  SELECT
    _account_id, btrim(_name), _location_id, _tradeshow_id, _lead_source_id,
    t.name, caller, caller, _captured_at, nullif(btrim(_phone), ''),
    nullif(btrim(_email), ''), nullif(btrim(_notes), ''), _stage_id, _pipeline_id
  FROM public.tradeshows t
  WHERE t.id = _tradeshow_id
  ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    lead_source_id = EXCLUDED.lead_source_id,
    lead_source_detail = EXCLUDED.lead_source_detail,
    phone = EXCLUDED.phone,
    email = EXCLUDED.email,
    notes = EXCLUDED.notes,
    stage_id = EXCLUDED.stage_id,
    pipeline_id = EXCLUDED.pipeline_id
  WHERE public.accounts.created_by = caller
    AND public.accounts.assigned_rep = caller
    AND public.accounts.location_id = _location_id
    AND public.accounts.tradeshow_id = _tradeshow_id
  RETURNING id INTO saved_id;

  IF saved_id IS NULL THEN
    RAISE EXCEPTION 'The captured lead could not be saved.' USING ERRCODE = '42501';
  END IF;

  -- Keep the existing multi-office serving relation honest for accounts made
  -- through this bypass. A replay is harmless because the pair is unique.
  INSERT INTO public.account_locations (account_id, location_id, created_by)
  VALUES (saved_id, _location_id, caller)
  ON CONFLICT (account_id, location_id) DO NOTHING;

  RETURN saved_id;
END;
$$;

ALTER FUNCTION goldstar_private.capture_tradeshow_lead_account(
  uuid, uuid, uuid, text, timestamptz, text, text, text, uuid, uuid, uuid
) OWNER TO postgres;
REVOKE ALL ON FUNCTION goldstar_private.capture_tradeshow_lead_account(
  uuid, uuid, uuid, text, timestamptz, text, text, text, uuid, uuid, uuid
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION goldstar_private.capture_tradeshow_lead_account(
  uuid, uuid, uuid, text, timestamptz, text, text, text, uuid, uuid, uuid
) TO authenticated, service_role;

-- The exposed wrapper is invoker-rights. The privileged implementation stays
-- in the non-exposed goldstar_private schema and performs every authorization
-- and relationship check itself.
CREATE OR REPLACE FUNCTION public.capture_tradeshow_lead_account(
  _account_id uuid,
  _tradeshow_id uuid,
  _location_id uuid,
  _name text,
  _captured_at timestamptz,
  _phone text DEFAULT NULL,
  _email text DEFAULT NULL,
  _notes text DEFAULT NULL,
  _lead_source_id uuid DEFAULT NULL,
  _pipeline_id uuid DEFAULT NULL,
  _stage_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT goldstar_private.capture_tradeshow_lead_account(
    _account_id, _tradeshow_id, _location_id, _name, _captured_at,
    _phone, _email, _notes, _lead_source_id, _pipeline_id, _stage_id
  );
$$;

REVOKE ALL ON FUNCTION public.capture_tradeshow_lead_account(
  uuid, uuid, uuid, text, timestamptz, text, text, text, uuid, uuid, uuid
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.capture_tradeshow_lead_account(
  uuid, uuid, uuid, text, timestamptz, text, text, text, uuid, uuid, uuid
) TO authenticated, service_role;
