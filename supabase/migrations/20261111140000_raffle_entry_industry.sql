-- Raffle entry form, 11 Nov redesign: "Full Name" in one box and an
-- Industry dropdown.
--
-- One name box means a visitor may type a single word ("Cher"), so the last
-- name may now be empty; the form splits "Pat van der Berg" into first word
-- and the rest. Industry is a short label picked from a fixed list on the
-- form (src/lib/raffles.ts RAFFLE_INDUSTRIES); the database only bounds its
-- length so the list can change without a migration.

ALTER TABLE public.tradeshow_raffle_entries
  DROP CONSTRAINT IF EXISTS tradeshow_raffle_entries_last_name_check;
ALTER TABLE public.tradeshow_raffle_entries
  ADD CONSTRAINT tradeshow_raffle_entries_last_name_check
    CHECK (length(btrim(last_name)) <= 80);

ALTER TABLE public.tradeshow_raffle_entries
  ADD COLUMN IF NOT EXISTS industry text
    CHECK (industry IS NULL OR length(industry) <= 80);

COMMENT ON COLUMN public.tradeshow_raffle_entries.industry IS
  'Picked from the entry form''s Industry dropdown; free text so the list can change.';

CREATE OR REPLACE FUNCTION public.raffle_public_enter(_token text, _entry jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _r public.tradeshow_raffles;
  _first text := nullif(btrim(_entry->>'first_name'), '');
  _last text := nullif(btrim(_entry->>'last_name'), '');
  _email text := lower(nullif(btrim(_entry->>'email'), ''));
  _phone text := nullif(btrim(_entry->>'phone'), '');
  _company text := nullif(btrim(_entry->>'company'), '');
  _title text := nullif(btrim(_entry->>'job_title'), '');
  _industry text := nullif(btrim(_entry->>'industry'), '');
BEGIN
  -- Locked: the cap is counted and the entry written as one step.
  SELECT * INTO _r FROM public.tradeshow_raffles WHERE token = _token FOR UPDATE;
  IF NOT FOUND OR _r.status = 'draft' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;
  IF NOT public.raffle_is_open(_r) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'closed');
  END IF;
  IF _first IS NULL OR _email IS NULL
     OR _email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'
     OR (_r.require_phone AND _phone IS NULL)
     OR coalesce((_entry->>'consent_terms')::boolean, false) IS NOT TRUE THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid');
  END IF;
  IF EXISTS (SELECT 1 FROM public.tradeshow_raffle_entries
              WHERE raffle_id = _r.id AND lower(btrim(email)) = _email) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'duplicate');
  END IF;
  IF _r.max_entries IS NOT NULL
     AND (SELECT count(*) FROM public.tradeshow_raffle_entries
           WHERE raffle_id = _r.id) >= _r.max_entries THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'full');
  END IF;

  BEGIN
    INSERT INTO public.tradeshow_raffle_entries
      (raffle_id, first_name, last_name, email, phone, company, job_title,
       industry, consent_terms, consent_marketing)
    VALUES
      (_r.id, left(_first, 80), coalesce(left(_last, 80), ''), left(_email, 254),
       CASE WHEN _r.ask_phone THEN left(_phone, 40) END,
       CASE WHEN _r.ask_company THEN left(_company, 160) END,
       CASE WHEN _r.ask_company THEN left(_title, 120) END,
       left(_industry, 80),
       true, coalesce((_entry->>'consent_marketing')::boolean, false));
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'duplicate');
  END;
  RETURN jsonb_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION public.raffle_public_enter(text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.raffle_public_enter(text, jsonb) TO service_role;
