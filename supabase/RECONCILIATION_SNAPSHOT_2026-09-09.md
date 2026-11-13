# Reconciliation snapshot — 2026-09-09 (read-only, taken before any write)

Target: Lovable project `b0a4cfc7-3fd3-46ba-aa5d-90a925aaa67c`, PostgreSQL 17.6.
Extensions: pg_cron 1.6.4, pg_net 0.20.4, supabase_vault 0.3.1, pgcrypto 1.3.
Vault: **empty** (no `CRON_SECRET`). Session role: `postgres`.
Tool: Lovable MCP `query_database`; one call = one transaction (verified: a
`vault.create_secret` followed by `select 1/0` in the same call left no secret).
A `499 request_cancelled` from the tool does not mean the statement rolled back:
several 499s during this run had committed server-side, so the catalog was
re-checked after every one.

## Ledger (`supabase_migrations.schema_migrations`) — versions >= 20260821 before this run

```
20260821171822 20260821171953 20260821172927 20260821175812 20260821233355 20260821235452
20260831172304 20260831172358 20260831190000 field_work_tickets 20260831190500 standalone_intake_links
20260831200046 20260831200235 20260901120000 drying_log 20260902172552 20260902172640
20260902200000 labour_rates_crew_class 20260902200500 field_ticket_crew_hours
20260903172802 job_calculations 20260903181541 secure_job_calculation_policy_and_grants
20260903182122 add_job_date_to_calculations 20260903212000 tradeshow_lead_capture
20260903220000 tradeshow_intake_links 20260903223000 intake_general_links 20260903224000 intake_form_trim
20260904090000 drying_interior_readings 20260907161050 chat_project_invoice_sharing
20260907162526 local_calendar_recurrence 20260907164530 20260907164711 20260907164828 20260907172022
20260907172841 reconcile_tradeshow_lead_media 20260907172938 reconcile_field_ticket_crew_hours
20260907173850 validate_drying_humidity_constraint 20260908055847 claim_new_lead_atomic
20260908142838 melly_seller_page_access 20260908142840 task_completed_notification_type
20260908142842 task_completion_notifications 20260908142844 google_review_link_tracking
20260908171508 tighten_google_review_link_grants 20260908171733 fix_google_review_link_insert_scope
20260908183307 advance_ready_on_first_call 20260908183312 91ded377-1386-4b15-a23c-049ccf7406aa
20260908183526 capture_tradeshow_lead_account 20260908183627 exclude_active_clients_from_pipeline_projection
20260908185502 move_account_back_to_pipeline_atomically
```

Ledger row with **no file in `supabase/migrations`**: `20260908183312`
(`91ded377-...`; statements: `ALTER ROLE authenticated SET statement_timeout='30s'`,
`ALTER ROLE anon SET statement_timeout='10s'`, `CREATE INDEX IF NOT EXISTS
vehicle_positions_occurred_at_idx`, `ANALYZE public.vehicle_positions`).
The 14 `20260728*` files are ledgered under versions 1-4 s later than their
filename (matched by name).

Duplicate-timestamp check (`ls supabase/migrations | sed -E 's/^([0-9]{14}).*/\1/' | sort | uniq -d`): **none**.

## Pending files (version absent from the ledger) and live catalog state

