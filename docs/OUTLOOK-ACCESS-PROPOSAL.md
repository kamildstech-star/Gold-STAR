# Microsoft 365 mailbox access — what we ask for, and three narrower ways to give it

**For:** SM Tech Solutions, reviewing before granting Recovery Hub access to
Microsoft 365.
**Companion document:** `docs/SECURITY-OVERVIEW.md` (stack, hosting, RLS,
public surfaces, gaps).
**Date:** 3 September 2026.

The objection is correct as stated. What the integration asks for **today** is
tenant-wide application permissions, and the only thing that would stop it
reading every mailbox in the tenant is an Exchange application access policy
that we cannot create, cannot enforce and cannot verify from inside the
application. This document says exactly what the code does now, then offers
three narrower options, and recommends one.

Nothing is provisioned yet. There is no Azure app registration, and none of
`OUTLOOK_TENANT_ID`, `OUTLOOK_CLIENT_ID` or `OUTLOOK_CLIENT_SECRET` is set. No
mailbox has been read. This is a design decision still open, not a change
request.

> **Update, 7 October 2026 — Option A is built.** IT asked for delegated
> access; it is now the default (`OUTLOOK_AUTH_MODE=delegated`). See
> **§6, What was built** at the end. Sections 1–5 are kept as written, because
> they are the reasoning IT reviewed; where §1 says "today", read "in
> application mode".

---

## 1. What the integration requests today

### The flow

App-only client credentials. No MSAL, no delegated flow, no authorization code,
no redirect URI, no per-user consent, no refresh tokens. All of that is
verifiable in `src/lib/graph.server.ts`:

```
POST https://login.microsoftonline.com/{OUTLOOK_TENANT_ID}/oauth2/v2.0/token
  grant_type = client_credentials
  scope      = https://graph.microsoft.com/.default
```

### The permissions the admin screen asks IT for

From `src/routes/_authenticated/admin.integrations.outlook.tsx`, the card
titled "Setup request for Gold Star IT" asks for these as **application**
permissions, requiring a Global Administrator to click "Grant admin consent":

| Permission | Stated reason | Actually used? |
| --- | --- | --- |
| `Mail.Read` | read matched messages | **Yes** |
| `Mail.ReadWrite` | flag/track and manage synced items | **No.** There is no `PATCH /messages`, no flag write, no category write anywhere in the code. This permission should be dropped. |
| `Mail.Send` | send from the user's own mailbox so replies thread | **Yes** |
| `Calendars.ReadWrite` | two-way meeting sync | Read and create: yes. The cancel path exists but is never called. |
| `User.Read.All` | resolve mailbox ids and display names | **Yes** |

### The Graph calls actually made

| Call | Read / Write |
| --- | --- |
| `GET /users/{upn}/mailFolders/AllItems/messages/delta` | read |
| `GET /users/{upn}/messages/{id}` (metadata, and body on demand) | read |
| `GET /users/{upn}/calendarView/delta`, `GET /users/{upn}/events/{id}` | read |
| `POST /users/{upn}/sendMail`, `POST /users/{upn}/messages/{id}/reply` | **write — sends mail** |
| `POST /users/{upn}/events` | **write — creates a meeting, invites attendees** |
| `GET /users/{upn}` | read |
| `POST / PATCH / DELETE /subscriptions` | change-notification lifecycle |

### The controls that already exist inside the application

These are real, and they are worth knowing before judging the ask — but be
clear that **none of them is a boundary Microsoft enforces**. They are
application conventions on top of a tenant-wide credential.

1. **A mailbox allowlist in the database.** Every Graph path is
   `/users/{upn}/…` where `upn` comes from a row in `graph_mailboxes`. The app
   never enumerates the tenant. Rows are added by an owner/admin/dev, or bulk-
   imported from the `office_email` of each active location. Per-mailbox
   switches control whether mail and calendar sync at all.
2. **Contact-matched ingestion.** A message is discarded unless a counterparty
   address matches a row in `contacts` — "no known contact, no ingestion; the
   mailbox stays private" (`src/lib/graph-sync.server.ts`). Internal mail
   between employees is not captured.
3. **Bodies are not warehoused.** `captured_communications` stores metadata
   plus an 800-character preview. Full bodies are fetched from Graph on demand
   and only after the requesting user's own RLS-scoped read of the row
   succeeds.
4. **Send-as is authorised in the app.** `assertCanSendAs`
   (`src/lib/graph.functions.ts`, unit-tested in `graph-send-rights.test.ts`)
   permits sending only from the caller's own mailbox, from an office mailbox
   for a location they manage, or by an owner/admin/dev.
5. **The AI assistant never drafts or sends client-facing email.** The send
   path rejects anything not marked human-authored.
