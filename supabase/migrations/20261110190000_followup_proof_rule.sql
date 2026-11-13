-- What counts as a follow-up (Melly, GSR Edits).
--
--   "A follow up only counts if the client responds. Leaving a voicemail is
--    not a follow up. Sending an email nobody answers is not a follow up. ...
--    Some of these the system catches on its own with no rep effort: inbound
--    emails, texts, answered calls over two minutes ... Some things the rep
--    logs by hand, like dropping off a gift or having lunch. Those count, but
--    only if the rep attaches something — a photo of the gift, a copy of
--    their thank you, meeting notes. The system marks these unverified but
--    accepts them. A rep clicking a button with nothing attached does not
--    count. It gets recorded as an attempt ... out of office auto replies
--    must not count as a response ... The manager gets one number per rep —
--    what percentage of their clients were cleared by the rep saying so
--    rather than the system detecting it."
--
-- WHAT CHANGES, for touchpoints created from the rule's start onward:
--   * a self-reported touch (capture_source = 'manual') counts toward the
--     client's clock only with proof attached; without it, it is an attempt;
--   * an inbound message flagged as an auto-reply never counts;
--   * a captured call counts at two minutes, not thirty seconds.
--
-- WHAT DOES NOT CHANGE. Every touchpoint created before the start keeps the
-- old rule, on insert and on any later update. Re-judging history would flip
-- years of hand-logged meetings to "attempt" overnight, and the nightly sweep
-- would open a Critical episode on every client it pushed over the line.
-- The start lives in app_settings.followup_rules.starts_at so it can be read
-- and, if the office wants, moved.
--
-- The pipeline's reply detection (pipeline_outreach_stats) reads replied_at
-- and inbound direction, not counts_toward_cadence, so a rep's "They
-- responded" still moves Active Outreach to Conversation Established. It now
-- ignores auto-replies, which are not anyone responding.

-- ---------------------------------------------------------------- columns

ALTER TABLE public.touchpoints
  ADD COLUMN IF NOT EXISTS proof_path text,
  ADD COLUMN IF NOT EXISTS proof_kind text,
  ADD COLUMN IF NOT EXISTS proof_added_at timestamptz,
  ADD COLUMN IF NOT EXISTS is_auto_reply boolean NOT NULL DEFAULT false;

ALTER TABLE public.touchpoints DROP CONSTRAINT IF EXISTS touchpoints_proof_kind_check;
ALTER TABLE public.touchpoints
  ADD CONSTRAINT touchpoints_proof_kind_check
  CHECK (proof_kind IS NULL OR proof_kind IN ('photo', 'file', 'form'));

COMMENT ON COLUMN public.touchpoints.proof_path IS
  'Storage path in the touchpoint-proof bucket: the photo of the gift, their thank-you, the meeting notes. A self-reported touch counts toward the client clock only with proof.';
COMMENT ON COLUMN public.touchpoints.proof_kind IS
  'photo | file — attached by the rep; form — the client filled in a Gold Star form themselves (set by the server, never by a rep).';
COMMENT ON COLUMN public.touchpoints.is_auto_reply IS
  'An out-of-office or other automated reply. Never counts as the client responding.';

-- ------------------------------------------------------------- settings

INSERT INTO public.app_settings (key, value)
VALUES ('followup_rules', jsonb_build_object('starts_at', now(), 'call_min_seconds', 120))
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.followup_rule_settings()
RETURNS TABLE(starts_at timestamptz, call_min_seconds integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((s.value->>'starts_at')::timestamptz, '2026-11-06 00:00:00-05'::timestamptz),
         COALESCE(NULLIF(s.value->>'call_min_seconds', '')::int, 120)
    FROM (SELECT (SELECT value FROM public.app_settings WHERE key = 'followup_rules') AS value) s;
$$;
REVOKE ALL ON FUNCTION public.followup_rule_settings() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.followup_rule_settings() TO authenticated, service_role;

-- --------------------------------------------------------- proof storage

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'touchpoint-proof',
  'touchpoint-proof',
  false,
  15728640,
  ARRAY['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif', 'application/pdf']
)
ON CONFLICT (id) DO UPDATE
  SET public = false,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

-- The account a stored proof belongs to: the first path segment. A CASE, not
-- a bare cast, so a malformed path reads as "no account" inside a policy.
CREATE OR REPLACE FUNCTION public.touchpoint_proof_account_id(_path text)
RETURNS uuid
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE
           WHEN split_part(_path, '/', 1)
                ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
             THEN split_part(_path, '/', 1)::uuid
         END;
