# Recovery Hub senior handover

Last updated: 2026-09-09

This is the running handover for issues that cannot be completed through an ordinary application pull request. Add future external-access, infrastructure, production-configuration, or approval blockers here. Do not include passwords, API keys, tokens, or service-role credentials.

## Current delivery status

- Pull request [#60](https://github.com/faser15/flood-hero-hub/pull/60) merged into `main` as `ef7174ae1bf187bfdaecda541142315e8728600d`.
- The Lovable production build was manually published after approval and verified at `https://goldstar.falconstaging.com`.
- Production database migration `20260908055847_claim_new_lead_atomic.sql` was applied through the authenticated Lovable database connection. The migration ledger entry, function owner, grants, row counts, and exact committed SQL checksum were verified.
- Full Vitest run: 1,110 passed and 5 skipped. TypeScript and production build passed. Changed-file ESLint had zero errors.
- Live-backend E2E passed for annual-to-month goal breakdown, `why` propagation, Dashboard/My Goals consistency, simultaneous lead claiming with one winner, meeting-triggered stage progression and Undo, full account editing, and View As write protection.

## Open blockers

### 1. Production Routes map — company Google Cloud access required

- Status: blocked externally
- Owner: company Google Cloud / Maps administrator
- Severity: high for field-sales routing

Production `/routes` displays:

> Google rejected the Maps key for goldstar.falconstaging.com.

The browser reports `RefererNotAllowedMapError`. The application is reading `VITE_LOVABLE_CONNECTOR_GOOGLE_MAPS_BROWSER_KEY`, but the Google Maps key does not permit the production hostname or the Maps JavaScript API is not enabled in the key's Google Cloud project.

Required action in the **company-owned** Google Cloud project:

1. Locate the browser key represented by `VITE_LOVABLE_CONNECTOR_GOOGLE_MAPS_BROWSER_KEY`.
2. Confirm Maps JavaScript API is enabled for that project.
3. Set Application restrictions to Websites.
4. Add these allowed referrers:
   - `https://goldstar.falconstaging.com/*`
   - `https://flood-hero-hub.lovable.app/*`
5. Keep API restrictions limited to the APIs the application actually uses.
6. Wait for Google propagation, then reload `/routes` without browser cache.

Verification:

- The field map renders instead of the rejection panel.
- No `RefererNotAllowedMapError` appears in the browser console.
- Pins and Fit all work for accounts with complete street addresses.

Recovery: remove the two referrers or restore the previous key restrictions. Do not use a personal Google Cloud project or key.

### 2. Demo-data count intermittently times out

- Status: code/database follow-up recommended
- Owner: backend/database
- Severity: medium; the banner fails independently and does not block core Dashboard data

Observed error:

`canceling statement due to statement timeout` for query key `['demo-total', userId]`.

`demo_data_total()` dynamically discovers every public table with an `is_demo` column and runs a separate count against each table on application-shell load. `vehicle_positions` was approximately 134,492 rows / 81 MB during investigation and had no `is_demo` index. Several demo-enabled tables added after the original indexing migration may also lack that index.

Recommended fix:

- Add a reviewed, additive migration that indexes the demo predicate on every current demo-enabled table. At minimum:

  ```sql
  CREATE INDEX IF NOT EXISTS vehicle_positions_is_demo_idx
    ON public.vehicle_positions (is_demo)
    WHERE is_demo;
  ```

- Audit all public tables containing `is_demo` so future tables are not missed.
- Consider calculating the exact total only for privileged users or caching it longer, but do not rely on that as the database fix.

Verification:

- Run the RPC repeatedly as a normal authenticated user and a privileged user.
- Confirm calls stay below the production statement timeout.
- Confirm the banner still reports the expected sample-row count.
- Run database security and performance advisors after applying the migration when target-project access permits.

Any production schema change requires a committed migration and explicit approval immediately before application.

### 3. Tracked-vehicle Dashboard query can time out

- Status: engineering follow-up recommended
- Owner: fleet/backend
- Severity: medium; isolated to the nearest/tracked-vehicle widget

Observed error:

`canceling statement due to statement timeout` for query key `['dashboard-tracked-vehicles', 'all']`.

The current path reads up to 1,000 `vehicle_positions` rows for visible vehicle IDs and sorts by `occurred_at`, while RLS performs correlated vehicle visibility checks. This is separate from the demo-count query but uses the same hot table.

Recommended decision:

- If `vehicles.last_lat`, `last_lon`, and `last_position_at` are authoritative after Raven ingestion, use those cached fields.
- Otherwise, add a reviewed latest-position RPC/view using `DISTINCT ON (vehicle_id)` and the existing `(vehicle_id, occurred_at DESC)` index, then verify the RLS path with `EXPLAIN (ANALYZE, BUFFERS)` in a safe environment.

Verification: the Dashboard widget loads consistently for all-location and single-location scopes without fetching unnecessary position history.

### 4. Repository-wide lint debt

- Status: non-blocking CI debt
- Owner: frontend/platform

The advisory lint job on PR #60 reported 131 errors and 534 warnings in pre-existing untouched files, primarily formatting and Fast Refresh warnings. Required typecheck/tests, secret scan, and high-severity audit checks passed; files changed by PR #60 had zero lint errors.

Recommended fix: make a dedicated formatting/lint PR so functional changes do not absorb a repository-wide mechanical rewrite. Re-run the full test/build suite and keep generated `src/routeTree.gen.ts` changes out unless route generation genuinely changed.

### 5. Calls direct in-app dialing — telephony provider not connected

- Status: blocked on production integration configuration
- Owner: company telephony administrator and engineering
- Severity: isolated feature blocker; other sales workflows remain available

Production `/calls` reports that no dialer provider is connected. Calls can only open on the user's phone and must be self-reported, so direct in-app dialing is not complete.

Required action:

1. Have the company telephony administrator and engineering connect and configure CallRail through **Admin > Integrations**.
2. Use only company-approved configuration; do not place credentials, tokens, or provider secrets in this document.

Verification:

- A representative can place a call directly from the application.
- The call recording and call log are captured as configured.
- The call outcome is attributed to the correct representative, contact, and account.
- `/calls` no longer reports that no dialer provider is connected.

Recovery: disconnect the provider and revoke its configuration through the approved integration-management path.

### 6. Email Marketing integration — provider not connected

- Status: blocked on production integration configuration
- Owner: company email-marketing administrator and engineering
- Severity: isolated feature blocker; other Director dashboard data remains available

Production `/sales-director` reports that campaign attribution is missing because an Email Marketing integration is not connected.

Required action:

1. Select and configure a supported provider through the approved integration path.
2. Map campaigns and attribution into the Director dashboard data model.
3. Keep provider credentials and secrets out of this document.

Verification:

- The Director dashboard displays campaign attribution from the connected provider.
- Campaign results map to the expected sales records.
- `/sales-director` no longer displays the missing-attribution warning.

Recovery: disconnect the provider through the approved integration-management path.

## Access and operational constraints

- The directly authenticated Supabase account did not have access to application project ref `ortpawtuqerkmuykwndp`. Never substitute a personal Supabase project. The authenticated Lovable project database connection is the approved fallback transport when explicitly authorized.
- Local database replay was unavailable because Docker returned HTTP 500 and no standalone PostgreSQL/`psql` runtime was installed. Restore local database tooling before depending on migration replay in CI-like local verification.
- GitHub `main` syncs into Lovable, but Lovable production updates require an explicit Publish/Update action. Treat production publishing as a high-authority action and obtain approval immediately before it.

## Intentional QA records from the 2026-09-08 acceptance run

These records contain no credentials. Keep them until a senior decides whether the seeded QA account should retain the acceptance evidence.

- Annual goal `d768ca04-b217-4208-a5d4-53b9cfb8cb1c` and its 12 monthly children remain active for the seeded Skokie sales representative. The reason is `E2E 2026: build an emergency fund`.
- Calendar event `f5621584-b1d8-42ed-8ff4-b65fad162d9c` remains linked to `Skokie Facilities 2`; subject: `E2E stage progression meeting`.
- Test lead account `ff4a33b8-299a-45d1-92fe-3269f39f2b6d` was archived after the concurrent-claim test.
- The stage move on `Skokie Facilities 2` was undone; its final verified stage was `Active Outreach`.

Retiring goals, cancelling/removing the event, or deleting records changes production data. Capture the exact targets and obtain approval immediately before cleanup.

## How to add another blocker

For each new blocker, record:

- Status, owner, and severity.
- The exact environment and user-visible symptom.
- Evidence such as an error code, query key, migration version, or pull request.
- The smallest required action and who has authority to perform it.
- A concrete verification checklist.
- Recovery or rollback instructions.
- Whether it blocks a release or is an isolated follow-up.
