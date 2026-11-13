# Authentication and SQL security audit — prepared changes

Worktree: `C:/dev/goldstar-security-audit`. No deployment, live SQL, commit or push.
The parent reported that the target's live `execute_sql` connector was denied.
Findings below are confirmed against repository source, not the live database.
Later authorization expanded ownership to app-context, auth route, and the document file route.
Queue fixes belong to the dedicated queue worker; server headers/caches belong to the parent.

## Confirmed findings and disposition

| Severity | Evidence | Prepared fix / limitation |
| --- | --- | --- |
| High | `auth-middleware.ts` accepted valid claims without current profile status or enrolled MFA checks. `api/documents.$id.file.ts` had an independent claims-only check. | Shared `validate-session.ts` checks claims, current Auth user identity, verified factors/AAL2, and active approved profile through caller RLS. Both callers now use it; file failures retain plain-text noncached 401. This does not check `auth.sessions` or instantly invalidate all JWTs. |
| High | `app-context.tsx` defaulted missing/failed profile reads to approved, omitted `is_active`, retained prior identity state on signout, and let old asynchronous reads publish after a switch. | Pending initial state; reject missing/error/inactive profiles; clear identity and scope before reload/signout; generation checks ignore stale results and impersonation replies. Role-fetch failures cannot manufacture structural administrator access. |
| High | `grantPermission` deleted all overrides before inserting; an insertion error permanently removed a revoke and restored role defaults. | Atomic invoker RPC, per-user/key transaction lock, existing RLS and audit triggers retained, actor stamped from Auth. Invalid insert rolls back deletion. Client refuses a missing RPC without fallback writes. Requires migration deployment before editing overrides. |
| High | `20260820084452...sql` defines unguarded `compute_job_commissions(uuid)` as definer and explicitly grants authenticated execution. The later hardening only guards the outer recompute function. | Revoke direct PUBLIC/anon/authenticated helper execution; service and internal definer owner access retained. Fixture validates ACLs, not full commission math. |
| High | Offboarding's `deactivate_user_now` changes profile status but retains roles/memberships. Existing location/role helpers omit status and ownership RLS paths can retain access. | Prepared status migration restricts 29 named public tables, profile writes, and authenticated Storage object access. Seven audited helper signatures now require the subject's active approved profile. Other tables/RPCs remain explicitly outside coverage. |
| High | `offboarding.functions.ts` passes a user UUID to `auth.admin.signOut`; installed Auth SDK expects a JWT. Refresh-session revocation cannot be assumed successful. | Reported to parent/function owner; this worker did not edit the function. Even correct global signout does not guarantee immediate JWT invalidation. |
| Medium | `resolveAllPages` restored role defaults when all optional pages were denied; permission errors became empty defaults; cached successful capability rows survived query errors. | Preserve explicit deny-all, fail closed on unavailable permissions/capabilities, deny unknown pages. Floor screens remain. Trusted loaded Owner/Admin/Dev roles retain structural page access; these roles are withheld while identity loads or is absent. Page access is not data authorization. |
| Medium | `mfaGateForSession` returned no challenge when AAL required one but no verified factor was found; auth route caught gate failures as `required:false`. | Helper throws; route reports error and does not navigate. Authenticated route already propagated failures. SQL policies do not yet impose conditional enrolled-MFA enforcement. |
| Medium | Auth redirect accepted `/\\evil` despite checking `//`. | Same-origin normalized path helper rejects backslashes, control characters, protocol-relative and encoded separator/control destinations. |
| High, separate owner | General queue has no owner field and drains every `sync-queue:` item using current session. Photo queue is global and filtered only by project. | Handed to dedicated worker; no queue edits by this worker. |
| High | Many query keys omit user identity; no cache removal occurred on account switches. | `identity-cache.ts` cancels/clears React Query and clears/invalidates router data on identity transitions, with identity publication delayed until router invalidation completes. Same-user token refresh preserves caches. WeakMap state survives authenticated-provider remounts. Tests cover cached A data, late query results and late browser loader results after B. Already-sent mutation requests cannot be recalled by cache cancellation. |

## SQL scope and bootstrap behavior

`20260908013000_active_profile_access_guard.sql` uses an explicit list, never discovers all relations and rewrites them. Missing listed tables fail the migration rather than silently skip protection.

The 29 public tables are user_roles, location_members, region_members, permissions, role_permissions, user_permissions, jobs, accounts, contacts, projects, invoices, estimates, commission_payouts, time_entries, shifts, company_credentials, integration_connections, photo_access_log, property_notes, time_entry_corrections, documents, photos, account_notes, job_notes, tasks, conversations, messages, assistant_conversations and assistant_messages.

Restrictive authenticated policies combine with existing permissive policies; they add no row grants. Explicit anonymous deny policies cover these business tables and profiles. Storage adds an authenticated status restriction, leaving anonymous bucket policies unchanged. Public buckets and existing signed URLs do not become private through an object policy.

`goldstar_private.profile_is_active(uuid)` reads only profiles. Its postgres ownership bypasses profiles RLS, avoiding recursion; it calls no role helper. Do not expose this schema through PostgREST. The migration refuses FORCE RLS on profiles and must be applied by a role able to set the helper owner to postgres. Confirm that owner's bypass privileges in deployment review.

Profiles retain a restrictive self-read exception for pending/rejected/inactive users; existing SELECT grants and permissive policies remain necessary. Client profile writes require active approval. The actual `handle_new_user` definer trigger still creates pending profiles. Service-role business operations continue to depend on the deployed role's BYPASSRLS privileges; they do not depend on a user JWT.

