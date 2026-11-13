-- APPLIED to production on 2026-09-16 and ledgered as 20260916140000. Verified by
-- calling scorecard_action_counts as an admin with all 60 catalogue keys: every
-- key answered for 32 reps, no runtime errors (plpgsql only checks column names
-- when a branch runs, so this was the real test). Sales Head write policy live.
--
-- 
-- =====================================================================
-- Scorecard action catalogue: any catalogue action, per rep, computed here.
--
-- Mark, 16 Sep 2026, verbatim:
--
--   "this needs to have an admin menu to change and add, also the admin menu
--    needs to have the ability to add components and targets weights etc for
--    anything they want that needs to tie to an action, so have a list of
--    actions they can choose from, it should get every action available i
--    the crm with a serach function thats smart"
--
-- Leaderboard points are Σ weight × attainment against target over the
-- components in `scorecard_weights`. Until now a component could only be one
-- of the fixed columns `leaderboard_standings` returns. Once an admin can pick
-- any action from the catalogue (src/lib/action-catalogue.ts), the actual for
-- that action has to be computable for any key — and it has to be computed
-- HERE, never from a query the browser composes.
--
-- HOW THE ALLOWLIST WORKS
-- -----------------------
-- `scorecard_action_counts(_from, _to, _keys, _location_ids)` is the only
-- entry point. It works out who the caller may see (the same
-- `can_view_location` rule `leaderboard_standings` uses), decides money
-- visibility once, then loops over the distinct keys it was handed and
-- switches on them. Each `WHEN 'key' THEN` runs one fixed query, or hands a
-- fixed set of literal arguments to one of the family helpers below. A key
-- with no branch falls into `ELSE NULL` — ignored, never raised, so a probing
-- client learns nothing about the schema from an error message.
--
-- The client passes KEYS. It never passes a table, a column, a predicate or a
-- stage name; those are all typed here, in this file, once.
--
-- The four helpers (`scorecard_count_outreach`, `scorecard_count_stage_moves`,
-- `scorecard_account_client_since`, `scorecard_money_visible`) are SECURITY
-- INVOKER and revoked from clients. They are reachable only through the
-- definer function, which has already done the access check and runs them
-- with its own rights — the same arrangement as `scorecard_metrics_raw`.
--
-- HOUSE ACCOUNTS
-- --------------
-- Every per-rep aggregate carries `NOT public.account_is_house_account(a.id)`
-- exactly as 20260912103000 and 20260913090000 put it on the standings and
-- director cards. Chase rows with no account (a fire-lead attempt, an
-- incident nobody has tied to an account yet) have no account to be a house
-- account, and count.
--
-- MONEY
-- -----
-- Currency actions return NULL, not 0, unless the caller may see money — the
-- predicate `leaderboard_standings` already uses, factored into
-- `scorecard_money_visible()` so the two cannot drift.
--
-- STANDINGS-BACKED KEYS
-- ---------------------
-- Keys the standings row already carries (touchpoints, meetings_held, ...)
-- delegate to `leaderboard_standings` in one query, so the number is the same
-- by construction and a caller asking for them gets exactly what the board
-- shows. The client prefers the standings row and normally never asks.
--
-- WHO MAY EDIT THE WEIGHTS
-- ------------------------
-- The admin screen is gated to owners, admins and the Sales Head. The write
-- policies on `scorecard_weights` and `scorecard_settings` were
-- `is_privileged` only, which would have let a Sales Head open the page and
-- fail to save. They now include `sales_head`.
--
-- NOT APPLIED. Until it runs, points keep using the fixed standings columns:
-- the client feature-detects this function and falls back.
-- =====================================================================


-- ---------------------------------------------------------------------------
-- 0. The Sales Head may edit weights and the minimum-activity setting.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Owners and admins manage scorecard weights" ON public.scorecard_weights;
CREATE POLICY "Owners, admins and the Sales Head manage scorecard weights"
  ON public.scorecard_weights FOR ALL TO authenticated
  USING (public.is_privileged(auth.uid()) OR public.has_role(auth.uid(), 'sales_head'))
  WITH CHECK (public.is_privileged(auth.uid()) OR public.has_role(auth.uid(), 'sales_head'));

