-- A rep can move their own account to another office, and approve their own
-- lead. This closes both, and pins the column that is only safe by accident.
--
-- WRITTEN, NOT APPLIED. One trigger function and one trigger binding. No
-- table, column, policy, grant or ownership change, and nothing is dropped.
--
-- ============================================================================
-- THE HOLE, and a correction to how it was first reported
-- ============================================================================
--
-- `accounts_update` is, from the live RLS dump:
--
--   USING      (can_manage_location(auth.uid(), location_id) OR assigned_rep = auth.uid())
--   WITH CHECK (can_manage_location(auth.uid(), location_id) OR assigned_rep = auth.uid())
--
-- and there is NO column-level restriction anywhere on the table. A policy
-- decides which ROWS you may update, never which COLUMNS, so the reasonable
-- reading is that the assigned rep — who satisfies both halves on their own
-- row — may write ANY column on it, `assigned_rep` included.
--
-- THAT READING IS HALF RIGHT, AND THE HALF IT GETS WRONG IS THE HEADLINE ONE.
-- Reproduced column by column against this exact policy in
-- supabase/tests/accounts-owner-guard.pglite.mjs, as a plain rep who is the
-- assigned_rep of the row and manages no office:
--
--   assigned_rep := another user   REFUSED  42501, by the policy
--   assigned_rep := NULL           REFUSED  42501, by the policy
--   location_id  := another office ALLOWED  <-- real hole
--   approval_state := 'approved'   ALLOWED  <-- real hole
--   all four approval columns      ALLOWED  <-- real hole
--   notes, name, phone             ALLOWED  (correct, and must stay so)
--
-- `assigned_rep` is refused because WITH CHECK is evaluated against the
-- FINISHED row: once the rep writes somebody else into `assigned_rep`, the new
-- row satisfies neither `assigned_rep = auth.uid()` nor `can_manage_location`,
-- so the policy rejects it. Setting it to NULL fails the same way — `NULL =
-- uid` is NULL, not true. So a rep cannot, today, hand their own account to a
-- colleague by PATCHing this column.
--
-- `location_id` is NOT refused, and this is the one that matters, because the
-- rep stays in `assigned_rep` — the WITH CHECK is still satisfied by the OTHER
-- half of the OR. A rep can therefore move their own account into any office
-- in the company, including one they hold no rights in. The account leaves its
-- manager's oversight while the rep keeps it: the same outcome as an
-- unauthorised reassignment, reached from the other side.
--
-- The four approval columns are not refused either, for the same reason, and
-- that is self-approval. A lead created by a non-approver is stamped `pending`
-- with a seven-day clock by `trg_account_needs_approval` (20260806211522), and
-- only `approve_account_lead()` — gated on `can_approve_leads`, i.e.
-- sales_head/owner/admin/dev — is supposed to clear it. One PATCH does it
-- instead, and forges the approver and timestamp while it is there.
--
-- WHY assigned_rep IS STILL GUARDED HERE. Its safety today is INCIDENTAL, not
-- stated. It holds only because that column happens to appear in the policy
-- expression, so the protection is a side effect of a predicate written to
-- answer a different question ("may this person touch this row?"). Anything
-- that widens the policy silently removes it — adding `OR created_by =
-- auth.uid()`, or any second PERMISSIVE UPDATE policy, since permissive
-- policies are OR-ed together and one that does not mention `assigned_rep`
-- re-opens the column for every row it covers. A guard that says the rule out
-- loud costs one comparison and cannot be undone by accident. It also turns
-- today's bare "new row violates row-level security policy" into a message
-- that says which column and who to ask.
--
-- ============================================================================
-- THIS MIRRORS THE 9 SEP FIX, ONE COLUMN OVER
-- ============================================================================
--
-- 20260909140000 (`move_back_to_pipeline_manager_only`) closed the identical
-- shape: an action with no check of its own, guarded only by `accounts_update`,
-- which let the assigned rep do a manager's job on their own record. Its header
-- quotes the written permissions spec —
--
--   "Reps cannot assign owners, move a client back to the pipeline, or clear a
--    Critical directly" — "Managers can do everything reps can, plus assign
--    owners, move clients back to the pipeline, reassign accounts, and make
--    the day thirty decision."
--
-- — and closed the middle clause. This closes what is left of the first one and
-- uses the same manager notion, checked where the write actually happens.
--
-- WHY A TRIGGER AND NOT A POLICY. PostgreSQL RLS has no per-column
-- granularity; WITH CHECK sees the finished row and cannot ask "which columns
-- moved?" — which is exactly why it catches `assigned_rep` by luck and misses
-- `location_id` entirely. Column privileges (GRANT UPDATE (col)) cannot say
-- "unless you manage this office" either; they are static per role. A BEFORE
-- UPDATE trigger is the only place both OLD and NEW exist, so it is the only
-- place the question can be asked. It is also the pattern this table already
-- uses: `guard_account_is_reference` (20260812172139).
--
-- ============================================================================
-- COLUMNS THIS TRIGGER PROTECTS, AND WHY EACH ONE
-- ============================================================================
--
--   location_id      The office that owns the record, and half of
--                    `accounts_update` — it IS the RLS scope. Confirmed
--                    writable by a plain rep today. Moving it takes the account
--                    out from under its manager and can place it in an office
--                    the rep has no rights in.
--
--   assigned_rep     Ownership itself. Currently refused by the policy as a
--                    side effect (see above); guarded here so the rule is
--                    stated rather than inherited. It decides whose book,
--                    goals, leaderboard row and commission attribution the
--                    account counts toward (src/lib/account-ownership.ts), so a
--                    silent change moves money and quota.
--
--   approval_state   The new-lead approval control, all four together because
--   approved_by      approving is one act: guarding only the state would let a
--   approved_at      rep forge the approver and the timestamp instead, leaving
--   approval_due_on  a record that reads as though a sales head signed it off.
--
-- ============================================================================
-- COLUMNS DELIBERATELY NOT PROTECTED — a rep's ordinary day must still work
-- ============================================================================
--
-- This blocks six columns and nothing else. Every normal edit a rep makes on
-- their own account is untouched: name, notes, phone, email, website,
-- address_line1, city, state, postal_code, client_since, priority,
-- what_they_do, standing_note, certificates_email, satisfaction_score,
-- estimated_annual_value, account_type, parent_account_id, tradeshow_id,
-- lead_source_id and the rest of the record.
--
-- These were considered and left writable ON PURPOSE, because a rep flow needs
-- them and guarding them would break the product:
--
--   stage, stage_id, stage_changed_at  A rep moving a card along the pipeline
--                                      is the core rep action. The `pipeline_*`
--                                      RPCs are SECURITY INVOKER, so their
--                                      UPDATEs run as the rep and would be
--                                      refused if these were guarded.
--   status                             Written by `pipeline_activate_client`
--                                      (convert to client) as the rep.
--   health_pipeline_id,                A rep may drag a client to a WORSE
--   health_stage_id,                   health band; only a move BELOW the
--   health_changed_at                  metric floor is refused, and that rule
--                                      already lives in `healthMoveRefusal`
--                                      (src/lib/client-health-move.ts).
--                                      Guarding the column would block the
--                                      allowed direction too.
--   ghost_*, no_service_*,             Reps may ghost a record, mark No Service
--   reactivate_on, green_light_date    Needed and set a retry — all named in
--                                      the spec as rep actions.
--   archived_at, archived_by           "Revive from archive" is a rep action.
--   lost_reason                        Carried by the stage-history trigger.
--   last_in_person_at,                 Written by the Graph calendar sync as
--   annual_meeting_due_on,             service_role, and by nothing a rep can
--   annual_meeting_missed_at           reach by hand.
--   is_reference                       Already guarded, and more strictly, by
--                                      `guard_account_is_reference`: privileged
--                                      only. Not repeated — two guards on one
--                                      column is two places to keep in step.
--   is_demo, created_by                Set at INSERT, never updated by any app
--                                      path. Data hygiene and provenance rather
--                                      than authority; left out to keep this
--                                      change to ownership and approval. If
--                                      is_demo is ever worth locking it belongs
--                                      beside is_reference, not here.
--
-- ============================================================================
-- WHO STILL PASSES, AND WHY EACH IS NAMED
-- ============================================================================
--
--   is_privileged(actor)          owner / admin / dev. Named separately from
--                                 can_manage_location for the reason
--                                 20260909140000 gives: can_manage_location is
--                                 FALSE when location_id IS NULL, so without
--                                 this an admin could not fix an account that
--                                 has no office.
--
--   can_manage_location(actor,    The app's existing manager notion — a member
--     OLD.location_id)            of that office holding office/location_manager/
--                                 sales_manager, or a regional over it. OLD, not
--                                 NEW: the question is whether you have
--                                 authority over the record AS IT STANDS, and
--                                 reading NEW would let a manager of office B
--                                 pull in an account from office A by naming
--                                 their own office in the same statement. RLS
--                                 still applies WITH CHECK to the new row, so a
--                                 legitimate move between offices needs rights
--                                 on both ends.
--
--   is_sales_lead(actor)          owner / admin / dev / SALES_HEAD. Load-bearing,
--                                 and the reason the guard is not just the two
--                                 helpers above. `reassign_book_atomically`
--                                 (20260909130000) is the sanctioned
--                                 book-handover tool; it is gated on
--                                 `is_sales_lead` and does
--                                 `UPDATE public.accounts SET assigned_rep`.
--                                 It is SECURITY DEFINER, but SECURITY DEFINER
--                                 changes the ROLE, NOT `auth.uid()` — the JWT
--                                 subject is still the caller — so this trigger
--                                 sees the sales_head's own uid. A sales_head is
--                                 NOT privileged and does NOT satisfy
--                                 can_manage_location (whose role list is
--                                 office/location_manager/sales_manager/
--                                 regional), so omitting this would have broken
--                                 the handover tool for exactly the people it
--                                 was built for. `approve_account_lead` is gated
--                                 on the same role set, so naming is_sales_lead
--                                 widens nothing: it admits precisely the roles
--                                 already allowed to perform these writes.
--
--   auth.uid() IS NULL            No signed-in user at all — the cron sweeps,
--                                 the Graph sync and the automation engine,
--                                 which run as service_role and bypass RLS
--                                 anyway. The lead-escalation sweep writes
--                                 `approval_state = 'escalated'` this way. This
--                                 cannot become a way in: `anon` holds no
--                                 UPDATE grant on this table.
--
-- ============================================================================
-- NO LEGITIMATE REP FLOW CHANGES. Every app write of a protected column, from
-- reading the whole src tree:
-- ============================================================================
--
--   assigned_rep
--     src/components/create-customer-dialog.tsx:515   INSERT — unaffected. This
--     src/components/pipeline-add-dialog.tsx:85,253   trigger is UPDATE only, so
--     src/lib/tradeshow-intake.server.ts:94           a rep creating an account
--                                                    and assigning it to
--                                                    themselves still works.
--     src/lib/coaching.ts:92 reassignAccount()        UPDATE, reachable only
--                                                    from the manager tab of
--                                                    /coaching/nudges, rendered
--                                                    behind isSalesLeadership()
--                                                    || isPrivileged().
--     src/lib/reassignment.ts:185 reassignBook()      UPDATE via
--                                                    reassign_book_atomically,
--                                                    already is_sales_lead-gated.
--
--   location_id and the four approval columns
--     No UPDATE of any of them on `accounts` exists in the app outside
--     `approve_account_lead()` and the lead-escalation sweep, both covered
--     above. The account editors (account-panel.tsx, accounts.$id.tsx and
--     `accountPatch` in client-360-edit.ts) read location_id for display and
--     write only name/address_line1/city/state/postal_code/client_since.
--
-- TRIGGER ORDER. BEFORE ROW triggers fire in alphabetical order by trigger
-- name. `guard_account_owner_columns` sorts after `guard_account_is_reference`
-- and before every `trg_*` on this table, so it reads NEW as the client
-- submitted it. The other BEFORE UPDATE triggers here
-- (trg_accounts_stage_normalize, trg_accounts_updated_at) were read line by
-- line: they write only stage_changed_at and updated_at, so none can make this
-- guard fire on a write the user did not make.
-- `trg_account_needs_approval`, which does set approval columns, is BEFORE
-- INSERT only and never runs on UPDATE.
--
-- RE-RUNNABLE. CREATE OR REPLACE plus DROP TRIGGER IF EXISTS, the same shape as
-- 20260812172139. Applying twice is identical to applying once, and no grant is
-- issued so replay cannot widen access.

