# Goldstar database prerequisites for QA fixes

Target: Lovable project `b0a4cfc7-3fd3-46ba-aa5d-90a925aaa67c`, Supabase `ortpawtuqerkmuykwndp`.
Prepared September 7, 2026; not applied.
The user elected Lovable for Supabase work only.
The one read-only Lovable chat check cost 1 credit.
Follow-up direct Lovable database reads corrected two imprecise AI findings: accounts.tradeshow_id exists, and the drying base table is not proof that interior-readings migration was applied.

## Exact scope

Apply the following committed migration files in order, only if absent from the live migration ledger.
Their SHA-256 hashes are in database-batch-manifest.json.
The base field-ticket and drying tables already exist in older shapes; the corresponding convergence migrations are still required.

1. `20260831190000_field_work_tickets.sql`
2. `20260831190500_standalone_intake_links.sql`
3. `20260901120000_drying_log.sql`
4. `20260902200000_labour_rates_crew_class.sql`
5. `20260902200500_field_ticket_crew_hours.sql`
6. `20260903212000_tradeshow_lead_capture.sql`
7. `20260903220000_tradeshow_intake_links.sql`
8. `20260903223000_intake_general_links.sql`
9. `20260903224000_intake_form_trim.sql`
10. `20260904090000_drying_interior_readings.sql`
11. `20260907161050_chat_project_invoice_sharing.sql`
12. `20260907162526_local_calendar_recurrence.sql`

## Expected impact

This enables crew-hour costing prerequisites, drying category/interior/baseline/photo fields, standalone and Trade Show intake, private Trade Show/drying/intake media storage, Chat project/invoice sharing, and local Calendar recurrence.
It adds columns, tables, indexes and validation triggers, expands the Chat record-type constraint, changes the specified intake/drying policies, and installs scoped table/storage policies and function grants.
It relaxes intake job_id nullability for leads without a job.
It replaces the crew minutes helper signature as specified in the committed migration; the obsolete helper does not currently exist.
No business-row deletion, demo cleanup, access-role changes, notification sends or application code edits are included.
Existing business values are retained; additive columns receive their declared defaults.
The three new storage buckets are private and are currently absent.

## Preflight already captured

Live row counts: 44 jobs, 110 accounts, 8 calendar events, 8 messages, 2 field tickets, 0 drying readings, 1 labour rate, 5 intake requests, 0 submissions and 7 questions.
Invalid drying point/humidity counts, duplicate weather groups and invalid rate-subject counts are all zero.
Existing policies, constraints and relevant function definitions are saved in the local run's database-preflight.json; relevant helper functions and all three target buckets are absent.
No listed migration version is present in the live ledger.
Recheck the target and ledger immediately before executing the batch.

## Execution and recovery

Execute each exact file transactionally, and record its exact SQL, version and name in supabase_migrations.schema_migrations.
Abort on unexpected schema, permissions, existing definitions, invalid rows or SQL errors; do not repair or delete user data automatically to force a migration through.
After application, verify columns, valid constraints, indexes, enabled RLS, grants, triggers, bucket privacy and migration records with catalog queries.
Compare business-row counts with the baseline and run the consolidated Lovable retest after code delivery.
No local Postgres integration test was possible: the installed Docker daemon returns HTTP 500.
Direct Supabase advisors are unavailable because that account lacks the exact project; use the available Lovable catalog checks and record that limit.

Roll back any failing transaction before commit.
If a later application issue appears, retain additive schema and new data and revert the compatible application change if necessary.
Restore prior policies/functions from the captured definitions through a reviewed recovery migration when required.
Do not drop tables, columns, buckets or captured records to undo this batch.
