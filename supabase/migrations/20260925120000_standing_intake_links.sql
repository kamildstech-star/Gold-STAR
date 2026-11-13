-- Standing intake links: one reusable link per person, routed by address.
--
-- David, 22 Sep: "the link shouldn't be a one-time link... I want to be able
-- to have this link saved and constantly just paste it... if one of the field
-- guys gets a phone call about a job, they could just send a link — not go
-- into the system, create a link, then send." And: "one link that
-- automatically chooses the office based on the location they're reporting."
--
-- The general link (20260903223000) already does the routing half: no job, no
-- office, no show, multi-use, and each submission lands at the office matching
-- the address. What it could not do was belong to a field tech. Minting one is
-- privileged-only under the intake_requests RLS, and reading one back is too,
-- because a request with no office has nothing else to scope it by.
--
-- So each employee gets their OWN standing link rather than one company link
-- in everybody's phone notes. It is still "one link" from where they stand,
-- and it keeps the security shape honest:
--   * a person who leaves takes nothing with them — the public side refuses a
--     standing link whose owner is no longer active (intake-public.functions);
--   * one leaked link is rotated by its owner without breaking everyone
--     else's copy;
--   * the submission says whose link it came through (created_by).
--
-- The RLS on intake_requests is NOT widened. The two functions below are the
-- only way a non-privileged user touches a standing row, each checks the
-- caller itself, and each only ever sees the caller's own link. Revoking any
-- standing link as an admin is the existing privileged write.
--
-- Rate limiting is unchanged and shared: the standing link is an ordinary
-- intake_requests token, so the public read, submit, photo upload and address
-- lookup apply exactly the limits every other intake link gets.

ALTER TABLE public.intake_requests
  ADD COLUMN IF NOT EXISTS standing boolean NOT NULL DEFAULT false;

-- At most one live standing link per person; a rotation revokes before it mints.
CREATE UNIQUE INDEX IF NOT EXISTS intake_requests_one_live_standing_per_user
  ON public.intake_requests (created_by)
  WHERE standing AND revoked_at IS NULL;

-- A standing link is a general link: no job, no office, no show, multi-use.
ALTER TABLE public.intake_requests DROP CONSTRAINT IF EXISTS intake_requests_standing_is_general;
ALTER TABLE public.intake_requests
  ADD CONSTRAINT intake_requests_standing_is_general CHECK (
    NOT standing
    OR (job_id IS NULL AND location_id IS NULL AND tradeshow_id IS NULL
        AND multi_use AND created_by IS NOT NULL)
  );

-- The caller's live standing link, created on first ask. Returns the token.
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
  -- SECURITY DEFINER bypasses RLS, so the access check is here: an active
  -- employee, and nobody else, gets a link.
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

  -- An expired one (ten years on) is revoked so the unique index lets the new one in.
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

-- Throw the caller's current link away and hand back a new one. The old copy
-- stops working on the next load of the form.
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
