# Email draft — Mark to Chaim (SM Tech Solutions)

Plain text, ready to send. Attach or link `docs/SECURITY-OVERVIEW.md` and
`docs/OUTLOOK-ACCESS-PROPOSAL.md`.

Before sending, check: Chaim's email address, whether the two documents go as
attachments or as a repository link, and whether you want to name a date for
the Turnstile/WAF work.

---

**Subject:** Recovery Hub — tech stack, security posture and Microsoft 365 access options

---

Chaim,

Thanks for the call and for being direct about the mailbox question. You were
right to push on it, and I would rather work through it properly than talk you
into something. Two documents are attached: a security overview of the
application, and a proposal setting out narrower options for Microsoft 365
access. Both are written from the actual codebase, not from a template, and
both include a plainly labelled list of what we do not have yet.

**The stack**

- Front end and server: TanStack Start (React 19, TypeScript, Vite), rendered
  server-side on Cloudflare Workers. Tailwind CSS and shadcn/ui for the
  interface.
- Backend: Supabase only — managed Postgres, Supabase Auth, Supabase Storage —
  provisioned through Lovable Cloud. No separate application server, no ORM, no
  custom session store, no self-hosted infrastructure of any kind.
- Data path: browser → Cloudflare → Cloudflare Worker → Supabase Postgres. All
  data rests in one Supabase Postgres database and six private storage buckets.
  Nothing is copied anywhere else, and there is no analytics or log-shipping
  pipeline.
- Repository: GitHub, changes merged through pull requests.

**What is already in place**

- Authorisation is Postgres row-level security, not application code. The
  browser talks to Postgres directly using the user's token; every access
  decision is made by RLS policies inside the database. There is no
  application permission layer that RLS could be worked around. 223 of the 224
  tables have RLS enabled (the one that does not is a PostGIS reference table),
  under 543 policies. Hiding a button in the UI changes nothing — the row
  simply does not come back.
- Authentication is Supabase Auth, with Google SSO available and TOTP
  two-factor implemented, including an admin console showing adoption across
  the company and a logged, admin-only reset path. Two-factor is currently
  opt-in; making it mandatory is Gold Star's call and I would support it.
- New accounts cannot use the system until an owner or admin approves them.
- All six storage buckets are private. No bucket is public and no
  unauthenticated storage URL exists. Shared photographs are proxied through
  the application rather than served by signed URL, specifically so that
  revoking a share link actually revokes the pictures.
- Every unauthenticated endpoint is enumerated in the overview: four public
  pages (sign-in, plus three link-based customer pages for schedules, claim
  intake and e-signature) and seventeen webhook endpoints. Every webhook
  requires an HMAC signature or a shared secret, compared in constant time, and
  refuses all traffic when its secret is not configured.
- Application-level rate limiting on sign-in, per account as well as per IP —
  Supabase has no per-account limit at all — with lockout, a notification to
  the account holder, and an audit record.
- Audit logging of two-factor resets, sign-in lockouts, every view of a
  customer photograph including by anonymous share-link visitors, and every
  AI-assistant query with the data scope it ran under.

**What we are adding, and what we found doing it**

Automated scanning is wired to the GitHub repository. Two of the three pieces
are running today. The third — the one you would most want to see — is blocked
by a GitHub licensing constraint, and I would rather tell you that up front
than let you assume it is working:

- **Running and passing: a pull-request check running
  `npm audit --audit-level=high`**, alongside the project's typecheck and test
  suite. It blocks a merge on any high or critical dependency advisory. As of
  7 September it reports zero vulnerabilities.
- **Running: Dependabot** for npm and GitHub Actions dependencies, weekly. It
  is opening pull requests normally — five were open this week. One correction
  to what I said before: Dependabot *alerts*, the feature that raises a
  higher-priority pull request the moment a vulnerability is published against
  something we use, is currently switched **off** on the repository. That one
  is free on private repositories and I am turning it on.
- **Configured but NOT reporting: GitHub CodeQL static analysis.** The analysis
  runs and scans all 783 TypeScript files, but the repository is private, and
  GitHub does not accept code scanning results from a private repository unless
  you hold **GitHub Advanced Security** (the “GitHub Code Security” product).
  We do not. Every run since I added it has failed at the upload step with
  “Code scanning is not enabled for this repository”, and the API returns the
  same thing. So **there is no Security-tab report for me to give you access
  to, and no automated analysis of our own source code is happening** — npm
  audit and Dependabot only check the versions of third-party libraries; they
  never read our code.

  I have gated that workflow off so it stops failing every build (it now shows
  as “skipped” rather than as a red X, and stops consuming build minutes on a
  result it is not allowed to publish). Nothing was deleted: the workflow, its
  triggers and its query set are intact, and switching it back on is one
  command once the licence exists.

  **What it would cost to close that gap:** GitHub Code Security is billed per
  active committer per month — anyone who pushed in the last 90 days — at a
  list price of US$30 per active committer per month, and it needs a GitHub
  Team or Enterprise plan. For this repository that is on the order of
  US$30–$150 a month; I would confirm the exact figure with GitHub before Gold
  Star commits to it. The only free alternative is making the repository
  public, which is obviously not on the table. This is a purchasing decision
  for Gold Star, and I am happy to be told it is not worth it — I just did not
  want it recorded as “static analysis is in place” when it is not.

