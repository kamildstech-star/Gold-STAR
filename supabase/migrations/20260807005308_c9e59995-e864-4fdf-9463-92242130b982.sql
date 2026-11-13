ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS phone text,
  ADD COLUMN IF NOT EXISTS email text,
  ADD COLUMN IF NOT EXISTS website text,
  ADD COLUMN IF NOT EXISTS address_line1 text,
  ADD COLUMN IF NOT EXISTS city text,
  ADD COLUMN IF NOT EXISTS state text,
  ADD COLUMN IF NOT EXISTS postal_code text;

-- Seed general details for existing accounts from their primary contact.
UPDATE public.accounts a
SET phone = COALESCE(a.phone, c.phone),
    email = COALESCE(a.email, c.email)
FROM public.contacts c
WHERE c.account_id = a.id
  AND c.is_primary
  AND c.archived_at IS NULL;

UPDATE public.accounts a
SET city = COALESCE(a.city, l.locality)
FROM public.locations l
WHERE l.id = a.location_id;