# Recovery Hub — security overview

**Application:** Recovery Hub, the internal CRM for Gold Star Restoration
(~250 staff, 12 locations).
**Audience:** an IT / security reviewer deciding what access to grant this
application.
**Written:** 3 September 2026. Every statement below is drawn from the source
tree or from read-only queries against the live database on that date. Where
something is written but not yet live, it says so.

This document does not claim any certification. Gold Star Restoration holds no
SOC 2 report, ISO 27001 certificate, or third-party penetration test for this
application. See **Known gaps and planned work** at the end.

---

## 1. Technology stack, in one paragraph

TanStack Start (React 19, TypeScript, Vite 8) rendered server-side on
Cloudflare Workers, styled with Tailwind CSS 4 and shadcn/ui. The only backend
is Supabase (managed Postgres 15 with Auth, Storage and pg_cron), provisioned
through Lovable Cloud. There is no separate application server, no ORM, no
custom session store and no self-managed database. Data access from the browser
is the Supabase JS client speaking PostgREST directly to Postgres; server-side
work runs in TanStack "server functions" and route handlers inside the same
Worker.

There is no Redis, no message broker, no container fleet, no VM and no
self-hosted infrastructure of any kind. The complete attack surface is: the
Cloudflare Worker, the Supabase project, and the third-party APIs listed in
§8.

---

## 2. Hosting and the data path

```
Browser
  │  HTTPS
  ▼
Cloudflare (TLS termination, DNS, edge)
  │
  ▼
Cloudflare Worker — the TanStack Start SSR server and API routes
  │  HTTPS, Supabase JS client
  ▼
Supabase (Lovable Cloud) — Postgres, Auth, Storage
```

- **Where the app runs.** Cloudflare Workers. `vite.config.ts` builds through
  Nitro with Cloudflare as the target. The Worker is stateless: it holds no
  session, no user data and no durable storage. Anything a request needs is
  read from Postgres on that request. (One consequence is called out in
  `src/lib/rate-limit.ts`: in-process counters are meaningless across isolates,
  which is why rate limiting is done in Postgres — see §5.)
- **Where the data rests.** All application data is in one Supabase Postgres
  database (project ref `ortpawtuqerkmuykwndp`) and six Supabase Storage
  buckets. Encryption at rest and backups are Supabase's managed defaults for
  the plan; the application does not manage its own encryption keys for table
  data.
- **Where the data does not go.** There is no analytics pipeline, no data
  warehouse, no log shipping to a third party, and no copy of the database
  anywhere else. Browser-side caching is deliberately constrained: the service
  worker in `vite.config.ts` excludes `/api/` from `CacheFirst` precisely so
  that per-user, RLS-gated document bytes are never parked in Cache Storage
  where a later user of the same browser could be served them.
- **Two hostnames** serve the same application:
  `https://project--b0a4cfc7-3fd3-46ba-aa5d-90a925aaa67c.lovable.app` and
  `https://goldstar.falconstaging.com`.

---

## 3. Authentication

### 3.1 Supabase Auth

Identity is Supabase Auth. The application does not store passwords, does not
implement its own session cookies for the app, and does not issue its own JWTs.
Sessions are Supabase JWTs held in browser storage and refreshed by the
Supabase client (`src/integrations/supabase/client.ts`).

Two sign-in methods exist, both on `src/routes/auth.tsx`:

1. **Email and password.** The form validates with zod — a valid email and a
   minimum eight-character password — before it calls Supabase.
2. **Google SSO.** `lovable.auth.signInWithOAuth("google", …)`. This is the
   route Gold Star should prefer if the company standardises on Google
   Workspace identity, because it moves password policy and account lifecycle
   to the identity provider.

New signups are not automatically usable: `src/components/approval-gate.tsx`
sits inside the authenticated layout and holds a new account out of the
application until an owner or admin approves it
(`adminApproveUser` / `adminRejectUser` in `src/lib/admin.functions.ts`).

### 3.2 Two-factor authentication (TOTP)

TOTP MFA is implemented and working, on top of Supabase's `auth.mfa.*` API.

- **Enrolment** is self-service at `/security`
  (`src/routes/_authenticated/security.tsx`). It enrols a TOTP factor, shows
  the QR code and the secret, and only marks the factor `verified` once the
  user has typed a code the server accepts — so a mistyped secret cannot lock
  someone out later (`confirmMfaEnrolment`, `src/lib/mfa.ts`).
- **Enforcement at sign-in** is `mfaGateForSession()` in `src/lib/mfa.ts`. It
  reads the session's authenticator assurance level; a session that *could* be
  `aal2` but is only `aal1` is redirected back to the challenge. The same check
  runs again in the route guard `src/routes/_authenticated/route.tsx`, so a
  session that abandoned the challenge — a tab left open overnight — cannot
  walk past the second factor it opted into.
- **Removing a factor** refreshes the session immediately
  (`removeMfaFactor`), because Supabase otherwise leaves the user holding a
  token that claims a second factor they no longer have.
- **Admin visibility and recovery** is `/admin/security`
  (`src/routes/_authenticated/admin.security.tsx`, backed by
  `src/lib/mfa.functions.ts`). It lists every user with their verified and
  unverified factor counts, and it is the only recovery path. Supabase Auth
  issues **no backup codes** for TOTP, so "I lost my phone" has exactly one
  answer: an owner or admin deletes the factor. That action is restricted to
  the `admin` and `owner` roles, and it writes a `security_events` audit row
  (`event_type: 'mfa_reset'`, with actor and subject).
