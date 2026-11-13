# Answers: moving off Lovable Cloud to Supabase `nixpjqinsgngmrfepiot`

This is answers only. Nothing in the project, database or secrets was changed. Approving this card changes nothing either.

## 1. Direct Postgres connection string
**You can't get one yourself.** Lovable Cloud never shows the database host, password or pooler URI, and it has no Supabase dashboard. The built-in option is **Cloud → Advanced settings → Export data**. There is no one-click "migrate to your own Supabase" button. If you need a raw connection for `pg_dump`, ask Lovable support (in-app Help / support@lovable.dev) for a one-off dump or temporary credentials for project `b0a4cfc7-3fd3-46ba-aa5d-90a925aaa67c`.

## 2. Full export: schema, data, and the `auth` schema
- **Schema:** it's already in the repo. Replay `supabase/migrations/` in order. Some objects were applied by hand and the ledger is incomplete (see `supabase/MIGRATION_RECONCILIATION.md`), so diff the live catalog against the replay before cutover.
- **Data:** use Cloud → Advanced settings → Export data. You can also export single tables as CSV, but that's per table, not a full dump.
- **`auth` schema** (password hashes, original user IDs, identities, MFA factors): you can't get this through the product. It needs a support request. Without it, users have to reset their passwords and you'd need to remap every foreign key to new IDs. Ask support to include `auth.users`, `auth.identities` and `auth.mfa_factors` with their original UUIDs.

## 3. Storage files (about 11 buckets, ~159 MB)
There's no bulk download, no service-role key and no S3 credentials. You can download individual files from the Cloud storage view. For a full bucket export, include it in the same support request.

## 4. Secret values
**They can't be viewed or exported.** You can only add or overwrite them in Project Settings → Secrets. That applies to `INTEGRATION_CRED_KEY`, `CRON_SECRET`, `RESEND_API_KEY` and `RATE_LIMIT_PEPPER`. Consequences:
- `CRON_SECRET`, `RATE_LIMIT_PEPPER`: create new values in the new setup. Rate-limit counters reset, which is harmless.
- `RESEND_API_KEY`: get it again from your Resend account.
- `INTEGRATION_CRED_KEY`: **important.** Anything encrypted with it (stored integration credentials) can't be decrypted without the original value. Either ask support whether they can hand it over, or plan to re-enter those integration credentials after the move.

## 5. Vault secret behind `public.cron_secret()`
It can't be read: the function is deliberately executable only by `postgres` and `service_role`, which you don't have. Treat it as a new value. Create a new `CRON_SECRET` in the new project's Vault and use the same value in the Cloudflare env (steps in `supabase/CRON_SECRET_SETUP.md`).

## 6. Auth settings
Go to **Cloud → Users → Auth Settings** (gear icon). It has the email, phone and provider toggles, password policy (HIBP, current-password rule), the SMS template, and email templates where they're customised. The screen doesn't show every Supabase setting. For anything missing (full redirect allow-list, SMTP sender details), ask support or rebuild it from the app code: the `/auth` routes, the Microsoft callback in `src/routes/api/auth/microsoft/`, and the site URLs `flood-hero-hub.lovable.app` and `goldstar.falconstaging.com`.

## 7. Lovable-only items that stop working when you leave

| Item | Tied to Lovable? | Replacement |
|---|---|---|
| Google / Apple sign-in through `@lovable.dev/cloud-auth-js` (`src/integrations/lovable/`) | Yes, Lovable's broker | Set up your own Google/Apple OAuth app in your Supabase Auth and switch the code to `supabase.auth.signInWithOAuth` |
| AI gateway (`LOVABLE_API_KEY`: assistant, transcription, fire-feed extraction) | Yes, billed to the Lovable workspace | Your own OpenAI/Anthropic/Google keys, with call sites rewritten |
| Google Maps connector (managed browser key + server gateway) | Yes. The managed key only works on `*.lovable.app` / `*.lovableproject.com` | Your own Google Cloud keys (`GOOGLE_MAPS_SERVER_KEY`, browser key), called directly |
| Lovable managed email / sender domain (if used) | Yes. DNS delegation (NS records) points at Lovable | Resend directly (you already hold `RESEND_API_KEY`). Remove the Lovable NS records at your DNS host |
| Other connectors linked through the Lovable connector gateway | Yes | Call each provider's API directly with your own credentials |
| `LOVABLE_API_KEY` itself | Yes, it only works for this project | Not needed afterwards |
| Microsoft Graph, CallRail, Raven, Kai, Turnstile, Open-Meteo, NYC Open Data | No, these use your own credentials | Move the values (re-enter them, since secrets can't be read back) |
| pg_cron jobs + pg_net calls back to the app | No, but they point at the current host | Recreate them and change the URLs to your Cloudflare host |

## Suggested single support request
Ask Lovable support for: (a) a full `pg_dump` including `auth` with original IDs and hashes, (b) a full export of every storage bucket, and (c) whether the `INTEGRATION_CRED_KEY` value can be released. Everything else above you can rebuild yourself.
