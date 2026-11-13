-- Multi-location companies.
--
-- The CRM already had the pieces: accounts.location_id is the office that
-- owns the company (defaulted from whoever entered it) and account_locations
-- is the many-to-many of offices that serve it, which compliance already
-- resolves certificates against. What was missing was the switch the client
-- described — "we'll select that they have multiple locations and then a
-- second dropdown populates: which locations" — and a way for reports and
-- the accounts list to ask "is this company worked from more than one office"
-- without joining the m2m every time.
--
-- is_multi_location is that switch. When it is off, account_locations holds
-- the owning office only; when it is on, the extra offices are listed there
-- ("National" in the UI is simply every office). The owning office is always
-- present in account_locations so the m2m alone answers "who serves them".

ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS is_multi_location boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS account_locations_location_idx
  ON public.account_locations(location_id);

-- Every account is served by at least its owning office. Older rows created
-- before the picker existed may lack that row.
INSERT INTO public.account_locations (account_id, location_id, created_by, is_demo)
SELECT a.id, a.location_id, a.created_by, a.is_demo
  FROM public.accounts a
 WHERE NOT EXISTS (
   SELECT 1 FROM public.account_locations al
    WHERE al.account_id = a.id AND al.location_id = a.location_id
 );

-- An account already served by a second office is, by definition,
-- multi-location. Only the flag is set; nothing is removed.
UPDATE public.accounts a
   SET is_multi_location = true
 WHERE NOT a.is_multi_location
   AND EXISTS (
     SELECT 1 FROM public.account_locations al
      WHERE al.account_id = a.id AND al.location_id <> a.location_id
   );