- The adoption page refuses to render a false clean bill of health: if the auth
  API returns no factor data at all it sets `factorsUnavailable` and the page
  says "unknown" rather than drawing every row as "off".

**Honest limitation: MFA is opt-in, not mandatory.** Whether to require it is
Gold Star's policy decision, not a technical one; `src/lib/mfa.ts` says so
explicitly. Today an employee who does not enrol signs in with a password
alone. Making it mandatory is a Supabase project setting plus a decision about
the recovery burden, since there are no backup codes.

### 3.3 Brute-force controls on sign-in

`src/lib/auth-guard.functions.ts` is deliberately honest about its own scope:
Supabase's `/auth/v1/token` endpoint is public and reachable with the
publishable key, so nothing the application does can stop someone who skips its
sign-in page. What it adds is the control Supabase does not have — Supabase
limits that endpoint to 1800 requests/hour **per IP** and has **no per-account
limit at all**.

- `beginSignIn` spends budget *before* the password attempt, from a per-account
  bucket and a per-IP bucket, so an attacker can only consume budget by making
  real requests from their own address.
- `endSignIn` requires a valid session before it will clear a counter — so an
  attacker cannot wipe their own counter between guesses, and nobody can lock a
  colleague out by naming their email.
- A progressive stall (`signInDelayMs`) makes a serial attacker roughly one
  guess per eight seconds by the fifth failure.
- A lockout emails the account holder and writes a `security_events` row
  (`event_type: 'signin_lockout'`), including for addresses that are *not*
  accounts — a run of those is what an enumeration sweep looks like from the
  inside. No mail is sent to a non-account, so the endpoint does not confirm
  which addresses exist.
- It **fails open** if the counter store is unreachable. That is a deliberate
  trade: a database wobble must not lock a 24-hour emergency-service company
  out of its own dispatch system, and Supabase's own limits plus CAPTCHA are
  still counting during such an outage.

---

## 4. Authorisation

### 4.1 Postgres row-level security is the enforcement boundary

This is the single most important design fact in this document, and it is the
answer to "what stops a compromised browser reading everything".

The browser talks to Postgres directly, using the Supabase **publishable** key
plus the signed-in user's JWT. The publishable key is not a secret — it is in
`.env`, it is compiled into the browser bundle, and the app sends it on every
request. It confers no authority. All authority comes from the JWT, and every
decision is made by row-level security policies inside Postgres.

Consequences a reviewer should verify and hold us to:

- There is **no** application-tier permission layer that RLS could be bypassed
  around. Hiding a button changes nothing; the row simply does not come back.
- Server functions that need the user's identity run queries through the
  **caller's own** Supabase client (`requireSupabaseAuth` in
  `src/integrations/supabase/auth-middleware.ts`), so RLS still applies to
  them. The service-role client that bypasses RLS
  (`src/integrations/supabase/client.server.ts`) is loaded by dynamic import
  inside server handlers only, and the file carries an explicit warning that a
  top-level import would ship it to the browser bundle.

**Live coverage, verified 3 September 2026 by SELECT-only query:**

| Measure | Value |
| --- | --- |
| Tables in `public` | 224 |
| With row-level security enabled | **223** |
| Without | 1 — `spatial_ref_sys`, the PostGIS reference table (no customer data) |
| RLS policies in `public` | 543 |
| RLS policies on `storage.objects` | 22 |

### 4.2 Role model

Roles live in `public.user_roles`, one row per user per role, and are read
through `SECURITY DEFINER` helpers so that reading a role does not itself
recurse through RLS:

- `has_role(user_id, role)` — is this user in this role.
- `is_privileged(user_id)` — true for `admin`, `owner` or `dev`.
- Scope helpers used throughout the policies: `can_view_location`,
  `can_manage_location`, `can_view_job`, `can_manage_job`, `can_view_project`,
  `can_manage_project`, `can_view_finance`.

The `app_role` enum currently holds: `owner`, `admin`, `dev`, `regional`,
`location_manager`, `sales_manager`, `sales_head`, `sales_rep`,
`sales_person`, `outside_sales_rep`, `cold_caller`, `field_chaser`, `office`,
`field`, `crew`.

Most policies are location-scoped rather than role-scoped: a sales rep sees the
jobs and accounts of the locations they are assigned to, not the company's.

### 4.3 The security-hardening migration — written, NOT yet applied

`supabase/migrations/20260903130000_security_hardening_batch1.sql` is the
output of an internal audit of the RLS policy set. It is complete and
re-runnable. **It has not been applied to the live database.** Verified live on
3 September 2026: none of its objects are present. State it that way to anyone
who asks.

It closes seven classes of issue. The three worth a reviewer's attention:

- **B2 — an employee could approve their own timesheet.** The
  `time_entries_update` policy had no `WITH CHECK`, so Postgres reused the
  `USING` clause, and neither expression mentioned `status`. Owning the row was
  enough to PATCH `{"status":"approved","minutes":960}` straight into payroll
  and job costing. The fix splits it into a self policy that can never set
  `approved`, and a manager policy that can.
