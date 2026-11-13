-- Trade show raffles: a QR code on the booth, a short entry form, a contact
-- list, and a prize draw nobody can rig from the browser.
--
-- Tradeshow > Raffles > Contacts and prize draw. A raffle belongs to one show
-- and carries its own public token (the QR). Visitors enter through
-- raffle_public_enter(); staff never type entries in by hand. Prizes have a
-- quantity ("3 × $50 gift card" is one prize, three winners). The draw happens
-- in the database — draw_raffle_winners() locks the raffle, picks uniformly at
-- random from the entries that are still eligible, closes entries, and writes
-- who drew, when, and how big the pool was. A winner who does not claim is
-- forfeited (never deleted) and the slot can be drawn again; someone who has
-- won once, or was disqualified, is never drawn again.
--
-- Who: anyone who can see the show sees its raffles and contacts; managing
-- (create, edit, close, draw, disqualify, mark notified/claimed) is the same
-- rule as managing the show — sales management, or a manager of its office.
-- The two public functions are executable by service_role only: the app calls
-- them from rate-limited server functions (src/lib/raffle-public.functions.ts).

-- ------------------------------------------------------------- permissions

CREATE OR REPLACE FUNCTION public.can_view_tradeshow(_user_id uuid, _tradeshow_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.tradeshows t
     WHERE t.id = _tradeshow_id
       AND (t.location_id IS NULL OR public.can_view_location(_user_id, t.location_id))
  );
$$;