6. **Tokens are never persisted.** The access token lives in a module-level
   variable in the Worker process and is re-requested on expiry. There is no
   refresh token in this flow and nothing Graph-related is written to the
   database as a credential.

### The honest problem

`src/lib/graph.server.ts` states it in its own header, and we are not going to
soften it:

> Because app-only permissions can otherwise read every mailbox in the tenant,
> the tenant must apply an ApplicationAccessPolicy restricting the app to a
> mail-enabled security group. **We cannot enforce that from here.**

So: the credential's blast radius is the whole tenant. The database allowlist
is a convention that a bug, a misconfiguration or anyone with owner/admin
access to the CRM could widen — not a permission boundary. If someone stole
`OUTLOOK_CLIENT_SECRET`, the allowlist would not slow them down for one second,
because they would not be running our code. That is the "keys to the kingdom"
concern, and it is legitimate.

---

## 2. Three narrower options

### Option A — per-user delegated consent

Each employee authorises their own mailbox, the way Lever works today. This is
what Mark proposed on the call.

**Azure app registration:** same tenant, but with a redirect URI and
**delegated** permissions instead of application permissions. Delegated
permissions are consented by the user (or pre-consented tenant-wide by an
admin, which does *not* widen them beyond the signed-in user's own mailbox).

**Scopes:**

```
offline_access
openid profile email
Mail.Read              (delegated)
Mail.Send              (delegated)
Calendars.ReadWrite    (delegated)
User.Read              (delegated)
```

Note `User.Read`, not `User.Read.All` — a delegated flow does not need
directory-wide read.

**What the token can reach:** exactly one mailbox, the signed-in user's own.
Microsoft enforces this, not us. There is no configuration anyone can get wrong
that turns a delegated token into tenant-wide access.

**What the CRM loses:**

- **Shared and office mailboxes need separate handling.** The bulk import of
  every location's `office_email` stops working as written. A shared mailbox
  can still be reached delegated — a user with Full Access to it can consent
  and the app uses `/users/{shared-upn}/…` on their behalf — but somebody has
  to own each one, and if that person leaves, that office mailbox stops syncing
  until someone re-consents.
- **Coverage becomes voluntary.** Anyone who does not click "allow" is simply
  not synced. For a CRM whose value depends on capturing client
  correspondence, partial coverage is a real product cost, and it is the reason
  app-only was chosen in the first draft.
- **Sync stops when a user is inactive.** A delegated refresh token expires
  after 90 days of no use (and dies immediately on a password change, a
  conditional-access revocation, or an admin revoking sessions). Background
  delta sync for a rep on three weeks' leave will lapse and need a re-consent.
- **Real engineering work.** This is not a configuration change. The app must
  gain an OAuth authorization-code flow with PKCE, encrypted per-user refresh
  token storage (the `integration_credentials` AES-256-GCM store already
  exists and would be the place), token refresh, and re-consent prompting. Call
  it a couple of weeks, not an afternoon.

**Token handling and revocation:** refresh tokens per user, encrypted at rest
with AES-256-GCM. Revocation is IT's, unilaterally and instantly: Entra →
Enterprise applications → Recovery Hub → revoke consent, or revoke the user's
sessions, or the user removes the app themselves. No cooperation from us
required.

---

### Option B — application permissions, bounded by an Exchange application access policy

Keep the app-only flow that exists, and bound it in Exchange so the credential
physically cannot reach a mailbox outside a named group.

**Azure app registration:** as designed today, but with the permission list
trimmed to what the code uses:

```
Mail.Read              (application)   — drop Mail.ReadWrite entirely
Mail.Send              (application)
Calendars.ReadWrite    (application)
User.Read.All          (application)
```

`User.Read.All` is worth a conversation of its own — it is directory-wide read
of every user object. If it is unacceptable, the app can be changed to resolve
display names from its own `graph_mailboxes` rows instead, and the permission
dropped. That is a small change and we are happy to make it.

**The bounding control** — this is the part that matters, and it is IT's to
run:

```powershell
New-ApplicationAccessPolicy `
  -AppId <APPLICATION_CLIENT_ID> `
  -PolicyScopeGroupId CRM-Mailbox-Sync@goldstarrestoration.com `
  -AccessRight RestrictAccess `
  -Description "Recovery Hub CRM — sales and office mailboxes only"

# verify, per mailbox, both inside and outside the group
Test-ApplicationAccessPolicy -Identity someone@goldstarrestoration.com -AppId <APPLICATION_CLIENT_ID>
```

With `RestrictAccess`, Graph returns `ErrorAccessDenied` for any mailbox
outside the group, no matter what the application asks for. Membership of
`CRM-Mailbox-Sync` becomes the access control, and it lives in IT's hands, not
ours.

Two things to be honest about:

- **The policy is silently load-bearing.** If it is removed, or if the group is
  widened, access widens with it and the application does not know and cannot
  tell. There is nothing in the code that verifies it. If you choose this
  option, `Test-ApplicationAccessPolicy` against a control mailbox belongs in
  your own periodic checks, not ours.
- **One client secret is the whole credential.** It should be a certificate
  rather than a secret if you prefer, and its expiry should be short (12
  months maximum) with a calendar reminder. Recovery Hub reads it from Lovable
  Cloud project secrets, never from the repository, and it never reaches the
  browser.

**What the CRM loses:** nothing, relative to the current design. Full coverage,
shared mailboxes work, no per-user consent to chase, no expiring refresh
tokens.

**Revocation:** remove the app from the group, or delete the app registration,
or delete the client secret. Any of the three, instantly, by IT alone.

---

### Option C — send-only through one no-reply mailbox

The narrowest option, and the one SM Tech Solutions said on the call he would
be comfortable with.

One dedicated mailbox — say `crm-noreply@goldstarrestoration.com` — and an
application access policy restricting the app to a group containing that
mailbox and nothing else.

**Scopes:**

```
Mail.Send    (application)
```

That is the entire list. No `Mail.Read`. No `Calendars.*`. No `User.Read.All`.
The credential cannot read a single message in the tenant, including in the
no-reply mailbox itself, because `Mail.Send` does not confer read.

**What the CRM loses — and it is a lot:**

- **No inbound logging at all.** This is the headline loss and you named it
  yourself. Nothing a client sends back appears in the CRM. A rep sends a
  quote from Recovery Hub; the client replies; the reply lands in the rep's
  Outlook and the CRM never knows. Every follow-up cadence, every "no response
  in 5 days" escalation, every activity timeline and every touchpoint metric
  that depends on `replied_at` is either dead or has to be maintained by hand.
  Roughly half of the reason for the integration disappears.
- **Threading breaks.** Replies go to the no-reply mailbox, not to the rep, so
  clients must be told to reply elsewhere — or the mailbox needs a forwarding
  rule, which is its own configuration to maintain and its own thing to get
  wrong.
- **Mail comes from the wrong sender.** Everything appears from
  `crm-noreply@`, not from the rep the client knows. `Mail.Send` with a
  `from` override is possible but requires Send-As rights on the target
  mailboxes, which quietly reintroduces the tenant-wide question.
- **No calendar sync.** Meeting creation and the meeting-cadence reporting go.

**Revocation:** delete the app registration or the secret. Same as B.

---

## 3. Recommendation

**Option A — per-user delegated consent — if Gold Star will accept the
coverage gaps and the delivery time.**
**Option B, correctly bounded, if it will not.**

Here is the reasoning, plainly.

Option A is the right answer on security and we are not going to argue against
it. It is the only one of the three where the boundary is enforced by Microsoft
rather than by a policy someone has to remember not to change, and where a
stolen credential from our side yields one mailbox rather than a group. It is
also, as you noted, how Lever already works at Gold Star — so the consent
prompt is a pattern the staff have seen, and the security review of it has
effectively already happened. It removes the single artefact your objection is
really about: a long-lived client secret that, absent an Exchange policy,
unlocks 250 mailboxes.

Its costs are real and they are product costs, not security costs: voluntary
coverage, shared mailboxes needing an owner, refresh tokens that lapse after 90
days of inactivity, and a couple of weeks of engineering before it works at
all. Those are Gold Star's to weigh, not ours and not yours.

Option B is defensible and it is what the code is written for today, but only
with the application access policy in place and periodically verified. Without
that policy it is precisely the "keys to the kingdom" arrangement you objected
to, and you would be right to refuse it. If you go this route, we would ask
that you treat `Test-ApplicationAccessPolicy` as a recurring check on your
side, because we have no way to prove from the application that the policy is
still there.

We do not recommend Option C as the destination, but **we would happily take it
as a first phase.** It is genuinely the narrowest thing that is still useful:
it gets outbound quotes, estimates and signature requests flowing from the CRM
with a credential that cannot read anything, while A is built or while B's
group and policy are being agreed. It is a reasonable place to start on Monday
rather than a reasonable place to stop.

**A suggested sequence, if it helps:** start with C to unblock outbound; build
A in parallel; use B only as the fallback if A's coverage gaps prove
unacceptable in practice — and if you land on B, trim the permission list to
`Mail.Read`, `Mail.Send`, `Calendars.ReadWrite`, drop `Mail.ReadWrite`
outright, and let us remove `User.Read.All` too.

---

## 4. Token handling and revocation, across all three options

| | A — delegated | B — application + policy | C — send-only |
| --- | --- | --- | --- |
| Credential | per-user refresh token | one client secret or certificate | one client secret or certificate |
| Stored where | encrypted AES-256-GCM in `integration_credentials` | Lovable Cloud project secrets (`process.env`), never in the repository, never in the browser | same as B |
| Access token | in-process only, ~60–90 min, re-requested on expiry, never written to the database | same | same |
| Blast radius if stolen | one mailbox | the mail-enabled security group | one no-reply mailbox, send only, no read |
| Revocation, by IT alone | revoke consent or the user's sessions in Entra; the user can also remove the app | remove from the group, delete the secret, or delete the app registration | delete the secret or the app registration |
| Time to revoke | immediate | immediate | immediate |
| Rotation | automatic (refresh) | manual; recommend certificate, or a secret with a 12-month maximum lifetime and a calendar reminder | same as B |

In every case: no Graph credential is ever compiled into the browser bundle
(the `VITE_` prefix rule in `docs/SECURITY-OVERVIEW.md` §6 is what enforces
that), and no Graph token is ever written to the database.

## 5. Alongside whichever option, we would ask for

- **A conditional-access policy** on the app registration if you use one for
  other service principals — we have no objection to being inside it.
- **Sign-in and audit logs for the app registration** left enabled, so you have
  an independent record of what the credential did that does not depend on our
  `assistant_audit` and `photo_access_log` tables.
- **A named expiry and owner for the secret or certificate**, held on your
  side.
- Whichever option you choose, **`Mail.ReadWrite` should not be granted.** The
  code does not use it, and the setup screen asking for it is a defect we will
  correct. (Corrected: the application-mode request no longer lists it.)

---

## 6. What was built (Option A, October 2026)

**Registration IT makes:** single-tenant Entra app, platform **Web**, redirect
URIs exactly
`https://goldstar.falconstaging.com/api/auth/microsoft/callback` and
`https://flood-hero-hub.lovable.app/api/auth/microsoft/callback`.
**Delegated** permissions `openid profile email offline_access User.Read
Mail.Read Mail.Send Calendars.ReadWrite`, plus optionally `Mail.Read.Shared
Mail.Send.Shared Calendars.ReadWrite.Shared` for shared office mailboxes a user
already has Full Access to. No application permissions, no `User.Read.All`, no
`Mail.ReadWrite`, no ApplicationAccessPolicy. Admin consent is optional: it
saves each person the prompt and does not widen any token. Hand back Tenant ID
(the GUID), Client ID and a client secret as `OUTLOOK_TENANT_ID`,
`OUTLOOK_CLIENT_ID`, `OUTLOOK_CLIENT_SECRET`.

**Sign-in** (`src/routes/api/auth/microsoft/`, `src/lib/microsoft-oauth.ts`,
`src/lib/microsoft-delegated.server.ts`): each person presses Connect Outlook
on their own Security page. Authorization code with PKCE (S256),
`prompt=select_account`, an OIDC nonce, and a signed `state` that expires in
ten minutes and is bound to an HttpOnly cookie on the browser that started it.
The redirect URI is derived from the request's origin, and only from the two
registered origins (plus localhost for development). On return the `state` is
verified before any database or network call; the code is redeemed; the
id_token must name Gold Star's tenant (`tid`, issuer) and a member rather than
a guest, and Graph `/me` must agree, before anything is stored.

**Token storage:** the refresh token is AES-256-GCM encrypted with the existing
credential-store key, with the owner's user id as associated data, in
`microsoft_connection_secrets` — a table no browser-facing role has any grant
on. People can read only their own connection's status. Access tokens live in
memory for their hour and are never written anywhere. Every refresh stores the
rotated refresh token; a refused refresh (`invalid_grant`,
`interaction_required` — 90 days unused, password change, sessions revoked)
deletes the dead token and shows "Needs reconnect".

**Whose token reads what** (`src/lib/graph-auth.server.ts`): a personal mailbox
is synced with its own person's token. A shared office mailbox is synced with
the token of an owner an admin assigns — someone with Full Access who connected
with the shared scopes; if they disconnect or leave, it shows "needs an owner"
and pauses. Nobody else's token is ever borrowed. Sending and meeting invites
go out on the sender's own token, after the app's own send-as rule. A mailbox
nobody can speak for is skipped and listed, not failed.

**Revocation:** unchanged from §2 — IT revokes consent or sessions in Entra, or
deletes the registration or secret. A person's Disconnect deletes our copy.

**Application mode** (`OUTLOOK_AUTH_MODE=application`) keeps the original
client-credentials path for Option B, unchanged.