DROP POLICY IF EXISTS "Owners and admins manage scorecard settings" ON public.scorecard_settings;
CREATE POLICY "Owners, admins and the Sales Head manage scorecard settings"
  ON public.scorecard_settings FOR ALL TO authenticated
  USING (public.is_privileged(auth.uid()) OR public.has_role(auth.uid(), 'sales_head'))
  WITH CHECK (public.is_privileged(auth.uid()) OR public.has_role(auth.uid(), 'sales_head'));


-- ---------------------------------------------------------------------------
-- 1. When did this account become a client?
--
-- Mirrors isActiveClient() in src/lib/pipeline-reversion.ts and
-- isProspectingBoardCard() in src/lib/pipeline.ts: a Client Health stage, the
-- won prospecting stage, or an active/onboarding status means "client". Those
-- are current-state flags; to judge a touch AT THE TIME IT HAPPENED we take
-- the earliest evidence available — the stated `client_since`, the first
-- stage-history move into a client stage, or (for an account that is a
-- client today with no history saying when) the last stage or health change.
-- NULL means never a client. A reversion back to the pipeline is not undone
-- here: a rep's cold calls from before the account signed stay cold, and a
-- call after it signed was to a client, whatever happened later.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.scorecard_account_client_since(_account_id uuid)
RETURNS timestamptz
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT LEAST(
    (SELECT a.client_since::timestamptz FROM public.accounts a WHERE a.id = _account_id),
    (SELECT min(h.changed_at) FROM public.account_stage_history h
      WHERE h.account_id = _account_id
        AND h.to_stage IN ('active_client', 'won', 'active')),
    (SELECT CASE
              WHEN a.health_stage_id IS NOT NULL
                OR a.stage IN ('active_client', 'won')
                OR a.status::text IN ('active', 'onboarding')
              THEN COALESCE(a.health_changed_at, a.stage_changed_at, a.created_at)
            END
       FROM public.accounts a WHERE a.id = _account_id)
  );
$$;

REVOKE ALL ON FUNCTION public.scorecard_account_client_since(uuid) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.scorecard_account_client_since(uuid) IS
  'Earliest moment the account counts as an active client by the board rule (isActiveClient in pipeline-reversion.ts). NULL = never. Reachable only through scorecard_action_counts.';


-- ---------------------------------------------------------------------------
-- 2. Money visibility, the leaderboard_standings predicate, in one place.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.scorecard_money_visible()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT public.is_privileged(auth.uid())
      OR public.has_role(auth.uid(), 'location_manager')
      OR public.has_role(auth.uid(), 'sales_manager')
      OR public.has_role(auth.uid(), 'regional');
$$;

REVOKE ALL ON FUNCTION public.scorecard_money_visible() FROM PUBLIC, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 3. Family helper: outreach.
--
-- Touchpoints of the given types plus contact attempts on the given channels,
-- by each person, in the window, filtered by audience:
--   'any'      every account
--   'prospect' the account was NOT a client at the moment of the touch
--   'client'   the account WAS a client at that moment
-- An attempt with no account attached (chase work on a fire lead) has nothing
-- to be a prospect or a client, so it counts under 'any' only.
-- Inbound touchpoints are excluded when _outbound is true — a reach-out is
-- something the rep did. A meeting the client cancelled (meeting_held =
-- false) is not a touch at all.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.scorecard_count_outreach(
  _people uuid[], _from timestamptz, _to timestamptz,
  _tp_types text[], _ca_channels text[], _audience text, _outbound boolean
)
RETURNS TABLE(user_id uuid, n numeric)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH tp AS (
    SELECT t.created_by AS uid, count(*) AS c
      FROM public.touchpoints t
     WHERE t.created_by = ANY(_people)
       AND t.occurred_at >= _from AND t.occurred_at < _to
       AND t.type::text = ANY(_tp_types)
       AND NOT (_outbound AND t.direction = 'inbound')
       AND NOT (t.type::text LIKE 'meeting%' AND t.meeting_held IS FALSE)
       AND NOT public.account_is_house_account(t.account_id)
       AND CASE _audience
             WHEN 'client'   THEN public.scorecard_account_client_since(t.account_id) <= t.occurred_at
             WHEN 'prospect' THEN NOT COALESCE(public.scorecard_account_client_since(t.account_id) <= t.occurred_at, false)
             ELSE true
           END
     GROUP BY t.created_by
  ),
  ca AS (
    SELECT c.author_id AS uid, count(*) AS c
      FROM public.contact_attempts c
     WHERE c.author_id = ANY(_people)
       AND c.occurred_at >= _from AND c.occurred_at < _to
       AND c.channel::text = ANY(_ca_channels)
       AND (c.account_id IS NULL OR NOT public.account_is_house_account(c.account_id))
       AND CASE _audience
             WHEN 'client'   THEN c.account_id IS NOT NULL
                                  AND public.scorecard_account_client_since(c.account_id) <= c.occurred_at
             WHEN 'prospect' THEN c.account_id IS NOT NULL
                                  AND NOT COALESCE(public.scorecard_account_client_since(c.account_id) <= c.occurred_at, false)
             ELSE true
           END
     GROUP BY c.author_id
  )
  SELECT p.uid, (COALESCE(tp.c, 0) + COALESCE(ca.c, 0))::numeric
    FROM unnest(_people) AS p(uid)
    LEFT JOIN tp ON tp.uid = p.uid
    LEFT JOIN ca ON ca.uid = p.uid;
