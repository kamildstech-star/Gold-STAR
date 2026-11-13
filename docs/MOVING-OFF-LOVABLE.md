# Moving Recovery Hub off Lovable

From: Lovable hosting + Lovable Cloud (Supabase project `ortpawtuqerkmuykwndp`,
app `flood-hero-hub.lovable.app` / `project--b0a4cfc7-3fd3-46ba-aa5d-90a925aaa67c.lovable.app`,
custom domain `goldstar.falconstaging.com`).

To: Mark's own Supabase project **GSR** (`nixpjqinsgngmrfepiot`, us-west-1) for
the database, and **Vercel** for the app.

This runbook is host-neutral: the database, the data, the secrets, the outside
services, DNS and rollback. **Everything specific to Vercel** (plan, project
settings, environment variables per environment, test deploys, the domain and
Git at cutover) is in **`docs/MOVING-OFF-LOVABLE-VERCEL.md`** (#367).

Figures below were read from the live database on 2026-10-11/12 (read-only).

## Two constraints that shape every step

- **Lovable gives no database connection string.** `pg_dump`/`psql` against
  the live database are not available. Live can only be read through
  Lovable's database query tool, and the running app can read what its own
  service role can reach.
- **Lovable cannot show secret values.** Project Settings › Secrets lists the
  names only. Values are moved by the app itself (Phase 2 step 8b).

---

## Phase 1 — host-neutral code (PRs; nothing switched yet)

Every switch defaults to today's Lovable behaviour, so merging them changes
nothing on the live app. They are flipped only on the new host.

| PR | Switch | Lovable default | After the move |
|---|---|---|---|
| #357 | `PUBLIC_SITE_URL` (server), `VITE_PUBLIC_SITE_URL` (build); DB `app_settings.app_base_url` (migration `20261012150000`) | `flood-hero-hub.lovable.app`; DB seed `project--…lovable.app` | `https://goldstar.falconstaging.com` |
| #359 | `AI_PROVIDER`, `ANTHROPIC_API_KEY`, `AI_MODEL_*`, `AI_TRANSCRIBE_*` | `lovable` (gateway, `LOVABLE_API_KEY`) | `anthropic` |
| #361 | `AUTH_PROVIDER` (server/CSP), `VITE_AUTH_PROVIDER` (build) | `lovable` (oauth.lovable.app) | `supabase` |
| #362 | Maps: own keys first, Lovable connector gateway only with `LOVABLE_API_KEY` | gateway keys injected by Lovable | `GOOGLE_MAPS_SERVER_KEY`, `GOOGLE_MAPS_BROWSER_KEY`, optional `MAPBOX_ACCESS_TOKEN` |
| #365, #366 | Trusted client IP on Vercel; the Vercel build target | Lovable builds as before | see `MOVING-OFF-LOVABLE-VERCEL.md` |

**Scheduling stays in Postgres.** pg_cron (in GSR) runs all 19 jobs; the ones
that need the app POST to `<app_base_url>/api/public/hooks/*` with the Vault
cron secret. The host runs no cron of its own.

---

## What has to move

| Thing | Size / count (live) | How |
|---|---|---|
| Schema: `public`, `goldstar_private` (+ `drizzle` metadata) | 281 tables, ~1175 functions, 1515 RLS policies; **393 ledgered migrations, and the repo's migration folder has drifted from live** | **built from live, not from `supabase/migrations/`** — already done (Phase 2 step 1) |
| Extensions | pg_cron 1.6.4, pg_net 0.20.4 (schema `public`), postgis 3.3.7 (`public`), pg_trgm 1.6 (`public`), supabase_vault, pgcrypto, uuid-ossp, pg_stat_statements | part of the structure build |
| Custom roles | `portal_customer` (NOLOGIN, granted to `authenticator`), `supabase_privileged_role` | part of the structure build; `sandbox_exec` is Lovable's — not copied |
| Auth users | 58 users: 55 with passwords (bcrypt hashes), 59 identities (55 email, 4 Google), 0 MFA factors | `auth.users`, `auth.identities`, `auth.mfa_factors` copied with the same ids (step 6); the hashes carry over, so passwords keep working |
| Auth triggers on `auth.users` | `on_auth_user_created` → `handle_new_user`, `on_auth_user_password_changed`, `portal_role_guard` | part of the structure; **off while loading data** |
| Storage | 11 private buckets, ~159 MB, 737 objects (707 in `project-photos`, 143 MB), 38 policies on `storage.objects` | buckets + policies with the structure; objects via the **Export storage file list** button (step 7) |
| Realtime | publication `supabase_realtime`: chaser_shifts, conversations, incident_events, incidents, message_reactions, message_receipts, messages | part of the structure |
| pg_cron | 19 jobs (list below) | recreate after the data load (step 10) |
| Vault | 1 secret: `CRON_SECRET` | new value in GSR (step 8) |
| Deployment secrets | every row of the secrets table that is set on Lovable | the **Transfer secrets to new host** button (step 8b) |
| `integration_credentials` | 7 rows (OUTLOOK_CLIENT_ID/SECRET/TENANT_ID/WEBHOOK_CLIENT_STATE, RAVEN_API_KEY/SECRET + internal), AES-GCM sealed with `INTEGRATION_CRED_KEY` | data copy; **needs the same `INTEGRATION_CRED_KEY`** |
| `microsoft_connection_secrets` | 0 rows today (no one has connected delegated Outlook yet) | data copy; same key rule |

### The 19 pg_cron jobs (live)

| Job | Schedule (UTC) | Command |
|---|---|---|
| chase-claim-expiry | `*/5 * * * *` | `expire_stale_chase_claims(); expire_stale_dispatches()` |
| chase-shift-overtime-sweep | `*/5 * * * *` | `chase_shift_overtime_sweep()` |
| cleanup-rate-limit-counters | `17 4 * * *` | `cleanup_rate_limit_counters()` |
| compliance-alerts-daily | `0 7 * * *` | `run_compliance_alerts()` |
| credential-expiry-daily | `5 7 * * *` | `run_credential_expiry_alerts()` |
| document-signature-reminders | `20 7 * * *` | `run_document_signature_reminders()` |
| drying-outside-conditions | `20 13 * * *` | `drying_weather_kick()` → hook |
| email-release | `* * * * *` | `email_release_kick()` → hook |
| escalate-lead-approvals | `10 7 * * *` | `escalate_overdue_lead_approvals()` |
| escalation-scan-daily | `0 13 * * *` | `run_escalation_scan()` |
| fire-feed | `1-59/2 * * * *` | `fire_feed_kick()` → hook |
| graph-sync | `7-59/15 * * * *` | `graph_sync_kick()` → hook |
| insurance-info-tasks | `0 11 * * *` | `sweep_insurance_info_tasks()` |
| kahi-equipment-sync | `*/15 * * * *` | `kahi_sync_kick()` → hook |
| prune-telemetry | `20 4 * * *` | `prune_telemetry(30)` |
| raven-positions | `*/5 * * * *` | `raven_sync_kick('positions')` → hook |
| run-automations-15min | `*/15 * * * *` | inline `net.http_post` → hook (after migration 20261012150000: `app_hook_url('run-automations')`) |
| stage-advance-sweep | `*/10 * * * *` | `stage_advance_sweep()` |
| vehicle-due-alerts | `10 11 * * *` | `run_vehicle_due_alerts()` |

Plus the event-driven caller `tg_automation_notify()` (triggers on accounts,
account_stage_history, tasks, touchpoints), which posts to the same hook.

---

## Phase 2 — GSR (no user impact; Lovable stays live)

Prerequisite: every migration through `20261012150000` (#357, after #360's
`20261012100000` and #355's `20261012120000`) applied to **Lovable**, so the
live functions already read `app_base_url`.

1. **Structure — already built.** The GSR structure (schemas, tables,
   functions, RLS policies, grants, extensions, roles, the `auth.users`
   triggers, the realtime publication, storage buckets and their policies)
   has been built **from live** and diffed against live; the tooling for that
   lives in the `gsr/` folder of the scratchpad of the session that built it.
   Before cutover, re-run that diff: any migration applied to Lovable after
   the build must also be applied to GSR, and the diff must come back empty.
   Never rebuild GSR by replaying `supabase/migrations/` — it has drifted from
   live.
2. **Extensions** — part of step 1. For reference, GSR needs pg_cron, pg_net,
   postgis and pg_trgm in schema `public` (as live), supabase_vault, pgcrypto
   and uuid-ossp. `net.http_post` lives in schema `net` whichever schema
   pg_net is registered in, so the hook callers work either way.
3. **Roles** — part of step 1: `portal_customer` NOLOGIN, granted to
   `authenticator`. `supabase_privileged_role` is Supabase's own.
4. **Grants** — part of step 1, and the part most worth re-checking in the
   diff: EXECUTE revoked from anon/PUBLIC on functions is half the security
   model, and a structure copied without privileges would quietly open it.
5. **Storage buckets and policies** — part of step 1. Expect 11 private
   buckets and 38 policies on `storage.objects`.
6. **Data** — proven in a dry run, with the `gsr/gsr-data.mjs` tool from the
   same scratchpad (commands `export-sql`, `ingest`, `load`, `verify`,
   `clean-sensitive`). There is no connection string, so no `pg_dump`:
   - **Export** (`export-sql`, then `ingest`): read-only SQL against live
     through the Lovable MCP `query_database` tool, which runs as `postgres`
     and can read `auth.*`. The results are saved straight to disk.
   - **Load** (`load`): into GSR with the Supabase CLI,
     `npx supabase db query --linked` (GSR linked), as `postgres`, with
     `session_replication_role = replica`, so no trigger or cascade fires and
     no audit/history rows are written (`handle_new_user` does not create
     every profile a second time).
   - **Before loading**, every `public` and `drizzle` table and `auth.users`,
     `auth.identities` and `auth.mfa_factors` are truncated in GSR, rows the
     structure build seeded included.
   - **Copied:**
     - every app table, without its generated columns (GSR recomputes them);
     - `auth.users` with the bcrypt password hashes, `auth.identities` and
       `auth.mfa_factors`, all with the same ids. Every password keeps
       working; every session ends (GSR signs with its own keys), so people
       sign in once;
     - every sequence, set to live's value.
   - **Not copied:**
     - sessions and refresh tokens;
     - `storage.objects` (the file copy in step 7 creates those rows);
     - the `cron`, `net`, `vault` and `realtime` schemas (steps 8–10).
   - **Verify** (`verify`):
     - a row count and a full-row checksum for every table;
     - id checksums on the key tables;
     - every sequence equal to live;
     - an orphan foreign-key check, which must return 0.
   - **Dry run:** 284 tables and 62,715 rows matched, 0 mismatches. 58 users
     (55 with passwords) and 59 identities copied. Export took about 45 s,
     load about 23 s and verify about 4 s.
   - **`integration_credentials`** come across as ciphertext. They can only be
     read with Lovable's `INTEGRATION_CRED_KEY`, which the transfer button
     (step 8b) carries over; otherwise they must be re-entered (see the
     secrets table). The same applies to `microsoft_connection_secrets`.
   - **The local export files hold customer data.** Run `clean-sensitive`
     after every run, the dry run included.
7. **Storage objects** (~159 MB) — use the temporary, owner-only **Export
   storage file list** button on the live app. It lists every object with its
   bucket and path; copy each to the **same bucket and path** in GSR (photo
   rows store the path, so a different path is a broken photo). Verify counts
   per bucket against the table above. Remove the button once cutover is done.
8. **Vault cron secret** — generate a fresh one (`openssl rand -hex 32`):
   ```sql
   SELECT vault.create_secret('<value>', 'CRON_SECRET');
   ```
   The same value becomes the host's `CRON_SECRET`.

   **8b. Deployment secrets** — Lovable cannot show their values, so they are
   moved by the temporary, owner-only **Transfer secrets to new host** button
   on the live app, which reads them where they exist (the running
   deployment). This is how `INTEGRATION_CRED_KEY` keeps its value — see the
   secrets table. Values that must be new (`CRON_SECRET`, the GSR Supabase
   keys) are set by hand. Remove the button once cutover is done.
9. **App base URL in GSR** — point the hooks at the new host while testing
   (the one-statement cutover; it also clears per-job overrides):
   ```sql
   UPDATE public.app_settings
      SET value = CASE WHEN key = 'app_base_url' THEN jsonb_build_object('url', 'https://<test host>')
                       ELSE value - 'hook_url' END
    WHERE key IN ('app_base_url','kahi','raven','drying_weather','automations','graph_sync','fire_feed');
   ```
   The test host must be one the scheduler can reach without a login (on
   Vercel: the production `*.vercel.app` domain, not a deployment URL).
10. **pg_cron jobs** — recreate the 19 jobs above, with the live commands, in
    GSR **only after step 9** (otherwise GSR's jobs would post to the live
    app). Generate the statements from live with the query tool:
    ```sql
    SELECT format('SELECT cron.schedule(%L, %L, %L);', jobname, schedule, command)
      FROM cron.job ORDER BY jobname;
    ```
    Keep `fire-feed` and `graph-sync` paused (`cron.alter_job(id, active := false)`)
    until cutover: two databases both subscribing to the same Outlook
    mailboxes would ingest mail twice.
11. **Auth settings** (GSR Dashboard › Authentication) — copy from Lovable
    Cloud's auth settings screen:
    - URL Configuration › **Site URL**: `https://goldstar.falconstaging.com`
    - **Additional Redirect URLs**: `https://goldstar.falconstaging.com/**`,
      the test host `/**` while testing, `http://localhost:8080/**`
      (Google sign-in returns to `/auth?next=…`).
    - Providers › **Google**: enable, paste the client ID/secret from step 12.
    - Email: confirmation on/off and templates as on Lovable; SMTP → Resend
      (`smtp.resend.com`, user `resend`, password = a Resend API key) so auth
      email does not go out through Supabase's rate-limited default sender.
    - Attack Protection: CAPTCHA → Turnstile with the **secret** key, only in
      the same window as `VITE_TURNSTILE_SITE_KEY` (see `turnstile-widget.tsx`).
    - Password policy / leaked-password protection as on Lovable.
12. **Google Cloud OAuth client** (console.cloud.google.com › APIs & Services ›
    Credentials › OAuth client ID, type *Web application*):
    - Authorized JavaScript origins: `https://goldstar.falconstaging.com`
      (and the test host while testing).
    - Authorized redirect URI: **`https://nixpjqinsgngmrfepiot.supabase.co/auth/v1/callback`**
      — Supabase, not the app, receives Google's answer.
    - OAuth consent screen: app name, support email, the domain
      `falconstaging.com` under authorized domains.
    The 4 Google-identity users keep working: an identity is keyed by the
    Google account's `sub`, which does not change with the OAuth client.
13. **Migrations from now on** go to GSR (and to Lovable until cutover).
    `supabase link --project-ref nixpjqinsgngmrfepiot`, then mark the 393
    ledgered versions as applied (`supabase migration repair --status applied …`)
    so the CLI never replays history over the structure.

---

## Phase 3 — the new host (no user impact)

Follow **`docs/MOVING-OFF-LOVABLE-VERCEL.md`** sections 1–4: plan, project
settings, environment variables (values from the secrets table below), and a
test deploy. Then, on the test host:

- sign in with a password and with Google;
- open a job's photos (proves the storage copy), run Polaris, send a test
  email, sign a test document;
- in GSR, `SELECT * FROM net._http_response ORDER BY created DESC LIMIT 20;` —
  the cron hooks should answer 200.

---

## Phase 4 — cutover (a short maintenance window)

1. Announce; stop writes on Lovable: pause its cron jobs
   (`SELECT cron.alter_job(jobid, active := false) FROM cron.job;` through the
   query tool) and ask staff to stay out for ~30 minutes.
2. **Final data sync**: with Lovable quiet, a **full reload** with Phase 2
   step 6. There is no incremental mode: export, truncate, load, then
   `verify`, which must come back clean, then `clean-sensitive`. Re-run the
   storage copy from a fresh **Export storage file list**; only new objects
   need copying. Then re-run Phase 2 step 9 to reset the hook URLs, because
   the reload brought back live's `app_settings` rows.
3. In GSR, set the real address — the one statement:
   ```sql
   UPDATE public.app_settings
      SET value = CASE WHEN key = 'app_base_url' THEN jsonb_build_object('url', 'https://goldstar.falconstaging.com')
                       ELSE value - 'hook_url' END
    WHERE key IN ('app_base_url','kahi','raven','drying_weather','automations','graph_sync','fire_feed');
   ```
   and set `PUBLIC_SITE_URL` / `VITE_PUBLIC_SITE_URL` on the host to the same
   address (a rebuild, since the `VITE_` one is compiled in).
4. **DNS**: point `goldstar.falconstaging.com` at the new host
   (`MOVING-OFF-LOVABLE-VERCEL.md` section 5), and remove the custom domain
   from the Lovable project so Lovable stops answering for it.
5. Re-enable the GSR cron jobs, `fire-feed` and `graph-sync` included.
6. Repoint the outside services (next section).
7. Smoke test as in Phase 3, on the real domain.

### Outside services to repoint

| Service | What | New value |
|---|---|---|
| Microsoft Entra (IT — Chaim, SM Tech Solutions) | App registration › Authentication › Web redirect URIs | Keep `https://goldstar.falconstaging.com/api/auth/microsoft/callback` (already registered; it follows DNS). Add the test host's `/api/auth/microsoft/callback` only if Outlook connect must be tested before cutover (with `PUBLIC_SITE_URL` set to that host — the app accepts its own configured origin). The `flood-hero-hub.lovable.app` URI can go after cutover. |
| Outlook change notifications | Graph subscriptions carry the URL they were created with; renewals keep it | Check Settings › Integrations › Outlook for the notification URL. If it is not `goldstar.falconstaging.com`, remove and re-add each mailbox there after cutover (removal deletes its subscriptions; the next 15-minute graph-sync creates new ones at the new address). |
| Resend | Webhooks › endpoint | `https://goldstar.falconstaging.com/api/public/hooks/resend` (same signing secret, or a new one in `RESEND_WEBHOOK_SECRET`) |
| CallRail | Webhook (post-call) | `https://goldstar.falconstaging.com/api/public/hooks/callrail` |
| Raven (Klashwerks) | Webhook target | `https://goldstar.falconstaging.com/api/public/hooks/raven` |
| Auto-capture / equipment tracker / incident (BNN) senders | Webhook targets | `…/api/public/hooks/auto-capture`, `…/equipment-tracker`, `…/incidents` |
| Google Cloud | Browser key HTTP referrers | add `goldstar.falconstaging.com/*` and the test host; the server key stays unrestricted by referrer (restrict it by API instead) |
| Cloudflare Turnstile | Widget hostnames | add the test host while testing; `goldstar.falconstaging.com` stays |
| Supabase (GSR) | Auth URL configuration | Phase 2 step 11 |

Any endpoint that already uses `goldstar.falconstaging.com` follows DNS and
needs no change; anything registered on a `*.lovable.app` host does.

### Rollback

Lovable keeps running on its own database throughout, so rollback is:
1. **DNS**: point `goldstar.falconstaging.com` back at Lovable and re-add the
   custom domain in the Lovable project.
2. **app_base_url** in **Lovable's** database:
   `UPDATE public.app_settings SET value = jsonb_build_object('url','https://project--b0a4cfc7-3fd3-46ba-aa5d-90a925aaa67c.lovable.app') WHERE key = 'app_base_url';`
   then re-activate Lovable's cron jobs and pause GSR's.
3. Writes made on GSR during the attempt are not in Lovable. Re-enter them by
   hand: the step 6 tool only copies from Lovable into GSR.

---

## Secrets and settings

Set on the host as described in `MOVING-OFF-LOVABLE-VERCEL.md` section 3.
"Transfer" = moved by the **Transfer secrets to new host** button (Phase 2
step 8b), because Lovable cannot show the value.

| Variable | Used for | Where it comes from | If it cannot be transferred |
|---|---|---|---|
| `SUPABASE_URL` | server Supabase client | GSR | — |
| `SUPABASE_PUBLISHABLE_KEY` | server client (anon) | GSR › Settings › API keys (`sb_publishable_…`) | — |
| `SUPABASE_SERVICE_ROLE_KEY` | admin client (`client.server.ts`) | GSR › API keys › secret key (`sb_secret_…`) | — |
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_SUPABASE_PROJECT_ID` | browser bundle (build) | GSR | — |
| `PUBLIC_SITE_URL` / `VITE_PUBLIC_SITE_URL` | links, Outlook webhook URL, MS redirect allowlist | `https://goldstar.falconstaging.com` | — |
| `APP_ORIGINS` | extra CORS origins (optional) | only if a second domain needs it | — |
| `CRON_SECRET` | every `/api/public/hooks/*` scheduled call | **generate**; same value in GSR Vault `CRON_SECRET` | — |
| **`INTEGRATION_CRED_KEY`** | AES-GCM key for `integration_credentials` and `microsoft_connection_secrets` | **transfer — must be the current value** | Otherwise both tables are unreadable: generate a new key, re-type every Integrations-screen value (today: OUTLOOK_CLIENT_ID/SECRET/TENANT_ID/WEBHOOK_CLIENT_STATE, RAVEN_API_KEY/SECRET) and have each person reconnect Outlook (0 delegated connections today) |
| `RATE_LIMIT_PEPPER` | hashes rate-limit identifiers | transfer, or **generate** (counters reset — harmless) | generate |
| `AUTH_PROVIDER` / `VITE_AUTH_PROVIDER` | Google sign-in via Supabase | `supabase` | — |
| `AI_PROVIDER` | AI switch | `anthropic` | — |
| `ANTHROPIC_API_KEY` | AI; also, on its own, moves job loss reports to Claude Opus 5.5 even while `AI_PROVIDER` is still `lovable` | console.anthropic.com (Mark) | — |
| `AI_MODEL_GENERAL`, `_ASSISTANT`, `_EXTRACTION`, `_DOCUMENT` | model overrides (optional) | defaults: Sonnet 5.5 / Sonnet 5.5 / Haiku 4.5 / Sonnet 5.5 | — |
| `AI_MODEL_REPORT` | loss-report model override (optional) | default: Opus 5.5 on Anthropic (falls back to Sonnet 5.5); `google/gemini-3.6-pro` on the gateway (falls back to flash) | — |
| `AI_EFFORT`, `AI_FALLBACKS` | optional tuning | unset | — |
| `AI_TRANSCRIBE_BASE_URL`, `AI_TRANSCRIBE_API_KEY`, `AI_MODEL_TRANSCRIBE` | voice notes (Anthropic has no speech-to-text) | OpenAI: `https://api.openai.com/v1` + an OpenAI key (default model `gpt-4o-mini-transcribe`) | voice notes off until set |
| `AI_BASE_URL`, `AI_API_KEY` | only for `AI_PROVIDER=openai_compatible` | provider | — |
| `LOVABLE_API_KEY` | Lovable AI gateway + map connector | **do not set** off Lovable | — |
| `GOOGLE_MAPS_SERVER_KEY` | geocoding, Places, static maps | Google Cloud (Gold Star billing) — transfer if set on Lovable | create a new key limited by API to Geocoding / Places (New) / Static Maps / Street View |
| `GOOGLE_MAPS_BROWSER_KEY` | Maps JavaScript in the browser (served at runtime) | Google Cloud, referrer-restricted | create |
| `GOOGLE_PLACES_API_KEY`, `GOOGLE_API_KEY` | legacy fallbacks | only if used on Lovable | — |
| `GOOGLE_MAPS_API_KEY`, `MAPBOX_API_KEY`, `VITE_LOVABLE_CONNECTOR_GOOGLE_MAPS_*` | Lovable connector keys | **do not set** off Lovable (inert without the gateway) | — |
| `MAPBOX_ACCESS_TOKEN` | Mapbox fallback geocoding (optional) | mapbox.com | OSM fallbacks still work |
| `RESEND_API_KEY`, `RESEND_FROM`, `RESEND_FROM_ADDRESS` | email | transfer | new API key in Resend |
| `RESEND_WEBHOOK_SECRET` | Resend delivery webhook | transfer (or a new endpoint secret) | new endpoint secret |
| `OUTLOOK_TENANT_ID`, `OUTLOOK_CLIENT_ID`, `OUTLOOK_CLIENT_SECRET`, `OUTLOOK_WEBHOOK_CLIENT_STATE`, `OUTLOOK_AUTH_MODE` | Microsoft 365 | transfer, or rely on the Integrations-screen values (needs `INTEGRATION_CRED_KEY`) | IT issues a new client secret |
| `GRAPH_WEBHOOK_SECRET` | Graph webhook check | transfer | generate |
| `RAVEN_API_KEY`, `RAVEN_API_SECRET`, `RAVEN_API_URL`, `RAVEN_WEBHOOK_SECRET` | Raven fleet | transfer | Klashwerks |
| `KAHI_API_TOKEN` | Kahi equipment sync | transfer | Kahi |
| `CALLRAIL_API_KEY`, `CALLRAIL_WEBHOOK_SECRET` | CallRail | transfer | CallRail |
| `AUTO_CAPTURE_WEBHOOK_SECRET`, `EQUIPMENT_TRACKER_WEBHOOK_SECRET`, `INCIDENT_WEBHOOK_SECRET` | inbound webhooks | transfer | generate + update the sender |
| `PROPERTY_PROVIDER`, `PROPERTYSHARK_API_KEY` | property lookups | transfer | vendor |
| `OPEN_METEO_API_KEY` | paid weather (optional) | transfer if set | free tier |
| `SOCRATA_APP_TOKEN`, `COMPANYCAM_API_KEY`, `ESIGN_PROVIDER`, `ESIGN_API_KEY`, `ESIGN_WEBHOOK_SECRET`, `EMAIL_MARKETING_API_KEY` | optional integrations | transfer if set | — |
| `VITE_TURNSTILE_SITE_KEY` (build) + Turnstile secret (in Supabase Auth) | CAPTCHA | Cloudflare Turnstile | leave off |

Host-specific variables (for example the client-IP setting on Vercel) are in
`MOVING-OFF-LOVABLE-VERCEL.md`. Generate a secret with `openssl rand -hex 32`.

---

## What Mark provides

- The host account and plan — `MOVING-OFF-LOVABLE-VERCEL.md`, "What Mark
  needs to do".
- Anthropic API key (`ANTHROPIC_API_KEY`), and an OpenAI key for voice notes
  (`AI_TRANSCRIBE_API_KEY`).
- Google Cloud: an OAuth client (redirect URI above) for Supabase's Google
  provider; a server and a browser Maps key on Gold Star's billing account.
- The owner sign-in to run the **Export storage file list** and **Transfer
  secrets to new host** buttons on the live app — the only way out for the
  storage objects and for secret values, since Lovable shows no connection
  string and no secret values.
- Access to the DNS host for `falconstaging.com` at cutover.
- IT (Chaim): nothing, unless Outlook must be tested on the test host before
  cutover (one extra redirect URI).