Running those honestly turned up things I would rather you hear from me. Three
high-severity advisories in transitive build dependencies — those are now
fixed, and `npm audit` is clean. A lint backlog of about 158 pre-existing
issues unrelated to security, still open. There is
also a batch of 24 database migrations written but not yet applied, two of
which are security fixes — the most significant being that an employee can
currently approve their own timesheet, and that a rejected signup could
re-approve itself. Both are written and reviewed; they need a maintenance
window to apply. All of it is in the "Known gaps and planned work" section of
the overview.

To be explicit about what we do not have: no SOC 2 report, no ISO 27001, and no
third-party penetration test has ever been performed on this application. I am
not going to dress up automated scanning as equivalent to one. If Gold Star
wants a pen test, I will support it and help scope it — that is a commercial
decision above my pay grade.

**Microsoft 365 access**

Your objection is correct as written. What the integration currently asks for
is tenant-wide application permissions, and the only thing that would stop it
reading every mailbox is an Exchange application access policy that we cannot
create, cannot enforce and cannot verify from inside the application. Nothing
is provisioned — there is no app registration and no credential exists — so
this is still an open design decision.

The proposal document sets out three options with the exact Graph scopes and
what the CRM loses under each:

- **A — per-user delegated consent.** Each employee authorises their own
  mailbox, the way Lever already works at Gold Star. Delegated `Mail.Read`,
  `Mail.Send`, `Calendars.ReadWrite`, `User.Read`, plus `offline_access`.
  Microsoft enforces the one-mailbox boundary; there is no policy anyone can
  get wrong. Costs: coverage becomes voluntary, shared and office mailboxes
  each need an owner, refresh tokens lapse after 90 days of inactivity, and it
  is a couple of weeks of work before it functions at all.
- **B — application permissions bounded by an Exchange application access
  policy.** `Mail.Read`, `Mail.Send`, `Calendars.ReadWrite` (and `User.Read.All`,
  which we can remove if you would rather), restricted by
  `New-ApplicationAccessPolicy -AccessRight RestrictAccess` to a mail-enabled
  security group you control. Full functionality, no consent to chase — but the
  policy is silently load-bearing and we cannot verify it from our side.
- **C — send-only through one no-reply mailbox.** `Mail.Send` only, restricted
  to that single mailbox. The credential cannot read a single message anywhere
  in the tenant. It also cannot log inbound replies, which kills the follow-up
  cadences, the response tracking and roughly half the value of the
  integration.

**My recommendation: Option A**, if Gold Star will accept the coverage gaps and
the delivery time. It is the only one where the boundary is enforced by
Microsoft rather than by a configuration someone has to remember not to change,
and a credential stolen from our side yields one mailbox rather than a group.
It is also the pattern your users have already been through with Lever. If the
coverage gaps prove unacceptable in practice, B properly bounded is defensible
— but only with the access policy in place and periodically verified by you,
and I would ask you to treat `Test-ApplicationAccessPolicy` as a recurring
check on your side.

I would also happily start with C as a first phase to unblock outbound quotes
and signature requests while A is built. It is the narrowest thing that is
still useful.

One correction regardless of which we choose: the setup screen currently asks
for `Mail.ReadWrite` and no code path uses it. That should not be granted, and
I am removing it from the request.

**What I need from Gold Star**

1. **Cloudflare Turnstile keys** — a site key and a secret key for the app's
   hostname. The secret goes into the Supabase dashboard, the site key into the
   app environment. Both halves have to be set in the same window or sign-in
   breaks, so let us schedule it together.
2. **Cloudflare WAF rules.** Volumetric floods and known-bad traffic are the
   edge's job and I have deliberately not tried to duplicate that in
   application code. No rules exist for this app today. I would value your
   recommendation on a rule set.
3. **The Google Cloud keys** we already agreed on the call — Maps and the
   related APIs, browser-key restricted to our hostnames.
4. **A decision on the Outlook option**, and if it is B, the mail-enabled
   security group and the application access policy.

Happy to walk through any of this on a call, and equally happy for you to come
back with findings from the documents. If it is useful I can give you read
access to the repository itself, and to the pull-request check results, rather
than you taking my word for what they say. I cannot give you CodeQL results,
for the licensing reason above — if automated static analysis of our own code
is a condition of the mailbox access, then the Advanced Security licence is the
thing that has to be decided first, and I would rather we settle that
explicitly than have it sit as an assumption between us.

Thanks,
Mark
