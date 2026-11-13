-- A client signed this morning was marked Healthy. It should be Watch.
--
-- WRITTEN, NOT APPLIED. One function replaced. No table, column, policy, grant
-- or trigger change, and nothing is dropped.
--
-- ============================================================================
-- THE BUG
-- ============================================================================
--
-- `pipeline_activate_client` is what converts a prospect into an active client.
-- On conversion it sets
--
--   health_stage_id = coalesce(healthy, health_stage_id)
--
-- i.e. the brand-new client's stored health band is HEALTHY, on day one.
--
-- Mark's spec, item 18, says the opposite: "a new client starts at Watch, never
-- Healthy". The reason is that on day one the paperwork is BY DEFINITION not in
-- place — the certificate has not been sent, the W9 has not come back, the
-- vendor agreement is unsigned. A green card on a client signed this morning is
-- a claim nobody has earned, and it is exactly what lets an onboarding stall
-- for two months with the board showing a healthy account the whole time.
--
-- THE FIX. Seed the stored stage at `needs_attention`, which is the Farming
-- stage that asserts Watch — `HEALTH_TO_FARMING_STAGE_KEY.monitoring` in
-- src/lib/client-health.ts, and the same key a rep's hand move writes. It falls
-- back to `healthy` and then to whatever is already stored, so an office whose
-- Farming pipeline has no Needs Attention stage keeps today's behaviour rather
-- than activating with no health stage at all.
--
-- WHY THIS IS ONLY HALF OF THE ONBOARDING BAND, and where the other half is.
-- A stored stage is a FLOOR, not a schedule: `computeClientHealth` lets a
-- stored stage make the verdict worse than the metric says and never better,
-- so this alone would pin a new client at Watch and leave it there forever. The
-- 30-day and 60-day escalation, and the fact that the floor LIFTS the moment
-- the last document lands, are computed in TypeScript from the compliance rows
-- — `onboardingBand` in src/lib/client-health-tracks.ts. That is deliberate:
-- "still incomplete" is a question about outstanding requirements, which change
-- continuously, and a stored column would have to be swept to stay true.
-- This function's job is only to stop the record starting green.
--
-- The body is otherwise reproduced VERBATIM from 20260909140100, including
-- SECURITY INVOKER and `SET search_path = ''` — the RPC runs as the rep, and
-- RLS on `accounts` is what decides whether they may activate this record.
--
-- DEFERRED: Phase 3 (Critical workflow) and Phase 4 (commission). This makes a
-- band reachable; it triggers nothing.
--
-- RE-RUNNABLE. CREATE OR REPLACE only. Applying twice is identical to once, and
-- it changes no existing row — a client already activated keeps the band it
-- has, because this only affects the moment of conversion.
CREATE OR REPLACE FUNCTION public.pipeline_activate_client(
  _account_id uuid,
  _green_light_date date DEFAULT current_date
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  won uuid;
  farming uuid;
  healthy uuid;
  watching uuid;
  glow date := coalesce(_green_light_date, current_date);
BEGIN
  IF glow > current_date THEN
    RAISE EXCEPTION 'The green-light date cannot be in the future.' USING ERRCODE = '22023';
  END IF;

  SELECT w.id INTO won
    FROM public.accounts a
    JOIN public.pipeline_stages s ON s.id = a.stage_id
    JOIN public.pipeline_stages w ON w.pipeline_id = s.pipeline_id AND w.is_won AND w.is_active
   WHERE a.id = _account_id
   ORDER BY (w.key = 'active_client') DESC, w.sort_order
   LIMIT 1;
  IF won IS NULL THEN
    RAISE EXCEPTION 'This pipeline has no Active Client stage.' USING ERRCODE = '22023';
  END IF;

  SELECT h.pipeline_id, h.id INTO farming, healthy
    FROM public.pipeline_stages h
    JOIN public.pipelines p ON p.id = h.pipeline_id
   WHERE h.key = 'healthy' AND h.is_active AND p.is_active
   ORDER BY (p.id = '33333333-3333-4333-8333-333333333333'::uuid) DESC
   LIMIT 1;

  -- A new client starts at Watch, not Healthy: on day one the paperwork is by
  -- definition not in place. `needs_attention` is the Farming stage that
  -- asserts Watch (HEALTH_TO_FARMING_STAGE_KEY.monitoring).
  SELECT h.id INTO watching
    FROM public.pipeline_stages h
    JOIN public.pipelines p ON p.id = h.pipeline_id
   WHERE h.key = 'needs_attention' AND h.is_active AND p.is_active
   ORDER BY (p.id = '33333333-3333-4333-8333-333333333333'::uuid) DESC
   LIMIT 1;

  UPDATE public.accounts
     SET stage_id = won,
         status = 'active',
         green_light_date = glow,
         health_pipeline_id = coalesce(farming, health_pipeline_id),
         health_stage_id = coalesce(watching, healthy, health_stage_id),
         health_changed_at = glow::timestamptz,
         annual_meeting_due_on = coalesce(annual_meeting_due_on, (glow + interval '1 year')::date),
         lost_reason = 'Green light ' || to_char(glow, 'YYYY-MM-DD')
   WHERE id = _account_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The account could not be activated.' USING ERRCODE = '42501';
  END IF;

  -- The stage-history trigger has copied the reason from the first update.
  UPDATE public.accounts SET lost_reason = NULL WHERE id = _account_id;
END;
$$;

-- ===========================================================================
-- Verification after applying
-- ===========================================================================
--
--   -- 1. The function seeds Watch, not Healthy.
--   SELECT prosrc LIKE '%coalesce(watching, healthy, health_stage_id)%' AS starts_at_watch
--     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public' AND p.proname = 'pipeline_activate_client';
--   -- expected: true
--
--   -- 2. The stage it seeds actually exists on the Farming pipeline.
--   SELECT h.id, h.key, h.is_active FROM public.pipeline_stages h
--     JOIN public.pipelines p ON p.id = h.pipeline_id
--    WHERE h.key IN ('healthy','needs_attention') AND p.is_active;
--   -- expected: both present and active; if needs_attention is missing the
--   -- function falls back to healthy and behaviour is unchanged.
--
-- BEHAVIOUR (in a transaction, rolled back):
--   BEGIN;
--   SELECT public.pipeline_activate_client('<prospect id>', current_date);
--   SELECT s.key FROM public.accounts a
--     JOIN public.pipeline_stages s ON s.id = a.health_stage_id
--    WHERE a.id = '<prospect id>';
--   -- expected: needs_attention
--   ROLLBACK;
--
-- Rollback: re-apply the function body from 20260909140100 verbatim.
