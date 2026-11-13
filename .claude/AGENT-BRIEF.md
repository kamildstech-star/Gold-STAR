# Standing brief — Goldstar / Recovery Hub

Read this instead of exploring the repo. It is kept current; if something here
is wrong, fix it in the same PR and say so.

## What this is

A disaster-restoration CRM for Gold Star Restoration. The client is **Mark**;
his words are quoted verbatim in code comments because they are the spec. QC is
done by **Daffa**, who verifies each PR independently — hence one change per PR.

## Stack

- TanStack Start, React 19, TanStack Router (file-based routes in `src/routes/`)
- Tailwind 4, shadcn/ui (`src/components/ui/`)
- Supabase (Postgres + Auth + Storage) on Lovable Cloud, client at
  `src/integrations/supabase/client`
- Vite 8, Vitest, `@dnd-kit` (pipeline drag and drop), `pdf-lib`
- Data fetching is TanStack Query (`useQuery` / `useMutation`)
- Toasts are `sonner`; database errors go through `toastDbError` from
  `@/lib/db-errors`, which turns a Postgres error into something a rep can read.

## Layout you need to know

- `src/components/app-shell.tsx` — the shell. The real scrollport is
  `<main className="min-h-0 flex-1 overflow-auto ...">`; the app header sits
  OUTSIDE it in a `shrink-0` wrapper, so `sticky top-0` inside the scrollport
  needs no offset.
- `src/components/pipeline-board.tsx` — the kanban board: `Column`,
  `BoardCard`, `ActiveClientsTile`, `isRotting`, view modes.
- `src/routes/_authenticated/pipeline.index.tsx` — the pipeline page: stat
  strip, "Needs you today", filters, view switcher.
- `src/lib/pipeline-rules.ts` — the outreach/ghost rule engine and the RPC
  wrappers (`activateClient`, `applyOnboarding`, `markNoService`, …).
- `src/lib/onboarding-questions.ts` — the category question catalogue.
- `src/lib/card-density.ts` — per-user view preference, and the pattern for
  any new one: table `user_view_prefs` (user_id, scope, view_mode).
- `src/lib/action-catalogue.ts` — every countable action in the CRM, keyed;
  `scorecard_weights.component` values are catalogue keys. Per-rep actuals
  come from the standings row or `scorecard_action_counts` (SQL allowlist in
  migration `20260916140000`); a new action needs an entry AND a `WHEN`.
  Edited at `/admin/scorecard`. The picker (smart search, grouped by area) is
  `src/components/action-picker.tsx`, shared by the scorecard admin and the
  leaderboard's weekly challenge — do not build another one.
- `src/lib/leaderboard-challenge.ts` — the weekly challenge scored on any
  catalogue key over its own window; unit (count / $ / % / minutes) and
  direction (lower is better) decide how the target reads and who wins.
- `src/lib/tradeshow-period.ts` — the tradeshows page's period (all time /
  year / quarter / custom, in the URL as `period`, `from`, `to`). A show
  belongs to a period by `starts_on`; `periodTotals` is the KPI strip's
  arithmetic, so "per account" divides by the period's own accounts. Custom
  ranges use the shared `DateRangeDialog` and the leaderboard's `customWindow`.
- `src/lib/badge-payload.ts` — `parseBadgePayload(raw)`: the ONE parser for
  any scanned code (vCard 2.1/3.0/4.0, MECARD, url, opaque), used by the
  badge scanner and the business-card QR alike. Do not write another.
- `src/lib/route-optimize.ts` — the Routes planner's Best order: Directions
  request from start/end/stops, Google's `waypoint_order` applied, the per-leg
  traffic pass, the cache key, the Maps URL. `route-planner-prefs.ts` keeps a
  rep's start/end/auto in `user_view_prefs` (scope `route_planner_endpoints`);
  `planned-routes.ts` is the saved-route history (`planned_routes`, hidden
  until migrated). UI: `src/components/routes/route-builder.tsx` and
  `past-routes.tsx`, rendered by `PlanRoutePanel` in `visit-planner.tsx`.
- `src/lib/business-card-reader.ts` — `readCard(photo, { qrRaw })`: a card
  photo in, `{ source, fields, raw, confidence, uncertain, pending }` out.
  QR is decoded on the device (`business-card-photo.ts`: native
  `BarcodeDetector`, else `jsqr`) and parsed by `badge-payload.ts`; printed
  text goes to the gateway vision model via `business-card.functions.ts`
  (auth + `RATE_LIMITS.businessCardRead`). `business-card.ts` is the pure
  validator/normaliser and the QR-over-OCR merge — test there.
- Paper field ticket reader (`field-ticket-read.ts` → `field-ticket-extract.functions.ts`,
  panel `field-work-ticket-panel.tsx`): picking the photo in "Upload paper"
  starts the read; a good read opens the ordinary ticket form for the crew to
  confirm. Every failure has a reason in `field-ticket-read-failure.ts`,
  shown to the crew with a code (`FT-LIMIT`, `FT-KEY`, …) and written to
  `assistant_audit` (feature `field_ticket_read`, `retrieved.reason`) —
  server refusals by the handler, browser-side ones by
  `reportFieldTicketReadFailure`. A new failure path needs a reason and an
  audit row; never a bare "couldn't read".
