# Calendar and Chat QA follow-up, 2026-09-07

DAF-17 and DAF-20 were reconciled against the current source before editing.
Historical findings are not a pass on this build.
The parent QA run captured the authenticated Lovable New Event popup and the empty Chat screen before editing.
Saving events, Outlook delivery and chat sends were not executed; the changes below require deployed retesting.

## Implemented

- Calendar rejects empty, invalid, equal, and reversed date ranges before writing.
- Editing preserves an existing event's all-day flag.
- A failed attendee fetch is distinguishable from an empty invite list; saving other fields preserves attendees while the fetch is unavailable.
- The event dialog fits short screens with internal scrolling and accessible title/date labels.
- A shared record and accompanying message use one message insert; caption failure no longer leaves an already-sent record requiring a second send.
- Record picker errors show Retry instead of claiming no matching records.
- Project and invoice record cards use ordinary authenticated table reads, preserving record RLS, and omit links when the record is inaccessible.
- Project/invoice picker tabs require the server capability introduced by the sharing migration; old schemas keep jobs/accounts.
- Invoice cards open their associated job, matching the existing Billing table, or Billing when no job exists.

## Sharing migration and verification

`supabase/migrations/20260907161050_chat_project_invoice_sharing.sql` expands the existing message type check and exposes an authenticated, security-invoker capability function.
A security-invoker trigger validates the target against the caller's record RLS before inserts or reference changes, including direct API writes.
It does not change membership, table grants, or record RLS.
Automatically generated record labels are not persisted into message bodies; previews read the target using the recipient's permissions.
No live SQL was run.
The repository instructions require exact human approval immediately before applying this schema change to `ortpawtuqerkmuykwndp`.
Apply only after verifying the existing constraint and target project.
Within a QA transaction, verify all five allowed types and rejection of an unknown type, then roll back fixture writes.
Verify authenticated callers see the capability and anonymous callers cannot execute it.
Retest a restricted recipient: its project/invoice read must remain denied even though it can see the conversation.
Rollback should disable the capability first and retain the expanded check if project/invoice messages have already been created; do not delete messages to restore the old constraint.

## Local recurrence implementation and deployment gate

`supabase/migrations/20260907162526_local_calendar_recurrence.sql` adds nullable rules, a local master reference, a unique occurrence index, an invoker validation trigger, and an authenticated capability function.
No live SQL was run.
The old database retains the single-event calendar because the UI and recurring queries require this capability.
Capability results are cached for one minute.

The event popup supports daily, weekly and monthly repetition, an interval, timezone, and an end count of 1-366 or an end date within five years.
A master expands into occurrences in the requested calendar window.
Edits and cancellations affect either one occurrence or the whole series.
Exceptions use a stable occurrence index, so a series time edit does not orphan overrides or duplicate occurrences.
Previously changed occurrences keep their overrides when the series changes.
Changing an existing series' owner, office, type or linked records requires a new series, enforced by UI and database validation, so filtered views cannot lose or misfile exceptions.
The account timeline includes recurring occurrences in its surrounding one-year window in each direction.

Named-zone wall times survive DST changes.
Nonexistent DST times and missing monthly dates are skipped; repeated DST times use the earlier instant.
The tests cover spring/fall changes, month ends, date/count limits, moved exceptions, individual cancellations, and series cancellation.

Recurring events are **Goldstar only**.
The popup explains that Outlook synchronization and invitations are unavailable for recurring events, disables attendees, and the database enforces no attendees/external provider on series or exceptions.
The outbound queue also skips local events as a defensive safeguard.
Normal single-event Outlook behavior remains available.
Microsoft recurring-series ingestion and cancellation reconciliation remain a separate integration requirement, not a claimed pass.

Before applying the migration, verify the target is `ortpawtuqerkmuykwndp`, inspect the existing calendar policies and columns, then request exact approval under the repository instructions.
After applying, verify nullable defaults leave existing events unchanged, the capability is authenticated-only, and invalid rules, attendees, external providers, mixed-office exceptions and unauthorized writes are rejected.
In an approved QA account, create a weekly series spanning DST, change one occurrence, change the series, cancel one occurrence, and cancel the series; reload every step and check month/week/day/agenda and record timeline.
Verify that no Graph request or invitation is sent for any recurring action.
Apply no live migration merely to complete that test without approval.
Rollback should hide the capability and preserve series rows; dropping columns would discard user schedules and is not a routine rollback.

## Outlook investigation

The current outbound calendar queue exists in `calendar-push.server.ts`; DAF-20's historical statement that it has no consumer is stale.
That does not establish live Outlook delivery or tenant approval.

Outlook labels currently do not sync into a usable app field.
`graph.server.ts` omits `categories`, `flag`, `parentFolderId` and `hasAttachments` from its message selection and GraphMessage type.
`graph-sync.server.ts` writes `raw: {}` for captured communications, so those fields are discarded rather than retained.
Microsoft Graph exposes these message properties; category names are distinct from folders and flags.
Add explicit metadata ingestion and display before claiming label sync, and decide whether label edits are read-only imports or bidirectional writes.
Category color requires the mailbox's master category metadata, beyond names on individual messages.

Office 365 security review still needs the exact app registration, approved mailbox scope, tenant consent, credential rotation and revocation, and test mailbox/recipient.
This patch changes no OAuth grants and sends no events, mail, or chat messages.

## AI tagging

The current composer and server support `@polaris` and `@ai` with shared mention parsing.
The server rechecks the stored message and scopes the assistant request to the asker.
General questions and natural-language requests for open or outstanding jobs should be tested against the asker's allowed records.
A distinct tag for each job category is unnecessary if the existing retrieval tools answer those questions correctly.
Cross-recipient disclosure in shared conversations still needs a role-matrix test before marking DAF-17 passed.

## Sources

- [Microsoft patterned recurrence](https://learn.microsoft.com/en-us/graph/api/resources/patternedrecurrence?view=graph-rest-1.0)
- [Microsoft message properties](https://learn.microsoft.com/en-us/graph/api/resources/message?view=graph-rest-1.0)
- [Supabase database functions and invoker permissions](https://supabase.com/docs/guides/database/functions)