CREATE OR REPLACE FUNCTION public.guard_account_owner_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  actor uuid := auth.uid();
  changed text[] := '{}';
BEGIN
  -- Backend work: cron sweeps, the Graph sync, the automation engine. They run
  -- as service_role with no JWT and already bypass RLS entirely.
  IF actor IS NULL THEN
    RETURN NEW;
  END IF;

  -- Anyone the app already trusts with these writes keeps full update rights.
  IF public.is_privileged(actor)
     OR public.can_manage_location(actor, OLD.location_id)
     OR public.is_sales_lead(actor) THEN
    RETURN NEW;
  END IF;

  IF NEW.assigned_rep IS DISTINCT FROM OLD.assigned_rep THEN
    changed := changed || 'assigned_rep'::text;
  END IF;
  IF NEW.location_id IS DISTINCT FROM OLD.location_id THEN
    changed := changed || 'location_id'::text;
  END IF;
  IF NEW.approval_state IS DISTINCT FROM OLD.approval_state THEN
    changed := changed || 'approval_state'::text;
  END IF;
  IF NEW.approved_by IS DISTINCT FROM OLD.approved_by THEN
    changed := changed || 'approved_by'::text;
  END IF;
  IF NEW.approved_at IS DISTINCT FROM OLD.approved_at THEN
    changed := changed || 'approved_at'::text;
  END IF;
  IF NEW.approval_due_on IS DISTINCT FROM OLD.approval_due_on THEN
    changed := changed || 'approval_due_on'::text;
  END IF;

  IF cardinality(changed) > 0 THEN
    RAISE EXCEPTION
      'Only a manager can change % on an account. Ask the office manager to reassign or approve it.',
      array_to_string(changed, ', ')
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.guard_account_owner_columns() IS
  'BEFORE UPDATE on public.accounts: refuses changes to assigned_rep, location_id and the four approval columns unless the caller is privileged, manages the account''s office, or is a sales lead. RLS decides which rows may be updated; this decides which columns. See 20260914110000.';