- **T&M daily sheets** (Mark, 7 Oct: "for a T&M job, there is a sign in sheet,
  rate codes and the three pages that are used for each day"). The job's Field
  Form tab asks `fieldFormsFor(job_type)` (`src/lib/field-forms-visibility.ts`):
  `t_m` gets `TmFieldFormsPanel` (Crew sign-in sheet, Daily crew chief report,
  Daily supply list) and the field work ticket only as read-only history
  (`readOnly`, hidden when there are none); every other type — insurance, cash,
  undetermined, reconstruction, null — keeps the ticket as before. Storage is
  `job_tm_forms` (migration 20261007231000, hidden until applied): one row per
  (job, kind, day), jsonb payload; writes are `writeTmForm` upserting on that
  key (queue kind `tm_field_form`), and a sign-in sheet MERGES rows by row id
  (`mergeSignIn`) so two phones' signatures both land. PDFs (`tm-forms-pdf.ts`)
  are Gold Star's ORIGINAL sheets from `public/forms/tm/` with the entries
  written on at coordinates measured from those files (`tm-forms-layout.ts`);
  "Blank PDF" is the same sheet with AcroForm boxes. Filled PDFs file as
  `job_report` documents. Rate codes: `src/lib/tm-rate-codes.ts` (the Daily
  Supply List compiled in; table `tm_rate_codes`, migration 20261007230000,
  edited at Settings › Operations › T&M rate codes, PR #342) — no prices, T&M
  Pro holds the rates.
- **Proposals on a pipeline card** (Mark: "Is there a way to make something in
  the pipeline a proposal?"). `account_proposals` + `account_proposal_lines`
  (migration 20261012200000, hidden until applied; read untyped through
  `src/lib/account-proposals.ts`). Opened from the card's "Proposal" button on
  /pipeline and the Proposals section on both account layouts
  (`src/components/account-proposals/`; the dialog is `React.lazy` because it
  imports server functions the record's render tests mock away). Lifecycle
  draft → sent → signed | declined | expired is a guard trigger; line totals
  are a generated column; the total is recomputed from the lines. Sending for
  signature is the Documents panel's path (a `documents` row, then
  `createSendPacket`, `/sign/$token`) — no vendor. The card moves in the
  database (`tg_account_proposal_advance`): sent → the pipeline's
  `proposal_sent` stage, signed → `pipeline_activate_client`, never backwards;
  a signed document marks its proposal signed (`trg_account_proposal_document_status`).
  "Proposals sent" in `sales_rep_metrics` counts quotes plus proposals sent.
- `src/lib/tradeshow-card-read.ts` — what the capture screen does with a
  read, kept pure: `startCardRead` (fire-and-forget; Save never waits), the
  four thumbnail states, and the field precedence typed > badge > card
  (`applyBadgeFields` / `applyCardRead` / `takeBackFields`). A read that
  lands after Save is written onto the lead by `applyLateCardRead` in
  `tradeshow-capture.ts`; the review queue's "Read card" reruns it.
- `src/components/deal-timeline.tsx` — the account Timeline card, on the full
  record, the prospect layout and the account drawer. Rows are live:
  `src/lib/timeline-edit.ts` is the per-type edit policy (mirrors the row
  policies, clause by clause) and the writes; `timeline-entry-actions.tsx` is
  the hover action row, the pickers, the editor and the delete confirm. The
  card's "+ Add" hands a composer tab to its host (`onAdd`) — it never owns a
  composer. Completing a task anywhere is `src/lib/task-complete.ts`
  `completeTask` (Needs-you-today, /tasks and the Timeline all call it).
- `src/lib/todo.ts` — a rep's own to-do list (`todo_items`, migration
  20260918120000, hidden until applied): PINS of job tasks (any task, anyone's;
  ticking one is `completeTask`) and QUICK items (notes to self, optionally on
  a job; "Make this a task" is the `promote_todo_item` RPC, one transaction).
  Owner-only RLS. `use-todo.ts` is the React side; `useTodoPin(taskId)` is the
  ONE toggle, rendered as `TodoPinButton` / `TodoPinMenuItem` from
  `src/components/todo/todo-pin.tsx` on the job Tasks tab, the Timeline ⋯
  menu, Needs-you-today, /tasks and the list. Writes are offline-queue kind
  `todo` (`todo-writes.ts`). Page /todo, dashboard card `my_todo`.
- `src/lib/estimate-sheet.ts` + `src/components/estimate-sheet.tsx` — the
  estimate editor's Sheet view: the catalogue laid out like the Job
  Calculator, one quantity box per rate, writing the same `estimate_lines`
  the table writes. The table view in `estimate-editor.tsx` is untouched and
  its tests must stay so; the calculator (`job_calculations`) is a separate
  system and stays separate.

- `src/lib/company-family-tree.ts` + `src/components/company-family-tree.tsx`
  — the Tree view on the account's Company hierarchy card (List · Tree
  switch): parent company → child companies (`accounts.parent_account_id`) →
  key people (top of each reporting line, via `buildOrgTree`). Org chart on
  desktop, indented list under 768px. Reads through RLS only; also the one
  place the parent company is set.
- `src/lib/label-language.ts` + `src/components/bilingual.tsx` — the ONE
  mechanism for bilingual field labels: `useLabelLanguage().bi(en, es)` for
  inline text, `<Es>` for a stacked Spanish line. Per user in
  `user_view_prefs` (scope `field_label_language`); no row = role default
  (crew/field bilingual, everyone else English). Switch in the user menu. A
  new bilingual label must go through these — `bilingual.wiring.test.ts` fails
  a hard-coded "English · Español" string on the field screens.
- Drying log, Heshy's S500 checklist (2026-09-28): `water-class.ts` (class
  1–4 beside `water-category.ts`), `dehu-performance.ts` (inlet − outlet GPP =
  grain depression, verdict pulling/ineffective/check; points `dehu_inlet` /
  `dehu_outlet` are `entry: false` — never on the daily cards, only in
  `drying-dehu-readings.tsx`), `drying-materials.ts` + `-data.ts` (fixed test
  points, `job_moisture_points` / `job_moisture_readings`, dry standard with
  `dryGoal`), `equipment-hours.ts` (placement `hour_meter_start/_end`, asked in
  the scan sessions via `HourMeterField`). `drying-summary.tsx` is the five-line
  audit answer at the top of the Drying tab. Queue kinds `moisture_point`,
  `moisture_reading`, `equipment_hours`.
