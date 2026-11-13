# Goldstar security review — 7 September 2026

## Assessment

This review found actionable application vulnerabilities, including stored script injection, cross-office document access through editable references, mailbox authorization failures, and private CRM information being retrieved for a shared chat. The first rollout repairs those paths and adds regression coverage. Database-dependent repairs are prepared separately.

### Rollout status

**Phase one (independent app fixes):** HTML/file handling, photo/document/mailbox authorization, shared-chat isolation, current-session/MFA checks, fail-closed page state, account cache/queue isolation, offboarding/reactivation and repository controls. SQL migrations and their local tests are included for review, but are not applied by merging this PR.

**Phase two (requires verified live database deployment):** atomic permission replacement, calendar identity enforcement, atomic public intake/signing, and closed rate-limiter behavior. Their app consumers remain in a separate prepared PR. Existing form/calendar/permission write behavior is retained in phase one; those findings are **not yet closed in production**. The table below describes the complete prepared remediation, not a claim that every row has shipped.

**Production security sign-off remains open.** The available Supabase connection was denied access to Goldstar (`ortpawtuqerkmuykwndp`). No production database changes, Auth bans, customer document submissions or emails were performed during this review. Local fixes and prepared migrations are not evidence that the live database enforces them. This is a source/dependency/history review with local tests and browser smoke checks, not an independent penetration-test certification or evidence that no prior compromise occurred.

## Scope and findings

Reviewed authentication, MFA, account approval/offboarding, page/capability authorization, privileged server functions, public token flows, file handling, internal AI/chat, Outlook integration, offline queues, dependencies, repository secrets and CI. Detailed inventories are in [the endpoint review](../src/routes/api/SECURITY-AUDIT.md) and [the browser/file review](SECURITY-CLIENT-FINDINGS.md).

| Priority | Confirmed issue | Remediation and boundary |
| --- | --- | --- |
| High | Stored template HTML/merge values could execute script in the editor | DOMPurify allowlist, text-node token handling and escaped values. Malicious fixtures are tested. |
| High | Photo signing authorized a path prefix before URL normalization | Reject ambiguous traversal/encoded paths and restrict upload identifiers before service-role operations. |
| High | An editable signing-packet item could reference a different office's document | Validate every referenced document against the packet's office before reading/signing. |
| High | A communication record could select another person's Outlook mailbox | Recheck mailbox authority independently of the editable record. Graph bearer tokens are restricted to the Graph origin, with redirects refused. |
| High | Group Polaris used the asker's private CRM access | Shared mode has no CRM tools and rejects unsolicited tool calls; shared errors are generic. General questions and the shared transcript remain supported. |
| High | Offboarding called a JWT-based sign-out API with a user ID | Auth ban before profile deactivation, protected-role hierarchy, explicit partial-failure reporting and reviewed reactivation. Existing tokens also need database enforcement. |
| High | Server actions and client state could accept incomplete MFA or failed profile/permission reads | Current user/status/MFA checks, fail-closed state, no all-denied permission recovery, race-safe identity loading. |
| High | Offline queues were shared across accounts | Owner-specific storage and captured-token requests; unidentified old entries retained for support recovery, never automatically assigned to the next user. |
| High | Privileged calendar processing trusted mutable provider/mailbox references | Database identity guard and fresh authorization RPC. Processing refuses to proceed until the integrity migration is installed. |
| High | A privileged commission calculation helper was directly callable by browser roles | Revoke direct execution; preserve internal/service callers. **Database migration required.** |
| Medium | Permission override replacement deleted a revoke before a possibly failing insert | Transactional replacement RPC; no unsafe client fallback. Existing rules stay intact if the migration is missing. |
| Medium | Single-use intake/signing checked state separately from writes | Atomic database operations and fail-closed migration requirements; see prepared migrations and their tests. |
| Medium | Closed rate-limit policy was ignored for missing database schema | Missing schema now respects refusal. Protected public writes stop with a temporary-service error; real throttling remains distinct. |
| Medium | Same-browser cached pages could retain private/token-bearing HTML after logout | Dynamic responses are private/no-store; navigation cache retired. Static assets and queued captures are retained. |
| Medium | Uploaded active content received an unrestricted preview | Raster allowlist and sandboxed PDF with forced-download fallback. |
| Medium | Customer receipts included internal payment notes | Remove internal notes; tests inspect actual rendered PDF output. |
| Medium | Outgoing plain-text email could inject HTML | Escape text before formatting it as HTML. |
| Medium | ESX expansion/downloads lacked effective aggregate bounds | Bound streamed download, member count, per-member/nested expansion and total output. |

Severity expresses potential impact demonstrated from code and controlled fixtures, not a claim that an attacker exploited production.

## Deployment requirements

Reconcile each new migration against the live schema and function owners before applying it; previous work documents out-of-band Lovable schema changes. Do not blindly push the entire pending migration directory. The new migrations do not perform touchpoint deduplication or delete business records.

