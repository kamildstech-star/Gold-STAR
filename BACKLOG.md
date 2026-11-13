# Backlog

Items in the order Mark raised them. Nothing leaves this file until it ships or
is explicitly dropped — a skipped item has to be visible.

---

### External-access security hardening (security review; branch `wt/security-external-hardening`)
`src/lib/security/*` (new: public-surface, migration-surface, bundle-secrets, bundle-secret-plugin + tests),
`src/lib/webhook-verify.ts` (new), `src/lib/signed-url.ts` (new), `src/lib/security-response.ts`,
`src/lib/safe-html.ts`, `src/lib/cron-auth.ts`, `src/lib/maps-key.functions.ts`, `src/lib/offboarding.functions.ts`,
`vite.config.ts`, 15 signed-URL call sites,
`supabase/migrations/20260929120000_anon_surface_sweep.sql` (WRITTEN, NOT APPLIED),
`supabase/migrations/20260929121000_account_takeover_guards.sql` (WRITTEN, NOT APPLIED),
`supabase/tests/anon-surface.pglite.mjs`, `supabase/tests/account-takeover.pglite.mjs`,
`supabase/tests/anon-surface-live-audit.sql` (new)

anon reaches no function, table or public bucket (and 0924's default-privilege
line, a no-op, is fixed); every server entry point refuses no-session callers
(maps key was public — fixed); unapproved signups read nothing on ANY RLS
table (the 09-08 guard covered 29); sessions end on deactivation and password
change; the build fails on a secret in the client bundle; CSP report-only +
enforced frame-ancestors/nosniff/HSTS/CORS lock; one external-HTML
sanitizer; signed URLs 10 min by default; one webhook seam.

STILL OPEN:
- **Both migrations unapplied**, run in order. Then run
  supabase/tests/anon-surface-live-audit.sql — every query should return 0 rows.
- **CSP hard flip**: set `CSP_ENFORCED = true` once inline scripts carry
  nonces (TanStack hydration + theme init are the only violations seen).
- Tables with no RLS at all (live audit §6) are listed, not changed.
- The eight pre-seam HMAC/secret hooks keep their own audited checks; moving
  them onto webhook-verify.ts (and adding replay windows) is follow-up.
- `GOOGLE_API_KEY` is still read as a fallback browser key: rename it to
  GOOGLE_MAPS_BROWSER_KEY and referrer-restrict it.
- The password-change trigger needs this role to create triggers on
  auth.users; if the apply NOTICE says it could not, sessions still end on
  deactivation and via the RPC.
- Dashboard settings (MFA, leaked-password protection, CAPTCHA, …) are in the
  PR under SETTINGS TASKS — HUMAN.

---

### Remaining M3 items: S500 drying log, job billing split, ledger strip, settings groups (branch `wt/m3-remaining`)

**1 — Drying log against Heshy's checklist (IICRC S500).**
`src/lib/water-class.ts` (new, + test), `src/lib/dehu-performance.ts` (new, + test),
`src/lib/drying-materials.ts` (new, + test), `src/lib/drying-materials-data.ts` (new),
`src/lib/drying-equipment.ts` (new, + test), `src/lib/equipment-hours.ts` (new, + test),
`src/lib/drying-log.ts`, `src/lib/equipment-scan.ts`, `src/lib/equipment-writes.ts`,
`src/lib/offline-queue.ts`, `src/components/job-drying-log.tsx`,
`src/components/drying-summary.tsx` (new), `src/components/drying-dehu-readings.tsx` (new),
`src/components/drying-material-points.tsx` (new), `src/components/hour-meter-field.tsx` (new),
`src/components/asset-tag-scanner.tsx`, `src/components/equipment-panel.tsx`,
`src/components/field-work-ticket-panel.tsx`, `src/components/drying-s500.wiring.test.ts` (new),
`supabase/migrations/20260928160000_drying_class_dehu_inlet_hour_meters.sql` (WRITTEN, NOT APPLIED),
`supabase/migrations/20260928161000_drying_material_moisture_points.sql` (WRITTEN, NOT APPLIED)

