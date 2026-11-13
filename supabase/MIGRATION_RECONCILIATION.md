> [!IMPORTANT]
> **Project targets — permanent rule for this repo**
>
> - **PRODUCTION Supabase = `nixpjqinsgngmrfepiot`** (https://nixpjqinsgngmrfepiot.supabase.co).
>   The ONLY database we connect to, migrate or modify. The live app
>   (goldstar.falconstaging.com) and Vercel point here.
> - **OLD Lovable Cloud DB = `ortpawtuqerkmuykwndp`.** Legacy only. NEVER link,
>   push or write to it. Any repo file still naming `ortpawtuqerkmuykwndp` is an
>   outdated Lovable leftover and should be fixed.
> - Migrations are applied by `.github/workflows/db-migrate.yml` on every push
>   to `main` that touches `supabase/migrations/**` (or by hand from the Actions
>   tab). The ledger is `supabase_migrations.schema_migrations` on
>   `nixpjqinsgngmrfepiot`.
>
> Everything below is the history of the OLD project, kept for reference.

# Migration reconciliation — state as of 2026-09-09 (UTC)

Target: Lovable project `b0a4cfc7-3fd3-46ba-aa5d-90a925aaa67c` (Supabase ref
`ortpawtuqerkmuykwndp`), PostgreSQL 17.6. Applied through the Lovable
`query_database` tool as `postgres`, one migration file per call (one call is
one transaction; `BEGIN;`/`COMMIT;` lines inside a file were omitted from the
call, never from the file). Every object was checked before and after each
call; the ledger is `supabase_migrations.schema_migrations`. The read-only
snapshot taken before the first write is `RECONCILIATION_SNAPSHOT_2026-09-09.md`.

Operational note that matters for anyone repeating this: a `499
request_cancelled` from the tool does **not** mean the statement rolled back.
Three 499s in this continuation (`chat_assistant_messages`,
`account_multi_location`, `calendar_push_integrity`) had all committed
server-side, and the first pass saw the same. After a 499, re-check the
catalog; re-run only if the objects are absent.

## Ledger: every hand-written file is now recorded, except one

All 39 files that were unrecorded on 2026-09-09 morning are now in the ledger
under their filename version, with one exception (below). Nothing was
dropped, no user rows were deleted, RLS was never disabled, and no migration
file was edited to make it apply.

| Version | Name | Outcome |
|---|---|---|
| 20260821070000 … 20260902200500 | certificate_send_log → field_ticket_crew_hours (13 files) | applied or recorded by the first pass (see snapshot) |
| 20260902100000 | payment_attachment | applied (column + partial index) |
| 20260902190000 | drying_outside_conditions | applied |
| 20260903090000 | company_hierarchy | applied; backfill set `position_key` on 26 contacts |
| 20260903090500 | account_properties | **NOT recorded — diverged, see below** |
| 20260903120000 | rate_limit_counters | applied, hardened state |
| 20260903130000 | security_hardening_batch1 | applied, hardened state |
| 20260903131000 | job_photo_share_links | recorded only (already fully present) |
| 20260903190000 | polaris_attachments | applied (bucket + 3 storage policies) |
| 20260903200000 | cron_callers_send_secret | applied |
| 20260903210000 | chat_assistant_messages | applied (file on main already carried the parenthesised guard; no fix needed) |
| 20260903211000 | pipeline_reversion_reasons | applied (list + 6 values) |
| 20260903213000 | invoice_photos | recorded only (already fully present) |
| 20260903221000 | reconstruction_job_type | recorded only (already fully present) |
| 20260903221500 | profile_primary_location | applied; backfill set a primary on 47 profiles (7 have no membership) |
| 20260903222000 | account_multi_location | applied; 37 missing owning-office rows added to `account_locations` (now 111) |
| 20260904120000 | calendar_outbound_push | applied |
| 20260907120000 | profiles_missing_column_grants | recorded only (grants already present) |
| 20260907120500 | job_room_unit | applied |
| 20260907190000 | page_access_seed | applied — 70 `page.*` permissions, 640 `role_permissions` rows |
| 20260907210000 | access_audit_never_blocks | applied and proven: an INSERT into `user_permissions` succeeded and wrote its audit row inside a transaction that was then rolled back (table still 0 rows) |
| 20260908010058 | restrict_internal_commission_rpc | applied |
| 20260908010611 | atomic_permission_override | applied |
| 20260908012000 | calendar_push_integrity | applied |
| 20260908012100 | atomic_public_intake | applied |
| 20260908013000 | active_profile_access_guard | applied — `goldstar_private.profile_is_active`, 29×2 restrictive policies, 5 on `profiles`, 1 on `storage.objects`, 7 helpers rewritten |
| 20260908014000 | atomic_document_signing | applied |

## Diverged and left alone

**`20260903090500_account_properties`** — both tables already exist (created
by Lovable) with the file's columns plus `is_demo` (and `updated_at` on the
contacts table), the same unique constraints under different names, and
different updated_at trigger names. The policies are the real difference:
Lovable's single `ALL` policy per table permits on `can_view_location`, while
the file's write policy requires `can_manage_location` or `assigned_rep`.
Running the file would only add a second, permissive policy beside Lovable's,
so effective access would not change and the ledger would claim a shape that
is not live. Not applied, not recorded. Still missing from live:
`account_properties_address_key_idx`, `account_property_contacts_property_idx`
/ `_contact_idx`, and the `guard_property_contact_account()` trigger that
refuses assigning a contact from another company. Decide whether Lovable's
policy or the file's is wanted, then apply the missing pieces in one file.