REVOKE EXECUTE ON FUNCTION public.guard_account_owner_columns()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS guard_account_owner_columns ON public.accounts;
CREATE TRIGGER guard_account_owner_columns
BEFORE UPDATE ON public.accounts
FOR EACH ROW EXECUTE FUNCTION public.guard_account_owner_columns();

-- ===========================================================================
-- Verification after applying
-- ===========================================================================
--
--   -- 1. The trigger is bound once, BEFORE UPDATE, and enabled.
--   SELECT tgname, tgenabled, pg_get_triggerdef(oid)
--     FROM pg_trigger
--    WHERE tgrelid = 'public.accounts'::regclass AND NOT tgisinternal
--      AND tgname = 'guard_account_owner_columns';
--
--   -- 2. Definer, with a pinned search_path.
--   SELECT prosecdef AS security_definer, proconfig
--     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public' AND p.proname = 'guard_account_owner_columns';
--   -- expected: true, {search_path=public\, pg_temp}
--
--   -- 3. The policy is unchanged — this migration does not touch it.
--   SELECT polname, pg_get_expr(polqual, polrelid) AS using_expr,
--          pg_get_expr(polwithcheck, polrelid) AS check_expr
--     FROM pg_policy WHERE polrelid = 'public.accounts'::regclass;
--
-- BEHAVIOUR, signed in as a rep who is the assigned_rep of account A and
-- manages no office (run in a transaction and roll back):
--
--   BEGIN;
--   UPDATE public.accounts SET notes = 'still editable' WHERE id = A;
--   -- expected: 1 row. Normal fields are untouched by this change.
--   UPDATE public.accounts SET location_id = <another office> WHERE id = A;
--   -- BEFORE this migration: 1 row. This is the hole.
--   -- AFTER:  ERROR 42501 "Only a manager can change location_id ..."
--   UPDATE public.accounts SET approval_state = 'approved' WHERE id = A;
--   -- BEFORE: 1 row, self-approved. AFTER: ERROR 42501.
--   UPDATE public.accounts SET assigned_rep = <someone else> WHERE id = A;
--   -- BEFORE: ERROR 42501 "new row violates row-level security policy".
--   -- AFTER:  ERROR 42501 "Only a manager can change assigned_rep ..." —
--   --         same refusal, now stated rather than inherited, and legible.
--   ROLLBACK;
--
-- and as a manager of that office, or a sales head, each of those succeeds.
--
-- OFFLINE PROOF. The repository harness establishes the before/after of every
-- one of those columns without a live database, including that a rep's normal
-- edit keeps working:
--   node supabase/tests/accounts-owner-guard.pglite.mjs node_modules/@electric-sql/pglite/dist/index.js
-- and the same script runs inside `npx vitest run` via accounts-owner-guard.test.ts.
--
-- Rollback (restores the hole — only to prove causation):
--   DROP TRIGGER IF EXISTS guard_account_owner_columns ON public.accounts;
