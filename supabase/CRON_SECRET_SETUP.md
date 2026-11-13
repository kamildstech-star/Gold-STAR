# CRON_SECRET setup

The cron hooks under `/api/public/hooks/*` (run-automations, kahi-sync,
raven-sync, drying-weather, cadence-sweep, chase-escalation,
document-signature-reminders, sync-nyc-fire-leads) accept one credential: an
`x-cron-secret` header equal to the app's `CRON_SECRET` environment variable.
They fail closed — with `CRON_SECRET` unset every call gets **503**, and with
it set every call without the right header gets **401**.

The database is the caller. pg_cron jobs and the automation triggers read the
same value from Supabase Vault (entry name `CRON_SECRET`) through
`public.cron_secret()`, which migration
`20260903200000_cron_callers_send_secret.sql` creates.

**The two copies must be the same string.** The app compares them byte for
byte.

## 1. Generate the secret (once, on your machine)

Any of these produce 48 random bytes, printed URL-safe so it needs no quoting
in a header or in SQL:

```sh
# macOS / Linux / Git Bash
openssl rand -base64 48 | tr '+/' '-_' | tr -d '='
```

```powershell
# Windows PowerShell
$b = New-Object byte[] 48; [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
[Convert]::ToBase64String($b).Replace('+','-').Replace('/','_').TrimEnd('=')
```

```sh
# Node
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Keep it somewhere you can copy from twice. It is not shown again by either
system.

## 2. Store it in Supabase Vault

In the Lovable Cloud SQL editor (Cloud → Database → SQL), or any client
connected as `postgres`:

```sql
select vault.create_secret(
  '<paste the value>',
  'CRON_SECRET',
  'Shared secret for /api/public/hooks/* (x-cron-secret header)'
);
```

Vault was empty on 2026-09-03, so this is a create, not an update. If you ever
rotate:

```sql
select vault.update_secret(
  (select id from vault.secrets where name = 'CRON_SECRET'),
  '<new value>'
);
```

## 3. Apply the migration

Run `supabase/migrations/20260903200000_cron_callers_send_secret.sql` against
the project. It is re-runnable and does not need the Vault entry to exist at
apply time, but step 2 first means the very next cron tick succeeds instead of
failing once.

- Lovable Cloud: paste the file into the SQL editor and run it.
- Supabase CLI, if the project is linked: `supabase db push`.

The migration replaces the header sent by `run-automations-15min`,
`kahi_sync_kick()`, `raven_sync_kick()` and `tg_automation_notify()`, and adds
the `drying-outside-conditions` daily job that was written but never applied.

Later kick functions read the same Vault entry: `email_release_kick()`
(20260928122000) and `graph_sync_kick()` (20261011120000, the Microsoft 365
sync, which until then had a secret of its own that nothing ever sent).

## 4. Set it in the app environment

In the Lovable project: **Project Settings → Secrets → Add secret**, name
`CRON_SECRET`, value = the same string. This is a server-side secret, the same
place the Outlook/Resend secrets live (the Outlook
setup screen in `/admin/integrations` points at the same place).

- Name it exactly `CRON_SECRET`. **Not** `VITE_CRON_SECRET` — a `VITE_` prefix
  would compile it into the browser bundle and publish it.
- Redeploy / publish after saving so the running server picks it up.
  `src/lib/cron-auth.ts` reads `process.env.CRON_SECRET` at request time; a
  build that started before the secret existed does not have it.

## 5. Verify

### The function is not exposed

Run as `postgres` (SQL editor). Expected: `false`, `false`, `true`, `true`.

```sql
select
  has_function_privilege('authenticated', 'public.cron_secret()', 'EXECUTE') as authenticated_can_execute,
  has_function_privilege('anon',          'public.cron_secret()', 'EXECUTE') as anon_can_execute,
  has_function_privilege('postgres',      'public.cron_secret()', 'EXECUTE') as postgres_can_execute,
  has_function_privilege('service_role',  'public.cron_secret()', 'EXECUTE') as service_role_can_execute;
```

Belt and braces, from an authenticated session (the app's Supabase client, or
`set role authenticated;` in the SQL editor):

```sql
select public.cron_secret();
-- expected: ERROR: permission denied for function cron_secret
```

And that the value is present without printing it:

```sql
select length(public.cron_secret()) as secret_length;  -- 64 for the commands above
```

### The hooks answer correctly

Pick one hook. `run-automations` accepts an empty body. Use the host the
scheduler uses (both `https://project--b0a4cfc7-3fd3-46ba-aa5d-90a925aaa67c.lovable.app`
and `https://goldstar.falconstaging.com` serve the app).

```sh
HOST=https://project--b0a4cfc7-3fd3-46ba-aa5d-90a925aaa67c.lovable.app

# no header -> 401 once CRON_SECRET is set (503 while it is still unset)
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$HOST/api/public/hooks/run-automations" \
  -H "Content-Type: application/json" -d '{}'

# wrong header -> 401
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$HOST/api/public/hooks/run-automations" \
  -H "Content-Type: application/json" -H "x-cron-secret: nope" -d '{}'

# right header -> 200 and a JSON report
curl -s -w "\n%{http_code}\n" -X POST "$HOST/api/public/hooks/run-automations" \
  -H "Content-Type: application/json" -H "x-cron-secret: <paste the value>" -d '{}'
```

Reading the status codes: **503** = step 4 not done (or not redeployed);
**401** with the right value = the two copies differ (re-check for a trailing
newline or a partial paste); **200** = done.

### The scheduler is back

Wait for the next quarter hour, then:

```sql
-- what the hooks returned to pg_net (want 200s, not 503/401)
select id, status_code, left(content, 120) as content, created
from net._http_response
order by created desc
limit 10;

-- job outcomes (a `failed` row here with "CRON_SECRET is not in Supabase Vault"
-- means step 2 was skipped)
select j.jobname, d.status, d.return_message, d.start_time
from cron.job_run_details d
join cron.job j on j.jobid = d.jobid
where j.jobname in ('run-automations-15min', 'kahi-equipment-sync', 'raven-positions', 'drying-outside-conditions')
order by d.start_time desc
limit 12;
```

## Rotation

1. `vault.update_secret(...)` with the new value (step 2's second query).
2. Update `CRON_SECRET` in Lovable Cloud → Secrets and redeploy.
3. Between the two steps, hooks return 401 to the scheduler; nothing is lost,
   every hook backfills on its next run.

## What is deliberately still unscheduled

`cadence-sweep`, `chase-escalation`, `document-signature-reminders` (the SQL
job of the same name already runs) and `sync-nyc-fire-leads` (manual button)
have no database caller. The reasons are at the bottom of the migration. The
"Sync now" button for NYC fire leads on `/admin/integrations` POSTs from the
browser without the header and will get 401 until it is moved behind a server
function.