- Drying report PDF (`drying-report.ts` data, `drying-report-pdf.ts` drawing,
  `pdf-charts.ts` vector line/bar charts on pdf-lib, button
  `drying-report-button.tsx` on the Drying log tab): MoistureMapper's layout.
  Its tables ARE `dryingLogWorkbook`'s sheets and its charts come from the same
  `buildDryingLog` window — change what the log says there, not here. Missing
  days are `null`, never 0. Room schematic = rooms to recorded size, not a plan.
- Job checklists (`src/lib/automatic-job-tasks.ts`): Mark's per-job-type task
  lists (Water · Extraction / Remediation, Monitoring, Pick up equipment, Mold,
  Fire), seeded by cadence key (`tasks_cadence_uniq`) so reconciling is always
  safe. Keyed off `jobs.loss_type` (service category), not `job_type`. Placing
  equipment seeds Monitoring/Pickup via `scheduleAutomaticTaskSync`, called by
  `placeUnit` and the offline queue — do not add another seeding path. The
  LINES are data since 6 Oct (migration `20261006174500`, hidden until
  applied): `job_task_templates` (group_key + task_key = the cadence key's
  tail, never renamed; edit `title`, switch off with `active`, no delete),
  `job_task_seeding_settings` (Monitoring/Pick up on Mold / Fire, default on;
  Water has no switch). `loadTaskCatalog` reads them and falls back to the
  compiled lists ONLY on a missing table. `job_task_seed_keys` remembers every
  automatic key ever seeded (trigger on tasks), so a deleted task is never
  re-seeded. The retroactive pass is the SQL function
  `sync_job_automatic_tasks(_dry_run DEFAULT true, _only_seeded_groups)`,
  open jobs only; its rules mirror `buildAutomaticTaskSyncPlan` and
  `automatic-job-task-templates.test.ts` holds the two together. Edited at
  Settings › Operations › Job checklists (`/admin/job-checklists`,
  `job-task-templates-admin.tsx` over `src/lib/job-task-templates.ts`, built
  from the Supply catalog's parts); a rename / new line runs the narrow pass
  (`_only_seeded_groups => true`), and the Tasks tab lists each checklist in
  the set order via `sortTasksByChecklist`. There is
  ONE drying reset: `DryingClockCard` → `drying-reset.ts`, which restarts the
  clock AND pushes open placements' `expected_retrieval_date` (what every
  overdue-equipment alert reads).
- Fleet paperwork and maintenance: `vehicle-maintenance.ts` (due kinds incl.
  `dot_inspection`, `dueStatus` — mirrors `run_vehicle_due_alerts()` stage for
  stage), `vehicle-compliance.ts` (paperwork banded in vendor compliance's
  words: satisfied / expiring_soon / expired / missing; the Fleet tiles, the
  `?due=` filter, the lapsed banner, next-service arithmetic), and
  `vehicle-documents.ts` (bucket `vehicle-documents`, superseding like
  compliance files). UI: `src/components/vehicle-maintenance-panel.tsx`. Alerts
  are the pg_cron SQL job `vehicle-due-alerts` — no HTTP hook, no CRON_SECRET.
  Never default a clock in these modules; pass `now`.
- Drying log export (`src/lib/drying-log-export.ts`): the ONE way readings
  leave the app — an .xlsx (Summary / Readings / Gaps) from "Download log" on
  the Drying tab, through `ExportExcelButton` (export gate + `log_export`).
  Every modelled outside row carries `OUTSIDE_MODELLED_NOTE` verbatim, every
  `DryingLog.gaps` day is a row on both sheets, no reading is capped away, and
  crew notes are never exported. The job report has no drying section on
  purpose: it is a model-written narrative, and a drying log must not be
  paraphrased.