Audited definitions copied explicitly, preserving signatures: `has_role(uuid,app_role)`, `has_role_text(uuid,text)`, `has_any_role_text(uuid,text[])`, `is_privileged(uuid)`, `is_member_of(uuid,uuid)`, `is_regional_for(uuid,uuid)`, and `has_permission(uuid,text,uuid)`. They now check the subject profile, including when called through a definer function. A function that accepts a caller-supplied user ID still needs to validate that identity separately. No runtime text-replacement of unknown live function bodies is performed.

## Remaining RPC and policy review inventory

Do not claim total closure. Source examples needing individual caller/status review include `expense_threshold_for(uuid)`, `visible_fields(uuid,text)`, `on_duty_chasers(uuid)`, scorecard definer functions, compliance indicator functions, and internal automation/escalation functions. Some earlier migrations revoke access or modify bodies dynamically: confirm their final catalog definitions and effective grants before classifying each as an exploitable endpoint. Subject-status checks alone do not bind an arbitrary `_user_id` argument to the caller.

`supabase/tests/auth-security-catalog.sql` lists definer signatures, owners, effective anon/authenticated EXECUTE privileges and definitions, plus public tables without the new restriction and bucket privacy. Review it through an authorized read-only connection. Also inspect views' `security_invoker` settings and all permissive Storage policies, since permissive policies combine with OR.

User-editable Auth metadata is used for display names in the signup trigger; no authorization use of `raw_user_meta_data` was found in the migration search. Roles/memberships and permission writes have privileged RLS in the audited definitions. Profile approval/activation self-editing was addressed in the earlier `20260903130000_security_hardening_batch1.sql`; do not report that historical hole as still present without ledger/catalog evidence.

All located view definitions have later invoker settings in source, including the August 20 recreation of `account_fire_rollup`, corrected August 21. This is not a live view audit. Recent Trade Show/drying/assistant/intake bucket migrations set private storage with owner/record policies; older documents INSERT permits any signed-in account. The new authenticated Storage status guard prevents inactive/pending uploads but does not redesign ownership of active-user uploads.

## Reconciliation and verification

Read `database-reconciliation-2026-09-08.md`, `database-batch.md`, and `calendar-chat-follow-up.md`. The latest report claims fifteen exact ledger entries and focused constraint/RLS checks, including crew RPC restrictions and private media buckets. Those are historical scoped results, not a security pass for these new migrations. Earlier reports' unapplied/deployment statements are superseded only where the latest reconciliation explicitly says so.

Validation performed:

- 94 focused Vitest cases across middleware/shared validation, document route, MFA, redirect normalization, page resolution/capability hooks, actual React identity lifecycle, and query/browser-router cache isolation tests.
- 40 PostgreSQL assertions using PGlite 0.3.16, no dependency/lockfile changes by this worker. Parent owns adding that exact development dependency for reproducible CI. Actual permission table/RLS and signup trigger definitions are used. Forced FK insertion failure preserves prior revoke; admin/non-admin/inactive/anon behavior and migration replays are exercised. Status policies are tested against deliberately permissive baseline policies. Commission callers are representative definer fixtures to isolate ACL semantics, not full business integration tests.
- Parent owns combined typecheck/build. This worker's earlier typecheck completed with an unrelated `safe-html.test.ts` Element.protocol error; no typecheck remained running.

Reproduce the 40 PostgreSQL checks in CI with `node supabase/tests/auth-security.pglite.mjs node_modules/@electric-sql/pglite/dist/index.js` after installing the pinned development dependency. This one script reads actual repository migration files through URLs relative to itself. All data are in-memory fixtures; no remote connection is opened. `commission_rpc_grants.sql` and `auth-security-catalog.sql` are read-only post-deployment verification, not additional executed fixture suites.

## Deployment limitations and order

Prepared migrations: `20260908010058_restrict_internal_commission_rpc.sql`, `20260908010611_atomic_permission_override.sql`, `20260908013000_active_profile_access_guard.sql`. The final filename uses the parent's reserved 013000 slot after initial CLI creation; Pascal owns 012000 and Gauss 014000.

Apply each exact migration transactionally after confirming target, ledger, table names, helper signatures/owners, preexisting definitions, grants and policy composition. No migration has been applied by this worker. Old client bundles can still use direct permission-table writes; the new RPC lock serializes RPC callers, not legacy clients writing tables directly. Deploy/reload clients together and review whether future table DML revocation is appropriate.

The application patch denies account access on Auth/profile outages and requires current profile SELECT column grants. This is an intentional availability/security tradeoff. Middleware and document file reads add Auth/profile requests. New atomic override edits remain unavailable until their RPC is deployed.

Parent deployment split: phase one may restore only the original `grantPermission` body while retaining the fail-closed capability hook changes in the same file. This deliberately leaves the non-atomic override vulnerability unresolved in phase one. Phase two should include the atomic wrapper and its SQL migration together; do not present the atomic edit fix as deployed in phase one. All three prepared migrations remain unapplied. The other application checks use existing profile columns/grants and are independently reviewable.

After deployment, execute the read-only catalog/grant checks, then run a real role matrix for approval/deactivation, enrolled AAL1/AAL2, private files, signup bootstrap, permission-edit rollback/concurrency, and old JWTs. Retest public/signed links and service integrations separately. Prefer reviewed forward recovery; do not restore broad RPC grants or remove status guards merely to make a broken caller work.
