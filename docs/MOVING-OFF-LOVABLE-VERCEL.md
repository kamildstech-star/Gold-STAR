# Moving Recovery Hub off Lovable: the Vercel path

Mark chose **Vercel** to host the app after Lovable. The database plan does not
change: Supabase project **GSR** (`nixpjqinsgngmrfepiot`, us-west-1).

This file covers the host only. The database steps (GSR set-up, data copy,
pg_cron, Vault, auth settings, Google OAuth), the outside services to repoint,
and the full secrets table are in `docs/MOVING-OFF-LOVABLE.md` (#364). Where
that runbook says Cloudflare / `wrangler`, use the steps below. Its Phase 2
(GSR) and its list of outside services apply unchanged.

|                 |                                                                                         |
| --------------- | --------------------------------------------------------------------------------------- |
| Vercel team     | Falcon (`monitex`)                                                                      |
| Project         | `goldstar` (`prj_uhromcBFNXhTJsHqbSv3tHvifzDm`), not linked to Git yet                  |
| Domain          | `goldstar.falconstaging.com`                                                            |
| Function region | `sfo1` (San Francisco), next to GSR in us-west-1                                        |
| Build           | `npm run build:vercel` (#366): Nitro's Build Output API in `.vercel/output`             |
| Scheduler       | pg_cron in GSR, calling `<app_base_url>/api/public/hooks/*` (#357). **No Vercel Cron.** |

The code PRs this depends on, all defaulting to Lovable's behaviour until
switched: #357 (app base URL), #359 (AI provider), #361 (Google sign-in through
Supabase), #362 (maps keys), #365 (trusted client IP on Vercel) and #366 (the
build target). **Merge all of them before the first Vercel deploy.** In
particular:

- **#365 must be merged first.** Without it, a visitor to the Vercel deployment
  can choose their own IP address: they can bypass the per-IP limits on sign-in,
  public intake and signing links, and forge the IP recorded on a signed
  document.
- **`package-lock.json` must be back in sync with `package.json`** (it drifted
  in Lovable's sync `a01eeabc`). Vercel installs with `npm ci`, which refuses a
  lockfile that disagrees with `package.json`.

---

## 1. Plan: Pro

Use **Pro**. Hobby is "non-commercial, personal use only"
(vercel.com/docs/plans/hobby, citing the fair use guidelines). Recovery Hub is
Gold Star's business system. Pro also gives:

- function duration up to 800 s (300 s is configured);
- a day of runtime logs, where Hobby keeps one hour;
- spend management.

## 2. Project settings

Set these in the dashboard (Project › Settings). `vercel.json` in the repo
already carries the first three, and the build checks the rest.

| Setting                                                                   | Value                                              | Why                                                                                                                                                   |
| ------------------------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Framework Preset                                                          | **Other**                                          | `vercel.json` sets `"framework": null`; the build writes the Build Output API itself                                                                  |
| Install Command                                                           | `npm ci` (from `vercel.json`)                      | the same tree CI tests and audits (`package-lock.json`)                                                                                               |
| Build Command                                                             | `npm run build:vercel` (from `vercel.json`)        | pins Nitro's vercel preset and writes region and duration into the function config                                                                    |
| Output Directory                                                          | leave empty                                        | a build that writes `.vercel/output` is deployed as-is                                                                                                |
| Node.js Version                                                           | **24.x**                                           | the build fails on any other major version                                                                                                            |
| Functions › Function Region                                               | **sfo1**                                           | also in `vercel.json` and in each function's `.vc-config.json`                                                                                        |
| Functions › Fluid compute                                                 | **on** (the default for new projects)              | the 300 s default and maximum below assume it                                                                                                         |
| Functions › Default Max Duration                                          | leave it                                           | the function's own `maxDuration: 300` applies                                                                                                         |
| Environment Variables › **Enable access to System Environment Variables** | **on**                                             | the app detects Vercel from `VERCEL=1` and then trusts only Vercel's IP headers (#365). If this has to be off, set `CLIENT_IP_SOURCE=vercel` instead. |
| Deployment Protection                                                     | **Standard Protection, Vercel Authentication: on** | every preview and generated deployment URL needs a Vercel login; only the production domain is public                                                 |
| Git                                                                       | **not connected until cutover** (section 5)        |                                                                                                                                                       |

Do not add Vercel Cron jobs and do not add `crons` to `vercel.json`. pg_cron
is the scheduler, and `build:vercel` fails if a cron ever appears in the
output.

## 3. Environment variables

Values come from the secrets table in `docs/MOVING-OFF-LOVABLE.md`. Vercel has
two kinds: **Config**, readable after saving, and **Secret**, write-only after
saving (the old "Sensitive"). Mark everything that is a key, token or secret as
**Secret**. Vercel also redacts Secret values of 32 characters or more from
build logs.

**Production** gets the real values. **Preview** must never get production
secrets. A preview is any branch build, and with Git connected that means any
pushed branch. Choose one:

- **(a) A separate staging Supabase project** (a second project, or a GSR
  branch). Give Preview its URL and keys, and generate a separate set of
  secrets for it.
- **(b) No server secrets in Preview at all.** Set only the Config values that
  point at a staging database, or nothing. Previews then show the UI and fail
  on anything that needs the server key. That is the intended result.

Never give Preview the GSR `SUPABASE_SERVICE_ROLE_KEY`, `INTEGRATION_CRED_KEY`
or `CRON_SECRET`. Deployment Protection (section 2) stays on in both cases.

`VITE_*` variables are compiled into the browser bundle at **build** time.
Vercel exposes project variables to the build, so set them in the same place.
The committed `.env` holds Lovable Cloud's values, and environment values
override it. `build:vercel` prints a warning if the bundle would still point
at Lovable Cloud.

### Config (readable)

| Variable                                                                                                                                                                   | Production                                                           | Preview                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------- |
| `SUPABASE_URL`                                                                                                                                                             | `https://nixpjqinsgngmrfepiot.supabase.co`                           | staging URL, or unset                               |
| `SUPABASE_PUBLISHABLE_KEY`                                                                                                                                                 | GSR `sb_publishable_…`                                               | staging, or unset                                   |
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_SUPABASE_PROJECT_ID`                                                                                           | GSR (`nixpjqinsgngmrfepiot`)                                         | staging, or unset                                   |
| `PUBLIC_SITE_URL`, `VITE_PUBLIC_SITE_URL`                                                                                                                                  | `https://goldstar.falconstaging.com` (#357)                          | the preview host, or unset                          |
| `AUTH_PROVIDER`, `VITE_AUTH_PROVIDER`                                                                                                                                      | `supabase` (#361)                                                    | `supabase`                                          |
| `AI_PROVIDER`                                                                                                                                                              | `anthropic` (#359)                                                   | `anthropic`, or unset                               |
| `AI_MODEL_*`, `AI_TRANSCRIBE_BASE_URL`, `AI_MODEL_TRANSCRIBE`                                                                                                              | as in the runbook, optional                                          | same                                                |
| `GOOGLE_MAPS_BROWSER_KEY`                                                                                                                                                  | referrer-restricted browser key (#362)                               | same key, if its referrers include the preview host |
| `VITE_TURNSTILE_SITE_KEY`                                                                                                                                                  | only once CAPTCHA is on in GSR Auth                                  | unset                                               |
| `OUTLOOK_TENANT_ID`, `OUTLOOK_CLIENT_ID`, `OUTLOOK_AUTH_MODE`, `RAVEN_API_URL`, `RESEND_FROM`, `RESEND_FROM_ADDRESS`, `PROPERTY_PROVIDER`, `ESIGN_PROVIDER`, `APP_ORIGINS` | only those set on Lovable today                                      | unset                                               |
| `CLIENT_IP_SOURCE`                                                                                                                                                         | unset (Vercel is detected); `vercel` only if system env vars are off | same                                                |

Do **not** set `LOVABLE_API_KEY`, `GOOGLE_MAPS_API_KEY`, `MAPBOX_API_KEY` or
`VITE_LOVABLE_CONNECTOR_GOOGLE_MAPS_*` anywhere. The committed `.env` holds
Lovable's value for the two `VITE_LOVABLE_CONNECTOR_GOOGLE_MAPS_*` names. To keep
it out of the bundle, set both to an empty value in both environments. If the
dashboard will not save an empty value, remove the two lines from `.env` in a
PR at cutover instead. Do not set `NODE_OPTIONS`: the build sets its own heap size, and the
variable would also reach the functions.

### Secret (write-only): Production only, or separate staging values in Preview

| Variable                                                                                                                                                     | Notes                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `SUPABASE_SERVICE_ROLE_KEY`                                                                                                                                  | GSR `sb_secret_…`. **Never in Preview.**                                                                                       |
| `INTEGRATION_CRED_KEY`                                                                                                                                       | **the current Lovable value**: it decrypts `integration_credentials` and `microsoft_connection_secrets`. **Never in Preview.** |
| `CRON_SECRET`                                                                                                                                                | equals the GSR Vault `CRON_SECRET`. **Never in Preview.**                                                                      |
| `RATE_LIMIT_PEPPER`                                                                                                                                          | copy or generate                                                                                                               |
| `ANTHROPIC_API_KEY`, `AI_TRANSCRIBE_API_KEY`, `AI_API_KEY`                                                                                                   | AI                                                                                                                             |
| `GOOGLE_MAPS_SERVER_KEY`, `GOOGLE_PLACES_API_KEY`, `GOOGLE_API_KEY`, `MAPBOX_ACCESS_TOKEN`                                                                   | maps (#362); only those that are set                                                                                           |
| `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`                                                                                                                    | email                                                                                                                          |
| `OUTLOOK_CLIENT_SECRET`, `OUTLOOK_WEBHOOK_CLIENT_STATE`, `GRAPH_WEBHOOK_SECRET`                                                                              | Microsoft 365                                                                                                                  |
| `RAVEN_API_KEY`, `RAVEN_API_SECRET`, `RAVEN_WEBHOOK_SECRET`, `KAHI_API_TOKEN`                                                                                | fleet and equipment                                                                                                            |
| `CALLRAIL_API_KEY`, `CALLRAIL_WEBHOOK_SECRET`                                                                                                                | CallRail                                                                                                                       |
| `AUTO_CAPTURE_WEBHOOK_SECRET`, `EQUIPMENT_TRACKER_WEBHOOK_SECRET`, `INCIDENT_WEBHOOK_SECRET`                                                                 | inbound webhooks                                                                                                               |
| `PROPERTYSHARK_API_KEY`, `OPEN_METEO_API_KEY`, `SOCRATA_APP_TOKEN`, `COMPANYCAM_API_KEY`, `ESIGN_API_KEY`, `ESIGN_WEBHOOK_SECRET`, `EMAIL_MARKETING_API_KEY` | only those set on Lovable today                                                                                                |

The team setting **Security › Separate Production Secret Values** (owner only)
makes Vercel refuse a Secret whose Production value equals its Preview value.
Turn it on.

## 4. Test before cutover (Git still not connected)

Deploy from a machine with the Vercel CLI, logged in to the Falcon team:

```bash
npx vercel@latest link --project goldstar --scope monitex   # once; writes .vercel/project.json (git-ignored)
npx vercel@latest pull --environment=production             # project settings + env for the build
npx vercel@latest build --prod                              # runs npm ci + build:vercel with Production env
npx vercel@latest deploy --prebuilt --prod                  # uploads .vercel/output
```

Before cutover, the production deployment is reachable at the project's
`*.vercel.app` production domain (Project › Domains). Standard Protection
leaves production domains public and protects the per-deployment URLs.

- **Sign in** with a password and with Google. Add the `*.vercel.app` host to
  GSR Auth's redirect URLs and to the Google OAuth origins while testing.
- **Check the main features:** open a job's photos, run Polaris, send a test
  email, sign a test document. Then confirm that its `document_signatures.ip`
  is your own address.
- **Cron:** point GSR's `app_base_url` at the `*.vercel.app` host (runbook,
  Phase 2 step 9). Check `net._http_response` in GSR: the hooks should answer 200. A 401 with a Vercel login page means the URL you used is protected; use
  the production domain, not a deployment URL.
- **Logs:** Project › Logs (runtime) and Observability. A response's
  `x-vercel-id` lists the regions the request passed through, and the region
  that ran the function should be `sfo1`.

## 5. Cutover

Same window as the runbook's Phase 4. Only the host steps differ:

1. **Domain:** Project › Settings › Domains › Add `goldstar.falconstaging.com`.
   Vercel shows the record to create. At the **current DNS host** for
   `falconstaging.com`, replace the `goldstar` record (today it points at
   Lovable) with a **CNAME `goldstar` → the value Vercel shows** (for example
   `cname.vercel-dns.com`, or a project-specific `…vercel-dns…` name). The
   certificate is issued once DNS resolves. If the zone is on Cloudflare, the
   record must be **DNS only (grey cloud)**, never proxied. Behind a proxy,
   every visitor would arrive from the proxy's addresses, and the per-IP limits
   would lump them together. Vercel says to put no proxy in front of it.
2. Remove the custom domain from the Lovable project so that Lovable stops
   answering for it.
3. In GSR, set `app_base_url` to `https://goldstar.falconstaging.com` (runbook,
   Phase 4 step 3). Re-enable the cron jobs.
4. **Git:** connect the project to `MarkFalconM/Goldstar` (Project › Settings ›
   Git), production branch `main`. From then on, every push to `main` deploys.
   Do this at cutover and not before: an earlier push to `main` would deploy
   over the test deployment. If Git has to be connected earlier, set **Ignored
   Build Step** to "Don't build anything" (or the command `exit 0`) until
   cutover, then clear it.
5. Repoint the outside services listed in the runbook. Anything already on
   `goldstar.falconstaging.com` follows DNS.

**Rollback:** point the `goldstar` record back at Lovable, re-add the domain in
Lovable, and follow the runbook's rollback for the database.

## What Mark needs to do

- Upgrade the Falcon team to **Pro**.
- Set the project settings in section 2.
- Set the variables in section 3, Production first; Preview per option (a) or
  (b).
- At cutover: add the domain, change the CNAME at the DNS host, and connect Git.
