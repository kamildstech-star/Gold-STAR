-- Compliance needs a clock, and had no date to start one from.
--
-- WRITTEN, NOT APPLIED. One column, one backfill, one view replaced. Nothing
-- is dropped and no existing row changes meaning.
--
-- ============================================================================
-- WHY
-- ============================================================================
--
-- Phase 2 bands compliance by DAYS OUTSTANDING. The spec is explicit about
-- where the clock starts:
--
--   never delivered -> the REQUEST date
--   lapsed          -> the EXPIRY date
--
-- The expiry half already exists (`effective_expiry` on
-- `account_compliance_status`). The request half did not exist at all, which
-- is why Phase 1 could only map STATES and said so: a document requested this
-- morning and one missing since spring both read `missing`, so the card
-- over-alarmed on the first and under-alarmed on the second.
--
-- Phase 1 deliberately did NOT add this column, on the grounds that a column
-- nobody reads is schema nobody maintains. This is the phase that reads it.
--
-- ============================================================================
-- THE BACKFILL RULE, and why it is `created_at`
-- ============================================================================
--
-- `requested_at` defaults to `now()` for new rows and is backfilled to
-- `created_at` for existing ones. A requirement row exists because somebody
-- decided Gold Star needs this document on this account, and the day that
-- decision was recorded is the day it was asked for. There is no better
-- candidate in the data, and the alternatives are worse:
--
--   * NULL would make every pre-existing outstanding document unageable, and
--     the TypeScript band treats an unageable outstanding document as Watch —
--     so a certificate missing since spring would quietly DROP from At Risk to
--     Watch the day this ships. Backfilling avoids a regression disguised as a
--     migration.
--   * now() would reset every existing chase to day zero and hide exactly the
--     long-outstanding paperwork this phase exists to surface.
--
-- `created_at` can only ever be EARLIER than the true request date, so the
-- backfill errs toward showing a document as MORE overdue than it is, never
-- less. That is the safe direction for a compliance clock: the failure mode is
-- someone chasing a document that was actually asked for last week, not a
-- lapsed certificate sitting green.
--
-- ============================================================================
-- DEFERRED
-- ============================================================================
--
--   Phase 3  The Critical workflow — recovery task, the manager's Critical
--            list, the 30-day window and the day-30 decision, the >20% rep cap.
--            This migration makes the Critical BAND reachable by metric, which
--            it never was before; it triggers nothing.
--   Phase 4  Commission by account stage at job arrival. Untouched.
--
-- FINANCE STILL DOES NOT FEED HEALTH. `requested_at` is a date, not a sum.
-- Nothing added here is financial, and `required_amount` remains an insurance
-- LIMIT rather than money owed.
--
-- RE-RUNNABLE. ADD COLUMN IF NOT EXISTS, a backfill guarded on IS NULL, and a
-- DROP/CREATE view. Applying twice is identical to applying once — the second
-- run backfills nothing because the first left no NULLs.

ALTER TABLE public.account_compliance_requirements
  ADD COLUMN IF NOT EXISTS requested_at timestamptz;

UPDATE public.account_compliance_requirements
   SET requested_at = created_at
 WHERE requested_at IS NULL;

ALTER TABLE public.account_compliance_requirements
  ALTER COLUMN requested_at SET DEFAULT now();

COMMENT ON COLUMN public.account_compliance_requirements.requested_at IS
  'When this document was asked for. Start of the outstanding clock for a requirement that was never delivered; a lapsed one ages from its expiry date instead. Backfilled from created_at by 20260914130000.';

