# Database outage — diagnosis report and recovery options

## What I could and could not observe

Read-only only. No schema, data, or app changes were made.

Confirmed just now:

- The backend API host answers instantly (HTTP 401 on an unauthenticated REST probe), so networking and the API layer are fine.
- The Postgres connection pooler refuses every connection. `select 1` fails with "connection pooler unavailable" — not a statement timeout, a refusal to connect.
- The privileged metrics endpoint (disk %, WAL size, memory, restart count) times out on every attempt over roughly 10 minutes.
- The auth-to-database probe returns 503.

So all six items you asked me to measure — free space, WAL and replication slots, largest relations, `net._http_response` size, unpruned churn tables, temp files — require a working SQL connection, and there is none. I cannot report numbers I did not read, and I will not guess at them.

## What the pattern means

A database that answers nothing at all, including catalog views and `select 1`, while the API around it is healthy, is an instance-level failure, not a query or index problem. Combined with the metrics panel reporting sustained disk pressure, the most consistent explanation is disk exhaustion: Postgres cannot write, so it enters read-only mode and then restarts repeatedly and stops accepting connections. Your migrations from earlier today are too small to be a factor, and a lingering index build cannot block `select 1`.

This is unconfirmed until metrics or SQL come back. It is the leading hypothesis, not a finding.

## Proposed sequence

1. Keep polling backend status and metrics until either returns. If metrics come back, read disk usage, WAL size, database size, and restart count first.
2. If disk usage is at or near 100 percent: grow the data disk. Cleanup cannot run while the database refuses connections, so space must be added before anything can be deleted. Disk can grow but never shrink, so size it about 25 percent above current usage. You enter and approve the size.
3. If the database stays unreachable while metrics show disk is fine: request your approval for a backend restart, then re-check status.
4. Once SQL responds, run the full read-only survey you asked for, in your order: free space, replication slots with `active` flag and retained WAL bytes, largest relations including TOAST and indexes, `net._http_response` and `net.http_request_queue` on-disk size, unpruned high-churn tables, temp file usage, and `pg_stat_progress_create_index`.
5. Report those numbers, name the specific consumer, and only then propose deletions or retention rules. Nothing gets dropped, terminated, or pruned without naming it to you first.

## Decisions I need from you

- If disk is the cause, do you want the disk grown immediately, or would you rather see the numbers first even if that adds waiting time while the app is down?
- The `raven-positions` cron job has been failing every 5 minutes for 8 days against a 503 endpoint. Once the database is reachable, do you want it unscheduled while we investigate, or left running?

## Technical notes

- Disk and compute are separate controls. If the data disk is full, a larger compute instance does not help, and the reverse also holds.
- After space is freed, the database can remain in read-only mode; each cleanup statement then needs a per-session override before it will run.
- pg_net's `net._http_response` is pruned by pg_net's own retention setting. Roughly 2,300 failed calls is small in row terms; its real risk is TOAST plus index bloat, which I will size rather than assume.
