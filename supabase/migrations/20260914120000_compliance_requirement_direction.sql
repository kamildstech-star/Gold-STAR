-- Paperwork has two directions. The schema only ever had one.
--
-- WRITTEN, NOT APPLIED. One column, one constraint swap, one view replaced.
-- No data is deleted and no existing row changes meaning.
--
-- ============================================================================
-- WHY
-- ============================================================================
--
-- Phase 1 of the two-track client-health build needs a compliance band per
-- account covering BOTH directions of paperwork:
--
--   (a) what GSR owes the CLIENT   — the certificate of insurance, W9, signed
--                                    vendor agreement a property manager needs
--                                    on file before GSR stays on their approved
--                                    vendor list.
--   (b) what the CLIENT owes GSR   — the signed agreement, W9, purchase order
--                                    or carrier authorisation GSR is waiting on
--                                    before it can bill or proceed.
--
-- `public.account_compliance_requirements` today models ONLY (a). Every row is
-- satisfied by a `company_credentials` row — GSR's OWN insurance and licences —
-- or by a certificate filed against the account. `src/lib/compliance.ts` says
-- so in its header: "what Gold Star must hold to stay on a property manager's
-- approved list".
--
-- THE INVERSE THAT ALREADY EXISTS IS NOT THIS ONE. `src/lib/vendors.ts` calls
-- itself "the inverse of compliance.ts", and it is — but it is
-- SUBCONTRACTOR-owes-GSR (`vendor_documents`, keyed to a subcontractor, asking
-- what they must hold before GSR puts them on a loss). That is a third party in
-- a different relationship. Reusing it for "the client owes us" would attribute
-- a subcontractor's missing COI to the client's health card, so it is
-- deliberately untouched by this migration and by the track that reads it.
--
-- ============================================================================
-- WHAT THIS CHANGES
-- ============================================================================
--
-- 1. `direction` on `account_compliance_requirements`, defaulting to
--    'gsr_to_client'. Every existing row therefore keeps exactly the meaning it
--    has today, which is what makes this safe to apply to live data: the column
--    is additive and the default is the status quo.
--
-- 2. The uniqueness rule widens from (account_id, requirement_type) to
--    (account_id, requirement_type, direction). Without this the model cannot
--    express the ordinary case — GSR owes the client a W9 AND the client owes
--    GSR a W9 — because the second insert would collide with the first. This is
--    the only structural change, and it is a widening: nothing that inserts
--    today can start failing.
--
-- 3. `account_compliance_status` gains `direction`, and — the part that is a
--    correctness fix rather than a passthrough — STOPS matching GSR's own
--    credentials against client-owed rows. The view satisfies a requirement
--    from `company_credentials` by `kind = requirement_type`. Left alone, a
--    client-owed 'w9' would be marked satisfied by GOLD STAR'S w9, which is the
--    wrong company's paperwork and would show a green card for a document
--    nobody has chased. The LATERAL is therefore gated on
--    `r.direction = 'gsr_to_client'`. A client-owed row can only be satisfied
--    by a file actually filed against it (`compliance_requirement_files`,
--    slot 'certificate') — which is exactly what "the client sent it in" means.
--
-- Everything else in the view is reproduced verbatim from 20260820102608.
--
-- ============================================================================
-- BANDS ARE NOT IN THIS MIGRATION, AND THAT IS DELIBERATE
-- ============================================================================
--
-- The compliance TRACK maps the existing per-requirement status
-- (satisfied / expiring_soon / missing / insufficient / expired) onto the four
-- health bands in TypeScript — `src/lib/client-health-tracks.ts` — using the
-- same severity order `account_compliance_state` already applies
-- (expired > insufficient > missing > expiring_soon). No day-aging exists in
-- the data yet, so Phase 1 maps states, not ages.
--
-- DEFERRED, explicitly:
--
--   Phase 2  The real thresholds. Relationship bands by DAYS A TASK IS PAST DUE
--            (Healthy to +7, Watch 8-14, At Risk 15-30, Critical 30+) instead of
--            days since touch; compliance bands by DAYS OUTSTANDING (Watch 1-14,
--            At Risk 15-29, Critical 30+) with the clock starting at the request
--            date or the expiry date. That needs a `requested_at` on this table,
--            which is Phase 2's migration, not this one — adding an unused
--            column now would be schema nobody reads.
--            Also Phase 2: the Non-Compliant badge at 15+ days, separate from
--            the colour, and the onboarding band (new client starts at Watch).
--   Phase 3  The Critical workflow — recovery task, the manager's undismissable
--            Critical list, the 30-day window and the day-30 four-way decision,
--            the >20% rep cap. Nothing here creates a task or an escalation.
--   Phase 4  Commission by account stage at job arrival. Untouched: no
--            commission table, function or payout is referenced by this file or
--            by the track that reads it.
--
-- FINANCE STILL DOES NOT FEED HEALTH. No column added or read here is
-- financial. `required_amount` is an insurance LIMIT — the cover a property
-- manager demands — not money owed, billed or collected, and it only ever
-- decides `insufficient` vs `satisfied`. Late payment, thin margin, a bad job
-- and "no work sent" remain incapable of moving either band, which is the
-- property the two-track model exists to keep.
--
-- RE-RUNNABLE. Every statement is guarded: ADD COLUMN IF NOT EXISTS, constraint
-- drops are IF EXISTS before their creates, and the view is DROP ... CREATE, the
-- same shape 20260820102608 uses. Applying twice is identical to applying once.

