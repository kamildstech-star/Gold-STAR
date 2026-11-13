# Server endpoint security review

Worktree: `C:/dev/goldstar-security-audit`, branch `audit/security-review`.
No commits, pushes, live Auth operations or database writes were performed.
Other agents' changes are not included in this ownership report.

**Two-phase rollout:** live Supabase is unavailable. Do not ship the phase-two
signing consumer until its RPC and limiter store have been deployed and verified.
Phase-one signing source and matching tests are prepared at
`C:/dev/security-tools/phase1/src/lib/document-sign.functions.ts` and
`C:/dev/security-tools/phase1/src/lib/document-sign.functions.security.test.ts`.
They include document scope/IDOR fixes, retain the original non-atomic signing
algorithm, keep write rate limiting fail-open, and require no new signing RPC.
The actual audit worktree retains the complete phase-two implementation.

**Update, Oct 2026:** phase two is now on `main`. `complete_document_signing_atomic`
was verified live (signature, service_role-only EXECUTE, body identical to the
migration) before `submitSignPacket` was switched to it; the write limiter
fails closed and each attempt uploads to its own `{doc}/{attempt}/` folder.

The auth owner's `20260908013000_active_profile_access_guard.sql` is present in
the shared worktree. Until deployed and verified, already-issued JWT access
is not guaranteed blocked by Auth bans/application middleware alone. UI copy
does not promise immediate token revocation.

## Files changed by this reviewer

- `src/lib/photos.functions.ts`, `src/lib/photos.functions.security.test.ts`
- `src/lib/document-sign.functions.ts`, `src/lib/document-sign.functions.security.test.ts`
- `src/lib/chat-assistant.functions.ts`, `src/lib/chat-assistant.functions.security.test.ts`
- `src/lib/offboarding.functions.ts`, `src/lib/offboarding.functions.security.test.ts`
- `src/components/user-editor.tsx`, `src/components/user-editor.offboarding.test.tsx`
- `src/routes/_authenticated/admin.offboarding.tsx`
- `supabase/migrations/20260908014000_atomic_document_signing.sql`
- `supabase/tests/document-signing.pglite.mjs`
- This inventory.

## Confirmed findings and fixes

1. **High: service-role photo signing path traversal.** `signVariantUrl` authorized the first path segment, but the Storage SDK interpolated the full path into a URL. Literal/encoded dot segments and backslashes normalize to another project or bucket. Upload photo IDs also accepted path syntax. Reproduced with real validators, handlers, Storage SDK and a mocked HTTP boundary. Restrict IDs to filename-safe characters and reject ambiguous paths before authorization/signing/finalization. Eight negative tests failed before the fix; all now pass, with positive upload/read controls.
2. **High: public document packet IDOR.** The checked-in `dsi_all` policy authorizes item changes by packet access, without checking the referenced document. Public handlers fetched/signed those IDs using the service role. A token for an own-office packet could disclose or sign another office's document. Both handlers now resolve every item against the packet's location before any evidence/view writes; a mismatch rejects the entire packet. Both exploit tests failed before the fix; legitimate and revoked packets remain covered. Live policy deployment is unverified.
3. **High: shared chat inherited the asker's CRM privileges.** The endpoint now passes Pascal's enforced `audience: "shared"` option to `assistantTurn`. Shared mode disables tools and rejects unsolicited tool calls; it does not attempt to intersect participant permissions. User-derived chat titles/names/transcripts are wrapped as untrusted data. Provider exceptions become a generic broadcast failure. Three call-site regressions failed before the fix. Pascal's tool-enforcement tests also pass; his server files were not edited here.
4. **High: offboarding used a UUID where Auth signOut requires a JWT.** Replaced with `updateUserById(..., { ban_duration: "876000h" })` before `deactivate_user_now`. Authoritative target roles are checked with the service client before banning: sales leads cannot ban admins/owners/developers; admins cannot ban owners. Role-read failure denies the operation. Failure to ban prevents durable deactivation. Failure after a successful ban leaves it in place and returns an explicit partial-failure error. The response states `signInBlocked: true, sessionsRevoked: false`. `restoreUserSignIn` is owner/admin-only, checks an active approved profile and explicitly unbans with `ban_duration: "none"`. Tests cover hierarchy, order, failure, permission, self-deactivation and restoration.

## Verification

91 tests passed across eight targeted suites, including UI reactivation,
overlapping handler attempts, write-limiter outage, and failure rollback.
The separate phase-one variant passes seven tests, including successful signing
with an unavailable limiter store and no atomic-RPC dependency. It was tested
under temporary distinct module names, without replacing the phase-two module;
temporary verification files were removed.

13 in-memory PostgreSQL checks execute the real atomic signing migration,
including production document/signature triggers. They cover single consumption,
competing packets for one document, transaction rollback and retry, expiry
(including null), revocation, document edits, required answers, evidence
cardinality, multi-use answers, and RPC grants. PGlite queues statements on one
connection; this verifies transaction behavior but is not a live multi-session
load test. Actual overlapping handler requests are gated in the Vitest fixture.
No live writes or network exploits were attempted. Targeted lint has no errors
(two existing React Fast Refresh warnings on the route). Repository typecheck passed.

## Public endpoint inventory

