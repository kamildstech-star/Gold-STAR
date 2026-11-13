-- DRY RUN of the Billing & Costs catalog seed (20261029120000) against a real
-- database. Changes nothing: everything runs inside a transaction that is
-- rolled back. Run from the repo root with psql:
--
--   psql "$DATABASE_URL" -f supabase/tests/billing-costs-catalog-dry-run.sql
--
-- The migration itself aborts if a count does not match; this prints the
-- numbers side by side so they can be read before it is applied.

BEGIN;
\ir ../migrations/20261029120000_billing_costs_foundation.sql

SELECT s.section AS category,
       (SELECT count(*) FROM public.tm_rate_codes t WHERE t.section = s.section) AS old_rows,
       (SELECT count(*) FROM public.tm_rate_codes t WHERE t.section = s.section AND t.active) AS old_active,
       (SELECT count(*) FROM public.catalog_items c WHERE c.category = s.section) AS new_rows,
       (SELECT count(*) FROM public.catalog_items c WHERE c.category = s.section AND c.active) AS new_active,
       (SELECT count(*) FROM public.catalog_items c WHERE c.category = s.section AND c.unit_review IS NOT NULL) AS units_flagged
  FROM unnest(ARRAY['labor', 'consumable', 'ppe', 'vehicle']) AS s(section);

SELECT code, category, name, unit, unit_review
  FROM public.catalog_items
 WHERE unit_review IS NOT NULL
 ORDER BY category, sort_order;

ROLLBACK;
