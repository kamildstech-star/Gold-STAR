-- Raffles: an optional cap on entries (11 Nov).
--
-- "Max limit of raffle applications — this can be optional." A raffle may set
-- max_entries; empty means no limit, as before. Every entry counts toward the
-- cap, disqualified ones included, so disqualifying someone never reopens a
-- full draw by accident. The check runs inside raffle_public_enter() with the
-- raffle row locked, so two people scanning at the same moment cannot both
-- take the last place. The form learns it is full from raffle_public_load().

ALTER TABLE public.tradeshow_raffles
  ADD COLUMN IF NOT EXISTS max_entries integer
    CHECK (max_entries IS NULL OR max_entries BETWEEN 1 AND 100000);

COMMENT ON COLUMN public.tradeshow_raffles.max_entries IS
  'Optional cap on entries; NULL = unlimited. Enforced by raffle_public_enter().';

GRANT UPDATE (max_entries) ON public.tradeshow_raffles TO authenticated;

CREATE OR REPLACE FUNCTION public.raffle_public_load(_token text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _r public.tradeshow_raffles;
  _show public.tradeshows;
  _full boolean := false;
BEGIN
  SELECT * INTO _r FROM public.tradeshow_raffles WHERE token = _token;
  IF NOT FOUND OR _r.status = 'draft' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;
  IF _r.max_entries IS NOT NULL THEN
    _full := (SELECT count(*) FROM public.tradeshow_raffle_entries
               WHERE raffle_id = _r.id) >= _r.max_entries;
  END IF;
  SELECT * INTO _show FROM public.tradeshows WHERE id = _r.tradeshow_id;
  RETURN jsonb_build_object(
    'ok', true,
    'open', public.raffle_is_open(_r) AND NOT _full,
    'full', _full,
    'title', _r.title,
    'headline', _r.headline,
    'description', _r.description,
    'terms', _r.terms,
    'closes_at', _r.closes_at,
    'ask_phone', _r.ask_phone,
    'require_phone', _r.require_phone,
    'ask_company', _r.ask_company,
    'show_name', _show.name,
    'show_city', _show.city,
    'show_state', _show.state,
    'show_starts_on', _show.starts_on,
    'show_ends_on', _show.ends_on,
    'prizes', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'name', p.name, 'description', p.description,
               'value', p.value, 'quantity', p.quantity)
             ORDER BY p.position, p.created_at)
        FROM public.tradeshow_raffle_prizes p WHERE p.raffle_id = _r.id), '[]'::jsonb)
  );
END;
$$;

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
BEGIN
  -- Locked: the cap is counted and the entry written as one step.
  SELECT * INTO _r FROM public.tradeshow_raffles WHERE token = _token FOR UPDATE;
  IF NOT FOUND OR _r.status = 'draft' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;
  IF NOT public.raffle_is_open(_r) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'closed');
  END IF;
  IF _first IS NULL OR _last IS NULL OR _email IS NULL
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
       consent_terms, consent_marketing)
    VALUES
      (_r.id, left(_first, 80), left(_last, 80), left(_email, 254),
       CASE WHEN _r.ask_phone THEN left(_phone, 40) END,
       CASE WHEN _r.ask_company THEN left(_company, 160) END,
       CASE WHEN _r.ask_company THEN left(_title, 120) END,
       true, coalesce((_entry->>'consent_marketing')::boolean, false));
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'duplicate');
  END;
  RETURN jsonb_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION public.raffle_public_load(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.raffle_public_enter(text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.raffle_public_load(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.raffle_public_enter(text, jsonb) TO service_role;