- **B3 — a pending or rejected signup could approve itself.** A table-wide
  `UPDATE` grant on `profiles` plus a self-update policy that checked only
  ownership meant a rejected user could PATCH
  `{"approval_status":"approved","is_active":true}` on their own row. The fix
  replaces the table-wide grant with a column list and adds a
  `SECURITY DEFINER` trigger (`profiles_privilege_guard`) that raises unless the
  actor is privileged.
- **B1 — `SECURITY DEFINER` functions granted to every signed-in user.** Pay
  rates (`rate_for`), commission terms and the achievement rewriter were
  executable by anyone authenticated. Each revoke was checked against every
  caller before being written.

The file is candid about where it deviates from the audit that prompted it and
why, including three functions it deliberately leaves granted to
`authenticated` with the reason stated in place. It also carries a warning that
matters operationally: an earlier migration (`20260810221956`) blanket-grants
`EXECUTE` on every `SECURITY DEFINER` function in `public` to `authenticated`,
and re-running that loop would silently undo every revoke in this file.

---

## 5. Rate limiting and bot defence

### 5.1 Application-tier rate limiting

`src/lib/rate-limit.ts` (pure decision logic, unit-tested) and
`src/lib/rate-limit.server.ts` (the Postgres-backed store). Counters live in
`public.rate_limit_counters` and are driven by the `consume_rate_limit` RPC,
**not** in Worker memory — the module comment explains that a module-scope
counter on Workers is per-isolate and per-region and therefore "looks like a
control and is not one".

Identities are stored one-way: the bucket key is a SHA-256 hash of the
email or IP, optionally peppered with `RATE_LIMIT_PEPPER`, so the counter table
does not become a second, weaker login-and-location log.

| Bucket | Limit | Window | Lockout | Fails |
| --- | --- | --- | --- | --- |
| `signin:email` (per account) | 8 | 15 min | 15 min | open |
| `signin:ip` | 120 | 15 min | 15 min | open |
| Public token read (`/share`, `/intake`, `/sign`) | 60 | 5 min | — | open |
| Public token write (submit, sign) | 12 | 15 min | — | open |
| Provider webhooks | 240 | 60 s | — | **closed** |
| Internal (cron/trigger) webhooks | 1200 | 60 s | — | **closed** |

The fail directions are chosen, not accidental, and the reasoning is in the
source: a customer standing at a signature pad does not retry, so the public
token endpoints fail open; Svix, CallRail and Graph all read `Retry-After` and
back off, and are talking to the same database that is down anyway, so webhooks
fail closed.

**Ordering matters and is enforced at every call site:** the throttle runs
*after* the endpoint's credential check (HMAC compare or `denyUnlessCron`),
never before. A limiter in front of the credential check would turn one
anonymous request into one database round trip — the exact amplification a
limiter exists to prevent.

### 5.2 Bot defence — Cloudflare Turnstile

`src/components/turnstile-widget.tsx` renders Cloudflare Turnstile on the
sign-in and signup form. The application never handles the secret key and never
calls `siteverify`: Supabase Auth verifies the token against Cloudflare
server-side when CAPTCHA protection is enabled on the Supabase project.

**This is not yet switched on, and switching it on is Gold Star's task, not
ours.** It needs three steps, and steps 2 and 3 must happen in the same window
or sign-in breaks:

1. Cloudflare dashboard → Turnstile → create a widget for the app's hostname;
   copy the site key and the secret key.
2. Supabase dashboard → Authentication → Attack Protection → enable CAPTCHA,
   provider "Turnstile", paste the **secret** key.
3. Set `VITE_TURNSTILE_SITE_KEY` (the public half) in the app environment.

Until step 3, the widget renders nothing and sign-in behaves as it does today —
the widget must never be the reason nobody can log in.

### 5.3 Edge defence — Cloudflare WAF

**Outstanding, on Gold Star's side.** Volumetric floods, single-IP request
storms and known-bad ASNs are the WAF's job, not the application's: the edge
drops those before a Worker isolate spins up, at no database cost. The
application code says so explicitly (`src/lib/rate-limit.server.ts`) and
deliberately does not try to duplicate it. No WAF rules have been configured
for this application to date.

The application does rely on Cloudflare for one thing already:
`cf-connecting-ip` is written by Cloudflare itself and cannot be forged by the
client, which is what makes per-IP counting trustworthy. That is only true
behind Cloudflare, so the address is read in one place,
`src/lib/client-ip.server.ts`, which picks the headers by host: on Vercel
(`VERCEL=1`) it reads only the headers Vercel writes and overwrites
(`x-vercel-forwarded-for`, `x-real-ip`, `x-forwarded-for`) and never
`cf-connecting-ip`; anywhere else it keeps the Cloudflare order above. A host
that is neither sets `CLIENT_IP_SOURCE=none` (trust no header). A value that
is not an IP address is dropped (null), never used as a key or as evidence.

---

## 6. Secrets handling

- **What is in the repository.** `.env` is tracked on purpose and holds only
  browser-side, non-secret configuration: the Supabase URL, project ID, the
  Supabase **publishable** key, and the Google Maps *browser* key. `.gitignore`
  states the rule: "Anything secret belongs in Supabase secrets, never here."
  `.env.local`, `.env.production`, `*.pem`, `*.key` and `secrets.json` are all
  ignored.
