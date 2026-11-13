-- Tighten telemetry retention from 90 days to 30.
--
-- 20260910170000 set 90 deliberately loose, so that applying it deleted
-- nothing while the disk outage was still fresh. Mark has now chosen the real
-- number: "set retention to 30 days".
--
-- 30 still covers what these rows are kept for -- the fleet map's past routes,
-- which nobody reads a month back -- and it holds the two tables at roughly a
-- third of what took the database down. Vehicle positions alone were growing
-- about 5 MB a day, so 90 days would have settled near 450 MB on a database
-- whose entire contents were 262 MB.
--
-- Checked before applying: at a 30 day cutoff this deletes 0 vehicle positions
-- and 0 equipment tracker events, because neither table holds anything older
-- than 21 days. The only rows it removes are 43 in pg_cron's own run history,
-- which is scheduler bookkeeping and not anything anybody entered.
--
-- The function is unchanged, including its 7 day floor. Only the number the
-- nightly job passes it changes, so this can be moved again by rescheduling
-- rather than by rewriting anything.

SELECT cron.unschedule('prune-telemetry');

SELECT cron.schedule(
  'prune-telemetry',
  '20 4 * * *',
  $cron$ SELECT public.prune_telemetry(30); $cron$
);
