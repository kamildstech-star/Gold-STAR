-- Past-lead search has failed for every chaser since 20 August. Both functions
-- behind it now return what the column actually holds.
--
-- `search_my_past_leads` and `my_past_lead_summary` raised, on every call:
--
--   42P13: return type mismatch in function declared to return record
--   DETAIL: Final statement returns text instead of incident_type at column 5.
--
-- 20260820175922 moved `incidents.incident_type` from the `incident_type` enum
-- to text, so an admin can add a kind of loss through the managed option list
-- (`option_lists` key 'incident_type') without a migration. The column moved;
-- these two functions still declared the enum, and selected the column
-- straight through. A SQL function checks its final statement against its
-- declared columns at startup, so neither ever returned a row.
--
-- The fix is to declare text, not to cast back to the enum. Every one of the 76
-- incidents holds a value the enum knows today (fire, water, smoke, storm,
-- other), so a cast would work this morning and break the first time someone
-- adds a type through the very list the column was changed to allow.
--
-- CREATE OR REPLACE cannot change a function's return type, so each is dropped
-- and recreated. The bodies below are the deployed ones, unchanged except for
-- that one column. DROP takes the grants with it; they are restored exactly as
-- they were -- authenticated and service_role, never anon or PUBLIC, which is
-- what 20260924120000 (the anon revoke sweep) left them at.
--
-- The client already reads the field as a string (`String(r.incident_type)` in
-- chase.past-leads.tsx), so nothing on the page changes but that it works.
--
-- Also dropped: the older of the two `log_incident_outcome` overloads.
--
--   (uuid,uuid,uuid,text,boolean,timestamptz,text)   _note 4th, _sub_label 7th
--   (uuid,uuid,uuid,text,text,boolean,timestamptz)   _sub_label 4th, _note 5th
--
-- Two overloads whose named parameters overlap make PostgREST refuse the call
-- outright (PGRST203). Nothing calls the first. The only caller in the
-- database is `apply_offline_op`, which passes seven positional arguments with
-- text in the fifth place -- a text cannot become the first overload's
-- boolean, so it has only ever resolved to the second. Nothing in src/ calls
-- either by name. The two bodies are independent (neither calls the other),
-- so the survivor does not depend on the one going. Checked against the live
-- database on 2026-10-05, not inferred from the migration history.

BEGIN;

-- ---------------------------------------------------------------- search

DROP FUNCTION IF EXISTS public.search_my_past_leads(text, text);