Water class 1–4 beside the category; per-dehumidifier inlet/outlet with grain
depression and a pulling / ineffective / check verdict (completes the
`dehu_outlet` point, still off Mark's daily cards, in its own drawer); fixed
material test points with a dry standard, read daily, "dry n/m" on each day
square; hour meters at set-up and pickup, hours run on the Equipment tab and
in the new Drying summary. Every write is offline-queued.

STILL OPEN:
- **Both migrations unapplied.** Until 160000: class, inlet readings and hour
  meters are held back and say so. Until 161000: the test-point drawer says
  "pending migration". Nothing a tech types today is refused either way.
- Thresholds are field conventions, one constant each, for Heshy to confirm:
  10 gr/lb grain depression = pulling (`PULLING_MIN_GRAINS`); dry = within 10%
  of the dry standard, never tighter than 1 point (`DRY_TOLERANCE_*`).
- Not built: meter-photo OCR (seam unchanged), per-point photos, an S500 PDF
  export of the log, dehumidifier sizing from the class (AHAM chart), alerts
  when a machine reads ineffective two days running.
- The manual "Place equipment" dialog (no scan) takes no start reading; it is
  entered on the placement row afterwards.

**2 — Job Billing tab: Estimates | Invoices, Payments beneath.**
`src/components/job-billing-panel.tsx`, `src/components/billing-rail.tsx`,
`src/components/estimates-rail-list.tsx`, `src/routes/_authenticated/jobs.$id.tsx`,
`src/components/estimates-in-the-rail.test.ts`, `src/components/one-new-estimate-button.test.ts`,
`src/lib/invoice-paid.test.ts`

David, 22 Sep: "estimates should be here on the left side, and invoices on the
right side... payments underneath it." **Supersedes Mark's 16 Sep rail
placement at the client's request**; still one estimates list and one Detailed
estimate button. Split by the money column's own width (container query), both
editors open full width under it, payments list beneath; recording a payment is
the unchanged per-invoice dialog.

STILL OPEN:
- Mark has not seen the job tab since his "just have the sidebar"; worth
  showing him it now matches /billing.

**3 — Job ledger summary strip.**
`src/lib/job-ledger.ts` (`ledgerEffortRows`, `ledgerStripCells`), `src/lib/job-ledger-strip.test.ts` (new),
`src/components/job-ledger-panel.tsx` (`useJobLedger`, `JobLedgerStrip`), `src/routes/_authenticated/jobs.$id.tsx`

David, 22 Sep: "three days, 18 guys, 500 hours, costing us XYZ." One line atop
the Billing tab: days · guys · hours · cost so far · billed · profit so far,
picked from the ledger's own rows through the hook the full card now uses.
Money cells only with `job.view_costs`; without it, the three effort figures.

STILL OPEN:
- "Days" is days a field ticket was filed (the ledger's definition), not
  calendar days since the first placement; a job logged only on the time
  clock shows a dash until a ticket exists, as the ledger always has.

**4 — Settings grouped: Operations / Sales / System.**
`src/lib/admin-settings.ts` (`SETTINGS_SECTIONS`, `SETTINGS_SECTION_LAYOUT`, `settingsSectionOf`),
`src/components/admin/settings-nav.tsx`, `src/components/admin/settings-frame.tsx`,
`src/lib/admin-settings.test.ts`, `src/components/admin/settings-frame.test.tsx`,
`src/lib/supply-catalog-doorways.test.ts`

David, 22 Sep: "operational stuff and then sales stuff." The rail, hub cards
and breadcrumb read one mapping of three arrays; no URL moved; search still
matches the old area names as well as the new section names.

STILL OPEN:
- **David's own list never arrived.** When it does, it is an edit to
  `SETTINGS_SECTION_LAYOUT` only (move/reorder paths); the test fails if a
  page is dropped or doubled.
- Judgment calls to confirm with him: Tags under Sales; Dropdown options and
  Intake questions under Operations; Follow-up and Escalation rules under
  System; People and pay with Users. Fleet, drying and trade shows have no
  settings screens to place.

### David's 24 Sep check-in: family tree, field-label language, client portal (branch `wt/m4-tree-language-portal`)
`src/lib/company-family-tree.ts` (new), `src/components/company-family-tree.tsx` (new),
`src/components/company-hierarchy-panel.tsx`, `src/lib/label-language.ts` (new),
`src/components/bilingual.tsx` (new), `src/components/app-shell.tsx`,
`src/components/field-work-ticket-panel.tsx`, `src/components/equipment-panel.tsx`,
`src/components/drying-clock-card.tsx`, `src/components/asset-tag-scanner.tsx`,
`supabase/migrations/20260928130000_client_portal_foundation.sql` (WRITTEN, NOT APPLIED),
`supabase/migrations/20260928131000_client_portal_read_functions.sql` (WRITTEN, NOT APPLIED),
`src/lib/portal.ts` (new), `src/lib/portal.functions.ts` (new), `src/routes/portal*.tsx` (new routes),
`src/components/portal/portal-shell.tsx` (new), `src/components/job-portal-panel.tsx` (new),
`src/routes/_authenticated/route.tsx`, `src/routes/_authenticated/jobs.$id.tsx`,
`src/integrations/supabase/validate-session.ts`,
`supabase/tests/client-portal-security.pglite.mjs` (new), `supabase/tests/client-portal-live-audit.sql` (new)

**Family tree**: "it's not going to show like a tree, like an organizational
chart, right?" — List · Tree on the hierarchy card; parent → child companies →
key people, expand/collapse, click-through; indented list on a phone; a
"Parent company" setter because nothing set the column before. **Field
labels**: "I don't know if I like all the Spanish" — per-user English only /
English + Español, crew and field default bilingual, everyone else English.
**Client portal slice 1**: "they should only have access to whatever is shared
to them on a job-by-job basis" — invitation-only customers as their own
Postgres role, job-by-job read-only sharing of chosen documents, photo
albums/folders and sent invoices, 5-minute signed file links, 129-assertion
database regression fixture.

STILL OPEN:
- Portal: no payments, messaging, customer uploads or notifications (slice 1
  scope). Invitations are copied/mailed by staff by hand — no email is sent.
- Portal: invite from the account page is supported by `portal_invite`
  (`_account_id`) but has no UI yet; slice 1 invites from the job.
- Portal: no self-serve password reset; staff send a new invitation, which
  resets it.
- Portal: depends on the auth server putting `role` on the JWT from
  auth.users.role (standard Supabase). The accept flow refuses and deletes a
  sign-in that comes back without it, so the failure mode is "portal
  unavailable", never "customer with a staff-shaped session" — but it must be
  checked once on Lovable Cloud after the migrations are applied.
- Field labels: the supply request form has no Spanish today, so nothing there
  to switch; the translated work order card is content, not labels, and is
  untouched.
- Tree: parent-company loops are refused in the picker and drawn safely, but
  not blocked by a database constraint.

---

### David's 24 Sep check-in: platform and field (branch `wt/m4-platform-field`)
`src/lib/use-condense-on-scroll.ts` (new), `src/components/app-shell.tsx`, `src/styles.css`,
`src/components/supply-order-form.tsx`, `src/lib/supply-delivery-address.ts`,
`supabase/migrations/20260928120000_location_membership_edit_in_place.sql` (WRITTEN, NOT APPLIED),
`src/components/user-editor.tsx`,
`supabase/migrations/20260928121000_email_status_held_cancelled.sql` (WRITTEN, NOT APPLIED),
`supabase/migrations/20260928122000_email_send_delay.sql` (WRITTEN, NOT APPLIED),
`src/lib/email-hold.ts`, `src/lib/email-delivery.server.ts` (new), `src/lib/email.functions.ts`,
`src/components/held-email-controls.tsx`, `src/components/email-send-delay-card.tsx` (new),
`src/routes/api/public/hooks/email-release.ts` (new route),
`supabase/migrations/20260928123000_notification_type_vehicle_due.sql` (WRITTEN, NOT APPLIED),
`supabase/migrations/20260928124000_vehicle_maintenance.sql` (WRITTEN, NOT APPLIED),
`src/lib/vehicle-maintenance.ts`, `src/components/vehicle-maintenance-panel.tsx` (new),
`src/routes/_authenticated/fleet.$vehicleId.tsx`, `src/routes/_authenticated/fleet.index.tsx`

**Phone density**: top bar and bottom nav fold away on scroll down, tighter
card and page padding under 768px. **Supply categories** collapse even while
holding quantities, with an "N on this request" badge and a read-back above
Send. **Ship to** Shop / Job site / Somewhere else, one tap each (verified:
shop and typing were already there; the job site in one tap was not).
**Location assignments** edit in place (role, move office), audited, primary
office follows the move. **Email undo window**: every person-sent email holds
N minutes (default 5, Admin → Email templates) — "Sending in 4:32 — Edit ·
Cancel" on the job Communications tab, the send dialog's outbox and the
account timeline — then a minute sweep hands it to the transport seam.
Automation staff emails are not held. **Vehicle maintenance**: log + four due
items per van, warnings in the bell and badges on /fleet.

STILL OPEN:
- Email hold: attachments can be removed during the window but not added.
- Email hold: the certificate send log (compliance-files) records a held send
  as "queued" and is not updated if the sender cancels it.
- Email hold: real delivery still waits on the email backend (Chaim).
- Vehicles: recording an inspection/registration/renewal does not roll the due
  date forward; the due item is edited by hand.
- Vehicles: no importer for the Fleet-Vehicle Info sheet yet. The fields and
  the (vehicle, kind) unique key are there so it can be an upsert.
- Vehicles: current odometer is the highest one recorded by hand; Raven's
  odometer is not read.

---

### David's 24 Sep check-in: equipment and money (branch `wt/m4-equipment-money`)
`src/lib/equipment-import.ts`, `src/components/equipment-import-dialog.tsx` (new),
`src/lib/equipment.ts`, `src/components/equipment-panel.tsx`, `src/components/equipment-on-site.tsx` (new),
`supabase/migrations/20260927120000_equipment_days_local_calendar.sql` (WRITTEN, NOT APPLIED),
`src/lib/invoice-pull.ts`, `src/components/invoice-pull-panel.tsx` (new), `src/components/invoice-editor.tsx`,
`src/lib/formula.ts` (new), `src/components/ui/number-input.tsx`, `src/components/calc-input.tsx`,
`supabase/migrations/20260927121000_invoice_payment_audit.sql` (WRITTEN, NOT APPLIED),
`src/lib/payment-edits.ts`, `src/components/payment-edit-dialog.tsx` (new), `src/components/job-billing-panel.tsx`,
`supabase/migrations/20260927122000_job_commission_paid.sql` (WRITTEN, NOT APPLIED),
`src/lib/commission-entries.ts`, `src/lib/commissions-report.ts`, `src/components/commission-admin.tsx`,
`src/routes/_authenticated/admin.commissions.tsx` (new), `src/components/job-ledger-panel.tsx`

**Register import** on /equipment (tag per row; the count layout is refused).
**Days on site** now counted like the bill: inclusive calendar days, drop-off
= day 1, in America/New_York on the screen and in job_running_cost; offline
scans keep their scan time. **On-site counts** by type on the tab and header.
**Pull from job** on invoices: approved labor by day, equipment by type,
priced at charge rates via fetchCalculatorRates. **Editor**: no background
calculator, typed math on money boxes, a visible Save, "N payments" not "×1".
**Payments** correctable with a database-kept trail. **Commissions** admin
over commission_rates, paid/outstanding per job, preset report 19.

STILL OPEN:
- **Three migrations unapplied**, run in order. Until 20260927120000 the bill
  still dates in UTC (an evening drop can bill a day short); until 121000
  payments cannot be edited (refused, not unlogged); until 122000 jobs show no
  paid status and report 19 says it needs the update.
- **$65 vs $70 labor**: the pull and Quick Estimate charge $70/h unless a price
  list says otherwise. David's NJ $65 wants the GSC-LABOR-REG catalog item and
  an NJ state price list at 65 — data, not code.
- **Heater, moisture meter, "other"** have no charge rate; pulled at $0 and
  marked.
- **Typed math on a phone**: the money box keeps the numeric keypad, which has
  no operators; sums are a desktop convenience.
- **Commissions report period** is the job's created date; paid dates are
  shown per job, not used as the period.
- **The two commission systems** (this per-job one and the rep plans/payouts
  engine in /admin/payroll) are still separate.

### David's 22 Sep walkthrough: automation and reporting (branch `wt/m3-automation-reports`)
`supabase/migrations/20260926120000_insurance_info_task.sql` (WRITTEN, NOT APPLIED),
`supabase/migrations/20260926121000_job_stage_automation.sql` (WRITTEN, NOT APPLIED),
`supabase/migrations/20260926122000_saved_reports.sql` (WRITTEN, NOT APPLIED),
`src/lib/insurance-info-task.ts`, `src/lib/automation-jobs.ts`, `src/lib/automation-jobs.server.ts`,
`src/lib/custom-reports.ts`, `src/lib/report-charts.ts`, `src/lib/todo-notes.ts` (all new, + tests),
`src/components/automation-job-rule.tsx`, `src/components/custom-report-builder.tsx`,
`src/components/custom-chart-controls.tsx`, `src/components/todo/todo-notes.tsx` (new),
`src/lib/automation.ts`, `src/lib/automation-engine.server.ts`, `src/lib/email-templates.ts`,
`src/routes/api/public/hooks/run-automations.ts`, `src/routes/_authenticated/admin.automations.tsx`,
`src/routes/_authenticated/reports.index.tsx`, `src/components/report-view.tsx`,
`src/lib/reports-engine.ts` (types only), `src/components/todo/my-todo-card.tsx`,
`src/routes/_authenticated/jobs.$id.tsx`, `src/routes/_authenticated/jobs.new.tsx`, `src/styles.css`

**Missing insurance info** is kept by the database, not the engine: one
idempotent `sync_insurance_info_task(job)`, a trigger on the five fields (and
job type, status, stage_id), a daily pg_cron sweep, and a partial unique index
that allows one open task per job. Starred on the job form.

**Job-stage rules** ride the existing Automations engine and its
every-15-minutes pg_cron sweep: trigger `job_stage_age`, action `send_email`.
Email is to staff only (the validator refuses typed addresses), composed
through the template engine into `email_messages` as queued;
`deliverAutomationEmail` is the one seam to switch on. Claimed-first events
and a task cadence_key make each stay fire once.

**Custom reports** on /reports: four data areas over the tables the presets
read, saved in `saved_reports` (owner, or shared within an office). **Charts**:
data default, bar/line/pie by a natural dimension, refusals in words, a
validated `--viz-*` palette. **Sticky notes**: the my_todo card's new default
view — to-do items plus my tasks this week, grouped today / by day / by
property; the list is still one tap away.

STILL OPEN:
- **Three migrations unapplied**, in timestamp order. The first one runs the
  insurance sweep at once: every open insurance job missing any of the five
  gets one task on apply. Public adjuster is one of David's five, and many
  claims have none — if that floods the office, drop it from
  `insurance_info_missing` and INSURANCE_CRITICAL_FIELDS together.
- **"Sent to adjuster" and "Invoice pending payment" are not job stages yet**
  — add them in Settings → Pipelines; rules pick from the office's stages.
- **Email does not send.** `deliverAutomationEmail` returns queued until the
  backend is approved; recipients get an in-app notification meanwhile.
- **Job rules wait for the 15-minute sweep**; no database trigger on jobs
  wakes the engine (a delay rule does not need one).
- **"Office manager" is the office's first `location_members` manager** for a
  task (all of them for an email). A named office-manager role would be a
  small change if David wants one.
- **Charts not seen in a browser** here (sign-in); checked by tests and the
  palette validator only.

### David's 22 Sep walkthrough: supplies and purchasing (branch `wt/m3-supplies-purchasing`)
`src/components/supply-catalog-admin.tsx` (new), `src/routes/_authenticated/admin.supply-catalog.tsx` (new),
`src/components/commit-input.tsx` (new, from Cost rates), `src/lib/admin-settings.ts`, `src/lib/running-cost.ts`,
`supabase/migrations/20260925130000_supply_vendor_presets.sql` (WRITTEN, NOT APPLIED),
`supabase/migrations/20260925131000_supply_vendor_prices.sql` (WRITTEN, NOT APPLIED),
`supabase/migrations/20260925132000_supply_receipts_on_orders.sql` (WRITTEN, NOT APPLIED),
`supabase/migrations/20260925133000_supply_request_delivery_address.sql` (WRITTEN, NOT APPLIED),
`src/lib/supply-vendors.ts`, `src/lib/supply-vendor-prices.ts`, `src/lib/supply-delivery-address.ts`,
`src/lib/supply-order-card.ts` (all new, + tests), `src/components/supply-order-lines.tsx`,
`src/components/supply-order-detail.tsx` (new), `src/components/supply-receipt-panel.tsx`,
`src/components/supply-order-form.tsx`, `src/lib/supplies.ts`, `src/lib/supply-receipts.ts`,
`src/lib/vendor-order-email.ts`, `src/routes/_authenticated/supplies.index.tsx`

Six items, one commit each; the PR body has David's words and Daffa's steps.

**Catalog under Settings.** The Supplies Catalog tab is now `SupplyCatalogAdmin`,
also rendered at Settings → Rates & catalogs → Supply catalog — one component,
same rows. Items edit in place. Unit COSTS stay on Cost rates (what a job is
charged, not what a vendor charges).

**Vendors.** Built on `supply_vendors`. Items get `default_vendor_id`; order
lines get `vendor_id` (NULL = the item's preset). The migration turns every
distinct `default_supplier` text into a vendor (case/space-insensitive) and
points the item at it; the text is kept and mirrored from the vendor name
(rename trigger). An item with no text has no preset and its lines say "No
vendor" until one is chosen.

**Prices per vendor** in `supply_item_vendor_prices` — the expectation. What
was paid stays in `supply_purchases`. A line prices from its vendor; no price
on file is shown as such.

**Receipts on orders**: `supply_receipts.request_id`, one upload flow for both
doorways. **Delivery address**: `supply_requests.delivery_address`, preset from
the office. **Order card**: 1–2 items inline, else "View items"; the opened
order is the line list with vendor and Adjust.

Two existing bugs fixed on the way: managers could never write
`supply_request_lines` (RLS was requester-only while 'requested'), so the
partial-delivery running count never saved; and `rememberVendorEmail`
upserted on `onConflict: "name"`, which the table (unique on `lower(name)`)
refuses, so the vendor directory never filled itself.

STILL OPEN:
- **Four migrations unapplied**, run in timestamp order. Before each: no
  presets or line vendors (the old text still shows); no prices (lines say "No
  price on file"); attaching a receipt to an order says it needs the update;
  a typed delivery address rides in the order's note.
- **Expected prices are live, not snapshotted.** Changing a vendor price moves
  the expectation shown on an open order. Freezing it at approval is a column
  and one write if David wants the history.
- **Vendor choice is the approver's**, on the opened order. The requester's
  form does not pick vendors.
- **A receipt attached before 20260925132000** leaves its picture in storage
  with no row (the insert is refused after the upload).
- **Vendor duplicates from the text mapping** ("Home Depot" vs "HomeDepot") are
  two vendors; merge by renaming one and deleting the other.
- **Order-to-purchase is still by hand**: a delivered order does not write a
  `supply_purchases` row on its own; the receipt Confirm or Record a purchase
  does.

### David's 22 Sep walkthrough: jobs screens and flow, before Thursday's demo (branch `wt/m3-jobs-ui-layout`)
`src/routes/_authenticated/jobs.index.tsx`, `src/components/job-drawer.tsx` (deleted),
`src/routes/_authenticated/jobs.new.tsx`, `src/lib/job-new-defaults.ts` (new, + test),
`supabase/migrations/20260925120000_standing_intake_links.sql` (WRITTEN, NOT APPLIED),
`src/lib/standing-intake-link.ts` (new, + test), `src/components/intake-link-menu.tsx` (new),
`src/lib/intake-routing.ts`, `src/lib/intake-public.functions.ts`, `src/components/app-shell.tsx`,
`src/routes/_authenticated/intake-inbox.tsx`, `src/routes/_authenticated/billing.index.tsx`,
`src/routes/_authenticated/jobs.$id.tsx`, `src/components/job-report-panel.tsx`,
`src/components/job-ledger-panel.tsx`, `src/lib/record-view-memory.ts` (new, + test),
`supabase/migrations/20260925121000_job_tasks_visible_with_job.sql` (WRITTEN, NOT APPLIED),
`src/components/task-dialog.tsx`, `src/components/job-tasks-tab.tsx`,
`src/lib/report-voice.ts` (new, + test), `src/lib/job-reports.functions.ts`,
`src/lib/job-reports.server.ts`, `src/lib/job-report-sections.ts`, `src/components/job-photos.tsx`

Eleven items, one commit each. The PR body has David's words, what was found
and Daffa's steps per item; this is what stays open.

**Jobs list opens the record.** No split preview; a row, a tile and a board
card all go to `/jobs/$id`. The hover gutter keeps "open in a new tab".
Customers keeps its MasterDetail.

**New job.** The name follows the property address until the name box is
touched. "Time reported" starts at 12:00 AM.

**Standing intake link.** One per person, not one per company: a departure
or a leak is one link, not everybody's. Handed out by
`my_standing_intake_link()` (SECURITY DEFINER, `is_employee` check, caller's
own row only); intake_requests RLS is not widened. Top-bar "Intake link" menu
for every employee, and one-tap Copy/Email on the intake inbox. Routing on
every general link is now closest-office by the picked address's point,
in-state first, text rules otherwise.

**Billing page** is Estimates | Invoices with Payments beneath (was three
tabs). **Job Documents tab** is Documents | AI Reports. **Ledger** shows a
dash for an untracked cost.

**Position on the job record** is kept across navigation (tab + scroll, per
job, for the session) and across saves (`reload()` no longer puts the record
behind "Loading…" once it is shown).

**Tasks not populating**: the job's task caches were never refreshed after a
create; and the tasks SELECT policy scoped by the task's own office, which
drifts from the job's. **AI report**: the ban missed "recorded", "logged",
"a total of", "N total hours" and quoted/bracketed figures, and nothing
checked the output; now a prompt rule, one crew hours figure to the model,
and a checked draft with one rewrite. **Photo folders**: the rail's album
check ran only on mount, so a job's first upload never showed New folder.

STILL OPEN:
- **Both migrations are unapplied.** Until 20260925120000 is applied the
  intake-link menu says so and the inbox's Copy button hides; until
  20260925121000 is applied the tasks RLS gap remains (the refresh fix works
  without it).
- ~~**The job's Billing tab** still has Estimates in the right rail~~ —
  DONE on `wt/m3-remaining`: decision taken that the client's ask wins; the
  job tab now has David's split with payments beneath.
- **Staff photo view for general-link submissions.** `intakePhotoUrls` reads
  the submission's request through the caller's RLS, and an office-less
  request is privileged-only, so an office manager may not see photos on a
  lead routed to their office by a general or standing link. Pre-existing for
  the website link; standing links make it common.
- **Reported time at 12:00 AM** means response time counts from midnight when
  nobody corrects it. David floated a per-office setting; not built.
- **Tasks with no job** (made from /tasks or an account) never show on a job.
  A job picker in the task dialog is a product decision; the empty state now
  says so.
- **Old AI reports** keep their stored narrative; only new drafts get the new
  voice. The staff panel's "Underlying figures" still names sources.
- **Phone photo rail** folds New folder into the "All photos" row until it is
  tapped — by design, and the other way the option can look missing.

### Equipment scanning inside the field workflow: set up, pick up, reset the 3 days (2 Sep, David's scope of work; branch `wt/field-equipment-scanning`)
`src/lib/drying-clock.ts` (new, + test), `src/lib/drying-reset.ts` (new),
`src/lib/equipment-pickup.ts` (new, + test), `src/lib/equipment-setup.ts` (new, + test),
`src/components/drying-clock-card.tsx` (new),
`src/lib/code128.ts` (+ `code128.lighting.test.ts`), `src/lib/barcode-camera.ts` (+ `barcode-camera.crop.test.ts`),
`src/components/asset-tag-scanner.tsx`, `src/components/equipment-panel.tsx`,
`src/components/field-work-ticket-panel.tsx`, `src/components/job-drying-log.tsx`,
`src/lib/equipment-scan.ts`, `src/lib/field-work-ticket.ts`, `src/lib/offline-queue.ts`,
`src/components/field-equipment-scanning.wiring.test.ts` (new),
`supabase/migrations/20260919120000_equipment_condition_needs_cleaning.sql` (WRITTEN, NOT APPLIED),
`supabase/migrations/20260919121000_job_drying_resets.sql` (WRITTEN, NOT APPLIED)

David's scope-of-work email, 2 Sep, writes scanning into the tech's own steps:
"Set up equipment – Scan", "Scan all equipment" at pickup, and "Reset 3 days of
drying time (new button linked to scanning and alerts)."

The scanner engine and the shared scan dialog were already built. This is the
workflow around them.

**SET UP — the scan now places the units.** It used to be half a step. A scan
on the work ticket wrote TAGS on the ticket and nothing else, so somebody still
had to open the Equipment tab and log the same six machines out a second time.
That second pass does not happen at 7pm in a flooded basement, which is why the
ticket and the placement log kept disagreeing. One scan now does both: tags and
counts on the ticket, placements in the log, through the same `placeUnit` the
Equipment tab uses. The room and the retrieval date are asked once for the
session and the date is pre-filled with the 72-hour drying window, so nothing
is ever placed without a date to be overdue against.

The ticket's scan applies the SAME register rules the Equipment tab does, now
that it places: a retired unit is refused, a unit on another job or marked lost
or flagged for service or from another office is warned about and allowed. The
one exception is a unit already out on this job — the register has it as
`on_job`, which here would read as "still out on another job", which is the one
warning that would be false. It is named for what it is and confirmed, not
placed twice.

**PICKUP — the checklist, not the scan.** "Scan all equipment" is not really
about scanning; it is the reconciliation. The session now shows every unit
logged out to the job with the scanned ones ticked, still-missing at the top,
and refuses to close quietly: finishing with anything unticked takes two
presses, and the warning in between NAMES the machines and the rooms they are
in. "1 unit not scanned" sends a crew back to the house to look for something;
"GSR-AM00034-NJ (Air mover, Basement) was not scanned" sends them to the right
room. Condition is per unit, not one answer for the whole truck.

**3-DAY DRYING CLOCK.** The 72 hours are not stored anywhere — they are counted
from the first placement on the job, which is what the setup scan writes, so
nobody types a start date and nobody can forget to. What was missing was the
RESTART. `job_drying_resets` is an append-only log of somebody saying the
window starts again: who, when, what it had been running from, and why. A
column on `jobs` would have let the window slide with nobody's name on it, and
the whole reason David wants the button is that somebody has to own the extra
three days a carrier is billed for. The card is on the Drying tab and on the
work ticket — one component, so the two cannot disagree about the hours left.

**SCANNER HARDENING for a basement.** Two changes, both measured in the tests.
The frame is CROPPED rather than scaled: a plate is 40mm of Code 128 and the
dense ones put the narrow bar near a fifth of a millimetre, so squeezing a 1920
frame into 960 halves that bar and half a pixel survives no threshold. The
close-up pass takes the middle 60% at the resolution the sensor gave it and the
old whole-width pass is kept and tried second. And the row threshold is local
as well as global: a headlamp hot spot on one end of a riveted plate makes one
midpoint read the lit half as all white, and a plate a person can read fine
does not decode. Both passes still have to clear the modulo-103 check
character, so the extra tolerance buys reads, not guesses. Manual tag entry is
untouched — it is for painted-over plates and is not a fallback.

**Gloves.** Every write — placement, retrieval, reset — goes through the
offline queue. The scanner buzzes once for a unit added and twice for anything
refused, so a refusal is not mistaken for a camera that did not fire; both are
also on screen. Bilingual labels on the tech-facing actions, 44px+ targets,
full-width confirms.

STILL OPEN:
- **`needs_cleaning` is a new enum value** (20260919120000, its own file
  because Postgres will not let an added value be used in the transaction that
  added it). Until it is applied the app stores the nearest existing word,
  `needs_service`, and the pickup session says on screen that it is doing so.
- **The reset button is disabled until 20260919121000 is applied.** The clock
  above it still counts from the first placement, and says why.
- **Nothing alerts on a window running out yet.** David's line says "linked to
  scanning and alerts"; the scanning half is here and the clock exposes the
  phase (`due`, `overdue`) the alerts sweep would read. Wiring it into
  `deriveAlerts` is a separate decision about who gets told.

### The two clarified items from Melly's cleanup list (17 Sep; branch `wt/kanban-scroll-upload-dupe`)
`src/components/pipeline-board.tsx`, `src/components/pipeline-board.column-scroll.test.ts` (new),
`src/components/account-prospect/prospect-contact-bar.tsx`,
`src/components/account-prospect/prospect-record.tsx`, `src/components/documents-panel.tsx`,
`src/components/account-prospect/prospect-upload-single.test.ts` (new)

Two items on the 17 Sep cleanup list were left untouched on purpose, recorded
as "not changed -- needs a screenshot" rather than guessed at. Melly has since
pinpointed both.

**The empty gap under the deal cards.** "Leave an odd empty gap below them...
make all these deals a little bigger to fill this little gap... size it to the
thing." The cards were never too small. Every Kanban column stretched to the
tallest one on the board, so a stage holding two deals showed two deals and
then several hundred pixels of nothing. The cards container is now capped at
500px on every column and scrolls inside itself past that, so the board reads
level whether a stage holds two deals or twenty, and a card keeps the size it
always had.

The cap is on the cards, not on the column. Mark rejected capping the COLUMN
back in #161 -- "the page stopped moving" -- and that still holds: the column
is `md:max-h-none`, the page still owns the vertical scroll, and the column
header still sticks to the top of the screen on the way down. What changed is
only how tall the tallest column can get.

Smooth scrolling is gated on nothing being dragged. dnd-kit auto-scrolls a
container by writing `scrollTop` many times a second and `scroll-behavior:
smooth` animates every one of those, which would leave the container lagging
the cursor and a card dropped near an edge landing in the wrong stage. A
finger gets the smooth scroll; a drag gets an instant one. `overscroll-contain`
keeps a flick at the end of a column out of the page behind it.

**Upload appeared twice on the deal/prospect page.** It did. The Documents card
under the contact stack has its own Upload button, and the action bar's More
menu had a second one that reached across and clicked the first one's file
picker for it. Mark had already said "upload doesnt need to be here" about the
action row; folding it into More kept the duplicate, just hid it.

The whole route is gone rather than hidden: the menu entry, the `Paperclip`
icon nothing else used, the `files` branch in the record's `openActivity`, the
`uploadRequest` token it set, and the prop and effect on `DocumentsPanel` that
received it. That prop had exactly one producer, so with the menu entry gone it
was a public-looking prop nobody could reach. The Documents card's own Upload
is now the only way to put a file on an account there, which is where a file
was always going anyway.

STILL OPEN:
- **Auto-scroll while hovering a DIFFERENT column.** dnd-kit auto-scrolls the
  scrollable ancestors of the dragged node, so dragging within a tall column
  scrolls it. Whether hovering the edge of a full column you are dropping INTO
  scrolls that one is the library's behaviour, not ours, and wants a live
  check on a board with twenty deals in a stage.

### Approving a supply order composes the vendor's purchase order (18 Sep, point 22; branch `wt/vendor-order-auto-email`)
`src/lib/vendor-order-email.ts` (new), `src/lib/vendor-order-email.test.ts` (new),
`src/components/vendor-order-email-panel.tsx` (new), `src/lib/supply-workflow.ts`,
`src/routes/_authenticated/supplies.index.tsx`,
`supabase/migrations/20260918150000_vendor_order_email.sql` (WRITTEN, NOT APPLIED)

The supply flow shipped with vendor emailing MANUAL and "a clean seam to switch
on". The decision came back — switch it on. `VENDOR_EMAIL_ON_APPROVAL` is now
true and the stubs behind it are a real implementation.

**COMPOSES. DOES NOT SEND.** Outbound delivery is still blocked on Chaim
approving the email backend, so the composed order is recorded against the
request and opened as a prefilled draft in the approver's own Outlook. That
works today with software the office already has. The ONE function that changes
when a real sender exists is `deliverVendorOrder`.

Wording comes from the email template engine's `vendor_order` key, never from
this code. A missing template row falls back to the built-in default; a
template somebody switched OFF is also refused in favour of the default, since
disabled wording is not wording anyone stands behind. Either way the record
says which was used.

**Approval never fails because of email.** The status change commits first and
everything after it is wrapped: a missing address composes with a blank
recipient and says "no supplier email on file", a missing migration skips the
log, a thrown error leaves the order approved and reports it. There is also a
per-order "Approve without emailing" for the repeat order already placed by
phone, recorded on the row rather than inferred from a missing email.

`supply_vendors` is a new directory that resolves the free-text supplier names
already in `supply_items.default_supplier` to an address, without changing any
of them. It fills itself: the address the approver types into the draft is
remembered for next time.

STILL OPEN:
- **Depended on `wt/email-template-engine`** for the `vendor_order` key; both
  merged together, engine first.
- **An order spanning two suppliers gets no vendor name.** Picking the first
  would send one merchant a request for goods they do not stock, so the
  approver is asked. Splitting such an order is not built.
- **`email_messages` UPDATE is restricted to the sender.** If manager A approves
  and manager B opens the draft, B cannot mark it opened. Widening that is an
  RLS decision, not a tidy-up.

### One email template engine, ready and waiting (18 Sep, point 26; branch `wt/email-template-engine`)
`src/lib/email-templates.ts` (new), `src/lib/email-templates.test.ts` (new),
`src/routes/_authenticated/admin.email-templates.tsx`, `src/components/token-editor.tsx`,
`supabase/migrations/20260918140000_email_template_engine.sql` (WRITTEN, NOT APPLIED)

The decision, taken after the 16 Sep meeting — stop waiting on Chaim and build
the engine now: "A single place where all email templates live (receipt,
estimate, vendor order, etc.) · Each template: a subject + body with fill-in
blanks (customer name, amount...) · Staff can edit the wording themselves in
Admin."

**NOTHING SENDS.** The engine composes a subject and a body and stops. Sending
stays blocked on the backend approval; this is the part that did not have to
wait for it.

Five stable keys — `receipt`, `estimate_send`, `invoice_send`, `vendor_order`,
`intake_confirmation` — each with default wording, and each with its OWN typed
list of fill-in blanks. That per-key field list is the thing that did not exist
before: the base screen offered every template all 620 keys of the generated
merge catalogue, so "which fields belong to a vendor order" was not a question
anything could answer.

One pure render function, and the rule that makes it worth having: a value
substitutes, and anything else stays VISIBLE as its placeholder. A typo'd
`{{custmer_name}}` survives into the preview where somebody notices it; blanked,
it would read as a finished sentence with a hole in it. The next PR's
vendor-order auto-email calls `renderEmailTemplate("vendor_order", …)`.

TWO CONTRADICTIONS WITH THE BASE CODE, reconciled rather than papered over:
- **Two token vocabularies.** `merge-keys.ts` uses the client's `{Job.JobNumber}`
  spelling; the decision uses `{{customer_name}}`. The engine uses the
  decision's, with a deliberately tight pattern so the old spelling passes
  through untouched, and the editor judges an engine template against its own
  fields and a hand-made one against the global catalogue. Converging the two
  vocabularies is real work and is NOT bundled here.
- **A receipt template already existed.** 20260910010000 seeded
  `payment_receipt_default`, warning that a second template of one purpose makes
  JobEmailDialog's auto-select "a coin toss". The migration RENAMES that row's
  key to `receipt` rather than inserting a second one, so any wording already
  edited into it survives.

STILL OPEN:
- **Preview shows wording, not styling.** The body is rendered as text, because
  rendering admin-authored HTML would be the app's first `innerHTML` of user
  content and buys nothing for judging a sentence.
- **`estimate_send` and `invoice_send` add a template to the `estimate` and
  `invoice` categories.** If an office already wrote one, JobEmailDialog's
  purpose auto-select picks the first by name. Worth a look after the migration
  runs; the fix is one toggle.
- **No admin screen edits the per-key field list.** It is code, on purpose — a
  field nothing supplies is a blank that never fills.

### The scanner reads QR codes, on every device (17 Sep, Melly; branch `wt/scanner-qr-fix`)
`src/lib/barcode-camera.ts`, `src/lib/barcode-camera.qr.test.ts` (new),
`src/components/badge-scan-sheet.tsx`, `src/components/asset-tag-scanner.tsx`. No migration.

Melly, watching three printed business-card QR codes fail in a row on the call:
"basically it's looking for a barcode instead of QR codes." He was right, and
literally so.

The live loop's only JavaScript decoder was `decodeCode128Row`, fed from
`sampleFrame`, which crops a 34% horizontal band around the aim line. That is
correct for a 1-D barcode and useless for a QR code, which is two-dimensional —
a strip through the middle of one cannot be decoded by construction. Safari
ships no `BarcodeDetector`, so on every iPhone that reader was the whole of it.
The badge that DID scan on the call was read by a native detector.

jsQR now runs in the same loop, on the whole frame, before the Code 128 pass.
It was already a dependency — `business-card-photo.ts` used it on stills — so
nothing was added. It is loaded dynamically and only when there is no native
reader AND the caller asked for qr_code, so the asset-plate scanner never pays
for it. One fix in `startScanLoop`; every scanning screen inherits it.

`ScanEngine`'s "scanline" became "javascript" on purpose: the rename broke
every "only Code 128 will decode here" message and forced each to be revisited,
because they had all quietly become false.

The opaque-badge honesty Melly asked for already existed and was left alone —
`parseBadgePayload` returns `opaque`, `badgeIsLead` gates field-filling, and
`BADGE_ID_ONLY` says the registration vendor holds the details.

STILL OPEN:
- **PDF417, Data Matrix and Aztec still need a native reader.** jsQR is QR only.
  An iPhone shown one of those is told to type the number.
- **Inverted QR codes are not attempted** on the JavaScript path: `dontInvert`
  halves the per-frame cost, and printed cards are black-on-white.

### Routes present the fastest order by default (17 Sep, Melly; branch `wt/routes-fastest-default`)
`src/lib/route-planner-prefs.ts`, `src/components/routes/route-builder.tsx`,
`src/lib/route-optimize.test.ts`. No migration.

Melly: "The whole point of routes was that you choose, let's say five locations
and then a starting point and an end point and then it populates what's
fastest." What he got: "It's just making the order based on what you're
clicking on, which is stupid."

**The optimiser was never broken.** `route-optimize.ts` builds the Directions
request with `optimizeWaypoints`, applies Google's order, and runs a second
pass for traffic — all of it wired through RouteBuilder and reachable from the
Routes page. It was sitting behind `autoOptimize`, which defaulted to FALSE
because each Directions call is billed. So a rep picked stops, saw them back in
click order under a badge reading "Pick order", and had to find a button. A
feature nobody turns on is a feature that does not exist; the undiscoverability
WAS the bug.

`autoOptimize` now defaults to true, and `parseRoutePlannerPrefs` reads an
ABSENT flag as on rather than off — every rep who tried Routes before today has
a saved row with no such key, and reading that as "off" would leave exactly the
people who already gave up still looking at their own click order. An explicit
false, from somebody who turned it off deliberately, is still honoured.

Click order is never presented as the answer any more: during the debounce and
the Directions call the badge reads "Finding fastest…" rather than labelling the
list a route. Panel copy now says "fastest" throughout instead of three
synonyms for it.

Unchanged and already working: start/end pickers sit above the stop list
pre-filled from saved prefs, traffic comes from the second pass over the chosen
order, saved-route history and the Maps hand-off.

STILL OPEN:
- **The ORDER is chosen without traffic.** Google optimises waypoints on
  distance and time only; traffic is applied to the legs afterwards, so the
  times are right for the departure but the sequence was not picked with
  congestion in mind. Unchanged, and still stated in the planner copy.
- **Over 25 stops is not optimised at all** — the Directions waypoint ceiling.
  The picked order stands and the planner says so.
- **Each automatic run is billed.** The debounce, the per-question guard and
  the directions cache keep it to roughly one call per distinct route.

### Chaser location: granted once, then passive (17 Sep, Melly; branch `wt/chaser-passive-location`)
`src/routes/_authenticated/chase.index.tsx`, `src/lib/dispatch.ts`,
`src/routes/_authenticated/chase.dispatch.tsx`,
`src/components/chase/device-permissions.tsx`, `src/lib/chaser-location.test.ts` (new).
No migration.

Melly: "I don't want them to know that they're being tracked... they don't need
to toggle on location every time." He accepted on the call that they grant it
when they first get the app.

**THE BOUNDARY, which no web app can move:** the OS shows a location prompt
ONCE. Everything after that single grant is silent, and that is what this holds
in place.

Most of it was already built and is untouched: the priming screen that runs
before any cold browser prompt, `primed` recorded per user and device so it is
never asked twice, `getCurrentPosition()` that resolves null rather than
throwing, and `incident_events.lat/lon` stamped by every chaser action. Three
things were not:

- **A GPS poll ran behind the cockpit** — `setInterval` every two minutes with
  `enableHighAccuracy`, for as long as the screen was open. That is the
  battery-hungriest thing a phone can be asked to do and it bought nothing: a
  chaser in a parked truck is not moving, and one who is reads their position
  again the moment they look at the screen. Now read on open and on
  `visibilitychange`; capture rides on the events, as Melly asked.
- **Dispatch stored coordinates and never read them back.** `lat` and `lon`
  have been on every chase event since 20260812173002 and were not in the
  select, so the one screen a supervisor watches chasers on could not show
  where anything happened. Now shown, with "No location" said out loud rather
  than left blank — which chasers are reporting position is the thing being
  looked at.
- **The chaser was warned when location was denied.** A banner with steps to
  switch it back on is the app asking again by other means. It now raises for
  denied NOTIFICATIONS only — a chaser who gets no alerts cannot work — and
  names location alongside them when both are off.

STILL OPEN:
- **The one prompt is unavoidable.** iOS and Android both show it; the priming
  screen is the most that can be done, and it explains why before asking.
- **No background capture.** A chaser's position is recorded when they act, not
  while the app is closed — no web app can do otherwise on iOS.

### An install path that is always there (17 Sep, Melly; branch `wt/pwa-install`)
`src/components/install-prompt.tsx`, `src/routes/__root.tsx`,
`src/components/install-prompt.test.ts`. No migration.

Melly: "if you can make a web app, that would be much better... you get a
downloadable app and you download it and it shows up as an icon... when you
open it, it doesn't have the top banner, the bottom banner."

**The PWA itself was already right** and was left alone: `manifest.webmanifest`
declares `display: standalone` with 192/512/maskable icons, `__root.tsx`
carries the Apple meta tags and the apple-touch-icon, and the service worker
serves from `.output/public`. His session showed browser chrome for the
ordinary reason — he was browsing in Safari and had not added it to the home
screen. A web app only loses the bars after it is installed.

What was actually missing was the path to installing on the one platform with a
real install. `InstallMenuItem` rendered NOTHING on Android until Chrome fired
`beforeinstallprompt`, which it does on its own engagement schedule — so a
field tech opening the app for the first time was offered nothing at all, while
iOS at least had manual steps. The entry is now always present on a
Chrome-family browser and opens the manual steps when there is no prompt to
fire; the phone banner does the same. A browser that genuinely cannot install
still shows nothing, because an entry describing a button that does not exist
is worse than no entry.

`mobile-web-app-capable` now sits beside `apple-mobile-web-app-capable`: the
standards-track name Chrome warns about, next to the only one iOS honours.

HONEST LIMITS ON iOS, now said in the sheet rather than just known:
- **No install prompt, ever.** Safari has never had one; Share → Add to Home
  Screen is the only route, and non-Safari iOS browsers have to be sent to
  Safari first.
- **The installed app has its own storage,** so signing in happens once more
  inside it. Supabase persists the session from then on.
- **No background sync.** Offline work sends the next time the app is opened
  with signal, which the iOS sheet already said.

### David's real supply catalogue, and his real cost rates (18 Sep, David; branch `wt/supplies-catalogue-load`)
`docs/gsr-supplies-import.csv` (new), `src/lib/supplies.ts`, `src/lib/supply-spend.ts`,
`src/lib/field-ticket-costing.ts`, `src/components/supply-order-form.tsx`,
`src/routes/_authenticated/supplies.index.tsx`,
`src/lib/supply-catalogue-load.test.ts` (new), `src/lib/gsr-cost-rates.test.ts` (new),
`supabase/migrations/20260918130000_supply_catalogue_david_sheet.sql`,
`supabase/migrations/20260918131000_gsr_cost_rates.sql` (BOTH WRITTEN, NOT APPLIED)

Two things that had been waiting on the client rather than on code.

**The catalogue.** Meeting point 18 rebuilt the supply order form so its
sections are the catalogue's own categories, and it has shown six clearly
marked example rows ever since. David's spreadsheet arrived: 84 items across
six categories — Adhesive 8, Chemicals 23, Plastic 9, Filters 17, General /
Cleaning Supplies 12, Gloves / PPE 15. The example rows go, his items land.

His sheet has FOUR columns and no others: category, description, size,
case_qty. **No SKU, no supplier, no price** — so none is invented. Those stay
empty; a supplier and a price are facts about a purchase, and the purchaser
side from meeting point 20 already records both per receipt.

`size` became its own column rather than being folded into the name, because
the sheet repeats a description across sizes — five Pleated Filter Merv 8 rows,
four Carbon Filters, three sizes of Nitrile Gloves — and each size is
separately orderable. `supply_items_name_key` was unique on `lower(name)` alone
and would have rejected four of the five filters, so it is now unique on name
PLUS size, which is the rule David described. `case_qty` became `unit`: nobody
orders one strip of duct tape, they order a 24 Case. Both are stored exactly as
typed, "12 case" and "12 Case" alike; the one thing normalised is the double
space in his "General  / Cleaning Supplies", which is a card heading.

**The cost rates.** Meeting point 7 carried the note "crew rate + equipment day
rates must be set in the app or costs show $0". The engine was never wrong — it
had nothing to multiply. His Item Cost sheet now supplies crew labour $45/hour
(a COST; his $65 charge rate is the estimate catalogue's business and is not
touched) and day rates per machine. Air mover $5, dehumidifier $20, Scrubber XL
$10, Scrubber XXL $15, generator $10 go onto the asset register's existing
rows, only where nothing was set. Injector $10, ozone $10 and hydroxyl $20 have
no `equipment_type` to live on — Gold Star does not asset-tag them — so they go
into one `app_settings` card that `fetchTicketRates` reads ONLY where the
register has no rate, leaving /admin/equipment-rates authoritative.

STILL OPEN for David:
- **Scrubber XL vs XXL.** The field ticket has one generic Scrubber box, and
  the engine's existing highest-rate rule prices it at the XXL's $15. Either
  the ticket separates them or one blended rate is agreed.
- **His sheet's Scrubber XXL w/filter is $10 while plain XXL is $15.** Taken as
  $15; the discrepancy looks like a typo and needs confirming.
- **Per-office labour.** $45 is seeded as the corporate default. `labour_rates`
  is already per-location, so per-office overrides are one row each if he wants
  them.
- **Submersible pump $5/day, encapsulation $200/bucket, air samples $175 per
  batch of 4.** Recorded in the settings card so the numbers are his and not a
  guess, but nothing in the app counts them yet.

### Scan-out inventory depletion, alongside manual (18 Sep, point 21; branch `wt/inventory-scan-out`)
`src/lib/supply-scan.ts` (new), `src/lib/supply-scan.test.ts` (new),
`src/components/code-scan-dialog.tsx` (new), `src/components/badge-scan-sheet.tsx`,
`src/lib/supplies.ts`, `src/routes/_authenticated/supplies.index.tsx`,
`src/components/supply-catalog-admin.tsx` (the scan-code box on each item).
NO MIGRATION — see below.

Depletion shipped MANUAL-first with the deliberate seam that scan could be
added later with no enum change. The decision came back: add scan as well, both
ways must work.

**ONE MECHANISM, and the scan goes through it.** `depleteStock()` → `moveStock()`
is still the only write path: same ledger row, same running total, same
permissions, same confirm step. A scan is a faster way to PICK the item and
nothing more — the quantity defaults to 1 and is editable, and somebody still
presses Mark used. The only thing that reaches the database differently is the
movement's `reason`, which the ledger has accepted as `"scan"` since the day it
was written. That is the seam being used as designed, not a second system.

**No migration, because the column already existed.** `supply_items.sku` is
nullable and already carries `UNIQUE (lower(sku)) WHERE sku IS NOT NULL` from
20260918090000, so a duplicate code across two items is refused by the database
rather than merely discouraged by a form. The office types a bin's code onto
the item under Catalog and prints a label for it.

**The scanner is the repo's own.** No library was added. `barcode-camera.ts` —
native `BarcodeDetector`, QR and Code 128 in software — is unchanged, and the
badge sheet's body became `CodeScanDialog` so supplies and tradeshows share one
camera dialog instead of growing two. That matters beyond this PR: David's
scope-of-work email puts scanning at the centre of the field workflow ("Set up
equipment - Scan", "Scan all equipment" at pickup), so the next screen that
wants a camera should find one.

Resolution never guesses. An unknown code says so and offers the list; a
duplicate names both items rather than picking one, because depleting the wrong
shelf is silent and surfaces weeks later as a short count.

STILL OPEN:
- **Other symbologies need a native decoder.** The in-JavaScript fallback
  reads QR and Code 128 (jsQR joined it in #232), so either kind of bin label
  works on an iPhone; anything else needs `BarcodeDetector` or typing the code.
- **Codes are per item, not per bin.** One item in two locations shares one
  code. Per-location bins would need a table of their own.

### Price lists — customer agreements and per-state rates over the default catalog (10 Sep, David; branch `wt/price-lists`)
`src/lib/price-lists.ts` (+ test), `src/routes/_authenticated/admin.price-lists.tsx`,
`src/components/estimate-line-picker.tsx`, `src/components/estimate-editor.tsx`,
`src/components/invoice-editor.tsx`, `src/lib/admin-settings.ts`,
`supabase/migrations/20260910233000_customer_price_lists.sql`.

David, on the call: "The unit price is $95 ... but what's if I have different
clients that I have different pricing with? Let's say Falcon has a price that
I'm charging them only $80 ... There's a default across the board. But when you
select certain clients, those clients override the default." Plus the same
thing by state: "New York and California I charge for labor $70 versus Jersey.
I can charge $65."

The default price list already existed — `estimate_catalog_items.default_unit_price`,
the number the line picker copies onto a line. Nothing duplicates it. What is
new is a thin override layer: a named list of prices, and rows saying whether
it applies to an ACCOUNT or a LOCATION, effective-dated. Resolution is one
tested pure function, customer → location → catalog, falling through PER ITEM
so an agreement is the four lines that were negotiated rather than a copy of
all thirty-four.

NOT labour_rates, though it is already per-location and per-role: that table is
what a crew member COSTS us (`rate_for()` → `job_labour_summary.labour_cost`)
and its RLS hides it from the estimators who need the charge rate. Cost and
charge are not the same number.

A line already written never moves. `unit_price` is a stored value, resolution
runs only at insert, and there is no trigger anywhere in this feature that
could reach back into a document a customer has already seen.

DELIBERATELY NOT BUILT, and still open:
- **Reprice an existing document.** There is no "apply the new agreement to the
  lines already on this estimate" button. It is a real request the day someone
  signs an agreement mid-job, and it needs a confirmation and an audit note,
  not a silent recompute.
- **Import is codes and prices only.** `.csv` and pasted text, two columns,
  matched on catalog code. No `.xlsx`, no column mapping, and no creating
  catalog items the sheet mentions but the catalog does not have — an unknown
  code is reported, not invented.
- **No effective-date warning for overlaps.** Two agreements covering the same
  day are allowed; the resolver breaks the tie (newest wins) and the tests pin
  it, but the admin screen does not warn while you create one.
- **The Job Calculator is untouched.** It is a second pricing model —
  `equipment_rates`, typed hours and a `customer_price` someone enters — and
  it never reads `estimate_catalog_items`, so a price list does not reach it.
  If David wants Falcon's rates on the calculator too, that is its own piece of
  work against `job_calculations`.

### Contacts are NOT shared between offices — the Office field restricts (10 Sep, David; branch `wt/contact-office-visibility`)
`src/lib/contacts.ts`, `src/lib/contacts.test.ts` (new),
`src/components/create-customer-dialog.tsx`,
`supabase/migrations/20260910200000_contacts_accounts_shared_across_offices.sql`
(WRITTEN, NOT APPLIED)

David, mid-call, looking at the Office field on the create-contact form: "Office,
I have to be selected an office, right? It's not restricting this to an office,
right? ... So we don't want to restrict anything to an office because we want
everything in the CRM to be shared between all offices." Melly: "I'm not sure. We
have to check."

**Checked. It restricts.** `contacts_select` is `can_view_location(uid,
location_id) OR EXISTS (the contact's account, viewable or assigned to you)`, and
`can_view_location` is admin/owner/dev, or a `location_members` row for that
office, or a region covering it. Thirty-two of the thirty-eight active users who
belong to any office belong to exactly one, so those thirty-two see one office's
contacts out of ninety across eleven offices. Verified against production on
2026-09-10, read-only.

**The two policies disagree, and contacts is the narrower one.** `accounts_select`
carries `created_by = uid`; `contacts_select` does not. Thirty-five accounts are
visible to their creator today only because of that clause, and thirty-nine
contacts are invisible to the person who typed them. Left alone: closing the gap
means widening, and widening is the client's decision, not a tidy-up.

**Shipped now, because it is true either way:** the Office field on the person tab
was editable next to a chosen CRM account and then silently discarded on save —
`resolveContactLocationId` takes the account's office first. A rep in NY filing a
contact under a GA account picked "NY" and got GA with no explanation. The field
is now read-only when an account is picked, names the owning office, and says
plainly in both states that only that office can see the contact. Precedence
extracted to `pickContactLocationId` and pinned by test.

**Not shipped, on purpose:** the migration that delivers what David asked for is
written and explained in full, and is NOT applied. Melly said "we have to check",
`docs/melly-external-factors.md` already lists cross-office visibility as awaiting
product's access matrix, and a contact row carries spouse, children, birthday,
dietary notes and gift-policy notes — "shared between all offices" for a sales
directory and for a customer's family details may not be the same ask. Applying it
would give all 38 role-holding employees read on all 90 contacts and 112 accounts;
`anon` and the 7 role-less users gain nothing. Needs Melly's sign-off.

### Back should return to where you were (9 Sep, Mark; branch `wt/back-to-where-you-were`)
`src/lib/back-target.ts` (+ test), `src/lib/nav-trail-store.ts`,
`src/hooks/use-back-target.ts`, `src/components/back-link.tsx`,
`src/components/nav-trail.tsx`, and the 18 files that render a back control.

Mark, on an account opened from the pipeline: "clicking the back button to the
left of the company should not take you back to customers, it should take you
back to the pipeline which is where you just were." Every back control was a
hardcoded `<Link to="/accounts">`, `<Link to="/jobs">`, `<Link to="/fleet">`
and so on, so it always landed on the index however you had arrived.

One decision in one place. `resolveBackTarget` reads the **nav trail** — the
pages the user actually visited, which the breadcrumb row already keeps — and
returns the previous step, falling back to the call site's own index route when
there is no in-app history. Every call site keeps its old destination as that
fallback, so a pasted link or a new tab behaves exactly as it used to.

Trail rather than `router.history.back()`, which is what this entry originally
asked for: a browser entry is not a page here (search is view state, and the
trail folds a page's URL changes into one crumb), a real destination can be
rendered as a real `href` so the label, the hover target and the click finally
agree, and it can neither walk out of the app nor land on the page you are
already on. Where the trail's answer does happen to be one entry behind, the
control still pops, which is what keeps the list's scroll position.

### Trade show voice notes — one-tap capture and the post-show review pass (9 Sep, Mark; branch `wt/tradeshow-voice-queue`)
`src/components/tradeshow-quick-voice.tsx`, `src/components/tradeshow-review-queue.tsx`,
`src/components/badge-scan-sheet.tsx`, `src/lib/tradeshow-review.ts` (+ test),
`src/lib/tradeshow-capture.ts`, `src/lib/tradeshow-lead-writes.ts`,
`src/lib/barcode-camera.ts`, `src/components/voice-note-field.tsx`,
`src/routes/_authenticated/tradeshows.$id.tsx`,
`supabase/migrations/20260909150000_tradeshow_capture_review.sql`,
`supabase/migrations/20260909150100_fix_capture_lead_source_check.sql`

Mark: "What I do is — and it's the quickest way for me at a show — when I'll
talk to somebody, I'll scan their badge or whatever it is, I'll send myself a
voice note like 'you know Mark from Falcon Marketing blah blah, this is what he
does', and then when I'm done the show I'll go over all my voice notes. That
way I'm not sitting there at a show typing in."

**What was there.** The booth half only: a **Lead** button opening a four-step
dialog — badge photo, selfie, voice note, typed fields — that would not save
without a name or company *and* a phone or email. Every capture therefore
demanded typing at the booth, which is the thing he says he does not do. There
was no notion of a capture that had not been written up yet, and no screen for
going over the recordings afterwards.

**The booth now.** A **Just a voice note** bar sits at the top of the show page,
above everything. Hold it, talk, let go — one gesture, no photo step, no
fields, no dialog and no confirmation to tap past. The button is back to its
resting state before the upload finishes, so the next person can be handled
immediately, and a running "N voice notes captured this sitting" is the only
feedback. Under 0.7s is treated as a fumble and thrown away rather than filed
as an empty lead. Beside it, an optional **Scan badge**: the code is read and
kept *verbatim* — nothing parses vendor badge formats — and rides along with
the next note. The four-step **Lead** flow and **Type it in** are untouched.

**The review pass.** A **Voice note review** section on the same page lists
every capture nobody has written up, oldest first, each row a waveform player
with the capture time, the photo and badge photo if there are any, and the raw
badge string. Opening one starts it playing and unfolds the fields beside it —
name, company, phone, email, notes, lead source. **Space** plays and pauses,
**Enter** saves and drops straight onto the next note without the page moving
(plain Enter in the notes box is a newline; Ctrl/Cmd+Enter saves). The header
carries a progress bar and "7 of 23 reviewed". **Skip for now** steps past a
note and it comes back round at the end — it is never removed. Review demands
only a name or a company: a note saying "Mark from Falcon, no card" is worth
keeping, and refusing it would teach him to type a fake number.

**Reviewed state.** `tradeshow_lead_captures` — one row per captured account,
`needs_review` until somebody saves details against it, plus the raw badge
value and who reviewed it when. A side table, not columns on `accounts`,
because the account already *is* the lead: it carries `tradeshow_id`, counts on
the show's ROI block from the moment it is spoken, and appears on the board
without any of that depending on the new table. An unreviewed capture is
flagged **Unreviewed** on the leads table and counted under "Leads captured"
("4 not written up yet"), so a forgotten note is loud rather than lost. There
is deliberately no DELETE policy: nothing here can be removed. A database
without the migration says so in place of the queue and keeps saving leads.

**Offline.** The quick capture goes through the same queue as everything else —
payload plus the audio blob held on the tablet, replayed when the hall has
signal — and the replay is `ON CONFLICT DO NOTHING` on the capture row, so a
lead reviewed between a lost response and the replay is not dragged back into
the queue.

**A bug found on the way, fixed.** `capture_tradeshow_lead_account` joined
`option_list_values` on `v.option_list_id`; the column is `list_id`. PL/pgSQL
parses the whole condition before it can short-circuit the
`_lead_source_id IS NOT NULL` half, so **every** tablet capture raised 42703 and
was rejected by the queue as permanent — the booth flow had not saved a lead
since that function shipped on 8 Sep. Same signature, checks, owner and grants;
only the column reference changed. Verified end to end as a real seller in a
rolled-back transaction: capture → review → rename, badge value intact, replay
after review changes nothing, and a DELETE removes nothing.

**Not done.** Drafting the fields from the audio with the assistant was offered
as optional-if-cheap. It is not cheap: `assistant-chat.server.ts` accepts text,
images and file parts — there is no audio path and no transcription anywhere in
the app — so it would need a speech-to-text provider, a server route, and the
private recording leaving its bucket. Skipped deliberately, not forgotten.

### Reassign a book: split a departing rep's book across offices (9 Sep, Mark; branch `wt/reassign-book`)
`src/routes/_authenticated/reassign.tsx`, `src/lib/reassignment.ts`,
`src/lib/reassign-book.ts` (+ test), `src/lib/account-timeline.ts`,
`supabase/migrations/20260909130000_reassign_book_atomically.sql`
### Pipeline stage rules — the server side (9 Sep, Mark)
Migrations `20260909120000_touchpoint_outreach_methods`,
`20260909120100_pipeline_outreach_rules`, `20260909140200_pipeline_no_service_retry`,
`20260909140100_pipeline_activate_client_onboarding`; `src/lib/pipeline-rules.ts`
(+ test), `src/lib/onboarding-questions.ts` (+ test), `src/lib/accounts.ts`,
`src/lib/followup-rules.ts`, `src/lib/rep-nudges.server.ts`, `src/lib/coaching.ts`

Mark's rules for how a prospect moves between stages, as data and sweeps.
The board popups are the UI agent's; this is what they call.

**Ready → Active Outreach** "the moment the rep logs their first attempt" —
was: first *call* only (Daffa's `advance_ready_on_first_call`). The existing
auto-advance engine gained an `attempt_logged` condition (any outbound
touchpoint) and Ready is re-armed with it.

**The outreach standard.** Five attempts, at least three methods, on five
separate days, within thirty days. Attempts are outbound touchpoints; the
six methods are phone, email, text, showing up in person, LinkedIn and mail —
`text`, `linkedin` and `mail` are new `touchpoint_type` values (LinkedIn and
mail are hand-logged; text still expects the SMS gateway). Five tries in one
afternoon are one day, in the office's calendar (`America/New_York`).

**Active Outreach → Ghosted, by itself.** 30 days with no activity, or the
standard used up with no reply. The card warns from day 24 (`warning`), the
rep is told once per stretch of silence, and can snooze **once** per stage
stay (`pipeline_snooze_ghost`; the second call is refused). The move is
`pipeline_ghost_sweep()`, run from the ten-minute `stage_advance_sweep()`
cron that already existed — no second engine. **Active Outreach →
Conversation Established** on any response — an inbound touchpoint or an
outbound one marked replied ("even a receptionist") — a `reply_received`
condition on the same engine. **Conversation → Ghosted** on 30 silent days,
same warning, same snooze.

**Manual ghost** is never blocked; every move into Ghosted, by hand or by
the sweep, is logged in `pipeline_ghost_events` with the attempt count at
that moment. `pipeline_manual_ghost_signal(days)` names reps whose manual
ghosts mostly came under the standard, and the coaching sweep raises it to
the manager as a `quick_ghosting` nudge.

**No Service Needed**: `pipeline_mark_no_service(account, reason, 6|12)` sets
the reason and `reactivate_on`; on that date the sweep returns the record to
Active Outreach with a "Reach out again" task. **Active Clients**:
`pipeline_activate_client(account, green_light_date)` — the date is editable
and starts the Farming clock — and `pipeline_apply_onboarding(account,
answers)` turns the popup's answers (catalogue in `onboarding-questions.ts`,
keyed by label) into tasks, compliance items and `account_referral_fees`.

**Nothing was ghosted retroactively.** Every account got
`rule_clock_started_at` = the deploy timestamp; the timers count from the
later of stage entry and that. Had the rule been retroactive, 2 records
(both demo, 0 real) would have moved on deploy day. First possible automatic
ghost: 9 Oct 2026. Everything the card needs is one view,
`pipeline_rule_state`, under the accounts RLS.
### Prospect view: six corrections against the full record (9 Sep, Mark)
`src/components/account-prospect/prospect-timeline.tsx`, `deal-timeline.tsx`
(optional `pageSize`/`className`), `src/components/account-header-chips.tsx`
(+ render test), `routes/last-visit-badge.tsx`, `accounts.$id.tsx`,
`prospect-record.tsx`, `prospect-stage-line.tsx`, `prospect-view-helpers.ts`
(+ tests), `polaris-account-panel.tsx`, `prospect-dock.render.test.tsx`.
Branch `wt/prospect-parity`, one commit per correction.

Mark reviewed the prospect view against the full record and sent six
corrections, each with a screenshot.

**1. Full Timeline.** "Use this form full record for prospecting as well."
The prospect layout's own list of the feed is gone; `ProspectTimeline` is the
full record's `DealTimeline` — search, the activity filter, Add note, Jump
to, due and pinned notes, the rule that raised a task, Reply — rendered in
the prospect layout. It keeps the bounded page it had ("Show earlier
activity") through a new optional `pageSize`; the full record leaves it unset
and renders as before.

**2. Header chips.** "These should show on the prospects page as well." The
status pill, the type chip and the multi-office footprint chip are lifted out
of the route into `account-header-chips.tsx` and used by both headers. The
prospect header now carries status, compliance, last visit, office,
footprint, type and the same Labels chip, one line at laptop width — long
chips truncate with full text in a title — and a second line of chips under
the name below `xl`. The "2" in Mark's screenshot is read as the footprint
chip's office count; it shows only on a multi-location account.

**3. Rail colour.** "This thin line needs color to it, just grayed out since
it's not the active section." The rail and its markers take the current
pill's own `--primary` in three strengths — passed at 70%, ahead at 20–25%,
current solid — from the first marker's centre to the last. Tokens only,
pinned by `railTone` tests. The chevron path on the full record colours done
stages `--success`; the rail follows its own pill instead, so the line reads
as one colour dimmed rather than two hues. A one-token change if Mark wants
green.

**4. Close-outs visible.** "These are missing from prospect." No Service
Needed and Ghosted are stages on the rail again, after a hairline gap, on
their own dashed line in the destructive tone, so they are never read as the
step after Active Client. Same MoveDialog and reason prompts. `partitionStages`
(tested) puts every active close-out after the forward steps whatever its
sort order.

**5. Polaris under Documents.** "Move this under the documents." Polaris sits
at the foot of the contact column, beneath the Documents section; the dock is
two columns from `lg`.

**6. Polaris smaller.** "And smaller." Idle, the card is one header line, the
input (the intro is its placeholder) and the three quick asks — no fixed
height, no empty transcript. The bounded, scrollable transcript opens above
the input once a question is sent. Same asks, same confirm-before-write.

Verified against code, tsc, vitest and static renders only — no signed-in
session was available to look at any of it live; the one-line header at
laptop width and the rail on a tablet are the two things to eyeball first.

### Prospect view: the documents section beside the contact card (9 Sep, Mark)
`src/components/documents-panel.tsx` (+ compact render test),
`src/lib/prospect-documents.ts` (+ test),
`src/components/account-prospect/prospect-record.tsx`,
`prospect-contact-bar.tsx`, `prospect-activity-dialog.tsx`

Mark, with a screenshot of the contact card and its action row: "add the
documents section here." A prospect's paperwork — the proposal, the contract
out for signature, the intake form — was two clicks away under More →
Documents, in a popup, with nothing on the screen saying whether there was
any.

**The section.** Under the contact card and the action row, in the same
column of the dock, the account's documents as a glance: the newest three
rows (name, kind, status pill, "13 days ago · David Stern"), a count in the
header with the awaiting-signature count in red beside it, Upload with the
type it files as, and **All documents** as the way in. Bounded the way the
Morning brief tile was corrected to be — a busy account makes the count
bigger, not the dock taller. A failed read says so and offers Retry; it is
never shown as "No documents yet".

**One panel, not two lists.** It is `DocumentsPanel` — the panel on the job
page — in a new `compact` mode, scoped by `accountId` the way the full record's
"Files on…" dialog and the composer's Files tab already scope it. Same
`listDocuments` scope query, same status badge, same metadata line, same
upload path and thumbnail generation, so the dock cannot disagree with the
full panel, and whatever RLS lets a viewer read of an account's documents
anywhere is exactly what they see here. **All documents** opens that same
panel in full, on this account, in a dialog; closing it re-reads the section
and the timeline.

**Upload routes here.** The action row's Upload used to open the activity
popup on the composer's Files tab, which hosted the whole panel to reach one
button. It now opens the file picker of the section itself, so the file lands
in this account's documents with the type shown in the section's header. More
→ Documents is gone: the section's own **All documents** is that view.
Everything else on the row is as it was. (Superseded 17 Sep: Melly read the
row's Upload and the section's Upload as the same action offered twice, so the
row's is gone entirely — see the cleanup entry at the top of this file.)

**Tablet.** The section shares the contact column, so on an iPad in landscape
it sits under the contact card beside Polaris, and in portrait it stacks
beneath the action row; rows are 40px tall. Verified against code and a
static render only — no signed-in session was available to look at it live.

### Morning brief tile: a glance, counting real decisions only (8 Sep, Mark)
`src/lib/morning-brief.ts` (+ test), `src/components/dashboard/morning-brief-card.tsx`

Mark, with a screenshot: "This is too large on the dashboard." The tile said
"147 things need a decision" and rendered three sections in full, six two-line
rows each plus "+61 more", the full height of the column.

**Size.** The tile is now the headline count, one line per section with its
count and a dot in the colour of its worst row (Needs you today · N, Off pace ·
N, Slipping accounts · N), and the three most urgent rows across every section
— red before amber before blue, then the section a manager reads first
(`topBriefItems`, tested). Everything else, with every Open / Book / Message /
Assign action, is behind **Open brief**, a right-hand Sheet that goes full
width on a phone. Same Card, header and padding as Rep's cost and New leads
beside it; it no longer grows with the pipeline.

**Content.** The six identical rows (Liberty Mutual, USAA, Farmers, Nationwide,
The Hartford, Amica — "29d in stage, window is 21d") were not demo data: they
are the national carrier **reference records** the 10 Aug migration seeded
(`is_reference`, `is_demo = false`) and a later migration took off every
pipeline (`stage = 'reference'`, `stage_id = NULL`). The brief's stall rule did
not know that stage, fell back to the 21-day default and measured from the
insert 29 days earlier. Reference accounts are now excluded at the query and
by `isRealAccount`. Demo rows were counted everywhere too; the brief now does
what the fleet screens do — `.eq("is_demo", false)` on accounts, tasks,
expense_requests, account_stage_history, touchpoints and contacts — and drops
standings and tasks belonging to `profiles.is_demo`. `supply_requests` has no
`is_demo` column, so that count is unfiltered. The "Test Sales Rep …" people in
the screenshot are not in the repo; if they are real logins rather than demo
profiles, their overdue tasks are still real and still count. Verified against
code and the seed migrations only — the Lovable endpoint was returning
`request_cancelled` throughout.

### Documents grid shows the file — image and first-page PDF thumbnails (7 Sep, Mark)
`src/lib/document-thumbnails.ts` (+ test), `src/lib/documents.ts`,
`src/components/document-viewer.tsx`, `src/components/documents-panel.tsx`,
`src/routes/api/documents.$id.file.ts`, `package.json` (`pdfjs-dist` 6.3.289, pinned)

Mark: "add a preview to the file with image." In the tile view every document
was a page glyph labelled `1p`, `ESX` or `FILE`, so four documents on a job
looked the same and you opened each one to find the photo report.

**An image now shows itself and a PDF shows its first page.** The thumbnail is
a ≤512px WebP made once in the browser and kept beside the file at
`<documentId>/thumb.webp` in the private `documents` bucket — the same sidecar
namespace a work authorisation's `signature.png` already uses, which all four
object policies grant through the document row. So it needs **no column and no
migration**, it is readable by exactly the people who can read the document,
and it can be added to a signed document (the policies refuse replacing a
signed document's objects, not adding one). It is read back through
`/api/documents/$id/file?variant=thumb`, the same cookie-authorised route as
the document itself; the bucket stays private.

**Made at upload, or lazily.** A new upload draws its thumbnail from the bytes
already in hand. A document filed before today is drawn the first time its tile
is looked at, and the viewer draws one from the PDF it has just read for its
page count. Rendering PDFs needs pdf.js — `pdf-lib` reads a PDF but cannot draw
one — and it is loaded on demand inside the one function that draws a page,
never in the main bundle and never in the server's entry graph (the Workers
build has already been taken down once by a PDF library imported at the top of
a route). Through the route it reads by byte range, so page one of a large photo
report does not pull the whole file.

**The grid never downloads files any more.** It used to fetch every PDF whole
to print a page count and every ESX whole to print a claim number. Now each
tile costs a one-byte range probe and one small image; the list view shows a
thumbnail only when one exists and never starts a download. An ESX, a
spreadsheet, a Word file or a draft rendered on demand keeps a typed icon on
the muted ground the previews never use, with its kind written under it
("Xactimate estimate", "Spreadsheet"), so an icon is never mistaken for a
preview of a blank page. A missing or failed thumbnail is that icon, never a
broken image. The viewer still reads the ESX and the page count on open.

Live data when this shipped: seven documents, three with files (a 1 MB PDF, a
1 MB ESX, a 14 KB XLSX); the size caps are for what comes later.
### Photo folders follow the room list on their own (Mark, 7 Sep)
`src/lib/job-rooms.ts` (+ test), `src/components/job-rooms-tab.tsx`,
`src/routes/_authenticated/jobs.$id.tsx`, `src/lib/photo-folders.ts`,
`src/lib/job-photos.ts`, `src/lib/photo-share.server.ts`,
`src/components/photo-folder-rail.tsx`

His words: "rooms in pics should be auto as well."

**Before.** A room got a photo folder only when somebody pressed *Generate
photo folders* on the Rooms tab, and only if the job already had an album —
which it only got from a first photo. Production has zero room-linked folders.
The folders Mark sees, `Unit 100 › Kitchen`, came from the multifamily
template, while a room folder would have landed flat at the root as
"Unit 100 · Kitchen" beside it.

**Now.** Adding a room, renaming it, or giving it a unit runs a folder pass
after the save: the album is created if the job has none, a `Unit 100` folder
is found (by label or as typed) or made, and the room's folder is created
inside it, or an existing folder at that path is adopted. An empty folder
follows its room when the room is renamed or moved. **A folder that holds
photos is never renamed or moved, and no folder is ever deleted** — the pure
`planRoomFolders` is what says so, and it is tested. The pass never blocks the
room save: the room is committed first and folder trouble is shown on the tab.
*Generate photo folders* became *Repair photo folders*, for jobs whose rooms
predate this. Room folders always show on the Pictures tab even while empty,
and a photo's room label is now the folder path, so two units' kitchens stop
merging into one "Kitchen" group.

---

### One room list for the whole job (Mark, 7 Sep)
`src/lib/room-choice.ts` (+ test), `src/components/room-select-items.tsx`,
`src/components/room-name-picker.tsx`, `src/components/estimate-editor.tsx`,
`src/components/invoice-editor.tsx`, `src/components/equipment-panel.tsx`

His words: "when creating rooms in the rooms page, it should be tied to all
rooms everywhere on the job."

Equipment and the drying log already read `job_rooms`. Estimate and invoice
scopes did not — their room was a free text box, and every one of the six
stored values in production ("Lobby", "Stairwell", "Unit 4C kitchen"…) names
no room. The scope room is now a picker offering the job's rooms grouped by
unit, storing the label the Rooms tab prints. `room_name` **stays free text,
with no foreign key**: an estimate is often written before rooms exist, a
Xactimate import names areas its own way, and a stairwell is not a room.
"Other…" keeps typing possible, and a stored value off the list is shown as it
is, marked, and left until someone re-points it. Equipment's room pickers now
group by unit through the same shared list.
### Drying log — two sections removed, room above the fields, unit picker, movable cards (7 Sep, Mark; branch `wt/drying-layout`)
`src/components/job-drying-log.tsx`, `src/lib/drying-log.ts` (+ test),
`src/lib/drying-room-picker.ts` (+ test, NEW), `src/lib/drying-card-order.ts`
(+ test, NEW). Five commits, one per request, on `wt/drying-layout`.

His words, in order: "remove the unaffacted section" · "remove this as well"
(the Dehu outlet block) · "for now room should be above" · "for the drying log
add a section for unit numbers" · "allow cards to move around".

**Unaffected and Dehu outlet are off the form, not out of the record.**
`DRYING_POINTS` gained an `entry` flag and the form draws from `ENTRY_POINTS`
(Outside, Inside, Affected). The two retired points keep their labels, their
chart series, their table columns and their lines in the baseline comparison,
and `buildReadingRow` still builds a `dehu_outlet` row with its `equipment_id`
so an outlet reading held in the offline queue drains to the same row. The
`point` check constraint is untouched. The live `job_drying_readings` table
held **0 rows** in total on 7 Sep, so nothing was orphaned. The dehumidifier
picker went with its section, so the panel no longer reads
`equipment_placements` for machines.

**Room above the fields.** On `main` the room select was already the first
thing inside each row card (since f5b8e26d); it is now its own labelled block
at the top of every Inside and Affected card, above the chamber label and the
temperature/humidity boxes, and the delete button moved to a "Reading n of m"
line that only appears when a card has more than one reading.

**Unit, then room.** No unit field on a reading — the room carries its unit
(`src/lib/job-rooms.ts`, read as-is). A Unit box beside the Room box narrows
the room list to that unit and stops repeating the unit in every room's name;
picking a room straight off the full list settles the unit; changing unit drops
a room that is not in it. On a job with no units — a house, or the live
database, where `job_rooms.unit` is not applied yet — the Unit box is not
drawn at all. A unit picked with no room says, before the save, that the
reading will count for the whole property.

**Cards move.** Inside and Affected carry a grip and drag into either slot with
`@dnd-kit`, the dashboard grid's sensors and sortable pattern. The order is
saved per person in `user_view_prefs` (scope `drying_card_order`), the same
key-value table the sidebar order lives in: no new column, follows the person
between devices, and an admin can edit or clear the row without a deploy. A
hand-edited or unknown value reads as the default layout, and a card the saved
order does not name is appended rather than hidden. Outside is not a card — it
is fetched, not typed — so it does not move.
### Access screen — collapsible groups with counts, and a change history that records (Mark, 7 Sep)
`src/components/access/access-group.tsx`, `src/components/access/use-group-state.ts`,
`src/components/access/access-history.tsx`, `src/components/access/access-role-panel.tsx`,
`src/components/access/access-person-panel.tsx`, `src/components/user-editor.tsx`,
`src/components/user-permissions.tsx`, `src/lib/access-history.ts` (+ test),
`src/lib/page-access-admin.ts`, `src/lib/admin.ts`,
`supabase/migrations/20260907210000_access_audit_never_blocks.sql` (WRITTEN, NOT APPLIED)

His words, looking at the Permissions panel on a user's page: "this is not bad
for page access as well." He meant the shape — closed rows with a `12/14`
count, a search box above, a change history beneath — not the content.

**What already matched.** The Roles and People tabs already grouped pages by
area, already showed `on of total` on each group, already had a search. What
differed: the groups were flat cards that could not close, so a role was a
long scroll rather than eight rows readable at a glance; capabilities on the
Roles tab were one undivided list; and neither tab had any history at all.

**What changed.** Both tabs now render `AccessGroup`, the same closed-row-with-
a-count the user page uses, collapsed by default, opened by a click, opened on
its own when a group carries a personal Allow/Block, opened wholesale by a
search (a hidden match reads as "no results"). Capabilities on the Roles tab
are grouped by their catalogue group with the same counts. "Expand all ·
Collapse all" sits by the heading. Allow all / Clear only show on an open
group so closed rows stay a plain count. A "Change history" section sits under
every role and every person, and the user page's own history now reads through
the same component, so a row says *Page allowed · Pipeline · off → on · by
Mark · 2h ago* instead of a JSON blob.

**Where history comes from.** Nothing new is written for it. `role_change_audit`
already receives one row per write to `user_roles`, `role_permissions` and
`user_permissions` through SECURITY DEFINER triggers — actor, time, target,
entity, before and after. Pages are rows in those same two permission tables,
so page changes were already covered on the role side.

**Except the person side never worked.** The `user_permissions` audit trigger
(10 Aug) emits `permission_granted` and friends; the CHECK on `action` (13
Aug) allows only `user_permission_added` and friends. An AFTER trigger that
violates a CHECK fails the write that fired it, so every insert, update and
delete on `user_permissions` has failed since 13 August — production has zero
rows in it — and the Allow/Block control on the People tab and the grant
dialog on the user page both die with a constraint error. The pending
migration renames the actions, wraps both permission audit triggers so a
failure to record a change can never refuse the change, and adds the old
names to the CHECK so nothing trips on them. No table or column changes;
`types.ts` is untouched. Until it is applied, the People tab cannot save an
override (as today), and history shows what the role triggers did record.

**Unchanged on purpose.** `page-access.ts` — the resolver — is not touched.
Owner/Admin/Dev still render locked with "Full access role"; the three-way
Role/Allow/Block control stays; unseeded, empty-table and unknown-role fall
back exactly as before; nothing scrolls sideways.

**Still wanted: the old checkbox grid (David, 9 Sep call, ~18:29 and ~35:01).**
He said twice that he preferred the way permissions used to read — a grid of
checkboxes, roles against capabilities, the whole matrix on one screen — over
the collapsed groups this round shipped. The two are not the same shape: the
groups answer "what can THIS person do", the grid answers "who can do THIS",
and he wants the second back.

Not actioned here, and deliberately not a quick revert: the collapsed groups
were Mark's own request from 7 Sep (above) and the counts, search and change
history hang off them. This is a requirement to carry into the **planned
permissions overhaul**, where the two views can be reconciled — most likely as
a matrix view alongside the per-person one rather than instead of it. Whoever
picks that round up should start from this note and confirm the shape with
David before building either.

---

### Outbound calendar sync — edits and cancellations now reach Outlook (security review, 4 Sep)
`src/lib/calendar-push.ts` (+ test), `src/lib/calendar-push.server.ts`,
`src/lib/calendar.ts`, `src/lib/graph.server.ts`, `src/lib/graph.functions.ts`,
`src/routes/api/public/hooks/graph-sync.ts`,
`src/routes/_authenticated/admin.integrations.outlook.tsx`,
`src/routes/_authenticated/calendar.tsx`,
`supabase/migrations/20260904120000_calendar_outbound_push.sql` (WRITTEN, NOT APPLIED)

**The bug.** `calendar.ts` stamped `sync_state: 'pending_push'` in four places
and nothing anywhere read it, and `cancelCalendarEvent` had no callers. Only
creation reached Graph. So somebody rescheduled an inspection or called a job
off in the CRM and every attendee kept the original invite — turning up at the
old time, or turning up at all.

**The fix is to drain the queue that was already there** rather than add a
second mechanism. `calendar-push.server.ts` reads `pending_push` and pushes
through the same app-only Graph transport the create path uses: PATCH for a
time, date, place, title, description or attendee change; `/cancel` for a
cancelled meeting that has attendees to notify; DELETE for a cancelled solo
appointment, where `/cancel` is not a valid verb. **No new Graph scope** —
`Calendars.ReadWrite` already covers all three.

**A Microsoft failure never costs the edit.** The row is committed first and
the push is asked for afterwards without being awaited, so a save always
lands. Failures retry with backoff on the scheduled Graph job; after five they
go to `sync_state = 'error'` and appear on the Microsoft 365 admin screen with
Microsoft's own message and a Retry button, and the cron notifies admins. A
queue that is merely old is reported too, so a stuck row cannot hide behind an
unapplied migration.

`deleteEvent` no longer hard-deletes a row that has an Outlook copy — that
dropped the only record of the external id and stranded the invite. It
cancels instead; cancelled events were already hidden from every view.

**Pending migration.** 20260904120000 adds `sync_attempts`, `last_push_at` and
`sync_error`. Until it is applied the queue still drains — reads and writes of
those three fall back — but failures retry without backoff and never reach the
`error` state, so they surface as an ageing pending queue instead.

---

### Drying log — inside beside outside, water category, baseline, meter photo (4 Sep call, Melly Chein)
`src/components/job-drying-log.tsx`, `src/lib/drying-log.ts`,
`src/lib/drying-day-grid.ts`, `src/lib/drying-baseline.ts` (+ test),
`src/lib/drying-meter-photo.ts` (+ test), `src/lib/water-category.ts` (+ test),
`src/lib/offline-queue.ts` (`drying_reading` now carries files),
`supabase/migrations/20260904090000_drying_interior_readings.sql` (WRITTEN, NOT APPLIED)

Her words: "I need one for outside exterior, I need one for interior. So
exterior, I need it to measure automatically every morning at nine o'clock. And
then interior, we'll manually have to put in the temperature and the humidity,
in addition to uploading the picture."

**Inside is a fifth drying point**, the pair to the automatic exterior baseline
— one figure a day for the whole property, never fetched, because no weather
model knows what the inside of a flooded house reads. It does not replace the
per-room affected/unaffected pair. Each day square now carries **out X° · in
Y°** side by side with a ▼/▲ against the baseline; the square did not grow, the
unaffected control moved into its hover text.

**The water category** (1 clean / 2 grey / 3 black — "a regular sink water
category one, or a stormwater category two, sewage is category three") sits at
the top of the log because it governs everything under it, and a category 3
loss is called out in red: porous materials come out, they are not dried. Never
defaulted — an unset category reads as unset.

**The baseline set** is ticked when a crew logs it ("job start, or when the
equipment went in — should really be the same time"), and the panel warns when
the baseline day and the first equipment placement disagree. With nothing
flagged the first logged day is used and every surface says the baseline was
*inferred*. Days are read against it point by point, with movement smaller than
1 °F called flat because that is the meter's own error.

**A photo of the meter** rides with every reading through the job photo
module's `makeVariants` and the existing offline queue (the `drying_reading`
kind now carries blobs), into a new private `drying-photos` bucket. The numbers
are written first and the row only points at the object once it is uploaded, so
a bucket that will not take the image cannot cost the reading.

**Not done — the OCR she asked about.** "Can it read the numbers off the
photo?" Not in this pass. The seam is `readMeterPhoto` /
`registerMeterPhotoReader` in `src/lib/drying-meter-photo.ts`, already called on
every photo attached; registering a reader is the only change needed.
`applyMeterRead` already enforces the policy (fill empty boxes only, never
overwrite a typed number, drop a low-confidence or impossible read) and
`values_source` is the column that will record it.

**Pending migration.** 20260904090000 is written and NOT applied, and neither is
the drying log's own 20260901120000. The panel probes for the new columns and,
while they are missing, hides the inside boxes, the baseline tick and the photo
field and says why — an interior reading would be refused by the `point` check
and a photo would have no bucket. Everything the older schema understands still
saves.
### Public intake form trimmed to four fields, photos and notes (3 Sep, Melly Chein)
`src/lib/intake-form.ts`, `src/lib/intake-form.test.ts`, `src/lib/intake-photos.functions.ts`,
`src/lib/intake-public.functions.ts`, `src/lib/intake-questions.ts`, `src/lib/intake-inbox.ts`,
`src/routes/intake.$token.tsx`, `src/routes/_authenticated/admin.intake-questions.tsx`,
`src/routes/_authenticated/intake-inbox.tsx`, `src/routes/_authenticated/jobs.new.tsx`,
`supabase/migrations/20260903224000_intake_form_trim.sql` (WRITTEN, NOT APPLIED)

Melly: "cut it down to just the first four questions that are on the intake form right now. Then
there should be an option to add photos and a box for notes. Photos and notes are optional but the
first four should be with an asterisk."

The standalone public form is now property address, name, phone, email — all four required and
asterisked, and the send button waits for all four — then an optional photo picker and an optional
notes box. Loss type, date of loss, carrier, claim and policy come off the public form; the office
asks those on the call. Notes land in the job's initial loss description when the lead becomes a
job. What "complete" means is decided once in `intake-form.ts`, shared by the form, the server
function and the tests.

The questionnaire is still defined on the admin screen, not in code: `ask_on_public_form` says
which of those questions the public form also asks, default off. The booth variant keeps its own
shorter rule and its own presentation — one form, two presentations.

Photos go to a private `intake-uploads` bucket through a signed upload URL minted against the link
token, landing under the request's own folder, so a submission can only claim photos uploaded under
itself. Staff see them in the inbox through signed read URLs minted only after RLS has let them
read the submission.

### Company organisational chart — visibility and billing (3 Sep, Melly Chein)
`src/lib/company-hierarchy.ts`, `src/lib/company-hierarchy.test.ts`,
`src/components/company-hierarchy-panel.tsx`, `src/components/site-escalation-card.tsx`,
`supabase/migrations/20260903090000_company_hierarchy.sql`,
`supabase/migrations/20260903090500_account_properties.sql` (both WRITTEN, NOT APPLIED)

Completes the chart Melly walked twice: company → owner/CEO → corporate → regional managers →
assets → whoever runs each asset, with billing off to one side. An asset is a physical property —
an apartment complex, a building, a nursing home.

**Visibility follows the tree.** "This guy works specifically for this building; when it comes to
the next building he has no idea it exists. However the person above him knows about these two
buildings but not the other two." `propertyScope()` states it once: your own buildings plus every
building run by anyone beneath you, and nothing else. The account page prints, under each person,
which buildings they may be told about and whether they run them or only oversee them. Behind it
is a real fire job with four people from one company — regional, corporate, super, maintenance
director — where the paperwork had to reach the right one: "We don't want to cause any harm with
relationships." Same function is the gate a client portal for public adjusters and building owners
would sit behind.

**Billing at either level.** Sometimes one accounts-payable contact covers the company, sometimes
each building bills its own. `resolveBilling()` answers per building: the building's own AP contact
wins outright, the company's answers otherwise, never both. A Billing contact tied to one building
is never offered as another building's fallback. Both the account panel and the 2am job card say
which of the two they are showing. Building assignment rows grew a role picker so an asset-level AP
contact can actually be recorded.

**Open:** nothing in the app enforces this visibility yet — it is displayed and computed, and the
portal that would enforce it does not exist. No new migration was needed; the two written-not-
applied migrations above already carry position, reporting line, assets and the per-building
position override.
### Job labour reading zero on a job documented by daily field forms (Melly Chein, call)
`src/lib/job-labour-rollup.ts` (new), `src/lib/job-labour-rollup.test.ts` (new),
`src/components/labour-cost-coverage.tsx` (new), `src/lib/job-reports.server.ts`,
`src/lib/job-reports.ts`, `src/lib/job-reports.functions.ts`,
`src/components/job-labour-panel.tsx`, `src/components/job-running-cost-panel.tsx`,
`src/components/job-cost-breakdown.tsx`, `src/components/job-report-panel.tsx`,
`src/lib/reports-engine.ts` (report 11)

Melly: “We have a crew of two, they were there for an hour, so a total of two
hours on site. Where do I see that? It says total hours. It’s not taking it from
field tickets… timecard here is zero.” It was zero because **every** labour
figure in the app — the job report snapshot, the Labor & profitability panel,
the Running cost labour line and the org-wide labour report — counted
`time_entries` and nothing else. A daily field form records a crew SIZE and two
time boxes, never a clock-in, so a job worked entirely off field forms had no
rows to count. Verified on production job `1b000000-…-006`: two field forms on
2026-09-01, zero time entries, `job_labour_summary` returning zeros across the
board.

One function now decides what a day of labour is worth — `rollUpLabour` — and
every surface reads it. Hours are man-hours: crew size × hours on site, so two
crew for an hour is two. The field form is the record for any day it covers and
the clock rows for that same day are reported but never added; a day with no
usable form falls back to the clock, per day rather than per job. A form whose
times will not parse contributes nothing and is raised as a line to fix — a
blank time box is unknown, not zero. Every figure now carries the source it came
from, on the panel, on the report and in the PDF.

Labour COST still prices named people out of `time_entries`, because a crew size
has no rate until `20260902200500_field_ticket_crew_hours` is applied. Rather
than let the hours card and the money cards drift apart — the bug recorded under
“Job money panels contradicting each other” below — every panel that shows
labour money renders the same `LabourCostCoverage` sentence off the same rollup,
saying exactly how many of the man-hours the money prices.

**Migration dependency:** `20260902200500_field_ticket_crew_hours` is written and
NOT applied, so `job_ticket_crew_hours()`, `field_ticket_crew_reviews` and
`crew_rate_for()` do not exist yet. The rollup prefers the RPC and falls back to
deriving the lines from `field_work_tickets` (which does exist) in TypeScript, so
the hours land today; accept/adjust/dismiss and crew-rate costing arrive with the
migration and change no figure that is already right.

### Trade show lead capture — selfie + voice note on a tablet (3 Sep meeting)
`src/components/tradeshow-lead-capture.tsx`, `src/components/voice-note-field.tsx`,
`src/lib/tradeshow-capture.ts`, `src/lib/tradeshow-lead-writes.ts`,
`src/lib/offline-queue.ts` (new `tradeshow_lead` kind, multi-blob items),
`src/routes/_authenticated/tradeshows.$id.tsx`, `src/lib/tradeshows.ts`,
`supabase/migrations/20260903212000_tradeshow_lead_capture.sql` (WRITTEN, NOT APPLIED)

Melly does not want to type at a show. The show page now has a big **Lead**
button: front-camera selfie with the contact → voice note → name / company /
phone or email → Save. Save creates the account attributed to the show (same
row the typed pipeline form creates, plus `tradeshow_id`, the Tradeshow lead
source, the show name as source detail), a primary contact when a name was
given, the photo and recording in a new private `tradeshow-leads` bucket with
a `tradeshow_lead_media` row each, and a `meeting_in_person` touchpoint so the
account timeline starts at the booth. **Type it in** opens the same dialog on
the last screen for anyone who would rather type.

Offline: the lead is held on the tablet — files included — through the
existing sync queue and goes up when the hall has signal; the page shows how
many are waiting. All writes are keyed by ids generated at the tap, so a replay
files one lead. The recorder is the chat module's `VoiceRecorder`; the photo
re-encode is the job photo module's `makeVariants`.

**Not done:** `tradeshows.leads_captured` is still the hand-typed number on
the show; captures count under "Accounts created" on the ROI block. Reps who
cannot `can_manage_location` their office are refused by `accounts_insert`
(the same rule the pipeline form is under) and the queue says so.

### Trade show intake link — QR on the booth (3 Sep meeting, clarified by Mark)
`src/components/tradeshow-intake-links.tsx`, `src/components/qr-code.tsx`, `src/lib/qr.ts`,
`src/lib/tradeshow-intake.ts`, `src/lib/tradeshow-intake.server.ts`,
`src/lib/intake-public.functions.ts`, `src/routes/intake.$token.tsx`,
`src/lib/intake-inbox.ts`, `src/routes/_authenticated/intake-inbox.tsx`,
`src/routes/_authenticated/jobs.new.tsx`,
`supabase/migrations/20260903220000_tradeshow_intake_links.sql` (WRITTEN, NOT APPLIED)

The show page has an **Intake link** panel: create a link (label defaults to
the show), copy the URL, show it as a QR code (dependency-free encoder,
byte mode, level M, versions 1–10, verified against OpenCV's decoder),
withdraw it. It reuses `intake_requests` with two new columns: `tradeshow_id`
and `multi_use` — a standalone link closes after one submission, a booth QR
is scanned by everyone who stops. Same permission as a standalone link (you
must manage the office it belongs to); a show link must carry an office
(check constraint) so the existing location-scoped RLS covers it unchanged.

Attribution: the public form for a show link is headed by the show and asks
only name, company, phone/email and "what can we help with". On submit the
server creates the account the same way the tablet capture does
(`tradeshow_id`, Tradeshow lead source, show as source detail, primary
contact, first touchpoint) and stamps `intake_submissions.account_id`, so it
appears on the show page with a **Form** tag beside tablet captures. The
submission also lands in the intake inbox tagged **Trade show** (linked to
the show); a job created from it carries `jobs.tradeshow_id`.

### Client health and back-to-pipeline (client-health)
`src/lib/client-health.ts`, `src/lib/pipeline-reversion.ts`, `src/lib/client-health.test.ts`,
`src/components/client-health-badge.tsx`, `src/components/account-actions.tsx`,
`src/lib/active-clients.ts`, `src/components/active-clients-kanban.tsx`,
`src/components/active-clients-cards.tsx`, `src/routes/_authenticated/farming.index.tsx`,
`src/routes/_authenticated/accounts.$id.tsx`, `src/routes/_authenticated/admin.client-health.tsx`,
`src/routes/api/public/hooks/cadence-sweep.ts`, `src/lib/automation-engine.server.ts`,
`supabase/migrations/20260903211000_pipeline_reversion_reasons.sql` (WRITTEN, NOT APPLIED)

Two decisions from the 2026-09-03 meeting with Melly Chein.

**At-risk client status.** "At risk" is now one definition — `computeClientHealth` — driven by
thresholds in `app_settings.client_health` (Settings → Client health, no deploy): Watch after 90
days without a cadence-counting touchpoint, At Risk after 120 (Melly's "no follow-up for four
months"). The Active Clients board, cards, list, Client 360, the account header, the nightly
sweep and the automation engine all read it, and every band carries its reason ("No touch in
134 days"). The four Farming stages stay as hand-set overrides that can only make health worse;
the kanban refuses a drag *below* the metric band and says why.

**Move back to pipeline.** Account header and Client 360 carry "Move back to pipeline": pick an
open Prospecting stage (earliest by default), pick a reason (managed list
`pipeline_reversion_reason`, code fallback until the migration is applied), optional note.
Writes `stage_id`, clears the health stage, and rides the reason into `account_stage_history`
through the existing `trg_accounts_stage_history` trigger — that table only grants SELECT to
authenticated users, so the trigger is the only door in. Nothing is deleted.

**Open for Melly:** the exact metric set. Today it is days since last touchpoint; a satisfaction
floor, task-overdue days, and a per-touch-type timeline (gifts, birthday wishes, calls) are the
next candidates. Also `person_accounts()` in SQL still hardcodes 90 days.

### Rate limiting and MFA (security-layers)
`src/lib/rate-limit.ts`, `src/lib/rate-limit.server.ts`, `src/lib/auth-guard.functions.ts`,
`src/lib/mfa.ts`, `src/lib/mfa.functions.ts`, `src/components/turnstile-widget.tsx`,
`src/components/mfa-code-input.tsx`, `src/routes/auth.tsx`,
`src/routes/_authenticated/security.tsx`, `src/routes/_authenticated/admin.security.tsx`,
all 16 files under `src/routes/api/public/hooks/`,
`supabase/migrations/20260903120000_rate_limit_counters.sql` (WRITTEN, NOT APPLIED)

The app had no rate limiting anywhere and never surfaced Supabase's TOTP MFA.
Counters live in Postgres because the worker has no KV or Durable Object
binding and module state does not survive a Workers isolate. Sign-in is
throttled per account and per IP (Supabase itself has no per-account limit at
all); public token endpoints and every webhook are throttled per IP, behind
their credential check rather than in front of it. MFA is opt-in with an
admin adoption list; Turnstile is a script tag plus two dashboard settings.

**Open for the client, not for us:** Cloudflare Turnstile secret + Supabase
"Enable CAPTCHA protection"; `VITE_TURNSTILE_SITE_KEY`; and Cloudflare WAF
rate-limiting rules at the edge, which we deliberately did not try to
reimplement in app code.

**Still unguarded:** `/share/$token` (`src/routes/share.$token.tsx` and
`src/lib/job-share*` were off-limits this round). Same throttle as
`/intake/$token` and `/sign/$token` should be added to
`loadSharedJob`-equivalent in `src/lib/job-share.functions.ts`.

### Photo multi-select and remove
`src/components/job-photos.tsx`

Tick box on every tile, shift-click for a range, **Select all** per room, and a
sticky selection bar. Removal uses the soft-delete columns that already exist
(`photos.deleted_at` / `deleted_by` / `deleted_reason`) so nothing is destroyed
and permission guards can be layered on later without rework.

Image *documents* (`doc:` prefixed, sourced from `documents` not `photos`) can be
selected but not removed here — they have no `deleted_at`. The button says so.

This is the foundation the share and report actions hang off.

### Photos on an invoice (3 Sep, Melly Chein)
`src/components/invoice-photos.tsx`, `src/components/invoice-email-button.tsx`,
`src/components/photo-attach-invoice.tsx`, `src/lib/invoice-photos.ts`,
`src/lib/invoice-photo-grid.ts` (+ test), `src/lib/invoice-pdf.ts`,
`src/lib/photo-share-links.ts`, `src/lib/photo-share.server.ts`,
`src/routes/api/share.$token.photo.$id.ts`, `src/components/public-photo-gallery.tsx`,
`src/components/job-email-dialog.tsx`,
`supabase/migrations/20260903213000_invoice_photos.sql` (WRITTEN, NOT APPLIED)

"Attach images to an invoice", both places asked for: **Add images** on the
invoice editor (the Pictures tab's own tile grid, select-only) and **Attach to
invoice** on the Pictures selection bar beside Share / Attach to report. The
invoice remembers `photo_ids` (grid ids, `text[]`, print order) and prints them
as a **Photos** section after the closing statement — square cells, three
across up to nine, four across beyond, rows flowing across pages. Images go
through the same display-WebP -> canvas -> JPEG pipeline as the photo PDF (640px
long edge, ~40 KB each), so EXIF never reaches the document. Soft warning past
12; no hard cap.

**Include link to photos** mints a `job_photos` share link for exactly the
invoice's selection (`invoices.photo_share_link_id`), keeps it in step on every
change, prints the URL on the PDF and writes it into the invoice email (new
**Email** button on the editor -> `JobEmailDialog` with the PDF as a download
link and the photo link as a page). One control for what the link permits:
**View only** (default) or **Allow full-resolution download** — stored on
`share_links.allow_download_original`, which the public viewer and the byte
route now honour (`?size=original`, refused 403 on a view-only link). A revoked
or expired link is not printed.

Until the migration is applied the card and the bar action say so and stay
off; the PDF simply has no Photos section.

### Job money panels contradicting each other
`src/components/job-running-cost-panel.tsx`, `src/components/job-cost-breakdown.tsx`

Running cost reported **100% margin on any job with zero costs entered**, so an
uncosted job displayed as the healthiest on the board and never tripped the
margin-floor warning. Now reads "no costs recorded yet". The breakdown card
dropped its competing Revenue/Margin headline and is now scoped to cost by
component.

---

## ANSWERED — no code change, decision or third party needed

### Raven GPS is not live
Confirmed against production: the token exchange returns **403 before Klashwerks
ever evaluates our credentials**. Their API sits on AWS API Gateway and the block
carries `x-amzn-errortype: ForbiddenException` with a plaintext `Forbidden` body —
an AWS WAF block, not an auth rejection. The same endpoint from a residential IP
returns a proper JSON credential error, which proves the path and payload are
right.

App runs on Cloudflare, so its egress is a datacenter range. **Klashwerks must
allowlist it.** Not fixable in our code.

Related and still open: `fleet.index.tsx:224` shows "Raven receiving" based only
on configuration, never on whether data has arrived — see OPEN below.

### Google Cloud API setup
Five APIs actually required (Maps JavaScript, Geocoding, Places New, Maps Static,
Street View Static). Two keys: browser key referrer-restricted, server key with
**no IP restriction** — Cloudflare egress rotates, which is exactly what broke
Raven. Full instructions delivered.

### 18-capability gap audit
Published: https://claude.ai/code/artifact/b4068d75-606d-49b5-b6a6-7d456f8aeb91

8 built, 6 partial, 3 missing, 1 hardware. Everything missing is field production
documentation — daily logs, floor plans, moisture readings.

### Encircle-style floor plan scanning
Not a feature to build. "Under 6 hours" is a human drafting service. Options are
integrate with Encircle, use Apple RoomPlan via a native iOS companion (requires
LiDAR — **decide before buying PM tablets**), or import ESX/PDF and add a markup
layer. Build the restoration layer on top, buy the geometry.

---

## OPEN — raised, not started

### Migrate history out of JobNimbus
New import job, new migration

Gold Star's current system is **JobNimbus**. They want contacts, jobs and
especially **files** (contracts) pulled across, flagged as historical so old
work never mixes into new orders.

Verified: base `https://app.jobnimbus.com/api1/`, Bearer key generated in
JobNimbus settings and scoped by an Access Profile, results nested under
`results`, rate limited (429 → back off). Endpoints include contacts, jobs,
files, activities, tasks, estimates, invoices, payments, work orders, material
orders, products, budgets.

Two things to settle before writing any importer:

1. **`/files` returns records, not bytes.** Fetching the actual contract PDFs is
   a second call per file and the mechanism is unconfirmed. That is the
   difference between having a list of their contracts and having their
   contracts.
2. **JobNimbus keeps the company name ON the contact.** Recovery Hub splits
   `accounts` from `contacts`. Every imported contact has to be resolved into
   one, the other, or both — get it wrong and we inherit the mess we are
   migrating away from.

Cheapest first step is a **read-only trial pull** to count what is actually
there before designing the mapping. Needs an API key with full read.

### The one migration — four things at once
Write once, send to Lovable as a single prompt.

- `jobs.office_next_step`, `jobs.field_next_step` (text).
- `jobs.hoa` (nullable boolean — not required, unset is a real answer).
- `external_source` + `external_id` on `jobs`, `accounts`, `contacts`,
  `documents`, with a **unique constraint on the pair** per table. This is both
  the "this is old JobNimbus data" flag (`external_source is not null`) and what
  makes the import re-runnable instead of duplicating everything on a second
  pass. Do not reuse `is_demo` — demo data gets purged.
- `share_links` job-scoping + anonymous read-by-token RLS, and photo storage on
  `job_reports`, for the photo share and embed work below.

### Estimates: drag line items into order
`src/components/estimate-editor.tsx`, `src/components/invoice-editor.tsx`

`estimate_lines.position` and `invoice_lines.position` already exist and are
already used for ordering, and @dnd-kit is already a dependency (the dashboard
grid uses it). No migration. Do both editors together so they cannot drift.

### Record payment: capture what actually gets asked for later
`src/components/job-billing-panel.tsx`

The dialog collects **amount and method only**. `invoice_payments` already has
`received_at`, `reference` and `notes` columns sitting unused — so payment date
(defaulted to today) and check/ACH reference need **no migration at all**.

A receipt or check image does need storage. Worth adding alongside: deposit vs
progress vs final, who received it, and which carrier/payer when a job has more
than one.

### Job list: shorthand status codes
`src/routes/_authenticated/jobs.index.tsx`

Codes seen: `REF A 24 SCP SKT ESE AWP EQ:0`, red for missing, green for
satisfied. `AWP` maps exactly to `jobs.additional_work_pending` and `EQ:n` to
open `equipment_placements`. `SCP` is `jobs.scope`. **`REF`, `A`, `24` and `ESE`
need their meanings confirmed** before building. `SKT` is a sketch indicator and
would be permanently red — leave it out until item 4 exists.

Also wants **in status for N days** — `stage_entered_at` is already on the job.

Implementation: fetch estimates, documents and equipment placements in bulk for
the visible page and map client-side. No migration unless the list later needs to
sort or filter on these flags.

### Photos: share selected images by email
`src/lib/photos.functions.ts`, new public route, new migration

`share_links` already exists with token, `photo_ids[]`, expiry, note, revoke and
`allow_download_original`. `createShareLink` / `revokeShareLink` are written.
**Nothing calls them and there is no page to view a link.**

Blocked on a migration: `share_links` is keyed to one `project_id`, but a job's
Pictures tab merges photos from *several* albums plus image documents. Needs
job-scoping plus anonymous read-by-token RLS.

### Photos: hide timestamps and location on shared images
Mostly already handled and worth knowing. The "02:37 PM" on tiles is a CSS
overlay, not burned in. **EXIF is already stripped from everything we serve** —
variants are re-encoded through canvas to WebP, which discards it. Only the
original retains GPS, and `allow_download_original` already gates that.

Design note: make it **one** control ("view only" vs "allow full-resolution
download"), not two that can contradict — hiding stamps while allowing the
original download leaks GPS anyway.

### Photos: update an existing link with more images
`photo_ids` is an array so the data supports it; only create and revoke exist.
Needs an `updateShareLink` function and an "add to existing link" path.

Decision taken: links stay **per-send but individually updatable**, so adding
photos later does not retroactively expose them to everyone who ever had a link.

### Photos: attach selected images to a report — embedded
`src/lib/job-reports.functions.ts`, new migration

Reports today store only a photo **count** in their snapshot. Embedding needs
photo storage on the report plus PDF composition. Confirmed with Mark: images
embedded, not a link out.

### Photos: tags and notes
`photo_tags` and `photo_comments` **exist in the database with no interface
anywhere**. The Pictures tab already *reads* captions from `photo_comments` but
there is no way to write one.

Also: `photo-folder-rail.tsx` already exists and is used on `projects.$id.tsx`,
but not on the job Pictures tab — which is why our tab has no folder sidebar and
the reference screenshot does. Cheap win.

### Email delivery and open tracking
New webhook route, new migration

Provider is **Resend**, which emits exactly these events (`sent`, `delivered`,
`bounced`, `complained`, `opened`, `clicked`). There is no email webhook route
today and `email_logs` has no per-event status. `document_events` is the pattern
to copy.

Caveat worth designing around: the reference screenshots show 30+ "Opened" events
minutes apart, all from the sender's own domain. That is image-proxy prefetch
(Gmail cache, Apple Mail Privacy Protection) and security scanners, not a human.
**Delivered is trustworthy; Opened is a weak signal.** Store every event, display
"first opened + count", never drive automation off it.

Scope boundary: this covers system-sent mail only. Mail a rep sends from Outlook
goes through the Graph sync and is not tracked this way.

---

## OPEN — found in audit, unfixed

- **Graph mail sync duplicates touchpoints** — `src/lib/graph-sync.server.ts:258` upserts on `id` while never supplying one, and there is no unique constraint on `touchpoints.external_ref`. Inflates cadence health, goals and the leaderboard. Needs both a migration and the corrected conflict target.
- **Fleet badge reports connection, not data** — `src/routes/_authenticated/fleet.index.tsx:224` checks only that config exists. Worse, `raven-sync.server.ts:226` writes `status: "connected"` even when every GPS call failed. Should report the age of the newest position.
- ~~**Chaser offline map prefetch has never worked**~~ — `chase-prefetch.ts` read `VITE_GOOGLE_MAPS_API_KEY`, set nowhere. Fixed: it now reads the browser key through the one shared loader (`src/lib/google-maps-loader.ts`, see the routes-map round below).
- **Director task boards omit `location_id`** — `components/director/task-board.tsx:333` and `components/sales-director/director-task-board.tsx:187` bypass `createTask()`, making tasks invisible under RLS.
- **Three chaser numbers permanently zero** — `chase-jobs.ts:283` filters `status === "accepted"` but the enum is `approved`; the assistant uses task status `completed` but the enum is `done`.
- **`commissions.ts` fix half-applied** — the type declaration and `my-commissions.tsx:402` still reference `address_line1`, which does not exist on `jobs`.
- **Loss description never displays** — `jobs.new.tsx:317` writes `loss_description`; `jobs.$id.tsx:594` reads `initial_loss_description`; nothing writes the latter.
- **Merge tokens blank on generated documents** — `mergeDataForJob` keys off columns that do not exist (`address_line1`, `carrier`).
- **`/admin` admits sales leadership** and 25 of 27 admin child routes are unguarded. Needs a product decision, not just a fix.
- **`cadence-sweep.ts` ON CONFLICT targets a partial index** — raises 42P10. Same defect in `callrail.ts:122` and `outlook.ts:99`.
- **~25 screens render query errors as confident empty states** — the pattern behind most "it says nothing is there but there is" reports.

---

## Blocked on access

The Supabase MCP connection is authorised to a **different account** — it lists
only `monitex-sage-standalone` and returns "You do not have permission" for the
Recovery Hub project. Live database verification is unavailable until it is
reconnected, and any migration written here has to be applied through Lovable.

---

## Round 27 Aug — SHIPPED (committed and pushed)

- **Discount privacy** — a targeted discount printed "Discount on Labor - After bus. hours - Loyalty credit", naming both the line and the internal reason. It now prints as its own anonymous row inside the scope; whole-document discounts stay in the totals stack. The printed subtotal was a gross figure appearing nowhere else on the page; it now equals the rows shown. `estimates.ts`, `estimate-pdf.ts`, `invoice-pdf.ts`
- **Closing statement** — `estimates.closing_statement`, `invoices.closing_statement`, printing after the totals. Migration `20260827130000_closing_statement.sql`, UNAPPLIED.
- **Mobile primitives** — the 16px iOS zoom trap (every form in the app), 44px targets by ARIA role, `viewport-fit=cover`, and `.row-actions` which was `opacity:0` until `tr:hover` so every per-row action in the app was unreachable on touch. Bottom nav now renders for all roles.
- **Job record** — rail was sticking behind the header (`--job-header-h` now measured), masonry silently reordered cards on a phone, per-card pencils, editable header badges, one-tap call/text/email.
- **Lists and boards** — card-per-row below md, filters behind one button, bulk select hidden rather than shrunk, snap-scrolling kanban.
- **Dashboard / fleet / registers** — drag disabled below lg with the menu saying why, `PageHeader` gutter overflow on five routes, `tasks.index` had no scroller at all, four more failed-read-as-empty-state bugs.

## Round 27 Aug — IN FLIGHT

- **Editors** (local agent): autosave page-blink (`refresh()` invalidates three query keys per `patchLine`), custom line items, hover per-line discount, calculator panel in the sidebar, Title -> "Opening statement", closing-statement field, REMOVE the "Applies to" picker from the bottom discount row.
- **Documents** (local agent): in-app viewer, ESX open, folders, prominent upload, thumbnails. Added `fflate` — a ZIP reader, which ESX genuinely requires. Needs sign-off.
- **Office groups** (local agent): group offices in Admin, office selectable by group on the estimate. Migration `20260827150000_location_groups.sql`, UNAPPLIED.
- **Polaris upload** (cloud, branch `polaris-upload`): attach a file to the AI assistant.
- **Bill to** (cloud, branch `bill-to-entity`): the job's "Billing entity" card becomes the CUSTOMER's billing entity. Our issuing entity moves onto the Office card — it cannot be deleted or jobs outside every office footprint become unfixable.

## Blocked on Mark

- `20260903213000_invoice_photos.sql` (photos on an invoice) — additive, re-runnable.
- **SIX migrations pending, one of which DELETES ROWS** (`20260826120000_touchpoint_external_ref_unique.sql` — needs a backup first).
- Admin -> Tags -> "Who can create labels" -> "Everyone".
- `RESEND_WEBHOOK_SECRET` + webhook pointed at `/api/public/hooks/resend`.
- Meanings of the shorthand codes REF, A, 24, ESE.
- Whether to re-grant `profiles.email` (revoked twice deliberately; not reversed).
- JobNimbus API key from David; Raven video endpoints from Brayden.
- Supabase MCP reconnection.

---

## Round 1 Sep — SHIPPED (merged to main, verified against the production Workers build)

- **THE APP WAS DOWN, and the cause was mine.** pdf-lib depends on tslib 1.x and reaches for its CommonJS build; under Workers the ESM interop returns an undefined default, so `const { __extends } = tslib` threw during worker startup and EVERY route 500'd. pdf-lib only reached the server bundle via the new document route. Fixed by aliasing tslib to its ESM build + loading document-render lazily. **`vite dev` and `tsc` are both blind to this** — the gate is now `npx vite build` + `npx wrangler dev --config .output/server/wrangler.json`.
- **The service worker never shipped.** vite-plugin-pwa wrote to `dist/` while nitro serves `.output/public`, so `/sw.js` 404'd in production and precached 0 entries. The offline shell did not exist. Now 445 entries (5.1 MB — worth reviewing for field phones on cellular).
- **Document serving rebuilt** — `/api/documents/:id/file`, caller-scoped auth (no service role), server-set Content-Type. Killed the blob: URL class of bug (`ERR_BLOCKED_BY_CLIENT` from ad blockers). Also fixed a PWA cache leak that would have parked RLS-gated documents in the browser cache for 30 days.
- **Barcode scanner** — Code 128 implemented directly (~10KB, no dependency, works on iOS where BarcodeDetector does not). `video.play()` on a frameless stream returns a promise that NEVER SETTLES; everything downstream was sequenced behind it, so the scan loop never started. Fixed.
- **Drying log** — psychrometric readings, dew point/GPP tested against published tables. Open-Meteo baseline (already used in chase.index.tsx — the repo DID have weather). Gaps measured to today; a weather row never closes a gap.
- **Offline coverage + obviousness** — clock in/out, job fields, notes, photo captions/tags, equipment notes now queue. Chrome 388px -> 280px at 390px wide.
- Discount base is the whole document; estimate PDF was subtracting document-level discounts TWICE.

## Round 3 Sep — Routes map (branch `wt/routes-map`)

Melly's ask: zoom into an area, see who is there, tap to build a route.

**Why it never worked, ranked.** (1) `accounts` has no lat/lon — only a typed
street address — so the map could draw offices and past visits but never the
book itself; there was nothing to tap. (2) The map and the planner did not talk:
`LiveMap`'s `onSelect` was not wired and the picked-stops list was private to
`PlanRoutePanel`. (3) A missing key rejected with `"no key"` and rendered
"Map unavailable." with no hint; a failed script load was cached forever; the
auth message only mentioned referrers. (4) The camera refitted on every marker
change and every resize, so zoom and pan never survived a re-render.

**What changed.** One loader, `src/lib/google-maps-loader.ts`, reads
`VITE_LOVABLE_CONNECTOR_GOOGLE_MAPS_BROWSER_KEY` and every surface (live-map,
cockpit-map, chase-prefetch, street view, admin integrations) goes through it.
Missing / rejected / blocked key each get their own on-map panel naming the
variable. Accounts are placed by `src/lib/stop-positions.ts`: geocode cache
first (`geocode_cache`, filled by the new signed-in-only server function
`geocodeAddresses` — Google when a server key is connected, OpenStreetMap
otherwise, one call per distinct address ever), then the coordinates of the
last logged visit. Pins cluster by grid (`src/lib/map-viewport.ts`, tested), a
cluster tap zooms in, a pin tap adds the stop to the ordered route (remove and
reorder in the planner), the "In this view" list under the map mirrors the
viewport, and the camera stays where the rep put it.

**How to test.**
1. Confirm the browser key is set: Lovable Cloud → project → Settings →
   Secrets (or the Google Maps connector) must carry
   `VITE_LOVABLE_CONNECTOR_GOOGLE_MAPS_BROWSER_KEY`, referrer-restricted to
   the app's domains, with **Maps JavaScript API** enabled. Locally the same
   name goes in `.env`. Without it `/routes` shows a panel that names the
   variable instead of a blank map — that panel appearing is itself a pass.
2. Open `/routes`. Offices are gold, deals purple (bigger = never visited),
   clients green, past visits small blue. Grey numbered circles are clusters;
   tap one to zoom in. "Locating addresses… n/m" top-right means addresses
   never geocoded before are being placed; pins fill in as it runs.
3. Zoom/pan into a town. The "In this view" list under the map should list
   exactly the pins on screen, hottest first. Pan again — the list follows;
   the map must NOT jump back.
4. Tap a pin (or **Add** in the list). It turns navy with its stop number and
   appears under "Your route" in the planner. Tap again to remove; use the
   arrows to reorder; **Open in Maps** hands the run to Google Maps.
5. Accounts with no street address are counted in the strip above the list
   and flagged "not on map" in the planner — add an address there and it
   appears after the next reload.
6. Server-side geocoding needs no key to work (OSM fallback, ~1 address/s);
   with `GOOGLE_MAPS_API_KEY` (Lovable Google Maps connector) or
   `GOOGLE_PLACES_API_KEY` it is faster and more exact.

## OPEN — flagged by agents, not yet done

- **`.gitattributes` is missing and it is costing real time.** `core.autocrlf=true` + LF blobs means a 15-line edit to `app-shell.tsx` stages as 1664 changed lines. Three agents independently hit whole-file merge conflicts. Fix is `* text=auto eol=crlf`, but it produces a renormalisation commit that will conflict with Lovable's concurrent pushes — needs a quiet window.
- **`vite build` regenerates `routeTree.gen.ts`** with ~2,700 lines of reorder churn. Any agent that builds and commits blindly poisons every other branch.
- **Signature queues drain only while their own screen is open** (`flushAuthorizationQueue`, `flushContractQueue`). A homeowner signature captured offline sits in IndexedDB until someone reopens that exact screen, and neither appears in the sync banner.
- **Two chase writes silently lose data offline**: `logArrival` (chase.index.tsx:1457) toasts success either way and its audit insert throws offline; quick notes (chase.index.tsx:2333) writes directly while `queueIncidentNote` exists and is called from nowhere.
- **`SyncBanner` renders three times** — app-shell (correct) plus chase.index.tsx:712 and field-work-ticket-panel.tsx:502.
- `src/components/sync-status.tsx` is dead code, superseded by SyncIndicator.
- Dead QueuedKinds with handlers but no producer: `note`, `voice_memo`, `call_outcome`, `touchpoint`.
- `npm run lint` is unusable repo-wide (CRLF vs prettier), so it gates nothing.
