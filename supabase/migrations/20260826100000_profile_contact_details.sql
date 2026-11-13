-- Staff directory: profiles carries a name and nothing else reachable, so
-- "what's Dave's extension" is currently answered by phoning the office.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS work_phone   text,
  ADD COLUMN IF NOT EXISTS extension    text,
  ADD COLUMN IF NOT EXISTS mobile_phone text,
  ADD COLUMN IF NOT EXISTS job_title    text;

-- profiles has no table-wide SELECT for `authenticated` — it was revoked in
-- 20260821175812 and privileges are handed out column by column since. A new
-- column is invisible to the app until it is named here, so the grant is part
-- of adding it, not a widening of access.
--
-- mobile_phone is granted alongside the rest because column privileges apply
-- to the `authenticated` database role, which every signed-in user shares;
-- Postgres cannot tell a location manager from a crew member here. Who sees a
-- mobile is decided in src/lib/directory.ts (canSeeMobiles), mirroring the
-- role set public.can_read_staff_email already uses for staff email.
GRANT SELECT (work_phone, extension, mobile_phone, job_title)
  ON public.profiles TO authenticated;

-- No new policy: "Users update own profile" (20260728043303) already lets a
-- person UPDATE their own row.
--
-- UPDATE used to be granted table-wide, which made these columns writable the
-- moment they existed. 20260903130000_security_hardening_batch1 replaces that
-- with a column list, and that list is built from whichever of these columns
-- exist when it runs. So the grant is stated here too: whichever of the two
-- files runs second, a person can still edit their own phone and title, and
-- nothing wider than these four self-service columns is opened.
GRANT UPDATE (work_phone, extension, mobile_phone, job_title)
  ON public.profiles TO authenticated;