$$;

REVOKE ALL ON FUNCTION public.scorecard_count_outreach(uuid[], timestamptz, timestamptz, text[], text[], text, boolean)
  FROM PUBLIC, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 4. Family helper: stage moves. Moves INTO any of _to_keys, made by the
--    person, optionally only FROM one of _from_keys. House accounts excluded.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.scorecard_count_stage_moves(
  _people uuid[], _from timestamptz, _to timestamptz, _to_keys text[], _from_keys text[]
)
RETURNS TABLE(user_id uuid, n numeric)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT p.uid,
         (SELECT count(*) FROM public.account_stage_history h
           WHERE h.changed_by = p.uid
             AND h.changed_at >= _from AND h.changed_at < _to
             AND (_to_keys IS NULL OR h.to_stage = ANY(_to_keys))
             AND (_from_keys IS NULL OR h.from_stage = ANY(_from_keys))
             AND NOT (_from_keys IS NOT NULL AND h.to_stage = ANY(_from_keys))
             AND NOT public.account_is_house_account(h.account_id))::numeric
    FROM unnest(_people) AS p(uid);
$$;

REVOKE ALL ON FUNCTION public.scorecard_count_stage_moves(uuid[], timestamptz, timestamptz, text[], text[])
  FROM PUBLIC, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 5. The entry point. Keys in, (user_id, key, value) out — one row per
--    visible person per recognised key.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.scorecard_action_counts(
  _from timestamptz,
  _to timestamptz,
  _keys text[],
  _location_ids uuid[] DEFAULT NULL
)
RETURNS TABLE(user_id uuid, key text, value numeric)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  people uuid[];
  money boolean;
  k text;
  -- Everything a rep can do to an account, for the audience-split "any
  -- outbound contact" keys. Listed here, not sent by the client.
  all_tp text[] := ARRAY['call','email','text','meeting_in_person','meeting_virtual','linkedin','mail','gift','seasonal_send','other'];
  all_ca text[] := ARRAY['call','sms','email','door','other'];
  client_stages text[] := ARRAY['active_client','won','active'];
  lead_pool text[] := ARRAY['leads','new_lead_input'];