-- 1. The direction ----------------------------------------------------------

ALTER TABLE public.account_compliance_requirements
  ADD COLUMN IF NOT EXISTS direction text NOT NULL DEFAULT 'gsr_to_client';

ALTER TABLE public.account_compliance_requirements
  DROP CONSTRAINT IF EXISTS account_compliance_requirements_direction_check;
ALTER TABLE public.account_compliance_requirements
  ADD CONSTRAINT account_compliance_requirements_direction_check
  CHECK (direction IN ('gsr_to_client', 'client_to_gsr'));

COMMENT ON COLUMN public.account_compliance_requirements.direction IS
  'Who owes this paperwork. gsr_to_client: Gold Star must hold it to stay on the client''s approved-vendor list (the original and only meaning before 20260914120000, hence the default). client_to_gsr: Gold Star is waiting on the client for it. Not to be confused with vendor_documents, which is what a SUBCONTRACTOR owes Gold Star.';

-- 2. Uniqueness is per direction --------------------------------------------
-- The original constraint was created inline by CREATE TABLE, so it carries the
-- default name; both spellings are dropped in case an environment differs.

ALTER TABLE public.account_compliance_requirements
  DROP CONSTRAINT IF EXISTS account_compliance_requirements_account_id_requirement_type_key;
ALTER TABLE public.account_compliance_requirements
  DROP CONSTRAINT IF EXISTS account_compliance_requirements_account_requirement_uniq;
ALTER TABLE public.account_compliance_requirements
  DROP CONSTRAINT IF EXISTS account_compliance_requirements_account_type_direction_key;
ALTER TABLE public.account_compliance_requirements
  ADD CONSTRAINT account_compliance_requirements_account_type_direction_key
  UNIQUE (account_id, requirement_type, direction);

CREATE INDEX IF NOT EXISTS acr_account_direction_idx
  ON public.account_compliance_requirements (account_id, direction)
  WHERE active;

-- 3. The view: expose direction, and never let GSR's own paperwork satisfy a
--    requirement the CLIENT owes. Otherwise verbatim from 20260820102608.

DROP VIEW IF EXISTS public.account_compliance_status;
CREATE VIEW public.account_compliance_status
WITH (security_invoker = true) AS
SELECT r.id AS requirement_id,
  r.account_id,
  a.name AS account_name,
  a.location_id,
  r.requirement_type,
  r.direction,
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
  'One row per active account compliance requirement, in both directions, with the document answering it and the derived status. A client_to_gsr row is never matched against company_credentials: Gold Star''s own W9 does not satisfy a W9 the client owes us. See 20260914120000.';

-- ===========================================================================
-- Verification after applying
-- ===========================================================================
--
--   -- 1. The column, its default and its check.
--   SELECT column_name, column_default, is_nullable
--     FROM information_schema.columns
--    WHERE table_schema='public' AND table_name='account_compliance_requirements'
--      AND column_name='direction';
--   -- expected: 'gsr_to_client'::text, NO
--
--   -- 2. Every pre-existing row kept its meaning.
--   SELECT direction, count(*) FROM public.account_compliance_requirements
--    GROUP BY direction;
--   -- expected before anyone adds one: all rows gsr_to_client
--
--   -- 3. Both directions can now coexist for one requirement type.
--   --    (in a transaction, rolled back)
--   BEGIN;
--   INSERT INTO public.account_compliance_requirements (account_id, requirement_type, direction)
--   SELECT account_id, requirement_type, 'client_to_gsr'
--     FROM public.account_compliance_requirements LIMIT 1;
--   -- expected: 1 row, no unique violation
--   ROLLBACK;
--
--   -- 4. GSR's own credential does not satisfy a client-owed requirement.
--   SELECT requirement_type, direction, credential_id, cert_file_id, status
--     FROM public.account_compliance_status
--    WHERE direction = 'client_to_gsr';
--   -- expected: credential_id IS NULL on every row; status is driven only by
--   -- whether a certificate file was filed against the requirement.
--
-- OFFLINE PROOF. The repository harness builds these tables from scratch and
-- checks both directions, including that a GSR credential cannot satisfy a
-- client-owed row:
--   node supabase/tests/compliance-direction.pglite.mjs node_modules/@electric-sql/pglite/dist/index.js
-- and the same script runs inside `npx vitest run` via compliance-direction.test.ts.
--
-- Rollback:
--   DROP the unique constraint, restore UNIQUE (account_id, requirement_type),
--   ALTER TABLE public.account_compliance_requirements DROP COLUMN direction,
--   and re-apply the view from 20260820102608 verbatim.