CREATE OR REPLACE FUNCTION public.can_manage_tradeshow(_user_id uuid, _tradeshow_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.is_sales_manager(_user_id)
      OR EXISTS (
        SELECT 1 FROM public.tradeshows t
         WHERE t.id = _tradeshow_id
           AND t.location_id IS NOT NULL
           AND public.can_manage_location(_user_id, t.location_id)
      );
$$;

REVOKE ALL ON FUNCTION public.can_view_tradeshow(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.can_manage_tradeshow(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_view_tradeshow(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.can_manage_tradeshow(uuid, uuid) TO authenticated, service_role;

-- ------------------------------------------------------------------ tables

CREATE TABLE IF NOT EXISTS public.tradeshow_raffles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tradeshow_id uuid NOT NULL REFERENCES public.tradeshows(id) ON DELETE CASCADE,
  token text NOT NULL UNIQUE
    DEFAULT replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 120),
  -- The line under the title on the entry form ("Win a YETI cooler").
  headline text CHECK (headline IS NULL OR length(headline) <= 200),
  description text CHECK (description IS NULL OR length(description) <= 2000),
  terms text CHECK (terms IS NULL OR length(terms) <= 5000),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('draft', 'open', 'closed')),
  -- Entries stop on their own at this moment, whatever the status says.
  closes_at timestamptz,
  ask_phone boolean NOT NULL DEFAULT true,
  require_phone boolean NOT NULL DEFAULT false,
  ask_company boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tradeshow_raffles_show_idx ON public.tradeshow_raffles (tradeshow_id);

CREATE TABLE IF NOT EXISTS public.tradeshow_raffle_prizes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  raffle_id uuid NOT NULL REFERENCES public.tradeshow_raffles(id) ON DELETE CASCADE,
  position integer NOT NULL DEFAULT 1,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  description text CHECK (description IS NULL OR length(description) <= 500),
  value numeric(12, 2) CHECK (value IS NULL OR value >= 0),
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tradeshow_raffle_prizes_raffle_idx
  ON public.tradeshow_raffle_prizes (raffle_id, position);

CREATE TABLE IF NOT EXISTS public.tradeshow_raffle_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  raffle_id uuid NOT NULL REFERENCES public.tradeshow_raffles(id) ON DELETE CASCADE,
  first_name text NOT NULL CHECK (length(btrim(first_name)) BETWEEN 1 AND 80),
  last_name text NOT NULL CHECK (length(btrim(last_name)) BETWEEN 1 AND 80),
  email text NOT NULL CHECK (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' AND length(email) <= 254),
  phone text CHECK (phone IS NULL OR length(phone) <= 40),
  company text CHECK (company IS NULL OR length(company) <= 160),
  job_title text CHECK (job_title IS NULL OR length(job_title) <= 120),
  consent_terms boolean NOT NULL CHECK (consent_terms),
  consent_marketing boolean NOT NULL DEFAULT false,
  disqualified_at timestamptz,
  disqualified_reason text CHECK (disqualified_reason IS NULL OR length(disqualified_reason) <= 300),
  disqualified_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- One entry per person per raffle: the email is the person.
CREATE UNIQUE INDEX IF NOT EXISTS tradeshow_raffle_entries_one_per_email
  ON public.tradeshow_raffle_entries (raffle_id, lower(btrim(email)));
CREATE INDEX IF NOT EXISTS tradeshow_raffle_entries_raffle_idx
  ON public.tradeshow_raffle_entries (raffle_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.tradeshow_raffle_winners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  raffle_id uuid NOT NULL REFERENCES public.tradeshow_raffles(id) ON DELETE CASCADE,
  prize_id uuid NOT NULL REFERENCES public.tradeshow_raffle_prizes(id) ON DELETE CASCADE,
  entry_id uuid NOT NULL REFERENCES public.tradeshow_raffle_entries(id) ON DELETE CASCADE,
  -- How many eligible entries were in the hat when this one came out.
  pool_size integer NOT NULL CHECK (pool_size >= 1),
  drawn_at timestamptz NOT NULL DEFAULT now(),
  drawn_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'drawn'
    CHECK (status IN ('drawn', 'notified', 'claimed', 'forfeited')),
  notified_at timestamptz,
  claimed_at timestamptz,
  forfeited_at timestamptz,
  forfeit_reason text CHECK (forfeit_reason IS NULL OR length(forfeit_reason) <= 300),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL
);
-- A person wins once per raffle, even if that win was later forfeited.
CREATE UNIQUE INDEX IF NOT EXISTS tradeshow_raffle_winners_one_per_entry
  ON public.tradeshow_raffle_winners (entry_id);
CREATE INDEX IF NOT EXISTS tradeshow_raffle_winners_raffle_idx
  ON public.tradeshow_raffle_winners (raffle_id, drawn_at);

DROP TRIGGER IF EXISTS tradeshow_raffles_updated_at ON public.tradeshow_raffles;
CREATE TRIGGER tradeshow_raffles_updated_at BEFORE UPDATE ON public.tradeshow_raffles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

COMMENT ON TABLE public.tradeshow_raffles IS
  'A prize draw at a trade show. token is the QR code; entries come in through raffle_public_enter().';
COMMENT ON TABLE public.tradeshow_raffle_winners IS
  'Written only by draw_raffle_winners(). Status moves drawn → notified → claimed, or to forfeited; rows are never deleted.';

-- ---------------------------------------------------------------------- RLS

ALTER TABLE public.tradeshow_raffles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tradeshow_raffle_prizes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tradeshow_raffle_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tradeshow_raffle_winners ENABLE ROW LEVEL SECURITY;

GRANT ALL ON public.tradeshow_raffles, public.tradeshow_raffle_prizes,
  public.tradeshow_raffle_entries, public.tradeshow_raffle_winners TO service_role;

GRANT SELECT, INSERT, DELETE ON public.tradeshow_raffles TO authenticated;
GRANT UPDATE (title, headline, description, terms, status, closes_at,
  ask_phone, require_phone, ask_company) ON public.tradeshow_raffles TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tradeshow_raffle_prizes TO authenticated;
-- Entries: read, and disqualify. Never inserted or rewritten by staff.
GRANT SELECT ON public.tradeshow_raffle_entries TO authenticated;
GRANT UPDATE (disqualified_at, disqualified_reason, disqualified_by)
  ON public.tradeshow_raffle_entries TO authenticated;
-- Winners: read, and move the status along. Inserted only by the draw.
GRANT SELECT ON public.tradeshow_raffle_winners TO authenticated;
GRANT UPDATE (status, notified_at, claimed_at, forfeited_at, forfeit_reason, updated_by)
  ON public.tradeshow_raffle_winners TO authenticated;

DROP POLICY IF EXISTS raffles_select ON public.tradeshow_raffles;
DROP POLICY IF EXISTS raffles_insert ON public.tradeshow_raffles;
DROP POLICY IF EXISTS raffles_update ON public.tradeshow_raffles;
DROP POLICY IF EXISTS raffles_delete ON public.tradeshow_raffles;
CREATE POLICY raffles_select ON public.tradeshow_raffles FOR SELECT TO authenticated
  USING (public.can_view_tradeshow(auth.uid(), tradeshow_id));
CREATE POLICY raffles_insert ON public.tradeshow_raffles FOR INSERT TO authenticated
  WITH CHECK (public.can_manage_tradeshow(auth.uid(), tradeshow_id));
CREATE POLICY raffles_update ON public.tradeshow_raffles FOR UPDATE TO authenticated
  USING (public.can_manage_tradeshow(auth.uid(), tradeshow_id))
  WITH CHECK (public.can_manage_tradeshow(auth.uid(), tradeshow_id));
-- Deleting throws away contacts, so only a raffle nobody has entered can go.
CREATE POLICY raffles_delete ON public.tradeshow_raffles FOR DELETE TO authenticated
  USING (public.can_manage_tradeshow(auth.uid(), tradeshow_id)
         AND NOT EXISTS (SELECT 1 FROM public.tradeshow_raffle_entries e
                         WHERE e.raffle_id = tradeshow_raffles.id));

CREATE OR REPLACE FUNCTION public.raffle_show(_raffle_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$ SELECT tradeshow_id FROM public.tradeshow_raffles WHERE id = _raffle_id $$;
REVOKE ALL ON FUNCTION public.raffle_show(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.raffle_show(uuid) TO authenticated, service_role;

DROP POLICY IF EXISTS raffle_prizes_select ON public.tradeshow_raffle_prizes;
DROP POLICY IF EXISTS raffle_prizes_write ON public.tradeshow_raffle_prizes;
CREATE POLICY raffle_prizes_select ON public.tradeshow_raffle_prizes FOR SELECT TO authenticated
  USING (public.can_view_tradeshow(auth.uid(), public.raffle_show(raffle_id)));
-- A prize that has been drawn stays: its winners point at it.
CREATE POLICY raffle_prizes_write ON public.tradeshow_raffle_prizes FOR ALL TO authenticated
  USING (public.can_manage_tradeshow(auth.uid(), public.raffle_show(raffle_id)))
  WITH CHECK (public.can_manage_tradeshow(auth.uid(), public.raffle_show(raffle_id)));

DROP POLICY IF EXISTS raffle_entries_select ON public.tradeshow_raffle_entries;
DROP POLICY IF EXISTS raffle_entries_update ON public.tradeshow_raffle_entries;
CREATE POLICY raffle_entries_select ON public.tradeshow_raffle_entries FOR SELECT TO authenticated
  USING (public.can_view_tradeshow(auth.uid(), public.raffle_show(raffle_id)));
CREATE POLICY raffle_entries_update ON public.tradeshow_raffle_entries FOR UPDATE TO authenticated
  USING (public.can_manage_tradeshow(auth.uid(), public.raffle_show(raffle_id)))
  WITH CHECK (public.can_manage_tradeshow(auth.uid(), public.raffle_show(raffle_id)));

DROP POLICY IF EXISTS raffle_winners_select ON public.tradeshow_raffle_winners;
DROP POLICY IF EXISTS raffle_winners_update ON public.tradeshow_raffle_winners;
CREATE POLICY raffle_winners_select ON public.tradeshow_raffle_winners FOR SELECT TO authenticated
  USING (public.can_view_tradeshow(auth.uid(), public.raffle_show(raffle_id)));
CREATE POLICY raffle_winners_update ON public.tradeshow_raffle_winners FOR UPDATE TO authenticated
  USING (public.can_manage_tradeshow(auth.uid(), public.raffle_show(raffle_id)))
  WITH CHECK (public.can_manage_tradeshow(auth.uid(), public.raffle_show(raffle_id)));

-- A prize with a winner on it cannot be deleted or have its quantity cut
-- below the winners it already has.
CREATE OR REPLACE FUNCTION public.tg_raffle_prize_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  _won integer;
BEGIN
  SELECT count(*) INTO _won FROM public.tradeshow_raffle_winners
   WHERE prize_id = OLD.id AND status <> 'forfeited';
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM public.tradeshow_raffle_winners WHERE prize_id = OLD.id) THEN
      RAISE EXCEPTION 'This prize has been drawn and cannot be removed.' USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.quantity < _won THEN
    RAISE EXCEPTION 'This prize already has % winner(s).', _won USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS raffle_prize_guard ON public.tradeshow_raffle_prizes;
CREATE TRIGGER raffle_prize_guard BEFORE UPDATE OR DELETE ON public.tradeshow_raffle_prizes
  FOR EACH ROW EXECUTE FUNCTION public.tg_raffle_prize_guard();

-- Winner status moves stamp themselves, so the UI only sends the status.
CREATE OR REPLACE FUNCTION public.tg_raffle_winner_status()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status IN ('claimed', 'forfeited') THEN
      RAISE EXCEPTION 'This win is already %.', OLD.status USING ERRCODE = 'P0001';
    END IF;
    IF NEW.status = 'notified' THEN NEW.notified_at := coalesce(NEW.notified_at, now()); END IF;
    IF NEW.status = 'claimed' THEN
      NEW.claimed_at := now();
      NEW.notified_at := coalesce(NEW.notified_at, now());
    END IF;
    IF NEW.status = 'forfeited' THEN NEW.forfeited_at := now(); END IF;
    NEW.updated_by := auth.uid();
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS raffle_winner_status ON public.tradeshow_raffle_winners;
CREATE TRIGGER raffle_winner_status BEFORE UPDATE ON public.tradeshow_raffle_winners
  FOR EACH ROW EXECUTE FUNCTION public.tg_raffle_winner_status();

-- ------------------------------------------------------------------ the draw

CREATE OR REPLACE FUNCTION public.draw_raffle_winners(_prize_id uuid, _count integer DEFAULT NULL)
RETURNS SETOF public.tradeshow_raffle_winners
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _prize public.tradeshow_raffle_prizes;
  _raffle public.tradeshow_raffles;
  _open_slots integer;
  _want integer;
  _pool integer;
  _entry uuid;
  _row public.tradeshow_raffle_winners;
BEGIN
  SELECT * INTO _prize FROM public.tradeshow_raffle_prizes WHERE id = _prize_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Prize not found.' USING ERRCODE = 'P0002';
  END IF;
  -- One draw at a time per raffle: two people pressing Draw together must
  -- not pick the same person twice or overfill a prize.
  SELECT * INTO _raffle FROM public.tradeshow_raffles WHERE id = _prize.raffle_id FOR UPDATE;
  IF NOT public.can_manage_tradeshow(auth.uid(), _raffle.tradeshow_id) THEN
    RAISE EXCEPTION 'Only a manager of this show can run the draw.' USING ERRCODE = '42501';
  END IF;

  SELECT _prize.quantity - count(*) INTO _open_slots
    FROM public.tradeshow_raffle_winners WHERE prize_id = _prize_id AND status <> 'forfeited';
  IF _open_slots <= 0 THEN
    RAISE EXCEPTION 'Every % has been drawn.', _prize.name USING ERRCODE = 'P0001';
  END IF;
  _want := least(_open_slots, greatest(1, coalesce(_count, _open_slots)));

  -- Drawing ends entries: nobody joins a draw that has already happened.
  IF _raffle.status <> 'closed' THEN
    UPDATE public.tradeshow_raffles SET status = 'closed' WHERE id = _raffle.id;
  END IF;

  FOR i IN 1.._want LOOP
    SELECT count(*) INTO _pool
      FROM public.tradeshow_raffle_entries e
     WHERE e.raffle_id = _raffle.id
       AND e.disqualified_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.tradeshow_raffle_winners w WHERE w.entry_id = e.id);
    IF _pool = 0 THEN
      IF i = 1 THEN
        RAISE EXCEPTION 'There is nobody left to draw.' USING ERRCODE = 'P0001';
      END IF;
      EXIT;
    END IF;
    -- gen_random_uuid() is drawn from the server's cryptographic source, so
    -- ordering by it is a fair, unpredictable shuffle.
    SELECT e.id INTO _entry
      FROM public.tradeshow_raffle_entries e
     WHERE e.raffle_id = _raffle.id
       AND e.disqualified_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.tradeshow_raffle_winners w WHERE w.entry_id = e.id)
     ORDER BY gen_random_uuid()
     LIMIT 1;
    INSERT INTO public.tradeshow_raffle_winners (raffle_id, prize_id, entry_id, pool_size, drawn_by)
    VALUES (_raffle.id, _prize_id, _entry, _pool, auth.uid())
    RETURNING * INTO _row;
    RETURN NEXT _row;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION public.draw_raffle_winners(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.draw_raffle_winners(uuid, integer) TO authenticated, service_role;

-- --------------------------------------------------------- the public side

CREATE OR REPLACE FUNCTION public.raffle_is_open(_r public.tradeshow_raffles)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$ SELECT _r.status = 'open' AND (_r.closes_at IS NULL OR _r.closes_at > now()) $$;

-- What the entry form needs, and nothing else: no contacts, no staff.
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
BEGIN
  SELECT * INTO _r FROM public.tradeshow_raffles WHERE token = _token;
  IF NOT FOUND OR _r.status = 'draft' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;
  SELECT * INTO _show FROM public.tradeshows WHERE id = _r.tradeshow_id;
  RETURN jsonb_build_object(
    'ok', true,
    'open', public.raffle_is_open(_r),
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
  SELECT * INTO _r FROM public.tradeshow_raffles WHERE token = _token;
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

REVOKE ALL ON FUNCTION public.raffle_is_open(public.tradeshow_raffles) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.raffle_public_load(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.raffle_public_enter(text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.raffle_is_open(public.tradeshow_raffles) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.raffle_public_load(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.raffle_public_enter(text, jsonb) TO service_role;