- **Where real secrets live.** Lovable Cloud → Project Settings → Secrets,
  exposed to the Worker as `process.env`. This covers
  `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`,
  `OUTLOOK_CLIENT_SECRET`, `RESEND_WEBHOOK_SECRET`, `CALLRAIL_WEBHOOK_SECRET`,
  `RAVEN_WEBHOOK_SECRET`, `INCIDENT_WEBHOOK_SECRET`,
  `EQUIPMENT_TRACKER_WEBHOOK_SECRET`, `AUTO_CAPTURE_WEBHOOK_SECRET`,
  `INTEGRATION_CRED_KEY` and `RATE_LIMIT_PEPPER`.
- **The `VITE_` rule.** Any variable prefixed `VITE_` is compiled into the
  browser bundle by Vite. Documentation for the operator is explicit about it —
  `supabase/CRON_SECRET_SETUP.md` says "Name it exactly `CRON_SECRET`. **Not**
  `VITE_CRON_SECRET` — a `VITE_` prefix would compile it into the browser
  bundle and publish it."
- **Supabase Vault** holds the database's copy of `CRON_SECRET`, read by
  `public.cron_secret()`. That function is granted to `postgres` and
  `service_role` only; `authenticated` and `anon` are revoked, and
  `supabase/CRON_SECRET_SETUP.md` gives the exact `has_function_privilege`
  queries to verify it.
- **Integration credentials in the database.** An admin can type integration
  credentials into the app instead of using environment secrets. Those are
  encrypted with AES-256-GCM (key derived from `INTEGRATION_CRED_KEY`, random
  12-byte IV per value) into `integration_credentials`, with an audit trail in
  `integration_credential_audit`. A credential typed into the app takes
  precedence over the environment variable of the same name, and is decrypted
  onto `process.env` for the duration of one invocation, cached in-process for
  60 seconds.

### The `CRON_SECRET` fail-closed change

Worth calling out because it is an example of the review process working.

The eight cron-triggered endpoints under `/api/public/hooks/*` run under the
**service role** — they bypass RLS entirely and can escalate incidents, create
tasks, send email and spend third-party quota. They were previously gated by
comparing an `apikey` header against `SUPABASE_PUBLISHABLE_KEY`, which, as
above, is not a secret. **Anyone who opened DevTools held the credential.** The
guard authenticated the public.

`src/lib/cron-auth.ts` replaces that with a dedicated `CRON_SECRET` in an
`x-cron-secret` header, compared in constant time (`timingSafeEqual`), and it
**fails closed**: with no `CRON_SECRET` configured the endpoints refuse every
caller including the real scheduler (503), rather than falling back to the old
public value. A cron that stops running is visible and fixable; an endpoint the
internet can invoke is neither.

The database side —
`supabase/migrations/20260903200000_cron_callers_send_secret.sql` — repoints
every HTTP-calling pg_cron job and trigger at the new scheme, reading the value
from Supabase Vault. **Status: the application-side change is in the code; the
migration is written and the Vault entry and app secret are not yet set.** Until
they are, those scheduled jobs return 503. The full runbook is
`supabase/CRON_SECRET_SETUP.md`.

---

## 7. Storage

Six Supabase Storage buckets. **All six are private** — verified live on
3 September 2026 (`select id, public from storage.buckets`): every row has
`public = false`. There is no public bucket and no unauthenticated storage URL.

| Bucket | Read is scoped by |
| --- | --- |
| `project-photos` | `can_view_project(auth.uid(), <first path segment as project id>)` |
| `project-documents` | `can_view_project(...)`; write requires `can_manage_project(...)` |
| `documents` | `can_access_document_object(auth.uid(), name)`; update/delete additionally refused once the document's status is `signed` |
| `chat-attachments` | `is_conversation_member(<first path segment>, auth.uid())`, with the path forced to match a UUID prefix regex |
| `compliance-files` | `can_view_compliance_file_path(name)`; write/delete need `can_manage_compliance_file_path(name)` |
| `feature-requests` | uploader, or `is_privileged`, or an attachment row that references the object |

Every one of the 22 `storage.objects` policies is granted to the
`authenticated` role. **None is granted to `anon`.** The scoping convention is
that the first path segment is the owning entity's id, and the policy resolves
authority from that id through the same helper functions the table policies
use — so a file's audience is the same as its parent record's, computed by the
same code.

**Signed URLs are deliberately avoided for shared photographs.**
`src/routes/api/share.$token.photo.$id.ts` proxies the bytes instead, and
explains why: a signed storage URL is a second credential with its own clock,
so once issued it keeps working for its full life whatever happens to the link
it came from — "revoke" would stop the page and not the pictures. Here the
token is re-checked against revocation and expiry on **every single image
request**, and the response never discloses the storage host, the bucket name
or the object path.

The document byte route `src/routes/api/documents.$id.file.ts` never touches
the service role at all. The caller's own JWT (from an `rh_doc_session` cookie
or an `Authorization` header) is verified, then both the row read and the
object read go through a client built on the *publishable* key carrying that
token — so `documents_select` and `documents_objects_read` apply
independently. Anything that could execute in the origin (SVG, HTML, XML) is
forced to a download rather than served inline, and nothing is cached
(`private, no-store`).

---

## 8. Public and unauthenticated surfaces — complete inventory

Everything under `src/routes/_authenticated/` (about 110 pages) is behind the
route guard in `src/routes/_authenticated/route.tsx`, which requires a valid
Supabase user and clears the MFA gate before rendering. What follows is
**every** route that is not.

### 8.1 Pages