CREATE FUNCTION public.search_my_past_leads(_q text, _type text DEFAULT NULL::text)
 RETURNS TABLE(id uuid, address text, locality text, postal_code text, incident_type text, reported_at timestamp with time zone, accepted_at timestamp with time zone, arrived_at timestamp with time zone, outcome incident_outcome, lifecycle incident_lifecycle, attempt_count integer, is_masked boolean, status_code text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH mine AS (
    SELECT i.id, i.address, i.locality, i.postal_code, i.incident_type,
           i.reported_at, i.accepted_at, i.arrived_at, i.outcome, i.lifecycle,
           i.accepted_by,
           (i.reported_at <= now() - make_interval(days => public.chase_setting_num('past_lead_search_days', 14)::integer)) AS masked
      FROM public.incidents i
     WHERE auth.uid() IS NOT NULL
       AND (
         i.accepted_by = auth.uid()
         OR EXISTS (SELECT 1 FROM public.incident_attempts a
                     WHERE a.incident_id = i.id AND a.chaser_id = auth.uid())
         OR EXISTS (SELECT 1 FROM public.incident_dispatches d
                     WHERE d.incident_id = i.id AND d.user_id = auth.uid()
                       AND d.response IN ('declined','declined_race','no_action'))
       )
       AND public.incident_market_allowed(auth.uid(), i.market_id)
       AND length(btrim(coalesce(_q, ''))) >= public.chase_setting_num('search_min_chars', 3)::integer
       AND i.reported_at > now() - make_interval(days => public.chase_setting_num('past_lead_archive_days', 180)::integer)
       AND (_type IS NULL OR _type = '' OR _type = 'all' OR i.incident_type::text = _type)
       AND (i.address ILIKE '%' || btrim(_q) || '%' OR i.postal_code ILIKE btrim(_q) || '%' OR i.locality ILIKE btrim(_q) || '%')
  )
  SELECT m.id,
         CASE WHEN m.masked THEN public.mask_past_lead_address(m.address) ELSE m.address END,
         CASE WHEN m.masked THEN NULL ELSE m.locality END,
         CASE WHEN m.masked THEN NULL ELSE m.postal_code END,
         m.incident_type, m.reported_at,
         CASE WHEN m.masked THEN NULL ELSE m.accepted_at END,
         CASE WHEN m.masked THEN NULL ELSE m.arrived_at END,
         CASE WHEN m.masked THEN NULL ELSE m.outcome END,
         m.lifecycle,
         (SELECT count(*)::integer FROM public.incident_attempts a
           WHERE a.incident_id = m.id AND a.chaser_id = auth.uid()),
         m.masked,
         CASE WHEN m.masked THEN 'office_only'
              WHEN m.accepted_by = auth.uid() THEN 'view_only'
              WHEN m.accepted_by IS NOT NULL THEN 'claimed_elsewhere'
              ELSE 'view_only' END
    FROM mine m
   ORDER BY m.reported_at DESC
   LIMIT LEAST(public.chase_setting_num('search_result_limit', 20)::integer, 20);
$function$;

REVOKE ALL ON FUNCTION public.search_my_past_leads(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.search_my_past_leads(text, text) TO authenticated, service_role;

-- --------------------------------------------------------------- summary

DROP FUNCTION IF EXISTS public.my_past_lead_summary(uuid);

CREATE FUNCTION public.my_past_lead_summary(_id uuid)
 RETURNS TABLE(id uuid, address text, locality text, postal_code text, incident_type text, reported_at timestamp with time zone, accepted_at timestamp with time zone, arrived_at timestamp with time zone, outcome incident_outcome, lifecycle incident_lifecycle, is_masked boolean, my_attempts jsonb)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH one AS (
    SELECT i.*, (i.reported_at <= now() - make_interval(days => public.chase_setting_num('past_lead_search_days', 14)::integer)) AS masked
      FROM public.incidents i
     WHERE i.id = _id
       AND auth.uid() IS NOT NULL
       AND (
         i.accepted_by = auth.uid()
         OR EXISTS (SELECT 1 FROM public.incident_attempts a
                     WHERE a.incident_id = i.id AND a.chaser_id = auth.uid())
         OR EXISTS (SELECT 1 FROM public.incident_dispatches d
                     WHERE d.incident_id = i.id AND d.user_id = auth.uid())
       )
       AND public.incident_market_allowed(auth.uid(), i.market_id)
  )
  SELECT o.id,
         CASE WHEN o.masked THEN public.mask_past_lead_address(o.address) ELSE o.address END,
         CASE WHEN o.masked THEN NULL ELSE o.locality END,
         CASE WHEN o.masked THEN NULL ELSE o.postal_code END,
         o.incident_type, o.reported_at,
         CASE WHEN o.masked THEN NULL ELSE o.accepted_at END,
         CASE WHEN o.masked THEN NULL ELSE o.arrived_at END,
         CASE WHEN o.masked THEN NULL ELSE o.outcome END,
         o.lifecycle, o.masked,
         CASE WHEN o.masked THEN '[]'::jsonb ELSE COALESCE((
           SELECT jsonb_agg(jsonb_build_object(
                    'at', a.attended_at, 'reason', a.reason_label,
                    'sub_reason', a.sub_reason_label, 'note', a.note,
                    'kept_live', a.kept_live)
                  ORDER BY a.attended_at DESC)
             FROM public.incident_attempts a
            WHERE a.incident_id = o.id AND a.chaser_id = auth.uid()
         ), '[]'::jsonb) END
    FROM one o;
$function$;

REVOKE ALL ON FUNCTION public.my_past_lead_summary(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_past_lead_summary(uuid) TO authenticated, service_role;

-- ------------------------------------------------- the unreachable overload

DROP FUNCTION IF EXISTS public.log_incident_outcome(uuid, uuid, uuid, text, boolean, timestamp with time zone, text);

COMMIT;