| # | File | Live state found before applying |
|---|---|---|
| 1 | 20260821070000_certificate_send_log | FULL: enum, table (RLS), 2 indexes, trigger, 4 policies, view |
| 2 | 20260823090000_close_money_leaks | FULL: invoices/estimates_select gate on job.view_costs; vehicles_select CASE; *_select_reference require a role; effective_permissions has is_privileged guard; chase_shift_overtime_sweep has no 'owner'; stage-advance-sweep scheduled; er_update_own allows cancelled |
| 3 | 20260825120000_share_links_legacy_import_and_job_fields | PARTIAL: share_links.job_id / document_ids (**text[]** live, file says uuid[]) / display_options, project_id nullable, share_links_job_id_idx, job_reports.photo_ids (text[]) present; missing jobs.office_next_step/field_next_step/hoa/external_source/external_id, accounts/contacts/documents.external_*, the 4 `*_external_ref_key` indexes, jobs_external_source_idx, share_links_scope_present |
| 4 | 20260826100000_profile_contact_details | ABSENT: no work_phone/extension/mobile_phone/job_title |
| 5 | 20260826110000_email_events | ABSENT |
| 6 | 20260826120000_touchpoint_external_ref_unique | ABSENT. touchpoints=466, external_ref non-null=0, doomed rows=0 |
| 7 | 20260827090000_document_folders | ABSENT |
| 8 | 20260827091000_share_links_job_schedule | PARTIAL/DIVERGED: enum value present; share_links_select_job and _update_job exist with **can_manage_job** (Lovable); the file designs can_view_job and says so in its header |
| 9 | 20260827130000_closing_statement | FULL |
| 10 | 20260827140000_job_bill_to | FULL (index non-partial) |
| 11 | 20260827150000_location_groups | PARTIAL: tables + 4 policies present (extra created_by column), trigger `location_groups_updated_at`; missing location_groups_name_key + 2 member indexes |
| 12 | 20260901090000_field_work_ticket_equipment_tags | PARTIAL: column present; GIN index missing |
| 13 | 20260902093000_payment_receipt_email_category | FULL: enum has payment_receipt |
| 14 | 20260902100000_payment_attachment | ABSENT |
| 15 | 20260902190000_drying_outside_conditions | PARTIAL: job_drying_readings_daily_weather_uniq present; missing observed_at, both functions, trigger, insert_weather policy, app_settings.drying_weather, cron job. Live INSERT policy = `can_view_job AND created_by = auth.uid()` |
| 16 | 20260903090000_company_hierarchy | PARTIAL: contacts.position_key / reports_to_contact_id present; missing contact_position list, 2 indexes, 2 functions, 2 triggers |
| 17 | 20260903090500_account_properties | PARTIAL/DIVERGED: both tables present (0 rows, extra is_demo) with Lovable ALL policies "Members of the owning office manage buildings" / "...building contacts" (can_view_location); missing the 4 indexes, guard function/trigger, updated_at trigger, and the file-named policies |
| 18 | 20260903120000_rate_limit_counters | ABSENT |
| 19 | 20260903130000_security_hardening_batch1 | ABSENT: rate_for / commission_terms_on still granted to authenticated; old single time_entries_update; profiles table-level INSERT/UPDATE for authenticated (and anon); no privilege-guard trigger; cc_select / connections / photo_access_log still permit NULL scope; recompute_all_commissions unguarded; award_achievements granted to PUBLIC; property_notes insert/update `auth.uid() IS NOT NULL`; "system records corrections" already absent |
| 20 | 20260903131000_job_photo_share_links | PARTIAL: enum job_photos present; job_reports.photo_ids text[]; policies in Lovable shape (see #8) |
| 21 | 20260903190000_polaris_attachments | ABSENT |
| 22 | 20260903200000_cron_callers_send_secret | ABSENT: no cron_secret(); kahi/raven/tg_automation_notify send `apikey`; run-automations-15min sends apikey |
| 23 | 20260903210000_chat_assistant_messages | PARTIAL: author_kind + CHECK present; "Members send messages" (from 20260728044004, not Daffa's) lacks the author_kind pin; no guard function / trigger / index |
| 24 | 20260903211000_pipeline_reversion_reasons | ABSENT |
| 25 | 20260903213000_invoice_photos | FULL |
| 26 | 20260903221000_reconstruction_job_type | FULL |
| 27 | 20260903221500_profile_primary_location | PARTIAL: column present; index, 2 functions, 2 triggers missing |
| 28 | 20260903222000_account_multi_location | PARTIAL: accounts.is_multi_location present; index missing; backfill pending |
| 29 | 20260904120000_calendar_outbound_push | ABSENT |
| 30 | 20260907120000_profiles_missing_column_grants | FULL: authenticated holds column SELECT on all 15 profiles columns incl. email and primary_location_id |
| 31 | 20260907120500_job_room_unit | ABSENT |
| 32 | 20260907190000_page_access_seed | PARTIAL: 7 page.* permissions + 14 role_permissions from 20260908142838 (identical values) |
| 33 | 20260907210000_access_audit_never_blocks | ABSENT: audit_user_permissions() emits permission_granted / permission_changed / permission_removed; the CHECK allows only user_permission_added / removed / changed, so every user_permissions write fails. user_permissions = 0 rows |
| 34 | 20260908010058_restrict_internal_commission_rpc | ABSENT: compute_job_commissions granted to PUBLIC/anon/authenticated |
| 35 | 20260908010611_atomic_permission_override | ABSENT |
| 36 | 20260908012000_calendar_push_integrity | ABSENT (not re-runnable: bare ADD COLUMN / CREATE FUNCTION / CREATE TRIGGER). Client insert path (src/lib/calendar-recurring-store.ts) sets provider/external_id to null, compatible with the guard |
| 37 | 20260908012100_atomic_public_intake | ABSENT (not re-runnable) |
| 38 | 20260908013000_active_profile_access_guard | ABSENT: no goldstar_private; all 29 listed tables exist; profiles FORCE RLS off; the 7 helpers it replaces have identical live bodies (live also carries PARALLEL SAFE). profiles: 45 approved/active, 9 approved/inactive, 0 pending |
| 39 | 20260908014000_atomic_document_signing | ABSENT; signature_provider enum has 'native' |

Not pending (in the ledger, applied by Daffa / Lovable out of band):
field_work_tickets, standalone_intake_links, drying_log, labour_rates_crew_class,
field_ticket_crew_hours, tradeshow_lead_capture, tradeshow_intake_links,
intake_general_links, intake_form_trim, drying_interior_readings,
chat_project_invoice_sharing, local_calendar_recurrence, the three
`reconcile_*` / `validate_*` files, and everything from 20260908055847 on
except the 20260908010058-014000 block.

profiles grants before: column-level SELECT (all 15 columns) to authenticated;
table-level INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER to authenticated
**and anon**; the column ACLs are SELECT-only (`authenticated=r`).

## Row counts before

profiles 54, touchpoints 466 (external_ref 0), share_links 0, jobs 44, accounts 111,
contacts 87, documents 7, email_messages 13, invoice_payments 12, labour_rates 1,
job_drying_readings 0, user_permissions 0, app_settings 9, option_list_values 234,
location_groups 0, field_work_tickets 2, job_reports 2, invoices 22, estimates 11,
intake_requests 7, intake_submissions 1, certificate_sends 0, locations 12,
account_properties 0, account_property_contacts 0, role_change_audit 338
(no user_permission_* / permission_* actions).

## cron.job before (11 jobs, all active)

escalation-scan-daily `0 13 * * *`; escalate-lead-approvals `10 7 * * *`;
compliance-alerts-daily `0 7 * * *`; credential-expiry-daily `5 7 * * *`;
document-signature-reminders `20 7 * * *`; run-automations-15min `*/15 * * * *`
(net.http_post with apikey header); chase-shift-overtime-sweep `*/5 * * * *`;
chase-claim-expiry `*/5 * * * *`; raven-positions `*/5 * * * *`;
kahi-equipment-sync `*/15 * * * *`; stage-advance-sweep `*/10 * * * *`.
No cleanup-rate-limit-counters, no drying-outside-conditions.