1. Confirm the rate-limit tables/RPCs from `20260903120000_rate_limit_counters.sql` exist and work; protected writes no longer bypass missing protection.
2. Apply the commission execution restriction and atomic permission override migration.
3. Apply calendar identity, atomic intake, active-profile access and atomic signing migrations after their prerequisites and role tests are checked against the live project.
4. Deploy the application changes. Refresh/re-ingest legitimate legacy calendar identities from Graph as directed by its migration; never mark every old row trusted without verification.
5. Run [the read-only live inventory](../supabase/tests/security-live-inventory.sql), plus the individual post-deployment checks in `supabase/tests`. Save results privately with the deployment record.
6. Exercise an active admin, active ordinary rep, different-office rep, pending account, deactivated account using an already-issued JWT, and enrolled MFA user at both assurance levels. Test the direct Data API/RPC/Storage paths as well as page navigation. Verify authorized users can still perform their work.

The active-profile guard is an explicit table allowlist plus central helper changes. It is **not a blanket proof for every security-definer function**. Review remaining direct RPC entry points and exposed views, including whether caller-supplied user IDs can substitute a different identity. Signed URLs already issued and public buckets are separate from authenticated RLS checks.

Until migrations are installed, permission replacement, outbound calendar processing and atomic public submission features may deliberately refuse work. This must be visible in deployment scheduling, rather than described as a fully live fix.

## Remaining live checks for IT

- **Storage:** enumerate every bucket and approve any public exception. RLS does not protect public object downloads. Check allowed file sizes/MIME types and sharing expiry/revocation.
- **Auth:** enforce CAPTCHA in Supabase (the browser widget alone is insufficient), verify allowed redirects and signup policy, strong passwords, email verification, JWT lifetime and MFA enforcement at the database boundary. Browser sign-in throttling is supplementary and can be bypassed by calling Auth directly.
- **Secrets and integrations:** verify `CRON_SECRET` and Graph/provider secrets exist only server-side, callers send the right header, rotations have a tested process, and disconnected mailboxes stop processing. Never place private credentials in `VITE_` variables.
- **Ingress:** confirm Cloudflare origin access, rate limits/WAF, HTTPS/HSTS and a tested CSP/frame policy. Do not enable a blanket CSP without exercising the Lovable preview, PDF viewer, maps and CAPTCHA.
- **Hooks:** test provider retry/replay and idempotency behavior. Credential checks alone do not guarantee freshness; not every provider hook has durable replay prevention.
- **Incident readiness:** confirm backups can actually restore, audit/access logs are retained and reviewed, responsible owners receive alerts, and Goldstar/IT administrators use MFA. This audit did not conduct a forensic investigation or disaster-recovery exercise.
- **Google Maps:** the browser key is intentionally public; verify Google API and HTTP-referrer restrictions and quotas in the owning cloud project.

## Supply chain and repository

- Dependency vulnerability scan reported zero known advisories for the installed lockfile at review time. This is time-sensitive and does not detect custom authorization bugs.
- Full reachable Git history scanned with checksum-verified Gitleaks 8.30.1: 2,658 commits. Seven detections were privately triaged: two UI-key false positives and five intentionally public browser/publishable configuration values. No private credential was confirmed by that scan. Historical exceptions are exact fingerprints in `.gitleaksignore`; new private secrets are not broadly excluded.
- Added a pinned, checksum-verified history scan on PRs/main/weekly runs. Findings are redacted.
- Enabled and verified GitHub Dependabot alerts and automated security fixes through the API. Security updates open PRs; they do not auto-merge.
- Regenerated `bun.lock` from the tested npm lockfile to remove existing dependency drift, using [Bun's documented lockfile migration](https://bun.sh/docs/pm/lockfile), then checked frozen-lockfile compatibility.
- GitHub refused branch-protection configuration for the current private-repository plan. Required checks cannot be enforced by branch protection here without a plan change. No paid plan was changed. CodeQL's existing paid-feature gate remains disabled; a skipped CodeQL job is not a clean scan.

## Validation record

Focused regression tests exercise negative and legitimate paths. SQL fixtures run in local PostgreSQL/PGlite with role/ACL and rollback assertions, not against production. The browser smoke check loaded `/auth` and redirected unauthenticated `/jobs` to sign-in without reported browser errors; no authenticated production business flow was exercised.

Full prepared code after incorporating the latest room/document changes: 1,110 application tests passed (5 pre-existing skips). Phase one: 1,090 application tests passed, TypeScript passed, production build passed, and all 90 local PostgreSQL checks passed. The final history scan covered 2,661 commits with no unsuppressed findings. [PR #56](https://github.com/faser15/flood-hero-hub/pull/56) runs the same build/type/test/SQL checks plus secret and dependency checks. CodeQL remains skipped, not a completed scan. Repository-wide lint remains advisory; the audit's changed-file lint is reviewed separately.

## Operational changes

- Group AI still answers general questions, but private record lookup belongs in a private Polaris conversation.
- Opening a private page from a cold offline browser now requires connectivity. Captures in an already-open app continue through the isolated queue.
- Legacy unsent work without trustworthy owner attribution remains on the device. Keep that browser profile/site data; support must establish the owner before recovery. Do not clear it to dismiss a notice.
- Safe PDF previews have a download fallback because browsers differ in sandboxed PDF support. Large ESX inputs above the documented limits need a desktop tool.

References: [Supabase row-level security](https://supabase.com/docs/guides/database/postgres/row-level-security), [Supabase Auth admin updates](https://supabase.com/docs/reference/javascript/auth-admin-updateuserbyid), [Workbox caching strategies](https://developer.chrome.com/docs/workbox/modules/workbox-strategies), [OWASP XSS prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html).