$$;
REVOKE ALL ON FUNCTION public.touchpoint_proof_account_id(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.touchpoint_proof_account_id(text) TO authenticated, service_role;

-- Who may see or add proof: whoever may see the account's touchpoints
-- (touchpoints_select: the office, or the account's rep).
CREATE OR REPLACE FUNCTION public.can_see_account_touches(_uid uuid, _account_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.accounts a
     WHERE a.id = _account_id
       AND (public.can_view_location(_uid, a.location_id) OR a.assigned_rep = _uid)
  );
$$;
REVOKE ALL ON FUNCTION public.can_see_account_touches(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_see_account_touches(uuid, uuid) TO authenticated, service_role;

DROP POLICY IF EXISTS touchpoint_proof_read ON storage.objects;
CREATE POLICY touchpoint_proof_read ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'touchpoint-proof'
    AND public.can_see_account_touches((SELECT auth.uid()), public.touchpoint_proof_account_id(name))
  );

DROP POLICY IF EXISTS touchpoint_proof_insert ON storage.objects;
CREATE POLICY touchpoint_proof_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'touchpoint-proof'
    AND public.can_see_account_touches((SELECT auth.uid()), public.touchpoint_proof_account_id(name))
  );
-- No UPDATE or DELETE: proof is what was on file when the touch was cleared.

-- A rep's proof must be a file that was actually uploaded for this account.
CREATE OR REPLACE FUNCTION public.touchpoint_proof_exists(_path text, _account_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT _path IS NOT NULL
     AND public.touchpoint_proof_account_id(_path) = _account_id
     AND EXISTS (SELECT 1 FROM storage.objects o
                  WHERE o.bucket_id = 'touchpoint-proof' AND o.name = _path);
$$;
REVOKE ALL ON FUNCTION public.touchpoint_proof_exists(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.touchpoint_proof_exists(text, uuid) TO service_role;

-- --------------------------------------------------------------- the rule

CREATE OR REPLACE FUNCTION public.tg_touchpoint_cadence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  cfg record;
  proofed boolean;
BEGIN
  NEW.is_self_reported := (NEW.capture_source = 'manual');
  SELECT * INTO cfg FROM public.followup_rule_settings();

  -- Proof hygiene, whatever the date. 'form' is the server's word that the
  -- client filled the form in; a signed-in user cannot claim it. A photo or
  -- file must be a real upload under this account's folder.
  IF NEW.proof_kind IS DISTINCT FROM (CASE WHEN TG_OP = 'UPDATE' THEN OLD.proof_kind END)
     OR NEW.proof_path IS DISTINCT FROM (CASE WHEN TG_OP = 'UPDATE' THEN OLD.proof_path END) THEN
    IF NEW.proof_kind = 'form' AND auth.uid() IS NOT NULL THEN
      RAISE EXCEPTION 'Only a submitted form can be filed as form proof.' USING ERRCODE = '42501';
    END IF;
    IF NEW.proof_kind IN ('photo', 'file')
       AND NOT public.touchpoint_proof_exists(NEW.proof_path, NEW.account_id) THEN
      RAISE EXCEPTION 'Upload the proof before attaching it.' USING ERRCODE = '22023';
    END IF;
    IF NEW.proof_kind IS NULL THEN
      NEW.proof_path := NULL;
      NEW.proof_added_at := NULL;
    ELSE
      NEW.proof_added_at := COALESCE(NEW.proof_added_at, now());
    END IF;
  END IF;

  IF COALESCE(NEW.created_at, now()) < cfg.starts_at THEN
    -- The rule as it stood before (20260806171901), for history.
    IF NEW.direction = 'inbound' THEN
      NEW.counts_toward_cadence := true;
    ELSIF NEW.type IN ('meeting_in_person','meeting_virtual') THEN
      NEW.counts_toward_cadence := COALESCE(NEW.meeting_held, NEW.capture_source <> 'calendar');
    ELSIF NEW.type = 'call' THEN
      NEW.counts_toward_cadence := COALESCE(NEW.duration_seconds, 0) >= 30 OR NEW.replied_at IS NOT NULL;
    ELSE
      NEW.counts_toward_cadence := NEW.replied_at IS NOT NULL;
    END IF;
    RETURN NEW;
  END IF;

  proofed := NEW.proof_kind IS NOT NULL;

  IF NEW.is_auto_reply THEN
    -- "Out of office auto replies must not count as a response."
    NEW.counts_toward_cadence := false;
  ELSIF NEW.is_self_reported THEN
    -- "Those count, but only if the rep attaches something." A meeting the
    -- rep marked not held is not one, proof or not.
    NEW.counts_toward_cadence := proofed AND NEW.meeting_held IS DISTINCT FROM false;
  ELSIF NEW.direction = 'inbound' THEN
    NEW.counts_toward_cadence := true;
  ELSIF NEW.type IN ('meeting_in_person','meeting_virtual') THEN
    NEW.counts_toward_cadence := COALESCE(NEW.meeting_held, NEW.capture_source <> 'calendar');
  ELSIF NEW.type = 'call' THEN
    -- "Answered calls over two minutes."
    NEW.counts_toward_cadence :=
      COALESCE(NEW.duration_seconds, 0) >= cfg.call_min_seconds OR NEW.replied_at IS NOT NULL;
  ELSE
    NEW.counts_toward_cadence := NEW.replied_at IS NOT NULL;
  END IF;

  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.tg_touchpoint_cadence() FROM PUBLIC, anon, authenticated;

-- ------------------------------------------- pipeline ignores auto-replies

CREATE OR REPLACE FUNCTION public.pipeline_outreach_stats(_account_id uuid, _since timestamptz)
RETURNS TABLE (
  attempts integer,
  attempt_days integer,
  methods text[],
  last_touch_at timestamptz,
  last_task_done_at timestamptz,
  replied boolean,
  last_reply_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  WITH cfg AS (SELECT public.pipeline_rule_settings() s),
  win AS (
    SELECT greatest(_since, now() - make_interval(days => (s->>'window_days')::int)) AS from_at,
           (s->>'day_timezone') AS tz
    FROM cfg
  ),
  tp AS (
    SELECT
      (count(*) FILTER (WHERE t.direction = 'outbound' AND t.occurred_at >= win.from_at))::int AS attempts,
      (count(DISTINCT (t.occurred_at AT TIME ZONE win.tz)::date)
        FILTER (WHERE t.direction = 'outbound' AND t.occurred_at >= win.from_at))::int AS attempt_days,
      coalesce(array_agg(DISTINCT public.touchpoint_method(t.type))
        FILTER (WHERE t.direction = 'outbound' AND t.occurred_at >= win.from_at
                  AND public.touchpoint_method(t.type) <> 'other'), '{}'::text[]) AS methods,
      max(t.occurred_at) AS last_touch_at,
      coalesce(bool_or((t.direction = 'inbound' AND NOT t.is_auto_reply AND t.occurred_at >= _since)
                       OR (t.replied_at IS NOT NULL AND t.replied_at >= _since)), false) AS replied,
      max(CASE WHEN t.direction = 'inbound' AND NOT t.is_auto_reply AND t.occurred_at >= _since THEN t.occurred_at
               WHEN t.replied_at IS NOT NULL AND t.replied_at >= _since THEN t.replied_at END) AS last_reply_at
    FROM win, public.touchpoints t
    WHERE t.account_id = _account_id
  ),
  tk AS (
    SELECT max(k.completed_at) AS last_task_done_at
    FROM public.tasks k
    WHERE k.account_id = _account_id AND k.status = 'done'
  )
  SELECT tp.attempts, tp.attempt_days, tp.methods, tp.last_touch_at, tk.last_task_done_at, tp.replied, tp.last_reply_at
  FROM tp, tk;
$$;
REVOKE ALL ON FUNCTION public.pipeline_outreach_stats(uuid, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pipeline_outreach_stats(uuid, timestamptz) TO authenticated, service_role;

-- --------------------------------------------- the manager's one number

-- "What percentage of their clients were cleared by the rep saying so rather
-- than the system detecting it." Per rep, over the same client book the
-- Critical cap counts (rep_critical_share, 20261110160000): of the clients
-- whose clock has a counting touch, how many were last cleared by a
-- self-reported one.
CREATE OR REPLACE FUNCTION public.rep_self_cleared_shares()
RETURNS TABLE(user_id uuid, full_name text, cleared integer, self_cleared integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH reps AS (
    SELECT r.user_id, r.full_name FROM public.list_business_reps() r
     WHERE public.is_sales_manager(auth.uid())
  ),
  book AS (
    SELECT a.id, a.assigned_rep
      FROM public.accounts a
     WHERE a.assigned_rep IN (SELECT user_id FROM reps)
       AND a.archived_at IS NULL
       AND a.status <> 'lost'
       AND (a.health_stage_id IS NOT NULL
            OR a.status IN ('active', 'onboarding')
            OR a.stage IN ('active_client', 'won'))
       AND NOT public.account_is_house_account(a.id)
  ),
  latest AS (
    SELECT DISTINCT ON (b.id) b.id, b.assigned_rep, t.is_self_reported
      FROM book b
      JOIN public.touchpoints t ON t.account_id = b.id AND t.counts_toward_cadence
     ORDER BY b.id, t.occurred_at DESC
  )
  SELECT reps.user_id, reps.full_name,
         count(latest.id)::int,
         count(latest.id) FILTER (WHERE latest.is_self_reported)::int
    FROM reps
    LEFT JOIN latest ON latest.assigned_rep = reps.user_id
   GROUP BY reps.user_id, reps.full_name;
$$;
REVOKE ALL ON FUNCTION public.rep_self_cleared_shares() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rep_self_cleared_shares() TO authenticated;
