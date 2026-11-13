ALTER TABLE public.intake_requests
  ADD COLUMN IF NOT EXISTS standing boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS intake_requests_one_live_standing_per_user
  ON public.intake_requests (created_by)
  WHERE standing AND revoked_at IS NULL;
ALTER TABLE public.intake_requests DROP CONSTRAINT IF EXISTS intake_requests_standing_is_general;
ALTER TABLE public.intake_requests
  ADD CONSTRAINT intake_requests_standing_is_general CHECK (
    NOT standing
    OR (job_id IS NULL AND location_id IS NULL AND tradeshow_id IS NULL
        AND multi_use AND created_by IS NOT NULL)
  );
CREATE OR REPLACE FUNCTION public.my_standing_intake_link()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _uid uuid := auth.uid();
  _token text;
BEGIN
  IF _uid IS NULL OR NOT public.is_employee(_uid) THEN
    RAISE EXCEPTION 'Only an active employee can have an intake link.' USING ERRCODE = '42501';
  END IF;
  SELECT r.token INTO _token
  FROM public.intake_requests r
  WHERE r.created_by = _uid AND r.standing AND r.revoked_at IS NULL
    AND r.expires_at > now()
  LIMIT 1;
  IF _token IS NOT NULL THEN
    RETURN _token;
  END IF;
  UPDATE public.intake_requests SET revoked_at = now()
  WHERE created_by = _uid AND standing AND revoked_at IS NULL;
  INSERT INTO public.intake_requests
    (job_id, location_id, tradeshow_id, multi_use, standing, label, expires_at, created_by)
  VALUES
    (NULL, NULL, NULL, true, true, 'Standing link', now() + interval '10 years', _uid)
  RETURNING token INTO _token;
  RETURN _token;
END;
$$;
CREATE OR REPLACE FUNCTION public.rotate_my_standing_intake_link()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _uid uuid := auth.uid();
BEGIN
  IF _uid IS NULL OR NOT public.is_employee(_uid) THEN
    RAISE EXCEPTION 'Only an active employee can have an intake link.' USING ERRCODE = '42501';
  END IF;
  UPDATE public.intake_requests SET revoked_at = now()
  WHERE created_by = _uid AND standing AND revoked_at IS NULL;
  RETURN public.my_standing_intake_link();
END;
$$;
REVOKE ALL ON FUNCTION public.my_standing_intake_link() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rotate_my_standing_intake_link() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_standing_intake_link() TO authenticated;
GRANT EXECUTE ON FUNCTION public.rotate_my_standing_intake_link() TO authenticated;