- **Outside baseline sources** (2026-10-07; Mark: "keep what we are using; if
  it won't work, change to anything that's free that will work"): Open-Meteo
  first everywhere (`outside-conditions.ts`; the browser path is ONLY
  Open-Meteo). The nightly hook falls back per job to the National Weather
  Service's nearest station when Open-Meteo refuses the server (429/5xx/no
  answer): `outside-conditions-nws.server.ts` (points → stations → the report
  nearest 09:00 local, ±2 h, nulls skipped) and
  `outside-conditions-nightly.server.ts` (per-job choice; summary + status:
  200 only when every job got a baseline). Provenance is `source_detail`
  (`open-meteo 09:00 local` vs `nws KEWR 08:51 local · 3.8 mi · …`); every
  surface prints `outsideReadingNote(row)` / `outsideReadingNotes(rows)`, never
  OUTSIDE_MODELLED_NOTE bare for a row — a station figure is "measured at a
  station N miles away", not "modelled".
- **Public incident pages** (fire feed source kind `public_page`; Mark: "I
  don't want to pay API fees"): county 911 / fire department live-call pages.
  `src/lib/fire-feed/public-page.ts` (presets html_table / json / rss, column
  guessing, page times in the page's zone), `polite-fetch.ts` (THE rules:
  `checkPublicUrl`, robots.txt per RFC 9309 incl. Crawl-delay, ≥2 min per URL,
  conditional GET, same-site redirects only, login/CAPTCHA pages refused —
  any new fetcher of admin-typed pages goes through it),
  `sources/public_page.source.ts`, admin panel
  `src/components/fire-feed/public-pages.panel.tsx` with "Test this page"
  (`public-page.functions.ts`, `RATE_LIMITS.publicPageTest`). Hosts that are
  not .gov / .mil / *.xx.us need the admin's government confirmation
  (`government_ack`). No county URLs are seeded.
- Settings navigation (`src/lib/admin-settings.ts`): the rail, hub cards and
  breadcrumb group by SECTION (Operations / Sales / System) from the one
  mapping `SETTINGS_SECTION_LAYOUT`; a new settings page needs a registry entry
  AND a slot there. `area` on a page is now search metadata only.
- Who reported a chase incident: `src/lib/incident-sources.ts` (reads
  `incidents.source_links` and `needs_review` / `review_reason` defensively —
  links are http(s) only) and `src/components/chase/incident-sources.tsx`,
  rendered on the new-alert and accepted cards in `chase.index.tsx`. The
  Integrations screen's "Fire feed — replaces BNN" card (`fire_feed` in
  `integration-catalog.ts`, signal `fireFeed` from `fire_feed_runs`) sits above
  the BNN card, which stays live until Mark retires it.
- Job ledger: `useJobLedger` (in `job-ledger-panel.tsx`) is the one read of the
  ledger; the Billing tab's pinned `JobLedgerStrip` IS the ledger (the old
  rail card listing the same rows was removed, Mark 2026-10-07), and the
  rail's Commissions card (below) feeds its Referral and Commission cells.
  Strip cells are typeable (Mark: "can we make each box editable"):
  `LEDGER_CELL_SOURCES` in `job-ledger.ts` is THE cell→source map (entry /
  override / elsewhere / total). Typed figures live in `job_ledger_overrides`
  (migration 20261007224500, hidden until applied; trail
  `job_ledger_override_changes`) and are ledger-only — never written back to
  invoices, payments, placements or tickets. Totals are the shared
  running-cost total / `jobProfit` moved by each typed cell's difference
  (`ledgerRowsWithOverrides`) — never re-added. Cells: `job-ledger-cell.tsx`.
  The job Billing tab is Estimates | Invoices (container query) with Payments
  beneath; the rail's estimates slot is gone.
- **Commissions** (Mark, 7 Oct: "a card called commissions ... or a flat fee,
  and running cost needs to add that into its calculation as well", then
  "separate salesman and referrers"). THE calculation is
  `src/lib/job-commission.ts`: lines with `payee_kind` `referrer` (the General
  tab's `referred_by_account_id` / `_contact_id`; deal = this job's override
  `commission_flat_amount` / `commission_rate_pct` → the person's rule → the
  company's rule (`referral_commission_rules`, 20261007224100, Settings ›
  Commissions) → the "Came from" `commission_rates` %) or `salesman` (the rep
  engine's `commission_payouts`, never recomputed). Base = job_running_cost
  revenue (calculated, never a typed ledger Billed). SQL twin
  `job_referrer_commission` (20261007224300); one case list
  `supabase/tests/fixtures/referrer-commission-cases.json` runs through both.
  `useJobCommission` (`src/lib/use-job-commission.ts`) is the one read: the
  card `job-commissions-card.tsx` and the strip's Referral (referrer + typed
  `job_referral_costs`) / Commission (salesmen) cells. job_running_cost counts
  commission in `total_cost` (`commission_cost`), so nothing downstream
  subtracts it again (`jobProfit` only does on a database without
  20261007224300). "+ New referrer" on General: `new-referrer-dialog.tsx` over
  `new-referrer.ts`. Report #19 has switches (`ReportDef.options`, URL `opt`,
  `report-options.ts`): All / Salesmen / Referrers, By payee / Lines.
