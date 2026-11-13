-- Backfill: the customer and the main point of contact as real job_contacts rows.
--
-- Mark, on job 2618851: "the main point of contact is missing". Creating a job
-- wrote those two people to the `jobs` row (`customer_name`,
-- `primary_contact_id`) and seeded `job_contacts` with the adjusters and the
-- referrer only, so a job with neither opened on an empty Contacts tab.
--
-- The application no longer needs this to be correct. `derivedJobContacts` in
-- src/lib/job-relationships.ts shows both people on any job whose
-- `job_contacts` does not already account for them, so every historical job
-- reads correctly the moment the UI ships, backfill or no backfill. This turns
-- the derived entries into rows so they can be edited, re-roled and starred
-- like any other contact, and so that anything reading `job_contacts` directly
-- — document recipients, the email context sidebar, `contact_job_roles` — sees
-- them too.
--
-- It mirrors `derivedJobContacts` clause for clause, including the dedupe:
-- skip anyone a row already links by contact id or carries by name, and
-- compare names case- and whitespace-insensitively. Running it twice is a
-- no-op. Running it after the UI has shipped is also a no-op for any job where
-- somebody already pressed "Add to list".
--
-- `created_by` is left NULL on purpose: nobody typed these rows, and stamping
-- them with whoever ran the migration would be a lie in the audit trail.

BEGIN;

-- 1. The main point of contact — jobs.primary_contact_id, resolved.
INSERT INTO public.job_contacts
  (job_id, role, contact_id, account_id, full_name, email, phone, notes, sort_order)
SELECT
  j.id,
  'customer',
  c.id,
  j.account_id,
  btrim(c.full_name),
  c.email,
  c.phone,
  NULLIF(btrim(a.name), ''),
  0
FROM public.jobs j
JOIN public.contacts c ON c.id = j.primary_contact_id
LEFT JOIN public.accounts a ON a.id = j.account_id
WHERE btrim(COALESCE(c.full_name, '')) <> ''
  AND NOT EXISTS (
    SELECT 1 FROM public.job_contacts jc
     WHERE jc.job_id = j.id
       AND (
         jc.contact_id = c.id
         OR lower(regexp_replace(btrim(COALESCE(jc.full_name, '')), '\s+', ' ', 'g'))
            = lower(regexp_replace(btrim(c.full_name), '\s+', ' ', 'g'))
       )
  );

-- 2. The customer — only when it is a second party. On a residential job the
--    insured IS the point of contact, so step 1 has already claimed the name
--    and this finds nothing, which is the common case.
INSERT INTO public.job_contacts
  (job_id, role, contact_id, account_id, full_name, email, phone, notes, sort_order)
SELECT
  j.id,
  'customer',
  NULL,
  j.account_id,
  btrim(j.customer_name),
  NULL,
  NULL,
  NULL,
  0
FROM public.jobs j
WHERE btrim(COALESCE(j.customer_name, '')) <> ''
  AND NOT EXISTS (
    SELECT 1 FROM public.job_contacts jc
     WHERE jc.job_id = j.id
       AND lower(regexp_replace(btrim(COALESCE(jc.full_name, '')), '\s+', ' ', 'g'))
           = lower(regexp_replace(btrim(j.customer_name), '\s+', ' ', 'g'))
  );

COMMIT;