-- The view gains requested_at so one read can age every requirement. Otherwise
-- verbatim from 20260914120000 (which added `direction` and stopped Gold
-- Star's own credentials answering a client-owed row).

DROP VIEW IF EXISTS public.account_compliance_status;
CREATE VIEW public.account_compliance_status
WITH (security_invoker = true) AS
SELECT r.id AS requirement_id,
  r.account_id,
  a.name AS account_name,
  a.location_id,
  r.requirement_type,
  r.direction,
  r.requested_at,
  r.mandatory,
  r.required_amount,
  r.required_currency,
  r.required_value,
  r.must_name_account,
  r.renewal_lead_days,
  r.notes,
  c.id AS credential_id,
  c.category,
  c.kind,
  c.name AS credential_name,
  c.document_id,
  c.issuer,
  c.carrier,
  c.policy_number,
  c.effective_date,
  c.expiry_date,
  c.limit_occurrence AS covered_amount,
  c.limit_aggregate,
  c.currency,
  c.state_code,
  c.holder_location_id,
  c.holder_user_id,
  f.id AS cert_file_id,
  f.file_name AS cert_file_name,
  f.expiry_date AS cert_expiry_date,
  f.policy_number AS cert_policy_number,
  LEAST(c.expiry_date, f.expiry_date) AS effective_expiry,
  LEAST(c.expiry_date, f.expiry_date) - CURRENT_DATE AS days_to_expiry,
  public.compliance_status_of(
    (c.id IS NOT NULL OR f.id IS NOT NULL),
    LEAST(c.expiry_date, f.expiry_date),
    c.limit_occurrence, r.required_amount, r.renewal_lead_days) AS status
FROM public.account_compliance_requirements r
JOIN public.accounts a ON a.id = r.account_id
LEFT JOIN LATERAL (
  SELECT cc.* FROM public.company_credentials cc
  WHERE r.direction = 'gsr_to_client'
    AND cc.active AND cc.kind = r.requirement_type
    AND (cc.holder_location_id IS NULL OR cc.holder_location_id = a.location_id
         OR EXISTS (SELECT 1 FROM public.account_locations al
                    WHERE al.account_id = a.id AND al.location_id = cc.holder_location_id))
  ORDER BY (cc.limit_occurrence IS NOT NULL AND r.required_amount IS NOT NULL
            AND cc.limit_occurrence >= r.required_amount) DESC,
           cc.expiry_date DESC NULLS LAST, cc.created_at DESC
  LIMIT 1) c ON true
LEFT JOIN LATERAL (
  SELECT ff.* FROM public.compliance_requirement_files ff
  WHERE ff.requirement_id = r.id AND ff.slot = 'certificate' AND ff.is_current
  ORDER BY ff.created_at DESC LIMIT 1) f ON true
WHERE r.active;

GRANT SELECT ON public.account_compliance_status TO authenticated;

COMMENT ON VIEW public.account_compliance_status IS
  'One row per active account compliance requirement, in both directions, with the document answering it, when it was requested, and the derived status. A client_to_gsr row is never matched against company_credentials. See 20260914120000 and 20260914130000.';

-- ===========================================================================
-- Verification after applying
-- ===========================================================================
--
--   -- 1. Nothing is left unageable.
--   SELECT count(*) FILTER (WHERE requested_at IS NULL) AS unageable,
--          count(*) AS total
--     FROM public.account_compliance_requirements;
--   -- expected: unageable = 0
--
--   -- 2. The backfill used the row's own creation date, not today.
--   SELECT count(*) FROM public.account_compliance_requirements
--    WHERE requested_at <> created_at;
--   -- expected: 0 immediately after applying
--
--   -- 3. What is actually outstanding, and for how long — the number the
--   --    Critical band now reads.
--   SELECT requirement_type, direction, status,
--          CASE status
--            WHEN 'expired' THEN CURRENT_DATE - effective_expiry
--            WHEN 'missing' THEN CURRENT_DATE - requested_at::date
--            WHEN 'insufficient' THEN CURRENT_DATE - requested_at::date
--          END AS days_outstanding
--     FROM public.account_compliance_status
--    WHERE status <> 'satisfied'
--    ORDER BY days_outstanding DESC NULLS LAST;
--
-- OFFLINE PROOF:
--   node supabase/tests/compliance-direction.pglite.mjs node_modules/@electric-sql/pglite/dist/index.js
-- which applies this migration after 20260914120000 and checks the backfill,
-- the default and that the view exposes the column.
--
-- Rollback:
--   ALTER TABLE public.account_compliance_requirements DROP COLUMN requested_at;
--   then re-apply the view from 20260914120000 verbatim.