The machine-checked version of this table is `src/lib/security/public-surface.ts`
(`API_ROUTES`, `PUBLIC_SERVER_FUNCTIONS`); `src/lib/security/server-surface.test.ts`
fails when a route or session-less server function is missing from it, and
`server-no-session.test.ts` calls every route with no credential.

All hook paths below are beneath `/api/public/hooks/`. Publicly routable does
not mean credential-free. Missing configured hook secrets fail closed.

| Endpoint | Methods | Credential / boundary |
| --- | --- | --- |
| `cadence-sweep` | POST | `x-cron-secret`, CRON_SECRET |
| `chase-escalation` | POST | `x-cron-secret`, CRON_SECRET |
| `document-signature-reminders` | POST | `x-cron-secret`, CRON_SECRET |
| `drying-weather` | POST | `x-cron-secret`, CRON_SECRET |
| `email-release` | POST | `x-cron-secret`, CRON_SECRET, via the webhook seam `src/lib/webhook-verify.ts` |
| `kahi-sync` | POST | `x-cron-secret`, CRON_SECRET |
| `raven-sync` | POST | `x-cron-secret`, CRON_SECRET |
| `run-automations` | POST | `x-cron-secret`, CRON_SECRET |
| `sync-nyc-fire-leads` | POST | `x-cron-secret`, CRON_SECRET |
| `auto-capture` | POST | Raw-body HMAC-SHA256, `x-signature` |
| `callrail` | POST | Raw-body HMAC-SHA1/base64, `signature` |
| `equipment-tracker` | POST | Raw-body HMAC-SHA256, `x-tracker-signature` |
| `incidents` | POST | Raw-body HMAC-SHA256, `x-incident-signature` |
| `raven` | POST | Raw-body HMAC-SHA256, `x-raven-signature` |
| `resend` | POST | Svix HMAC-SHA256 + timestamp tolerance |
| `graph-sync` | POST | `x-cron-secret`, CRON_SECRET (pg_cron `graph_sync_kick`); Graph owner retains deeper audit |
| `outlook` | GET, POST | Validation-token echo is intentionally public; notifications require clientState; Graph owner retains deeper audit |

Other routes and public server functions in this assignment:

| Surface | Credential / boundary |
| --- | --- |
| GET `/api/share/$token/photo/$id` | Share token, expiry/revocation, job membership and original-download flag |
| GET `/api/documents/$id/file` | Verified user JWT via Bearer or document cookie; row and object RLS; no service role |
| `loadJobShare` | Validate the share link, expiry, revocation and display options |
| `loadSignPacket`, `submitSignPacket` | Validate the packet link, expiry, revocation, completion and document location |
| `beginSignIn` | Intentionally public sign-in limiter; does not authenticate |

Graph/intake function internals and intake's public functions remain with
their assigned owners. Remaining assigned `*functions.ts` exports have
`requireSupabaseAuth`; privileged service calls have explicit role/ownership
gates or require deeper checks in their separately owned server helpers.

## Rollout and remaining verification

- **Phase one:** use the separate signing variant and test. Offboarding server/UI changes can merge independently: the Active toggle invokes Auth restoration after profile activation, rolls back on failure, and has a Restore sign-in retry button. Deactivation invokes the protected server endpoint. Status and confirmation copy do not claim sessions were killed. Assigned roles/offices are retained; integrations remain a separate administrative review.
- **Phase two prerequisites:** deploy and verify `20260903120000_rate_limit_counters.sql` and `20260908014000_atomic_document_signing.sql` before switching to the worktree signing consumer and closed write limiter. Coordinate with the auth owner's `20260908013000_active_profile_access_guard.sql` and Pascal's `20260908012100_atomic_public_intake.sql`; this reviewer did not edit their migrations.
- **Phase two behavior:** token expiry/revocation/completion, document snapshots and required answers are checked under packet/document locks. Evidence rows, document updates, notes and token consumption commit or roll back together. Uploads use unique attempt paths with upsert disabled, so losers cannot overwrite winning files. Missing RPC/store fails closed. Null expiry is rejected. Token reads remain fail-open on limiter outages.
- **Storage tradeoff:** failed or losing attempts may leave unreferenced private objects. They are never attached to the document or reused by a later attempt. No automatic deletion is attempted after an ambiguous RPC response, because the transaction may have committed successfully. Existing signed file paths are unchanged; only new submissions use attempt-specific paths.
- **Existing JWTs:** the Auth ban does not invalidate issued JWTs. Deploy and verify the auth owner's database guard before claiming direct Data API lockout. Live validation remains unavailable.
- **Mutable pointer review:** packet job/account references and public photo proxy storage coordinates come from editable database rows. Location pinning closes the demonstrated cross-office document-item case, but does not certify all pointer invariants. Database/storage owners should validate them, including immutable packet location and creator fields; no speculative schema edits here.
- **Hook replay:** Resend has a timestamp window. Other HMAC hooks authenticate bodies without a general freshness window; some deduplication occurs after side effects. Provider-specific retry/replay behavior remains to be tested.
- Live Supabase access was denied per parent. Applied RLS, bucket configuration, Auth ban behavior, JWT lifetime, deployment secrets and public ingress behavior were not verified against production. Parent owns Gitleaks/private triage, dependency findings, deployment, PR and merge.

References: Supabase [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security)
and [Auth admin updates](https://supabase.com/docs/reference/javascript/auth-admin-updateuserbyid),
plus the installed Storage/Auth SDK source inspected locally.
