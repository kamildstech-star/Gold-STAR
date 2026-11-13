-- Client 360 shows "Client since <date>" and the client asked to be able to
-- correct it. The panel was reading accounts.created_at, which is the record's
-- creation audit stamp: it is NOT NULL, it is what the health calculation falls
-- back to when a client has no touchpoint yet (src/lib/client-health.ts reads
-- stage_changed_at ?? created_at), and it answers "when was this row written",
-- not "when did this company become our client". Letting a hand edit rewrite it
-- would forge the audit stamp and silently move the health clock.
--
-- So the editable value gets its own column. Nullable on purpose: null means
-- "nobody has stated it", and the UI keeps falling back to created_at for
-- display. Nothing computes from client_since — it is a stated business fact,
-- not an input to health — so setting it cannot move a client between bands.
--
-- date, not timestamptz: an office states a day, and a timestamp would render
-- differently either side of midnight in another timezone.
--
-- No CHECK constraint: the only rule worth enforcing is "not in the future",
-- and now() is not IMMUTABLE so Postgres will not accept it in a CHECK. The
-- rule lives in validateClientSince() in src/lib/client-360-edit.ts, which is
-- the one place the UI writes this column from, and is unit-tested.
--
-- No backfill. Copying created_at into every row would assert 110 dates nobody
-- has actually stated; the display fallback already shows exactly that value
-- without claiming anyone confirmed it.
--
-- Re-runnable: IF NOT EXISTS on the column, COMMENT is idempotent.

alter table public.accounts
  add column if not exists client_since date;

comment on column public.accounts.client_since is
  'The day this account became a client, as stated by the office. Editable in '
  'Client 360. Null means unstated — read it as coalesce(client_since, '
  'created_at::date) for display. Deliberately not an input to client health; '
  'created_at / stage_changed_at remain the health clock.';
