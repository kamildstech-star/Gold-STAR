# Goldstar database reconciliation

Target: Lovable `b0a4cfc7-3fd3-46ba-aa5d-90a925aaa67c`, linked Supabase `ortpawtuqerkmuykwndp`.
The user explicitly requested inspection followed by migration application through Lovable.
Direct database queries avoid Lovable AI prompt credits.

The live migration ledger and catalogs were captured before writing.
Another writer had added the crew-review and Trade Show tables with different constraints and broad office policies, plus private media buckets.
Existing counts were 44 jobs, 110 accounts, eight events, eight messages, two tickets, five intake requests and zero crew reviews, media rows, drying readings or intake submissions.

The pending Chat migration had a PL/pgSQL `IF CASE` parser error.
Parenthesizing the CASE expression fixes it without changing the intended permission check.
The failed transaction did not apply; the corrected file is the source of truth for its exact ledger SQL.

## Applied reconciliation

Applied `20260907172841_reconcile_tradeshow_lead_media.sql` before the pending original Trade Show capture migration.
It restores required metadata, unique storage paths and the intended capture-owner/show-leadership policies.
It preserves numeric waveform arrays, extra columns and existing records.
Applied the original capture migration afterward to install the private bucket limits and remaining policies.

Applied `20260907172938_reconcile_field_ticket_crew_hours.sql` in one transaction before the pending original crew-hours migration.
It checks the exact deployed RPC signature, uses DROP RESTRICT only for the known integer-to-bigint return conflict, and recreates the canonical RPC in the same transaction.
Dependency catalog and public function-body checks found no callers requiring schema changes.
It restores review constraints and timestamps, replaces the broad office policy, removes the duplicate update trigger and prevents direct rate-helper access.
The original migration replayed unchanged.

Both reconciliations reject invalid or unexpected state rather than modifying business rows.
Use a short lock timeout and record each exact committed SQL file in the migration ledger transactionally.
On failure, roll back the entire transaction.
After commit, preserve additive schema and records; recovery of prior function/policy definitions uses the captured catalog through a reviewed forward migration.
Do not delete business data or storage objects for recovery.

## Verification

Check exact ledger SQL, capabilities, function grants, security mode, RLS, constraints, triggers, bucket privacy and unchanged business counts after application.
PGlite provides isolated PostgreSQL execution tests because the local Docker daemon returns HTTP 500.
Its fixture permissions are not a substitute for deployed user-role QA.
Supabase advisors are unavailable through the direct account for this project; Lovable catalog checks cover the accessible verification.
Database completion does not establish an end-to-end app pass.

## Verified result

All twelve planned migrations and three reconciliation/validation migrations are applied.
Exact SQL in all fifteen ledger entries matches committed files.
The additional validation migration confirms the earlier drying humidity constraint against existing data.
Existing business counts are unchanged, all inspected table RLS is enabled, relevant constraints and indexes are valid, and all three media buckets are private.
Authenticated capability calls return Chat job/account/project/invoice support and Calendar recurrence true; an inaccessible crew job returns zero rows.
Anonymous capability and crew RPC execution is denied; the rate helper is not directly executable by authenticated users.
Isolated PostgreSQL tests pass for real RLS-hidden Chat references, recurrence validation, canonical crew calculations, Trade Show ownership visibility, constraints, preserved fixture data and migration reruns.
No app records, notifications or invitations were created.
The consolidated deployed browser retest remains separate.
