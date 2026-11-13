CREATE TABLE IF NOT EXISTS public.client_operations (
  idempotency_key text PRIMARY KEY,
  user_id uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb,
  client_created_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT ON public.client_operations TO authenticated;
GRANT ALL ON public.client_operations TO service_role;

ALTER TABLE public.client_operations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own client operations" ON public.client_operations
  FOR SELECT TO authenticated USING (user_id = auth.uid());

CREATE INDEX IF NOT EXISTS client_operations_user_idx ON public.client_operations (user_id, created_at DESC);

-- Applies one queued offline operation exactly once. The key is inserted in the
-- same transaction as the work, so a retry after a dropped response replays the
-- stored result instead of creating a second lead, outcome or arrival.
CREATE OR REPLACE FUNCTION public.apply_offline_op(
  _key text,
  _kind text,
  _payload jsonb,
  _client_created_at timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _existing jsonb;
  _uid uuid := auth.uid();
  _res jsonb;
BEGIN
  IF _uid IS NULL THEN
    RAISE EXCEPTION 'Not signed in';
  END IF;

  SELECT result INTO _existing
  FROM public.client_operations
  WHERE idempotency_key = _key;

  IF FOUND THEN
    RETURN jsonb_build_object('duplicate', true, 'result', _existing);
  END IF;

  IF _kind = 'outcome' THEN
    _res := to_jsonb(public.log_incident_outcome(
      (_payload->>'incidentId')::uuid,
      (_payload->>'reasonId')::uuid,
      NULLIF(_payload->>'subReasonId','')::uuid,
      NULLIF(_payload->>'subLabel',''),
      NULLIF(_payload->>'note',''),
      COALESCE((_payload->>'worthAnotherTry')::boolean, false),
      NULLIF(_payload->>'revisitAfter','')::timestamptz
    ));
  ELSIF _kind = 'decline' THEN
    PERFORM public.decline_incident_with_reason(
      (_payload->>'incidentId')::uuid,
      NULLIF(_payload->>'reason','')
    );
    _res := jsonb_build_object('ok', true);
  ELSIF _kind = 'exposure' THEN
    _res := to_jsonb(public.create_exposure_incident(
      (_payload->>'originIncidentId')::uuid,
      _payload->>'address',
      NULLIF(_payload->>'lat','')::double precision,
      NULLIF(_payload->>'lon','')::double precision,
      NULLIF(_payload->>'postalCode',''),
      NULLIF(_payload->>'buildingType','')
    ));
  ELSIF _kind = 'arrival' THEN
    _res := to_jsonb(public.stamp_arrival_from_action(
      (_payload->>'incidentId')::uuid,
      COALESCE(_payload->>'action','manual'),
      NULLIF(_payload->>'lat','')::double precision,
      NULLIF(_payload->>'lon','')::double precision,
      NULLIF(_payload->>'accuracyM','')::double precision
    ));
  ELSIF _kind = 'incident_note' THEN
    INSERT INTO public.incident_notes (incident_id, body, created_by)
    VALUES ((_payload->>'incidentId')::uuid, _payload->>'body', _uid);
    _res := jsonb_build_object('ok', true);
  ELSE
    RAISE EXCEPTION 'Unknown offline operation: %', _kind;
  END IF;

  INSERT INTO public.client_operations (idempotency_key, user_id, kind, payload, result, client_created_at)
  VALUES (_key, _uid, _kind, _payload, _res, _client_created_at);

  RETURN jsonb_build_object('duplicate', false, 'result', _res);
END;
$$;

GRANT EXECUTE ON FUNCTION public.apply_offline_op(text, text, jsonb, timestamptz) TO authenticated;