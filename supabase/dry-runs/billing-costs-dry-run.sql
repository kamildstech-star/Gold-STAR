-- Billing & Costs rebuild (prompts 1–5): DRY RUN against a real database.
--
-- Applies every rebuild migration, in order, inside ONE transaction, prints
-- each migration's own seed counts and checks (RAISE NOTICE) plus the summary
-- below, then ROLLS BACK. Nothing is written. Any check that fails aborts with
-- its message before the rollback.
--
-- Run from the repository root (read-only role is not enough: the migrations
-- create objects, which the rollback then discards):
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/dry-runs/billing-costs-dry-run.sql
--
-- Expect NOTICE lines for: the catalog seed (P1), the T&M rate seed and the
-- equipment mapping (P2), the cost / wage seeds (P3), Standard rates, list
-- kinds, the HEPA decision and the Estimate catalog merge (P4), the T&M sheet
-- move and the agreements-with-equipment count (P5).

\set ON_ERROR_STOP on
BEGIN;

\echo '== P1 20261029120000_billing_costs_foundation'
\ir ../migrations/20261029120000_billing_costs_foundation.sql
\echo '== P2 20261030120000_billing_costs_rules_and_tm_rates'
\ir ../migrations/20261030120000_billing_costs_rules_and_tm_rates.sql
\echo '== P3 20261031120000_billing_costs_cost_and_overhead'
\ir ../migrations/20261031120000_billing_costs_cost_and_overhead.sql
\echo '== P4 20261101120000_billing_costs_client_agreements'
\ir ../migrations/20261101120000_billing_costs_client_agreements.sql
\echo '== P5 20261102120000_billing_costs_one_book'
\ir ../migrations/20261102120000_billing_costs_one_book.sql
\echo '== P5 20261103120000_billing_costs_one_engine'
\ir ../migrations/20261103120000_billing_costs_one_engine.sql

\echo '== Summary'
SELECT category, count(*) FILTER (WHERE in_tm) AS on_tm_sheet,
       count(*) FILTER (WHERE in_regular) AS regular, count(*) AS total,
       count(*) FILTER (WHERE unit_review IS NOT NULL) AS unit_flagged
  FROM public.catalog_items GROUP BY category ORDER BY category;
SELECT book, measure, count(*) FILTER (WHERE office_id IS NULL) AS company_rows,
       count(*) FILTER (WHERE office_id IS NOT NULL) AS office_rows
  FROM public.money_values GROUP BY book, measure ORDER BY book, measure;
SELECT kind, count(*) AS lists, count(*) FILTER (WHERE full_copy) AS full_copies
  FROM public.price_lists GROUP BY kind ORDER BY kind;
SELECT count(*) AS catalog_merge_flagged FROM public.catalog_merge_review;
SELECT code, name, reason FROM public.catalog_merge_review ORDER BY code;
SELECT code, label, equipment_type_review FROM public.tm_rate_codes
 WHERE section = 'equipment' AND equipment_type IS NULL ORDER BY code;
SELECT (SELECT count(*) FROM public.tm_rate_codes) AS old_sheet_codes,
       (SELECT count(*) FROM public.tm_sheet_codes) AS new_sheet_codes;
SELECT count(*) AS money_audit_entries_written_by_the_seeds FROM public.money_audit_log;

ROLLBACK;
\echo '== Rolled back: nothing was written.'