- **Recording a payment** is ONE dialog, `src/components/add-payment-dialog.tsx`
  over `src/lib/add-payment.ts` (Mark, 7 Oct, JobNimbus's Add Payment): tick
  the invoices, an amount per invoice, Applied/Credit. The Payments card opens
  it unticked; every Record payment button (invoice row, payment history,
  choosing Paid) opens it ticked. The save is `recordInvoicePayments` — ONE
  insert of every row (all or none; never loop it), proved in
  `supabase/tests/add-payment-split.pglite.mjs`. There is no customer-credit
  ledger, so Credit must be $0. `PAYMENT_METHODS` lives there too (method is
  free text). A split's rows share `created_at` + `created_by`
  (`splitSiblings`).
- Client portal (`src/lib/portal.ts`, `portal.functions.ts`,
  `src/routes/portal*.tsx`, `src/components/portal/`, staff side
  `src/components/job-portal-panel.tsx` = the job's Customer portal tab).
  Customers are the Postgres role `portal_customer` (auth.users.role), with
  NO table privileges and EXECUTE only on the five `portal_*` read functions
  (migrations 20260928130000/131000). **A new table or function needs no
  portal work — it is closed to customers by default — but never grant
  anything to PUBLIC or to portal_customer**, and give any new RLS table the
  `portal_customer_denied` restrictive policy (see the live audit,
  `supabase/tests/client-portal-live-audit.sql`). The security tests are
  `supabase/tests/client-portal-security.pglite.mjs`.

- Job photo upload queue (`src/lib/photos.ts`, server half
  `photos.functions.ts`, tests `photos.queue.test.ts`): IndexedDB queue →
  `createPhotoUploadUrls` (three signed upload URLs) → PUT → `finalizePhoto`
  (row upsert). Signed upload URLs are minted WITHOUT upsert, and an `x-upsert`
  header on the PUT does nothing, so a key that already exists is refused with
  "The resource already exists". That answer means "stored": the server returns
  `alreadyStored` per object and the queue skips it. Detect it with
  `isStorageAlreadyExists` (`src/lib/storage-already-exists.ts`) — status,
  body `statusCode`, code, then message — not a string match alone. Any new
  uploader that retries onto a deterministic path needs the same treatment or
  `upsert: true`.

- Purchase receipts (`src/lib/supply-receipts.ts`, `src/components/supply-receipt-panel.tsx`,
  page `/receipts`): one upload (`useReceiptUpload`) behind every doorway —
  /receipts (crew phone bar, job header "Upload receipt" with `?job=`), the
  Supplies Spending card, an order's "Attach receipt". States uploaded /
  unreadable → approved | rejected (migration 20261005173000). The ONLY path
  into `supply_purchases` from a receipt is the `approve_supply_receipt` RPC:
  it refuses the uploader and anyone who could not already write
  supply_purchases; receipts have no direct UPDATE; purchase rows with a
  `receipt_id` cannot be written directly (restrictive policy). Proved in
  `supabase/tests/supply-receipt-approval.pglite.mjs`. Separate from the
  expense queue (`/expenses/approvals`), which links to it.
- Field capture on the Rooms tab (Mark, 6 Oct 2026: "yes build field capture into the
  rooms tab"): `room-takeoff.ts` is THE floor-area formula and the takeoff rules (pairs are 2
  slabs; cased openings/windows not doors; 8 ft walls when unmeasured), `tape-measure.ts` parses
  `12'6"`/`12-6`/`12.5`/`2'8"`. Tables `job_room_openings`, `job_room_cabinets` + `job_rooms.flooring`,
  `extra_sf` (migration 20261006140000, hidden until applied), RLS = job_rooms' exactly. Every
  write is queue kind `room_capture` (`room-capture.ts` raw writes, `room-capture-ops.ts` ops +
  held overlay, `use-room-capture.ts` hook). UI: `room-capture-panel.tsx`, `tape-measure-field.tsx`,
  `room-takeoff-summary.tsx`. No separate jobs/units/bucket — units are `job_rooms.unit`.
  Adding a room is ONE path, `addJobRoom` in `src/lib/job-room-add.ts` (row, `["job-rooms", jobId]`
  refresh, photo folder via `followRoomFolders`): the Rooms tab's add row and the drying log's
  "+ Add room" (`drying-room-select.tsx`, shown on `useCanManageJob`) both call it. It is a plain
  insert, not queued — same as it always was on the Rooms tab.
- **Outlook calendar push** (`calendar-push.server.ts`): the database decides.
  `pushCalendarRow` asks `calendar_push_authorized_event` (service role;
  20260908012000, replaced by 20261007140000) and pushes only the fresh
  row it returns, through the mailbox it names; `resolveMailboxForEvent` is a
  second opinion that must agree. A refusal is `blocked` with the database's
  reason, never a silent skip. The function wants `push_identity_verified`
  and `push_actor_id`: client writes get both from the trigger
  `z_guard_calendar_push_identity` (never send them from the browser, and send
  `provider: null` on a CRM insert); a SERVER path that writes
  `provider/external_id/mailbox_id` must set `push_identity_verified: true`
  itself, and `push_actor_id` from the session when it acts for someone
  (`ingestEvents`, `createGraphMeeting`, the worker's create are the precedents).
  Proof: `supabase/tests/calendar-push-verified.pglite.mjs`.
- Microsoft 365 **delegated** access (IT's ask; Option A of
  `docs/OUTLOOK-ACCESS-PROPOSAL.md`): `microsoft-oauth.ts` (pure — redirect
  allowlist, scopes, signed `state`, PKCE/nonce derived from the browser
  binding cookie, id_token tenant checks), `microsoft-delegated.server.ts`
  (connect, refresh with rotation, `needs_reconnect`, disconnect;
  `getDelegatedAccessToken(userId)` is THE way to act as a person). Routes
  `/api/auth/microsoft/start` (POST, Bearer) and `/callback` (the path IT
  registered — do not rename). Refresh tokens are AES-GCM sealed with the
  owner's id as associated data in `microsoft_connection_secrets`, which no
  client role can read (migration 20261007200000, proved in
  `supabase/tests/microsoft-connections.pglite.mjs`). The person's control is
  the Outlook card on /security. `OUTLOOK_AUTH_MODE=application` keeps the
  old app-only client-credentials path.
  **Outlook config comes from the Integrations screen too**: an admin can type
  OUTLOOK_* there (`integration_credentials`), so any server path that reads
  OUTLOOK_* first calls `await loadOutlookEnv()` (microsoft-delegated.server.ts;
  stored values win over deployment secrets). `graphConfigured()` and
  `outlookAuthMode()` are sync and see only what was loaded —
  `outlook-env.wiring.test.ts` holds the entry points to it. The reconciliation
  hook `/api/public/hooks/graph-sync` uses the shared CRON_SECRET
  (`denyUnlessCron`; GRAPH_SYNC_SECRET is retired) and is run by pg_cron job
  `graph-sync` via `graph_sync_kick()` every 15 min (20261011120000).
- **Email a person sends** (David's 11 Oct invoice sat in 'queued' with the
  screen saying sent): ONE seam, `deliverEmailMessage`
  (`email-delivery.server.ts`), called by sendEmail (delay 0), the
  email-release hook (held → released), its retry step and a person's Resend.
  Transport order is `resolveEmailTransport` (`email-transport.server.ts`):
  the SENDER's own Outlook (delegated token via `resolveSenderAuth`, after
  `assertCanSendAs` with the service-role client; office mailbox they own as
  fallback), then Resend (key from the Integrations screen counts —
  `loadOutlookEnv` loads every stored credential), else the row stays
  'queued' with `delivery_reason` (vocabulary + 14-day / 6-attempt / 10-min
  constants in `email-transport.ts`, pinned to migration 20261012100000, not
  applied at time of writing). Outlook sends store `provider='outlook'`,
  `provider_id` = our `<rh-{id}@domain>` Message-ID, `sent_from`; there is no
  delivered/opened for them and the delivery dialog says so. Attachments are
  links (`composeOutgoingHtml`) on every transport. Retry: hook →
  `retryQueuedEmails` → SQL `claim_retryable_queued_emails` (parked rows
  only — vendor drafts, automation and assistant rows are never picked up).
  UI: every Send reports through `announceEmailSend`
  (`src/components/email-send-toast.ts`); every list showing a held email
  shows an unsent one via `HeldEmailControls` ("Not sent yet — …", Resend /
  Cancel = `resendQueuedEmail` / `cancelQueuedEmail`). A new sender screen
  uses both; never write its own "sent"/"queued" toast.
- **Fire feed** (Mark: "a feed that crawls google and x for fires in certain
  areas … in place of bnn", then "I don't want to pay API fees"): free,
  sanctioned sources only — never scrape google.com or x.com. Code in
  `src/lib/fire-feed/`: a source is `sources/<kind>.source.ts` whose default
  export is a `FireSource` (`types.ts`), found by `registry.ts`'s
  `import.meta.glob` — a new source is one file plus the kind in the
  `fire_feed_sources.kind` CHECK. Pipeline: fetch → ledger skip
  (`fire_feed_items`, `ledgerKey`) → read (`extract.ts` rules;
  `extract-ai.ts` via `complete()` when configured, house number must appear
  in the text) → `decide.ts` triage / geocode (`geocodeOneCached`, ZIP from
  `postalCodeOf`) / area (`areas.ts`) / match (`dedupe.ts sameFire`, merges
  into `incidents.source_links`) → insert with `ingestIncident`
  (`src/lib/incident-ingest.server.ts`), THE insert the BNN webhook also uses
  (`incidentPayloadSchema` in `src/lib/incident-payload.ts`). `run.server.ts`
  does the I/O; `run.test.ts` drives it end to end on `fake-supabase.testkit.ts`.
  Tables, RLS, seed and `fire_feed_kick()` (pg_cron `fire-feed`, every 2 min,
  posts only when on + area active + source due): migration 20261011140000,
  hidden until applied. Master switch `app_settings.fire_feed.enabled`, OFF by
  default; "Run now" while off is a dry run. Screen: Settings › Sales › Fire
  feed (`src/components/fire-feed/fire-feed-admin.tsx`); extra panels for a
  source kind are `src/components/fire-feed/*.panel.tsx`, also globbed.
- **View As (role and person)** (`src/lib/impersonation.ts`, `src/lib/view-as.ts`,
  switcher `RolePreviewSwitcher` in `app-shell.tsx`, picker
  `view-as-person-picker.tsx`, banner `impersonation-banner.tsx`). Mark, 11
  Oct: "I also want to be able to view as specific people." A PREVIEW, never a
  sign-in: the session stays the admin's, `start_impersonation` /
  `end_impersonation` write `impersonation_audit` (already in the Activity
  log). The context's `userId` is ALWAYS the signed-in user — authorship
  (author_id, created_by, actor_id, a row's user_id) takes it. `viewerUserId`
  is whose "my …" view it is (the viewed person under View As): use it for
  read scopes only — `view-as.wiring.test.ts` fails an authorship key fed from
  it. `roles`, `memberships`, `primaryLocationId`, `regionMemberships`,
  `visibleLocations` are the effective (viewed) identity; `usePreviewOfficeScope()`
  narrows a list's "All" to the person's offices. While a person view is on,
  `writesDisabled` greys buttons and the MutationCache refuses to start any
  mutation without `meta: VIEW_AS_ALLOWED_META`. A person view ends with the
  auth session that started it (token `session_id`) and after 8 h.
  RPCs that answer for `auth.uid()` (my_commission_summary, notifications,
  chat, own-only RLS tables) cannot be previewed — say so, never show the
  admin's own figures as theirs.
- **Moving off Lovable** to GSR + Vercel (`docs/MOVING-OFF-LOVABLE.md`,
  `docs/MOVING-OFF-LOVABLE-VERCEL.md`; PRs #357 #359 #361 #362 #365 #366):
  every host coupling is a switch whose default is
  Lovable. The app's public address is ONLY read through `src/lib/app-origin.ts`
  (`serverAppOrigin()` / `browserAppOrigin()`; a test fails on any other
  `PUBLIC_SITE_URL` read or a link built from `window.location.origin`); the
  database's hook callers use `public.app_hook_url()` over `app_settings
  'app_base_url'`. AI goes through `src/lib/ai-provider.server.ts` (`chat()`,
  `AI_PROVIDER`, per-task models) — never fetch a model endpoint directly.
  Google sign-in: `src/lib/auth-provider.ts`; maps credentials:
  `src/lib/maps-auth.server.ts`. Never add a `wrangler.json/jsonc/toml` at
  the repo root: Nitro merges it into the config of every build, Lovable's
  included.
- **Security surface** (`src/lib/security/`): `public-surface.ts` is THE
  allowlist of everything reachable without a session (anon functions and
  public buckets: none; session-less server functions; every API route's
  credential). A new session-less server function, API route, anon grant,
  public bucket, or function without `REVOKE … FROM anon` fails CI. New
  webhooks use `src/lib/webhook-verify.ts`; new signed read links use
  `src/lib/signed-url.ts` (10 min default, longer needs `why`); external HTML
  goes through `sanitizeExternalHtml` in `src/lib/safe-html.ts`; headers are
  `src/lib/security-response.ts`. The build fails on a secret in the client
  bundle (`bundle-secret-plugin.ts`). The caller's IP (rate limits, signing
  evidence) is ONLY `clientIp` from `src/lib/client-ip.server.ts`, which trusts
  the headers the host writes (Vercel vs Cloudflare) — never read
  `cf-connecting-ip` / `x-forwarded-for` directly; a test fails if you do.
- **Delete and edit history, Restore on the job Timeline** (migration
  `20261006150000_record_history.sql`, hidden until applied;
  `src/lib/record-history.ts`, `src/components/record-history-restore.tsx`).
  Mark: "in timeline have a restore button for each item that gets removed or
  changed". THE CONVENTION for anything job-scoped that can be deleted or
  edited:
  - **Hard delete stays a hard `DELETE`.** Do NOT add `deleted_at` / soft
    delete to a table to make it restorable — every read would have to learn
    to filter it. Instead the table gets the `"A_record_history"` trigger
    (`record_history_capture()`), which writes the full before-image into
    `public.record_history` on DELETE and the changed columns on UPDATE.
    No app-side logging is needed; the trigger catches every path (app,
    Lovable, SQL, offline replay). Existing soft deletes (`photos.deleted_at`)
    are left alone.
  - To cover a new table, ONE migration: add it to the `table_name` CHECK on
    `record_history`, to the CASEs in `record_history_capture()` (job id,
    summary, captured columns), `record_history_may_restore()` (the table's
    own DELETE/UPDATE policy, mirrored clause by clause — restore is
    SECURITY DEFINER because INSERT policies pin authorship and the
    before-image is not client-readable) and `record_history_display()`, to
    the allow-list arrays in `record_history_state()`,
    `record_history_reinsert()` and `restore_record_history()`, and to the
    live audit; then attach the trigger. Copy an existing table's branch;
    the pglite proof is `supabase/tests/record-history.pglite.mjs`. Restoring
    re-inserts the row with its own id, so a table whose rows are referenced
    by others needs those children captured too (see estimates → lines).
  - Restore is `restore_record_history(_history_id)`; the confirm reads
    `record_history_preview(_history_id)`. Never write to `record_history`
    from the app — `authenticated` has SELECT on its display columns only
    (never `old_row`/`new_row`, which can hold withheld columns such as
    `estimate_lines.unit_cost`), so `select("*")` on it fails by design.
  - Money is OUT: invoices, invoice lines, payments and money events are
    never captured or restored here (they have their own audit trails).
  - The job's OWN fields are not in `record_history`: they already have
    `job_field_changes` (trigger since 20260820184525). Revert there is
    `revert_job_field_change(_change_id)` (migration
    `20261006152000_job_field_revert.sql`, SECURITY INVOKER — jobs_update
    decides), one save = one entry, allow-list `job_revertable_fields()`
    mirrored by `JOB_REVERTABLE_FIELDS` in `src/lib/job-field-revert.ts`
    (money and system columns excluded; a test pins the two together). A new
    job column that should be revertable goes on both lists.
  - Quick Estimates (`job_calculations`, deletes only) joined in
    `20261006163000_estimate_delete.sql`, which copies #300's functions with
    marked additions; `src/lib/estimate-delete.test.ts` fails if the copy and
    20261006150000 drift, so a change to one of those functions means
    regenerating the copy too. Before offering a Delete, ask
    `record_history_covers(table)` (true only when the trigger is attached) —
    never offer a delete the Timeline cannot undo. The Billing tab's estimate
    Delete (`src/lib/estimate-delete.ts`) does; an invoiced estimate is
    refused by a BEFORE DELETE trigger.
  - The second set (`20261006200000_record_history_more_tables.sql`):
    photos (Restore clears `deleted_at`; a multi-photo removal is ONE entry
    with the rest as children; older removals backfilled), crew
    (`job_assignments`), `job_contact_methods`, `job_intake_answers`,
    `job_drying_readings` (weather rows skipped), `job_moisture_points` (its
    readings come back with it) and `job_moisture_readings`. `row_pk` is
    text now (photo ids are ULIDs). NOT covered yet, on purpose: job_rooms
    (waits for the Rooms PRs' openings/cabinets), documents, field work
    tickets, equipment placements — reasons in that file's header.
  - **Every redefinition of the shared record_history functions starts from
    the LATEST one** (not #300's) and keeps every table it lists — they are
    applied in version order, and a dropped name in the CHECK fails the
    user's DELETE. `src/lib/record-history-migrations.test.ts` walks the
    migrations and fails if any redefinition covers fewer tables than the
    one before. Two open PRs extending it: stack the later on the earlier.

## Testing — read this before writing a test

**There is no DOM testing library in this repo.** Do not add one.

- Pure logic → a normal unit test in `src/lib/*.test.ts`.
- Component wiring → read the source file with `readFileSync` and assert on it.
  Precedent: `src/lib/job-calculations.columns.test.ts`,
  `src/components/qty-takes-a-sum.test.ts`.

When asserting on source text, **extract the specific fragment with a regex and
assert on that**, never on the whole file. Asserting on the file means your own
explanatory comment can satisfy or break the assertion — this has caused three
separate false results. Example:

```ts
const classes = SOURCE.match(/"flex max-h-\[70svh\][^"]*"/);
expect(classes![0]).toContain("md:max-h-none");
```

**Normalise line endings before matching.** Git checks this repo out with CRLF
on Windows, and an agent worktree may hold LF, so a pattern that ends at a line
break passes where it was written and fails on `main`. This has happened. Read
the file as:

```ts
const SOURCE = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
```

Better still, write patterns that do not depend on a line break at all.

**Walking the source tree:** use `walkFiles(dir)` from `src/lib/source-files.ts`
— do not write another walker. It returns `src/…/file.ts` with forward
slashes on every OS. A hand-rolled `readdirSync` + `path.join` walker returns
`src\…` on Windows, so nothing matches a path-keyed allowlist and the audit
goes red (or, worse, silently checks nothing). This has happened.

## House style

- Comments explain **why**, not what, and quote Mark verbatim when the change
  came from him. They read like a person explaining a decision to the next
  engineer. No `// open the dialog` noise. Read the header comments in
  `src/components/no-service-dialog.tsx` and `src/lib/card-density.ts` and match
  that voice.
- American English in user-visible strings.
- Prettier decides formatting: `npx prettier --write <files>` before committing.

## Database

- **Do not apply migrations.** Write the `.sql` under `supabase/migrations/`
  and say so in the PR; applying is done from the main session.
- RLS is the real data boundary. `SECURITY DEFINER` functions bypass it, so any
  new one needs an explicit access check inside it.
- Data is scoped by office. A viewer without full access must not see contact
  details from another office.

## Verification gate — all three, before every push

```
npx tsc --noEmit      # no MORE errors than main has
npx vitest run        # all green
npm run build         # succeeds
```

CI also blocks on ESLint errors (Prettier included) in every `.ts`/`.tsx` file
the PR touches, and on ERROR-severity Semgrep findings the PR introduces, so
run `npx prettier --write <files>` and `npx eslint <files>` on what you
changed. A verified Semgrep false positive gets `// nosemgrep: <rule-id>` on
the line above, with a comment saying why. What runs when:
`docs/QUALITY-CONTROL.md`.

## Shipping

Branch off `main`, never commit to `main`. One change per PR.

- Commit message ends with: `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`
- PR body ends with: `🤖 Generated with [Claude Code](https://claude.com/claude-code)`
- The PR body quotes Mark's request, says what changed and why, and tells QC
  exactly what to click.
- Do not merge; leave the PR open.