Decided 2026-10-07: the file's access rule, Lovable's columns. That one file is
`20261007090000_account_properties_reconcile.sql` (written, not applied); its
header records each choice, and
`supabase/tests/account-properties-reconcile.pglite.mjs` proves a replay and
live end in the same shape. `account_property_contacts_property_idx` is
deliberately not added: the unique `(property_id, contact_id)` covers it.

Earlier divergences recorded by the first pass (`share_links.document_ids` is
`text[]` live; `location_groups` has an extra `created_by`) are unchanged.

## Cron and the hook secret

`cron.job` now has 13 active jobs: the 11 that existed plus
`cleanup-rate-limit-counters` (`17 4 * * *`) and `drying-outside-conditions`
(`20 13 * * *`). `run-automations-15min`, `kahi_sync_kick()`,
`raven_sync_kick()`, `tg_automation_notify()` and `drying_weather_kick()` all
send `x-cron-secret` from `public.cron_secret()`, which reads Vault entry
`CRON_SECRET` (present) and is executable by `postgres`/`service_role` only —
`has_function_privilege('authenticated','public.cron_secret()','EXECUTE')` is
false.

Automatic (authorless) drying readings: `job_drying_readings` now has two
INSERT policies. `job_drying_readings_insert` still requires
`created_by = auth.uid()`; the new `job_drying_readings_insert_weather`
allows `source = 'weather' AND created_by IS NULL AND can_view_job(auth.uid(),
job_id)`. So an authorless weather row **is** allowed for a signed-in user who
can view the job (the on-demand button). The cron path runs on the service
role, which bypasses RLS.

## What remains for Mark

1. **`CRON_SECRET` on the app** — set the Lovable/Cloudflare env var to the
   same value as the Vault entry (see `CRON_SECRET_SETUP.md`). Until then every
   scheduled hook call is refused by `denyUnlessCron` with a 503/401.
2. **Turnstile** — Cloudflare Turnstile secret, `VITE_TURNSTILE_SITE_KEY`, and
   Supabase "Enable CAPTCHA protection" (BACKLOG.md, security section).
3. **`account_properties`** policy decision above — decided; apply
   `20261007090000_account_properties_reconcile.sql`.
4. Observations, not changed here: `anon` still holds table-level
   INSERT/UPDATE/DELETE on `public.profiles` (pre-existing; RLS now denies anon
   outright via `anonymous_profile_access_denied`); `recompute_all_commissions()`
   keeps its PUBLIC EXECUTE by design (guarded in the body);
   `pipeline_reversion_reasons` uses `ON CONFLICT DO NOTHING` on
   `option_list_values`, which has no unique `(list_id, key)`, so a manual
   re-run would duplicate its six values (the ledger prevents that).
