-- APPLIED to production on 2026-09-10 and ledgered as 20260911120000.
--
-- Renumbered from 20260910200000, which was already taken by job_report_sections
-- -- the ledger insert hit ON CONFLICT DO NOTHING and silently kept the other
-- migration's name, so this one looked applied under a row describing something
-- else. The policies themselves were live and correct throughout; only the
-- bookkeeping was wrong. Worth knowing that a version collision fails quietly
-- in exactly that way.
--
-- It sat written-but-unapplied waiting on Melly, who had said "I'm not sure. We
-- have to check." Mark ended that wait: "sebndd it and stiop waiting for
-- confirmation." It is his call and he made it, so the reasoning below is kept
-- as the record of what was weighed, not as a reason to hold.
--
-- What actually happened when it ran: 38 users can now read all 90 contacts and
-- all 112 accounts. Two of those 38 hold a crew or field role, and so now have
-- the whole customer directory including the family details listed below. That
-- was flagged to Mark at the time rather than decided quietly here.
--
-- One consequence worth knowing about, because it is not obvious. On the same
-- day, 20260911100000 redacted email and phone inside find_customer_duplicates
-- and search_customers_minimal for viewers without full access, to stop a
-- two-character query enumerating other offices' contact details. That
-- redaction still stands, and it now contradicts this policy: the same person
-- reads the details freely on the account page and sees them blanked in
-- duplicate detection. Nothing is exposed by the mismatch -- it is the safe
-- direction -- but it is inconsistent, and lifting it is a deliberate decision
-- rather than a tidy-up.
--
-- David, on the create-contact form, looking at the Office field: "Office, I
-- have to be selected an office, right? It's not restricting this to an office,
-- right? ... So we don't want to restrict anything to an office because we want
-- everything in the CRM to be shared between all offices." Melly: "I'm not
-- sure. We have to check."
--
-- Checked, against production on 2026-09-10. It does restrict. `contacts_select`
-- is `can_view_location(uid, location_id) OR EXISTS (the contact's account,
-- viewable or assigned to you)`, and `can_view_location` is privileged
-- (admin/owner/dev) OR a `location_members` row for that office OR a region
-- covering it. Thirty-two of the thirty-eight active users who have an office at
-- all belong to exactly one, so those thirty-two see one office's contacts out
-- of ninety spread across eleven offices, and nothing else.
--
-- This migration is the narrowest change that delivers what David asked for. It
-- is deliberately NOT applied, because:
--
--   1. Melly said "we have to check", not "make it so". docs/melly-external-
--      factors.md already lists "cross-office visibility decisions" as awaiting
--      product's access matrix. This is that decision, and it is theirs.
--   2. A contact row is not just a name and a phone. It carries spouse_name,
--      children, family_notes, birthday, dietary_notes, personal_preferences,
--      hobbies and gift_policy_notes. "Shared between all offices" for a sales
--      directory and for a customer's family details may not be the same ask.
--   3. Widening a SELECT policy is the shape of the incidents this database has
--      already had.
--
-- WHO GAINS WHAT, exactly, if it is applied:
--
--   Gains read on all 90 contacts and all 112 accounts: every user holding at
--   least one row in `user_roles` whose profile is active and approved. That is
--   38 of the 45 active, approved profiles today (54 exist in total). Most of
--   those 38 see exactly one office today.
--
--   Gains nothing: the 7 active, approved users with no role at all (they see
--   nothing now and will still see nothing), and `anon` — the RESTRICTIVE
--   `anonymous_business_access_denied` policy on both tables keeps it out, so a
--   future public intake path is unaffected.
--
--   Not covered, and therefore still office-scoped after this: jobs, projects,
--   documents, estimates, invoices, tasks, notes, pay and commission. A user
--   would be able to read a contact whose job they cannot open. That is the
--   intended half-step — David asked about the CRM record, not the job file.
--
--   The `crew` and `field` roles are inside the gate. A crew member gains the
--   whole customer directory including the family notes above. If that is wrong,
--   swap the role list for an explicit one before applying.
--
-- The planned client portal (BACKLOG.md, "Company organisational chart") is a
-- portal for public adjusters and building owners gated on `propertyScope()`.
-- It does not exist yet. If it is ever built on Supabase `authenticated` users
-- WITH a role row, this policy would hand each of them the entire CRM. Gate the
-- portal on `anon` plus a signed token, or add an explicit employee role check
-- here, before both ship.
--
-- Written as two NEW permissive policies rather than edits to `contacts_select`
-- and `accounts_select`, so the office-scoped grants stay exactly as they are
-- and a rollback is two DROP POLICY statements and nothing else.
--
-- ROLLBACK:
--   DROP POLICY IF EXISTS contacts_select_all_offices ON public.contacts;
--   DROP POLICY IF EXISTS accounts_select_all_offices ON public.accounts;

-- Any employee — someone carrying at least one role — may read the CRM record
-- of any office. `is_employee` mirrors the gate `accounts_select_reference`
-- already uses for carriers and PA firms, which are shared company-wide today;
-- this reuses that precedent rather than inventing a second notion of staff.
CREATE OR REPLACE FUNCTION public.is_employee(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT goldstar_private.profile_is_active(_user_id) AND EXISTS (
    SELECT 1 FROM public.user_roles r WHERE r.user_id = _user_id
  );
$$;

REVOKE ALL ON FUNCTION public.is_employee(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_employee(uuid) TO authenticated;

DROP POLICY IF EXISTS accounts_select_all_offices ON public.accounts;
CREATE POLICY accounts_select_all_offices ON public.accounts
FOR SELECT TO authenticated
USING (public.is_employee((SELECT auth.uid())));

DROP POLICY IF EXISTS contacts_select_all_offices ON public.contacts;
CREATE POLICY contacts_select_all_offices ON public.contacts
FOR SELECT TO authenticated
USING (public.is_employee((SELECT auth.uid())));

-- Nothing here touches INSERT, UPDATE or DELETE. Writing a contact or an
-- account stays a `can_manage_location` decision, so shared does not become
-- editable-by-anyone. Deliberate: David asked to see everything, not to let
-- eleven offices edit each other's records.
