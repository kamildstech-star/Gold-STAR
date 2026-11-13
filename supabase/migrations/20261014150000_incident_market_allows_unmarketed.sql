-- Alerts with no market can be claimed by any chaser.
--
-- WRITTEN, NOT APPLIED. One function body. Re-runnable (CREATE OR REPLACE).
--
-- Live, 14 Oct: a chaser whose territory is "New York City · whole market"
-- pressed Accept on the fire-feed alert at 29 Calvert Dr, Viola 10952
-- (Rockland County) and got "Could not accept". The alert has market_id NULL:
-- markets exist only for New York City, Los Angeles and Philadelphia, so
-- Rockland and New Jersey fire-feed incidents get no market. claim_incident
-- raises 'Out of market' when NOT incident_market_allowed(uid, market_id), and
-- the old body returned false for ANY chaser with a territory when the
-- incident had no market. The board already shows market-less alerts to a
-- whole-market chaser (inDispatchScope in src/lib/territory.ts only excludes a
-- DIFFERENT market), so the board offered a claim the database refused.
--
-- The change: an incident with no market is allowed for everyone. When the
-- incident HAS a market the rule is unchanged — a chaser with a territory is
-- held to their own market, a user with no territory row sees every market.
--
-- Based on the newest repo definition (20260812145532, made PARALLEL SAFE by
-- 20260820071015), whose body is byte-identical to live (md5(prosrc)
-- 07b58d83f35ca5fff378a85d66456dbb, checked 14 Oct). Language, volatility,
-- SECURITY DEFINER, PARALLEL SAFE and search_path are kept; CREATE OR REPLACE
-- keeps the existing ACL, and the GRANT below is the original one.
--
-- Every caller sees market-less incidents as in-market from now on:
--   claim_incident, release_incident_claim, log_incident_outcome,
--   create_exposure_incident  -> no longer raise 'Out of market' for them;
--   search_chase_incidents, search_my_past_leads, my_past_lead_summary
--                             -> return them (their other filters still apply);
--   RLS incidents_select, incident_attempts_select, incident_notes_select,
--   incident_property_lookups_select
--                             -> the market wall stops hiding them; the rest of
--                                each policy (accepted_by / created_by /
--                                location visibility, or privileged) still
--                                decides visibility.

CREATE OR REPLACE FUNCTION public.incident_market_allowed(_user_id uuid, _market_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
PARALLEL SAFE
SET search_path = public
AS $$
  SELECT CASE
    WHEN _market_id IS NULL THEN true
    WHEN (SELECT market_id FROM public.chaser_territories WHERE user_id = _user_id) IS NULL THEN true
    ELSE _market_id = (SELECT market_id FROM public.chaser_territories WHERE user_id = _user_id)
  END
$$;

GRANT EXECUTE ON FUNCTION public.incident_market_allowed(uuid, uuid) TO authenticated;
