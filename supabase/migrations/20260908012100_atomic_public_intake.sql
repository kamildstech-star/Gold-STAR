BEGIN;
-- Called only by the validated public server handler, never by a browser RPC.
-- The lock, submission and consumption are one transaction: an insert failure
-- rolls back consumption, and a concurrent second caller observes submitted_at.
CREATE FUNCTION public.submit_public_intake_atomic(
  _token text, _request_id uuid, _submission jsonb
) RETURNS uuid
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE r public.intake_requests; submission_id uuid; routed_location uuid;
BEGIN
  SELECT * INTO r FROM public.intake_requests
    WHERE token = _token AND id = _request_id FOR UPDATE;
  IF NOT FOUND OR r.revoked_at IS NOT NULL OR r.expires_at IS NULL
     OR r.expires_at <= clock_timestamp()
     OR (r.submitted_at IS NOT NULL AND NOT coalesce(r.multi_use, false)) THEN
    RAISE EXCEPTION 'This intake link is no longer valid or was already submitted.' USING ERRCODE = '22023';
  END IF;
  -- Reject a request whose context changed after the server validated/routed it.
  IF (_submission->>'job_id')::uuid IS DISTINCT FROM r.job_id THEN
    RAISE EXCEPTION 'Intake request changed. Please reload the form.' USING ERRCODE = '22023';
  END IF;
  routed_location := CASE WHEN r.job_id IS NULL AND r.location_id IS NULL AND r.tradeshow_id IS NULL
    THEN (_submission->>'location_id')::uuid ELSE NULL END;
  INSERT INTO public.intake_submissions
    (request_id, job_id, submitted_by_name, submitted_by_email, fields, answers,
     status, location_id, location_auto_assigned, photos)
  VALUES
    (r.id, r.job_id, _submission->>'submitted_by_name', _submission->>'submitted_by_email',
     coalesce(_submission->'fields', '{}'::jsonb), coalesce(_submission->'answers', '{}'::jsonb),
     'pending', routed_location, routed_location IS NOT NULL,
     coalesce(_submission->'photos', '[]'::jsonb))
  RETURNING id INTO submission_id;
  IF NOT coalesce(r.multi_use, false) THEN
    UPDATE public.intake_requests SET submitted_at = clock_timestamp() WHERE id = r.id;
  END IF;
  RETURN submission_id;
END;
$$;
REVOKE ALL ON FUNCTION public.submit_public_intake_atomic(text, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_public_intake_atomic(text, uuid, jsonb) TO service_role;
COMMIT;
