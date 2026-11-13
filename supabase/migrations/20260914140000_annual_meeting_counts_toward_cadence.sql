-- A cancelled meeting held the annual visit off for a year.
--
-- WRITTEN, NOT APPLIED. One view replaced. No table, column, policy or grant
-- change, and nothing is dropped.
--
-- ============================================================================
-- THE BUG
-- ============================================================================
--
-- `account_fire_rollup.last_in_person_at` is
--
--   max(tp.occurred_at) FILTER (WHERE tp.type = 'meeting_in_person')
--
-- with no check of `counts_toward_cadence`. That column is set on write by
-- `tg_touchpoint_cadence` (20260806171901), and for a meeting it is
--
--   COALESCE(NEW.meeting_held, NEW.capture_source <> 'calendar')
--
-- so a calendar meeting the client CANCELLED carries false. Feeding it to the
-- annual clock means a meeting that did not happen satisfies the yearly visit,
-- and the account goes quiet for another 365 days on the strength of a
-- cancellation. It is the same class of bug as an unanswered outbound email
-- resetting the 90-day clock, which 20260914-phase-A fixed on the other clock.
--
-- BOTH SIDES ARE FIXED TOGETHER, which is the point of doing it here. Phase 1
-- found this and deliberately did NOT fix the TypeScript alone, because
-- `src/lib/cadence-sweep.ts` matched this view exactly and changing one would
-- have created the board-vs-sweep disagreement that work existed to end. This
-- migration and the `countsTowardCadence` check added to `lastTouchAndMeeting`
-- in the same commit are the two halves; neither is correct without the other.
--
-- ONLY `last_in_person_at` CHANGES. `last_touch_at` in the same LATERAL stays
-- unfiltered ON PURPOSE. This view is the fire-leads rollup, and `touch_count`
-- and `last_touch_at` there answer "when did anyone last contact this account
-- at all" — a provenance question, not a cadence one. The cadence-counting
-- answer is computed where it is used (`src/lib/active-clients.ts` and the
-- nightly sweep both filter it themselves), so narrowing it here would change a
-- number a different feature reads to mean something it does not want. The
-- annual clock is the only consumer of `last_in_person_at`.
--
-- The view is otherwise reproduced VERBATIM from 20260820175922, which is the
-- newest migration that defines its body. `security_invoker = true` is
-- re-applied afterwards because 20260821175812 set it and a DROP/CREATE would
-- otherwise silently drop it — that flag is the reason this view is safe to
-- expose at all, so losing it would be a security regression hidden inside a
-- health fix.
--
-- DEFERRED: Phase 3 (Critical workflow) and Phase 4 (commission). Nothing here
-- creates a task or an escalation; it only makes the annual clock honest.
--
-- RE-RUNNABLE. DROP VIEW IF EXISTS + CREATE VIEW + ALTER, the same shape
-- 20260820175922 uses. Applying twice is identical to applying once.

DROP VIEW IF EXISTS public.account_fire_rollup;

CREATE VIEW public.account_fire_rollup AS
 SELECT a.id AS account_id,
    a.name,
    a.status,
    a.stage,
    a.stage_id,
    a.pipeline_id,
    a.priority,
    a.estimated_annual_value,
    a.account_type,
    a.location_id,
    a.assigned_rep,
    a.notes,
    a.updated_at,
    COALESCE(l.lead_count, 0::bigint) AS lead_count,
    COALESCE(l.open_count, 0::bigint) AS open_count,
    l.last_loss_date,
    COALESCE(l.units_vacated, 0::bigint) AS units_vacated,
    l.mailing_address,
    c.primary_contact_id,
    c.primary_contact_name,
    c.primary_contact_email,
    c.primary_contact_phone,
    t.last_touch_at,
    t.last_in_person_at,
    COALESCE(t.touch_count, 0::bigint) AS touch_count,
    a.approval_state,
    a.approval_due_on
   FROM accounts a
     LEFT JOIN LATERAL ( SELECT count(*) AS lead_count,
            count(*) FILTER (WHERE fl.status = 'open'::lead_status AND fl.rescind_date IS NULL) AS open_count,
            max(fl.incident_date) AS last_loss_date,
            COALESCE(sum(fl.units_vacated), 0::bigint) AS units_vacated,
            (array_remove(array_agg(fl.owner_mailing_address ORDER BY fl.incident_date DESC NULLS LAST), NULL::text))[1] AS mailing_address
           FROM fire_leads fl
          WHERE fl.account_id = a.id) l ON true
     LEFT JOIN LATERAL ( SELECT ct.id AS primary_contact_id,
            ct.full_name AS primary_contact_name,
            ct.email AS primary_contact_email,
            ct.phone AS primary_contact_phone
           FROM contacts ct
          WHERE ct.account_id = a.id
          ORDER BY ct.is_primary DESC, ct.created_at
         LIMIT 1) c ON true
     LEFT JOIN LATERAL ( SELECT max(tp.occurred_at) AS last_touch_at,
            max(tp.occurred_at) FILTER (
              WHERE tp.type = 'meeting_in_person'::touchpoint_type
                AND tp.counts_toward_cadence
            ) AS last_in_person_at,
            count(*) AS touch_count
           FROM touchpoints tp
          WHERE tp.account_id = a.id) t ON true;

ALTER VIEW public.account_fire_rollup SET (security_invoker = true);
GRANT SELECT ON public.account_fire_rollup TO authenticated;
GRANT ALL ON public.account_fire_rollup TO service_role;

COMMENT ON VIEW public.account_fire_rollup IS
  'Per-account fire-lead rollup with contact and touch provenance. last_in_person_at counts only meetings that count toward cadence, so a cancelled calendar meeting does not satisfy the annual visit (20260914140000); last_touch_at is deliberately unfiltered and answers "did anyone contact this account at all".';

-- ===========================================================================
-- Verification after applying
-- ===========================================================================
--
--   -- 1. The filter is in the view body, and security_invoker survived.
--   SELECT pg_get_viewdef('public.account_fire_rollup'::regclass, true)
--            LIKE '%counts_toward_cadence%' AS filtered,
--          reloptions
--     FROM pg_class WHERE oid = 'public.account_fire_rollup'::regclass;
--   -- expected: true, {security_invoker=true}
--
--   -- 2. Accounts whose annual clock was being held off by a meeting that did
--   --    not happen. These are the ones that will correctly become due.
--   SELECT tp.account_id, max(tp.occurred_at) AS last_not_held
--     FROM public.touchpoints tp
--    WHERE tp.type = 'meeting_in_person' AND NOT tp.counts_toward_cadence
--    GROUP BY tp.account_id
--   EXCEPT
--   SELECT tp.account_id, max(tp.occurred_at)
--     FROM public.touchpoints tp
--    WHERE tp.type = 'meeting_in_person' AND tp.counts_toward_cadence
--    GROUP BY tp.account_id;
--
-- OFFLINE PROOF. The TypeScript half is covered by
-- src/lib/cadence-sweep.test.ts ("a not-held meeting does not satisfy the
-- annual clock"); this view is covered by
--   node supabase/tests/annual-meeting-cadence.pglite.mjs node_modules/@electric-sql/pglite/dist/index.js
-- and the same script runs inside `npx vitest run`.
--
-- Rollback (restores the bug — only to prove causation):
--   re-apply the view body from 20260820175922 verbatim, then
--   ALTER VIEW public.account_fire_rollup SET (security_invoker = true);