BEGIN
  IF auth.uid() IS NULL THEN RETURN; END IF;

  -- Who the caller may see: the leaderboard_standings rule, verbatim.
  SELECT COALESCE(array_agg(DISTINCT r.user_id), ARRAY[]::uuid[]) INTO people
    FROM public.list_business_reps() r
   WHERE EXISTS (
     SELECT 1 FROM public.location_members lm
      WHERE lm.user_id = r.user_id
        AND public.can_view_location(auth.uid(), lm.location_id)
        AND (_location_ids IS NULL OR lm.location_id = ANY(_location_ids))
   );
  IF cardinality(people) = 0 THEN RETURN; END IF;

  money := public.scorecard_money_visible();

  -- Standings-backed keys, all at once, straight off the board's own function.
  IF EXISTS (SELECT 1 FROM unnest(_keys) x WHERE x IN (
       'touchpoints','calls_made','contact_attempts','meetings_held','accounts_advanced',
       'stage_advances','cadence_health','new_accounts','accounts_owned','jobs_won',
       'jobs_signed_total','jobs_signed_insurance','jobs_signed_cash','billed_value',
       'collected_value','incidents_dispatched','incidents_accepted','fires_chased',
       'contracts_signed','chase_acceptance','chase_tta')) THEN
    RETURN QUERY
      SELECT s.user_id, x.k,
             CASE x.k
               WHEN 'touchpoints'           THEN s.touchpoints::numeric
               WHEN 'calls_made'            THEN s.calls_made::numeric
               WHEN 'contact_attempts'      THEN s.activity_events::numeric   -- the board has always read it so
               WHEN 'meetings_held'         THEN s.meetings_held::numeric
               WHEN 'accounts_advanced'     THEN s.accounts_advanced::numeric
               WHEN 'stage_advances'        THEN s.stage_advances::numeric
               WHEN 'cadence_health'        THEN s.cadence_health
               WHEN 'new_accounts'          THEN s.new_accounts::numeric
               WHEN 'accounts_owned'        THEN s.accounts_owned::numeric
               WHEN 'jobs_won'              THEN s.jobs_won::numeric
               WHEN 'jobs_signed_total'     THEN s.jobs_signed_total::numeric
               WHEN 'jobs_signed_insurance' THEN s.jobs_signed_insurance::numeric
               WHEN 'jobs_signed_cash'      THEN s.jobs_signed_cash::numeric
               WHEN 'billed_value'          THEN s.billed_value
               WHEN 'collected_value'       THEN s.collected_value
               WHEN 'incidents_dispatched'  THEN s.incidents_dispatched::numeric
               WHEN 'incidents_accepted'    THEN s.incidents_accepted::numeric
               WHEN 'fires_chased'          THEN s.incidents_accepted::numeric   -- Mark's name for it
               WHEN 'contracts_signed'      THEN s.contracts_signed::numeric
               WHEN 'chase_acceptance'      THEN s.chase_acceptance
               WHEN 'chase_tta'             THEN s.median_tta_minutes
             END
        FROM public.leaderboard_standings(_from, _to, _location_ids) s
        CROSS JOIN (SELECT DISTINCT u AS k FROM unnest(_keys) u) x
       WHERE x.k IN (
         'touchpoints','calls_made','contact_attempts','meetings_held','accounts_advanced',
         'stage_advances','cadence_health','new_accounts','accounts_owned','jobs_won',
         'jobs_signed_total','jobs_signed_insurance','jobs_signed_cash','billed_value',
         'collected_value','incidents_dispatched','incidents_accepted','fires_chased',
         'contracts_signed','chase_acceptance','chase_tta');
  END IF;

  FOR k IN SELECT DISTINCT x FROM unnest(COALESCE(_keys, ARRAY[]::text[])) x LOOP
    CASE k

      /* ------------------------------------------------------ Outreach */

      -- Cold calls: call touchpoints (not inbound) and call attempts to an
      -- account that was not yet a client when the call happened.
      WHEN 'cold_calls' THEN
        RETURN QUERY SELECT o.user_id, k, o.n
          FROM public.scorecard_count_outreach(people, _from, _to, ARRAY['call'], ARRAY['call'], 'prospect', true) o;

      -- Calls to an account that was already an active client.
      WHEN 'active_client_calls' THEN
        RETURN QUERY SELECT o.user_id, k, o.n
          FROM public.scorecard_count_outreach(people, _from, _to, ARRAY['call'], ARRAY['call'], 'client', true) o;

      -- Every outbound email, to anyone.
      WHEN 'emails_sent' THEN
        RETURN QUERY SELECT o.user_id, k, o.n
          FROM public.scorecard_count_outreach(people, _from, _to, ARRAY['email'], ARRAY['email'], 'any', true) o;

      -- Cold email outreach: emails to an account not yet a client at the time.
      WHEN 'cold_emails' THEN
        RETURN QUERY SELECT o.user_id, k, o.n
          FROM public.scorecard_count_outreach(people, _from, _to, ARRAY['email'], ARRAY['email'], 'prospect', true) o;

      WHEN 'active_client_emails' THEN
        RETURN QUERY SELECT o.user_id, k, o.n
          FROM public.scorecard_count_outreach(people, _from, _to, ARRAY['email'], ARRAY['email'], 'client', true) o;

      -- Text touchpoints plus SMS attempts on leads.
      WHEN 'texts_sent' THEN
        RETURN QUERY SELECT o.user_id, k, o.n
          FROM public.scorecard_count_outreach(people, _from, _to, ARRAY['text'], ARRAY['sms'], 'any', true) o;

      WHEN 'linkedin_touches' THEN
        RETURN QUERY SELECT o.user_id, k, o.n
          FROM public.scorecard_count_outreach(people, _from, _to, ARRAY['linkedin'], ARRAY[]::text[], 'any', true) o;

      WHEN 'mail_sent' THEN
        RETURN QUERY SELECT o.user_id, k, o.n
          FROM public.scorecard_count_outreach(people, _from, _to, ARRAY['mail'], ARRAY[]::text[], 'any', true) o;

      -- Gifts and seasonal sends: the gift engine writes one touchpoint per send.
      WHEN 'gifts_sent' THEN
        RETURN QUERY SELECT o.user_id, k, o.n
          FROM public.scorecard_count_outreach(people, _from, _to, ARRAY['gift','seasonal_send'], ARRAY[]::text[], 'any', false) o;

      -- Door knocks are contact attempts on fire leads, channel 'door'.
      WHEN 'door_knocks' THEN
        RETURN QUERY SELECT o.user_id, k, o.n
          FROM public.scorecard_count_outreach(people, _from, _to, ARRAY[]::text[], ARRAY['door'], 'any', true) o;

      -- Every contact attempt on a fire lead, any channel.
      WHEN 'lead_contact_attempts' THEN
        RETURN QUERY SELECT o.user_id, k, o.n
          FROM public.scorecard_count_outreach(people, _from, _to, ARRAY[]::text[], all_ca, 'any', true) o;

      -- Mark: "active client messaging, emails, texts, calls, etc" — any
      -- outbound touch of any type to an account that was a client at the time.
      WHEN 'active_client_reach_outs' THEN
        RETURN QUERY SELECT o.user_id, k, o.n
          FROM public.scorecard_count_outreach(people, _from, _to, all_tp, all_ca, 'client', true) o;

      -- The complement: any outbound touch to an account not yet a client.
      WHEN 'prospect_reach_outs' THEN
        RETURN QUERY SELECT o.user_id, k, o.n
          FROM public.scorecard_count_outreach(people, _from, _to, all_tp, all_ca, 'prospect', true) o;

      -- A reply recorded against one of the rep's touchpoints, in the window.
      WHEN 'replies_received' THEN
        RETURN QUERY
          SELECT p.uid, k,
                 (SELECT count(*) FROM public.touchpoints t
                   WHERE t.created_by = p.uid
                     AND t.replied_at >= _from AND t.replied_at < _to
                     AND NOT public.account_is_house_account(t.account_id))::numeric
            FROM unnest(people) AS p(uid);

      -- Contact that came in from the account, logged to the rep.
      WHEN 'inbound_contacts' THEN
        RETURN QUERY
          SELECT p.uid, k,
                 (SELECT count(*) FROM public.touchpoints t
                   WHERE t.created_by = p.uid
                     AND t.direction = 'inbound'
                     AND t.occurred_at >= _from AND t.occurred_at < _to
                     AND NOT public.account_is_house_account(t.account_id))::numeric
            FROM unnest(people) AS p(uid);

      /* ------------------------------------------------------ Meetings */

      -- Face-to-face meetings that happened (meeting_held false = cancelled, excluded by the helper).
      WHEN 'meetings_in_person' THEN
        RETURN QUERY SELECT o.user_id, k, o.n
          FROM public.scorecard_count_outreach(people, _from, _to, ARRAY['meeting_in_person'], ARRAY[]::text[], 'any', false) o;

      WHEN 'meetings_virtual' THEN
        RETURN QUERY SELECT o.user_id, k, o.n
          FROM public.scorecard_count_outreach(people, _from, _to, ARRAY['meeting_virtual'], ARRAY[]::text[], 'any', false) o;

      -- Meetings put on the calendar with an account, plus moves to a
      -- meeting-booked stage (the older relationship pipeline still has one).
      WHEN 'meetings_booked' THEN
        RETURN QUERY
          SELECT p.uid, k,
                 (SELECT count(*) FROM public.calendar_events e
                   WHERE e.created_by = p.uid
                     AND e.account_id IS NOT NULL
                     AND NOT e.is_cancelled
                     AND e.starts_at >= _from AND e.starts_at < _to
                     AND NOT public.account_is_house_account(e.account_id))::numeric
               + m.n
            FROM unnest(people) AS p(uid)
            JOIN public.scorecard_count_stage_moves(people, _from, _to, ARRAY['meeting_booked'], NULL) m
              ON m.user_id = p.uid;

      -- Touchpoints recorded at a place — what the Routes map draws.
      WHEN 'visits_logged' THEN
        RETURN QUERY
          SELECT p.uid, k,
                 (SELECT count(*) FROM public.touchpoints t
                   WHERE t.created_by = p.uid
                     AND t.lat IS NOT NULL
                     AND t.occurred_at >= _from AND t.occurred_at < _to
                     AND NOT public.account_is_house_account(t.account_id))::numeric
            FROM unnest(people) AS p(uid);

      /* ------------------------------------------------------ Pipeline */

      WHEN 'moved_to_active_outreach' THEN
        RETURN QUERY SELECT m.user_id, k, m.n
          FROM public.scorecard_count_stage_moves(people, _from, _to, ARRAY['active_outreach'], NULL) m;

      WHEN 'moved_to_conversation_established' THEN
        RETURN QUERY SELECT m.user_id, k, m.n
          FROM public.scorecard_count_stage_moves(people, _from, _to, ARRAY['conversation_established'], NULL) m;

      -- A prospect became a client: a move into any client stage.
      WHEN 'moved_to_active_client' THEN
        RETURN QUERY SELECT m.user_id, k, m.n
          FROM public.scorecard_count_stage_moves(people, _from, _to, client_stages, NULL) m;

      WHEN 'moved_to_no_service' THEN
        RETURN QUERY SELECT m.user_id, k, m.n
          FROM public.scorecard_count_stage_moves(people, _from, _to, ARRAY['no_service_needed'], NULL) m;

      -- The stage key really is spelled 'goasted' (20260806170640).
      WHEN 'moved_to_ghosted' THEN
        RETURN QUERY SELECT m.user_id, k, m.n
          FROM public.scorecard_count_stage_moves(people, _from, _to, ARRAY['goasted'], NULL) m;

      -- Out of the lead pool into anything that is not the lead pool.
      WHEN 'leads_claimed' THEN
        RETURN QUERY SELECT m.user_id, k, m.n
          FROM public.scorecard_count_stage_moves(people, _from, _to, NULL, lead_pool) m;

      WHEN 'accounts_created' THEN
        RETURN QUERY
          SELECT p.uid, k,
                 (SELECT count(*) FROM public.accounts a
                   WHERE a.created_by = p.uid
                     AND a.created_at >= _from AND a.created_at < _to
                     AND NOT public.account_is_house_account(a.id))::numeric
            FROM unnest(people) AS p(uid);

      -- Cold leads converted: an account the rep owns that moved into a client
      -- stage in the window AND had earlier passed through Active Outreach —
      -- the only thing in the data that says the rep had to open the
      -- conversation. Credited to the assigned rep, not whoever clicked.
      WHEN 'cold_leads_converted' THEN
        RETURN QUERY
          SELECT p.uid, k,
                 (SELECT count(DISTINCT a.id) FROM public.accounts a
                   WHERE a.assigned_rep = p.uid
                     AND NOT public.account_is_house_account(a.id)
                     AND EXISTS (
                       SELECT 1 FROM public.account_stage_history won
                        WHERE won.account_id = a.id
                          AND won.to_stage = ANY(client_stages)
                          AND won.changed_at >= _from AND won.changed_at < _to
                          AND EXISTS (
                            SELECT 1 FROM public.account_stage_history cold
                             WHERE cold.account_id = a.id
                               AND cold.to_stage = 'active_outreach'
                               AND cold.changed_at <= won.changed_at)))::numeric
            FROM unnest(people) AS p(uid);

      -- New deals worked on: distinct accounts whose FIRST outbound touch by
      -- the rep (either table) falls in the window, and that were not a
      -- client at that moment.
      WHEN 'new_deals_worked' THEN
        RETURN QUERY
          WITH touches AS (
            SELECT t.created_by AS uid, t.account_id, t.occurred_at
              FROM public.touchpoints t
             WHERE t.created_by = ANY(people) AND t.direction <> 'inbound'
            UNION ALL
            SELECT c.author_id, c.account_id, c.occurred_at
              FROM public.contact_attempts c
             WHERE c.author_id = ANY(people) AND c.account_id IS NOT NULL
          ),
          first_touch AS (
            SELECT x.uid, x.account_id, min(x.occurred_at) AS at
              FROM touches x
             GROUP BY x.uid, x.account_id
          )
          SELECT p.uid, k,
                 (SELECT count(*) FROM first_touch f
                   WHERE f.uid = p.uid
                     AND f.at >= _from AND f.at < _to
                     AND NOT public.account_is_house_account(f.account_id)
                     AND NOT COALESCE(public.scorecard_account_client_since(f.account_id) <= f.at, false))::numeric
            FROM unnest(people) AS p(uid);

      /* --------------------------------------------------------- Fires */

      WHEN 'incidents_arrived' THEN
        RETURN QUERY
          SELECT p.uid, k,
                 (SELECT count(*) FROM public.incidents i
                   WHERE i.accepted_by = p.uid
                     AND i.arrived_at >= _from AND i.arrived_at < _to
                     AND (i.account_id IS NULL OR NOT public.account_is_house_account(i.account_id)))::numeric
            FROM unnest(people) AS p(uid);

      WHEN 'chase_attempts' THEN
        RETURN QUERY
          SELECT p.uid, k,
                 (SELECT count(*) FROM public.incident_attempts ia
                   WHERE ia.chaser_id = p.uid
                     AND ia.attended_at >= _from AND ia.attended_at < _to)::numeric
            FROM unnest(people) AS p(uid);

      /* --------------------------------------------------------- Money */

      WHEN 'invoices_sent' THEN
        RETURN QUERY
          SELECT p.uid, k,
                 (SELECT count(*) FROM public.invoices inv
                   LEFT JOIN public.jobs j ON j.id = inv.job_id
                   WHERE inv.created_by = p.uid
                     AND inv.sent_at >= _from AND inv.sent_at < _to
                     AND (COALESCE(inv.account_id, j.account_id) IS NULL
                          OR NOT public.account_is_house_account(COALESCE(inv.account_id, j.account_id))))::numeric
            FROM unnest(people) AS p(uid);

      -- Payments are credited through the invoice's account (or its job's
      -- account) to that account's owner, the way billed/collected value is.
      WHEN 'payments_received' THEN
        RETURN QUERY
          SELECT p.uid, k,
                 (SELECT count(*) FROM public.invoice_payments ip
                   JOIN public.invoices inv ON inv.id = ip.invoice_id
                   LEFT JOIN public.jobs j ON j.id = inv.job_id
                   JOIN public.accounts a ON a.id = COALESCE(inv.account_id, j.account_id)
                   WHERE a.assigned_rep = p.uid
                     AND NOT public.account_is_house_account(a.id)
                     AND ip.received_at >= _from AND ip.received_at < _to)::numeric
            FROM unnest(people) AS p(uid);

      WHEN 'payments_collected' THEN
        RETURN QUERY
          SELECT p.uid, k,
                 CASE WHEN money THEN
                   (SELECT COALESCE(sum(ip.amount), 0) FROM public.invoice_payments ip
                     JOIN public.invoices inv ON inv.id = ip.invoice_id
                     LEFT JOIN public.jobs j ON j.id = inv.job_id
                     JOIN public.accounts a ON a.id = COALESCE(inv.account_id, j.account_id)
                     WHERE a.assigned_rep = p.uid
                       AND NOT public.account_is_house_account(a.id)
                       AND ip.received_at >= _from AND ip.received_at < _to)::numeric
                 END
            FROM unnest(people) AS p(uid);

      /* --------------------------------------------------------- Admin */

      WHEN 'tasks_completed' THEN
        RETURN QUERY
          SELECT p.uid, k,
                 (SELECT count(*) FROM public.tasks t
                   WHERE t.assignee = p.uid
                     AND t.status = 'done'
                     AND t.completed_at >= _from AND t.completed_at < _to
                     AND (t.account_id IS NULL OR NOT public.account_is_house_account(t.account_id)))::numeric
            FROM unnest(people) AS p(uid);

      WHEN 'tasks_completed_on_time' THEN
        RETURN QUERY
          SELECT p.uid, k,
                 (SELECT count(*) FROM public.tasks t
                   WHERE t.assignee = p.uid
                     AND t.status = 'done'
                     AND t.completed_at >= _from AND t.completed_at < _to
                     AND (t.due_date IS NULL OR t.completed_at::date <= t.due_date)
                     AND (t.account_id IS NULL OR NOT public.account_is_house_account(t.account_id)))::numeric
            FROM unnest(people) AS p(uid);

      WHEN 'documents_uploaded' THEN
        RETURN QUERY
          SELECT p.uid, k,
                 (SELECT count(*) FROM public.documents d
                   WHERE d.created_by = p.uid
                     AND d.storage_path IS NOT NULL
                     AND d.created_at >= _from AND d.created_at < _to
                     AND (d.account_id IS NULL OR NOT public.account_is_house_account(d.account_id)))::numeric
            FROM unnest(people) AS p(uid);

      WHEN 'documents_sent' THEN
        RETURN QUERY
          SELECT p.uid, k,
                 (SELECT count(*) FROM public.documents d
                   WHERE d.created_by = p.uid
                     AND d.sent_at >= _from AND d.sent_at < _to
                     AND (d.account_id IS NULL OR NOT public.account_is_house_account(d.account_id)))::numeric
            FROM unnest(people) AS p(uid);

      WHEN 'documents_signed' THEN
        RETURN QUERY
          SELECT p.uid, k,
                 (SELECT count(*) FROM public.documents d
                   WHERE d.created_by = p.uid
                     AND d.signed_at >= _from AND d.signed_at < _to
                     AND (d.account_id IS NULL OR NOT public.account_is_house_account(d.account_id)))::numeric
            FROM unnest(people) AS p(uid);

      WHEN 'notes_written' THEN
        RETURN QUERY
          SELECT p.uid, k,
                 ((SELECT count(*) FROM public.account_notes an
                    WHERE an.created_by = p.uid
                      AND an.created_at >= _from AND an.created_at < _to
                      AND NOT public.account_is_house_account(an.account_id))
                + (SELECT count(*) FROM public.job_notes jn
                    WHERE jn.author_id = p.uid
                      AND jn.created_at >= _from AND jn.created_at < _to)
                + (SELECT count(*) FROM public.lead_notes ln
                    WHERE ln.author_id = p.uid
                      AND ln.created_at >= _from AND ln.created_at < _to))::numeric
            FROM unnest(people) AS p(uid);

      -- Anything else is not an action this function knows. Ignored on
      -- purpose: an unknown key must not produce an error that names tables.
      ELSE NULL;
    END CASE;
  END LOOP;
END $$;

REVOKE ALL ON FUNCTION public.scorecard_action_counts(timestamptz, timestamptz, text[], uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.scorecard_action_counts(timestamptz, timestamptz, text[], uuid[]) TO authenticated;

COMMENT ON FUNCTION public.scorecard_action_counts(timestamptz, timestamptz, text[], uuid[]) IS
  'Per-person actuals for catalogue action keys (src/lib/action-catalogue.ts). The key→query mapping is the CASE in this function; the client only ever sends keys. Unknown keys are ignored. Scoped by can_view_location; currency is NULL unless scorecard_money_visible(); house accounts never count toward a rep.';