| Route | File | Guard |
| --- | --- | --- |
| `/auth` | `src/routes/auth.tsx` | Sign-in page by definition. zod input validation; Turnstile (when configured); per-account and per-IP throttling with progressive delay, lockout and lockout email; MFA challenge; `noindex,nofollow`. |
| `/share/$token` | `src/routes/share.$token.tsx` | Bearer-token link. Token length 16–128 enforced before any database call. `loadJobShare` re-checks the token against *not found / revoked / expired* on every load. Throttled `share:read` (60 / 5 min). `noindex, nofollow` **and** `referrer: no-referrer`, so the token cannot leak in a `Referer` header. |
| `/intake/$token` | `src/routes/intake.$token.tsx` | Bearer-token claim-information form. Token length ≥ 16. Throttled `intake:read` (60 / 5 min) and `intake:write` (12 / 15 min). `noindex`. |
| `/sign/$token` | `src/routes/sign.$token.tsx` | Bearer-token e-signature packet. Token length ≥ 16; every call re-checks *not found / revoked / expired / completed*. Throttled `sign:read` and `sign:write`. `noindex`. |

Share tokens are 24 bytes from `crypto.getRandomValues` rendered as 48 hex
characters (`newShareToken`, `src/lib/job-share-links.ts`) — 192 bits of
entropy, not guessable.

### 8.2 API routes outside `_authenticated`

| Route | Guard |
| --- | --- |
| `/api/documents/$id/file` | **Authenticated despite the path.** Requires the `rh_doc_session` cookie or an `Authorization` header; the token is verified against Supabase, then both the row and the object are read through the caller's own RLS-scoped client. See §7. |
| `/api/share/$token/photo/$id` | The share token is re-validated against revocation and expiry on every request; the photo id must be *named by that link* **and** resolve inside that link's own job (`shareImageSources` decides both, shared with the payload builder so the two cannot disagree). MIME allowlist — nothing that can execute is served inline. Throttled with the public-token buckets. |

### 8.3 Webhook and cron hooks — `/api/public/hooks/*` (17 endpoints)

Every one of these refuses traffic when its secret is unconfigured, compares
credentials in constant time, and applies its rate limit **after** the
credential check.

**HMAC-signed provider webhooks** — the sender signs the raw body with a shared
secret; the handler recomputes and compares with `timingSafeEqual`:

| Endpoint | Secret | Algorithm |
| --- | --- | --- |
| `/auto-capture` | `AUTO_CAPTURE_WEBHOOK_SECRET` | HMAC-SHA256 over the raw body |
| `/callrail` | `CALLRAIL_WEBHOOK_SECRET` | HMAC-SHA1 (CallRail's scheme) |
| `/equipment-tracker` | `EQUIPMENT_TRACKER_WEBHOOK_SECRET` | HMAC-SHA256 |
| `/incidents` | `INCIDENT_WEBHOOK_SECRET` | HMAC-SHA256 |
| `/raven` | `RAVEN_WEBHOOK_SECRET` | HMAC-SHA256 |
| `/resend` | `RESEND_WEBHOOK_SECRET` | Standard Webhooks / Svix: HMAC-SHA256 over `id.timestamp.body`, stale timestamps rejected, multiple `v1,` signatures accepted during rotation |

**Shared-secret cron endpoints** — `x-cron-secret` compared in constant time by
`denyUnlessCron`; 503 when `CRON_SECRET` is unset, 401 on a wrong value:

`/cadence-sweep`, `/chase-escalation`, `/document-signature-reminders`,
`/drying-weather`, `/graph-sync`, `/kahi-sync`, `/raven-sync`, `/run-automations`,
`/sync-nyc-fire-leads`.

**Microsoft Graph endpoints** (see §10):

| Endpoint | Guard |
| --- | --- |
| `/graph-sync` | `CRON_SECRET` in `x-cron-secret` via `denyUnlessCron`, like the other cron hooks (it had its own `GRAPH_SYNC_SECRET` until 2026-10-11, which no scheduler held). Called by pg_cron through `graph_sync_kick()` every 15 minutes; a 200 no-op until Outlook is configured and a mailbox exists. |
| `/outlook` | Graph change notifications. The `validationToken` query parameter is echoed unauthenticated and *before* the rate limiter, because Graph tears the subscription down if it is not echoed within seconds. Notifications are then checked against `OUTLOOK_WEBHOOK_CLIENT_STATE` (503 if unset, 401 on mismatch) and validated by a zod schema capping the batch at 200. Payload contents are never trusted: the handler re-fetches the resource from Graph. |

Known weaknesses in this set, stated plainly:

- `/outlook` compares `clientState` with a plain `!==`, not a constant-time
  compare, unlike its sibling endpoints. It is a fixed-length shared string and
  the practical exposure is low, but it is an inconsistency and is on the list.
- The `validationToken` echo means any anonymous caller can get an arbitrary
  string reflected as `text/plain` at that URL. This is what Microsoft's
  protocol requires; the content type prevents it from being a script-injection
  vector.
- The "Sync now" button for NYC fire leads on `/admin/integrations` POSTs from
  the browser without the cron header and will receive a 401 until it is moved
  behind a server function. Documented in `supabase/CRON_SECRET_SETUP.md`.

### 8.4 Not indexed

Every token page sets `noindex`. `public/robots.txt` currently allows all
crawlers on `/`, which is correct for the marketing-visible root but means the
`noindex` meta tags are doing the work for the token routes. That is the right
mechanism (a `Disallow` in robots.txt advertises the path); it is noted here so
nobody reads the permissive robots.txt as an oversight.

---

## 9. Audit logging

| Table | Written by | Contents |
| --- | --- | --- |
| `security_events` | `src/lib/mfa.functions.ts`, `src/lib/auth-guard.functions.ts` | `mfa_reset` (actor, subject, factors removed) and `signin_lockout` (subject, email, duration, whether the account exists). Written with the service role so the subject cannot suppress it. **Created by the unapplied `20260903120000_rate_limit_counters` migration — these writes are a no-op today** and the code logs the failure rather than failing the operation. |
| `photo_access_log` | `SECURITY DEFINER` insert from migration `20260820191259` | Every view of a photograph, including by an unauthenticated share-link visitor: photo id, project, actor (or actor *kind* for anonymous), action, IP address and user agent, timestamped. |
| `assistant_audit` | `logAssistantEvent`, `src/lib/assistant-scope.server.ts` | Every AI-assistant question: actor, effective user, roles, impersonation id, feature, the question text, and the full data scope (locations, regions, people scope) the answer was computed under. Written with the service role — the file notes this is the *only* service-role use in the assistant, and never for retrieval, precisely so the person being audited cannot edit it. |
| `integration_credential_audit` | `src/lib/integration-credentials.server.ts` | Who set or changed which integration credential, when. |
| `integration_events`, `sync_runs` | integration handlers | Raw provider notifications and per-run sync outcomes. |

Row-level history for business records is separate and predates this work
(`time_entry_corrections`, the various `*_history` tables, `updated_at`
triggers).

`photo_access_log` deserves one note for the reviewer: its rows carry customer
IP addresses and user agents, and the hardening migration in §4.3 tightens the
policy that governs who may read them (today a `project_id IS NULL` row — which
is how anonymous share views are recorded — is readable more widely than
intended).

---

## 10. Microsoft 365 / Outlook — current state

Covered in full in `docs/OUTLOOK-ACCESS-PROPOSAL.md`. The one-paragraph summary
for this document:

> **Update, 7 October 2026 — built as delegated access (Option A).** The
> default is now `OUTLOOK_AUTH_MODE=delegated`: each person connects their own
> Outlook (auth code + PKCE, signed browser-bound `state`, tenant-checked
> id_token), refresh tokens are AES-256-GCM sealed in a table no client role
> can read, and every Graph call carries the mailbox holder's or the sender's
> own token — no application permissions, no `User.Read.All`. Details in §6 of
> the proposal. The paragraph below describes `OUTLOOK_AUTH_MODE=application`,
> which is kept unchanged.

The integration is written but **not provisioned** — no Azure app registration
exists for it, and none of `OUTLOOK_TENANT_ID`, `OUTLOOK_CLIENT_ID` or
`OUTLOOK_CLIENT_SECRET` is set. As written it uses the **client-credentials
(app-only)** flow against
`https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token` with scope
`https://graph.microsoft.com/.default`, and the admin setup screen asks IT for
`Mail.Read`, `Mail.ReadWrite`, `Mail.Send`, `Calendars.ReadWrite` and
`User.Read.All` as **application** permissions. The code itself is explicit that
this can read every mailbox in the tenant unless Exchange's
`ApplicationAccessPolicy` restricts it to a mail-enabled security group, that
this must be configured by IT, and that **the application cannot enforce or
verify it**. That is exactly the objection Gold Star's IT provider raised, and
the proposal document sets out narrower alternatives.

Access tokens are held in a module-level in-process variable only, never
written to any database, and re-requested on expiry (no refresh tokens exist in
this flow). Message bodies are not warehoused: `captured_communications` stores
metadata plus an 800-character preview, and full bodies are fetched from Graph
on demand, authorised by re-reading the row through the caller's RLS-scoped
client first.

---

## 11. Software supply chain and code review

- **Dependencies.** Pinned by `package-lock.json`. React 19, TanStack Start /
  Router / Query, Supabase JS, Tailwind 4, Radix/shadcn, zod, pdf-lib, recharts.
  No dependency handles authentication or authorisation; those are Supabase and
  Postgres.
- **Automated scanning wired to GitHub — two of the three are running.**
  Revised 7 September 2026. Dependency scanning is active and passing; static
  analysis of our own source code is configured but **cannot report on this
  repository**, and that is stated here rather than left for a reviewer to
  find:

  - `.github/workflows/pull-request-checks.yml` — **running, blocking,
    passing.** `npm audit --audit-level=high` fails the pull request on a high
    or critical advisory, alongside the repository's own TypeScript typecheck
    and unit tests, plus lint. Re-verified 7 September 2026: `npm audit
    --audit-level=high` reports **0 vulnerabilities**, and the check is green
    on every recent run. The three advisories recorded at gap 17 when this
    document was written have since been fixed.
  - `.github/dependabot.yml` — **running.** Weekly npm and github-actions
    dependency updates; Dependabot is opening pull requests normally (five
    were open on 7 September 2026). One caveat, at gap 20 below: Dependabot
    *alerts* are switched **off** for this repository, so a newly published
    vulnerability does not currently raise its own higher-priority pull
    request. Alerts are free on private repositories and should be turned on.
  - `.github/workflows/codeql.yml` — **configured, but NOT reporting, and
    producing nothing a reviewer can be shown.** The analysis itself runs
    correctly — it extracts and scans 783 TypeScript files — but this
    repository is **private**, and uploading code scanning results from a
    private repository requires **GitHub Code Security**, the paid GitHub
    Advanced Security product, which this repository does not have. Every run
    from the day the workflow was added failed at the upload step with *“Code
    scanning is not enabled for this repository”*; querying
    `repos/faser15/flood-hero-hub/code-scanning/alerts` returns HTTP 403 with
    the same message.

    **Consequence, stated plainly: there is no Security → Code scanning
    alerts tab to show, and no automated static analysis of our own source
    code is being performed today.** `npm audit` and Dependabot look only at
    the versions of third-party dependencies; neither reads a line of the
    code in `src/`. That is the gap, and closing it is a purchasing decision
    — see gap 19.

    Because the check could never go green, the job is now gated behind a
    repository variable and shows as **“Skipped”** rather than failing. Before
    that it was a permanently red check on every push and every pull request,
    spending about 5.5 minutes of Actions time per run to produce a result it
    was not allowed to upload. The workflow, its triggers and its query
    configuration are otherwise unchanged, and the file documents the restore
    in full.

  The state of the checks that do run, verified 7 September 2026:

  | Check | Today |
  | --- | --- |
  | `tsc --noEmit` | clean — **blocking** |
  | Vitest | green on every recent run (289 passed, 5 skipped as of 3 September) — **blocking** |
  | `npm audit --audit-level=high` | **0 vulnerabilities** — blocking, passing |
  | `npm run lint` | ~158 pre-existing errors — **advisory, not blocking**; see gap 18 |
  | CodeQL code scanning | **not reporting** — needs GitHub Code Security; see gap 19 |

  **Update, October 2026:** static analysis of our own source now runs
  without Advanced Security. Semgrep Community Edition (free registry rules
  for TypeScript, React, Node.js and secrets) scans `src/` and `scripts/` in
  `pull-request-checks.yml` on every pull request, on Lovable's direct pushes
  to `main` and weekly; ERROR-severity findings block. Results appear as check
  annotations and in the job log, not in a Security tab. An AI review
  (`ai-review.yml`) also reads each pull request's diff and each direct push.
  See `docs/QUALITY-CONTROL.md`. CodeQL remains gated as described above.
- **Human review.** Changes land through pull requests on GitHub. The
  repository is also connected to Lovable, which commits to the same branch.
- **Tests.** 26 unit-test files under `src/`, run by Vitest. They cover the
  security-relevant pure logic directly — the rate-limit arithmetic, the
  assistant's data-scope resolution, notification authorisation, and Graph
  send-as rights.

---

## Known gaps and planned work

Listed so a reviewer does not have to find them. None of these is a claim about
severity; they are facts about the current state.

### Not done, and not currently planned by us

1. **No SOC 2 report, no ISO 27001, no third-party penetration test.** None has
   ever been performed on this application. The scanning described in §11 is
   automated **dependency** analysis only — static analysis of our own source
   is configured but not reporting (gap 19) — and even with it running, that
   is not a substitute for a pen test. If Gold Star wants one, it is a
   commercial decision and we will support it.
2. **No formal incident-response plan, no security contact of record, no
   documented breach-notification procedure** for this application.
3. **No independent security review of the RLS policy set.** The audit behind
   the hardening migration (§4.3) was internal.
4. **No data-retention or deletion policy.** Nothing is purged on a schedule;
   `photo_access_log`, `assistant_audit` and `captured_communications` grow
   without bound.

### Written but not yet applied

5. **24 hand-written migrations are unapplied and unrecorded** in the live
   database. The full file-by-file reconciliation, with the live status of every
   object and the order they must run in, is
   `supabase/MIGRATION_RECONCILIATION.md`. Two of the 24 are security work and
   are meant to run first:
   - `20260903130000_security_hardening_batch1.sql` — the seven fixes in §4.3,
     including self-approval of timesheets and self-approval of user accounts.
     **Verified not applied.**
   - `20260903120000_rate_limit_counters.sql` — creates `rate_limit_counters`,
     `security_events` and the four rate-limit functions. **Verified not
     applied.** Until it is, the rate limiter in §5.1 has no store: it detects
     the missing schema, logs loudly, and allows the request through
     (`degraded()` in `src/lib/rate-limit.server.ts`). **So the sign-in and
     public-form throttles described in §5.1, and the `security_events` audit
     rows in §9, are not yet actually in force.**
6. **`CRON_SECRET` is not set** in either Supabase Vault or the app
   environment, and `20260903200000_cron_callers_send_secret.sql` is not
   applied. The endpoints correctly fail closed (503), which means the
   scheduled jobs that call them are currently refused. Runbook:
   `supabase/CRON_SECRET_SETUP.md`.

### Waiting on Gold Star / SM Tech Solutions

7. **Turnstile is not configured.** Site key and secret key are needed (§5.2).
   Steps 2 and 3 must be done in the same maintenance window.
8. **No Cloudflare WAF rules** exist for this application (§5.3).
9. **The Exchange `ApplicationAccessPolicy`** that would bound the Outlook
   integration does not exist, because the integration is not provisioned
   (§10). This is the crux of `docs/OUTLOOK-ACCESS-PROPOSAL.md`.

### Smaller items found while writing this document

10. **MFA is opt-in, not enforced**, and Supabase issues no TOTP backup codes,
    so the only recovery is an administrator deleting the factor (§3.2).
11. **No Content-Security-Policy, HSTS, `X-Frame-Options` or
    `Referrer-Policy` headers** are set by the application. There is no
    `_headers` file and no header middleware; the token pages set
    `referrer: no-referrer` via a meta tag but nothing else does. These are
    cheap to add at the Cloudflare edge or in the Worker and are not yet added.
12. **`/api/public/hooks/outlook` compares `clientState` non-constant-time**,
    unlike every sibling endpoint (§8.3).
13. **`Mail.ReadWrite` is requested by the Outlook setup instructions but no
    code path uses it** — there is no `PATCH /messages`, no flag or category
    write. It should be dropped from the request (and is dropped in the
    proposal document's recommendation). *Fixed 7 October 2026: neither the
    delegated nor the application setup request lists it.*
14. **The "Sync now" NYC fire leads button will 401** until it is moved behind
    a server function (§8.3).
15. **`GraphError` messages embed the full provider response body**, which is
    then written to `graph_mailboxes.last_error` and rendered in the admin UI
    and in admin notifications. Admin-only, but it is provider output rendered
    in a privileged screen.
16. **Rate-limit deltas and Graph `deltaLink` cursors are stored in
    plaintext.** They are opaque state, not credentials, but they are
    resource-scoped URLs.
17. ~~**Three high-severity dependency advisories are open right now.**~~
    **CLOSED, 7 September 2026.** On 3 September 2026
    `npm audit --audit-level=high` reported `brace-expansion` (two DoS
    advisories), `js-yaml` (quadratic CPU consumption in `!!omap` resolution)
    and `nanoid` (infinite loop with a zero size) — all transitive
    build/development dependencies, not runtime code served to users. They were
    deliberately left unfixed in that pass so the first scan reported the true
    state rather than a state we had tidied up first. All three have since been
    resolved: `npm audit --audit-level=high` now reports **0 vulnerabilities**,
    and the blocking pull-request check is green.
18. **`npm run lint` does not currently pass**, for reasons unrelated to
    security: 149 `@typescript-eslint/no-explicit-any`, 2 `no-useless-escape`,
    2 `react-hooks/rules-of-hooks`, and 2 files carrying an
    `eslint-disable` for `@next/next/no-img-element`, a rule that is not in
    this project's ESLint config and therefore errors. The lint job is wired up
    as advisory rather than blocking until this backlog is cleared.

### Automated scanning coverage — found 7 September 2026

19. **No automated static analysis of our own source code is running, and it
    cannot be until GitHub Advanced Security is purchased.** `.github/workflows/
    codeql.yml` is configured correctly and the CodeQL analysis executes
    (783 TypeScript files extracted and scanned), but `faser15/flood-hero-hub`
    is a **private** repository, and uploading code scanning results from a
    private repository requires **GitHub Code Security**. Every run failed at
    the upload step; the REST endpoint returns HTTP 403, *“Code scanning is not
    enabled for this repository.”* The job is therefore gated off (it now shows
    as “Skipped” instead of failing every pull request and burning Actions
    minutes on a result it could not report).

    **What it costs Gold Star to close.** GitHub Code Security is licensed per
    **active committer per month** — an active committer being anyone who
    pushed a commit in the last 90 days — at a list price of **US$30 per
    active committer per month** at the time of writing, and it requires a
    GitHub **Team or Enterprise** plan. For a repository with a handful of
    active committers that is roughly US$30–$150 a month; confirm current
    pricing and the exact committer count with GitHub before budgeting. The
    only free alternative is making the repository public, which is not
    appropriate for this codebase.

    **What restoring it takes once that is bought.** Enable code scanning under
    Settings → Advanced Security, then one command, no code change and no pull
    request: `gh variable set CODE_SCANNING_ENABLED --repo faser15/flood-hero-hub
    --body true`. The full procedure, including how to test whether the feature
    is live without flipping the variable, is written at the top of
    `.github/workflows/codeql.yml`.

20. **Dependabot alerts are switched off for this repository.** Dependabot
    *version* updates are running (weekly pull requests, five open on
    7 September 2026), but the *alerts* feature — which is what raises a
    higher-priority pull request the moment a vulnerability is published
    against a dependency we use — is disabled:
    `repos/faser15/flood-hero-hub/dependabot/alerts` returns HTTP 403,
    *“Dependabot alerts are disabled for this repository.”* Unlike gap 19 this
    costs nothing: the dependency graph and Dependabot alerts are included on
    every GitHub plan, private repositories included. It is a toggle under
    Settings → Advanced Security and should be turned on regardless of what is
    decided about Code Security. Until it is, the weekly `npm audit` check is
    the only thing that will notice a newly published dependency
    vulnerability, and only when a pull request or push happens to run.

---

*Prepared from the `wt/security-posture` branch. Every live fact was checked
with SELECT-only queries against the production database on 3 September 2026.
No scanner was run against any live host in preparing this document.*

*Revised 7 September 2026: §11 and gaps 17, 19 and 20 corrected after finding
that CodeQL had failed on every run since it was added — code scanning cannot
be enabled on a private repository without GitHub Advanced Security — and that
Dependabot alerts were switched off. The earlier text overstated what was
running. Nothing else in this document was re-verified on that date.*
