-- accounts.goasted_at / goasted_escalated_at carry the "GOASTED" misspelling
-- into the schema. Add correctly-spelled columns without disturbing the writer.
--
-- Direction of the mirror, deliberately: goasted_at stays the PHYSICAL column
-- that tg_account_stage_rules_reset writes ("IF new_key = 'goasted' THEN
-- NEW.goasted_at := now()"), and ghosted_at is a STORED generated mirror of it.
-- A generated column cannot drift, needs no trigger, and needs no ordering
-- against the existing BEFORE trigger — generated values are computed after
-- BEFORE triggers run, so a stage move still lands on both columns in the same
-- statement. Flipping it the other way round would mean dropping a column that
-- holds data, which is not something this PR will do.
--
-- Backfill is implicit: adding a STORED generated column rewrites the table and
-- computes the value for every existing row, so the 2 accounts that already
-- carry a goasted_at get their ghosted_at for free.
--
-- Re-runnable: IF NOT EXISTS on both columns, COMMENT is idempotent.

alter table public.accounts
  add column if not exists ghosted_at timestamptz
  generated always as (goasted_at) stored;

alter table public.accounts
  add column if not exists ghosted_escalated_at timestamptz
  generated always as (goasted_escalated_at) stored;

comment on column public.accounts.ghosted_at is
  'When the account moved to the Ghosted stage. Read this one. Currently a '
  'generated mirror of the deprecated, misspelled goasted_at.';

comment on column public.accounts.ghosted_escalated_at is
  'Correctly-spelled mirror of the deprecated goasted_escalated_at.';

comment on column public.accounts.goasted_at is
  'DEPRECATED 2026-09-09 — misspelling of "ghosted". Still the written column; '
  'ghosted_at is generated from it. Read ghosted_at. Safe to drop only after a '
  'follow-up migration (a) repoints tg_account_stage_rules_reset at ghosted_at, '
  '(b) converts ghosted_at from GENERATED to a plain column, and (c) recreates '
  'the pipeline_rule_state view, which still selects goasted_at.';

comment on column public.accounts.goasted_escalated_at is
  'DEPRECATED 2026-09-09 — misspelling of "ghosted". Read ghosted_escalated_at. '
  'Nothing writes this column. Drop together with goasted_at.';
