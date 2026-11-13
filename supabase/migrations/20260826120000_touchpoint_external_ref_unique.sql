-- Stop the Outlook/Graph sync from re-inserting the same email as a new
-- touchpoint on every run.
--
-- THIS MIGRATION DELETES ROWS. Take a backup first anyway. Since 2026-09-03 it
-- also carries its own restore path: every row it is about to delete is
-- copied into public.touchpoints_dedupe_archive (section 1b) before anything
-- is repointed or removed, so the deletion can be undone from inside the
-- database. Verified against production on 2026-09-03: 466 touchpoints, none
-- with an external_ref, so today this file would delete 0 rows.
--
-- graph-sync.server.ts upserted touchpoints with ON CONFLICT ("id") while never
-- supplying an id, so nothing ever conflicted and each sweep inserted a fresh
-- copy of every message it had already seen. Cadence health, goals and the
-- leaderboard all count touchpoints, so all three read high by however many
-- times the sync has run. Fixing the code stops new copies; only this migration
-- removes the ones already there.

-- ---------------------------------------------------------------------------
-- 1. Pick the survivor for each external_ref: the OLDEST row.
--
-- Oldest, not newest, because captured_communications, calendar_events,
-- email_logs and email_messages have been pointing their touchpoint_id at it
-- since the first sweep. Ties on created_at break on id so the choice is
-- deterministic if a batch landed inside the same transaction.
-- ---------------------------------------------------------------------------

CREATE TEMP TABLE touchpoint_survivor AS
SELECT DISTINCT ON (external_ref) external_ref, id AS keep_id
FROM public.touchpoints
WHERE external_ref IS NOT NULL
ORDER BY external_ref, created_at, id;

CREATE TEMP TABLE touchpoint_doomed AS
SELECT t.id, s.keep_id
FROM public.touchpoints t
JOIN touchpoint_survivor s USING (external_ref)
WHERE t.id <> s.keep_id;

CREATE INDEX ON touchpoint_doomed (id);

-- ---------------------------------------------------------------------------
-- 1b. Self-backup: archive the doomed rows BEFORE touching anything.
--
-- The archive is a clone of touchpoints (same columns, defaults, indexes and
-- CHECKs; foreign keys are never copied by LIKE, so deleting an account later
-- does not cascade into the archive) plus two bookkeeping columns:
--   archived_at  when this migration copied the row
--   kept_id      the survivor every reference was repointed to in section 2
-- The column list for the copy is computed from the catalog rather than
-- written as `t.*`, so the copy still works if touchpoints has gained a column
-- since the archive table was first created by an earlier run.
--
-- The archive is service-role only: it holds the same data as touchpoints and
-- gets none of its policies, so no signed-in user can read or clear it.
--
-- RESTORE (one row, or all of them):
--   INSERT INTO public.touchpoints (<every touchpoints column>)
--   SELECT <the same columns> FROM public.touchpoints_dedupe_archive
--   WHERE id = '<uuid>';            -- omit the WHERE to restore everything
-- Build the column list with:
--   SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position)
--   FROM information_schema.columns
--   WHERE table_schema = 'public' AND table_name = 'touchpoints';
-- Restoring re-creates the duplicate, so the unique index in section 3 must be
-- dropped first (DROP INDEX public.touchpoints_external_ref_key) or the row's
-- external_ref set to NULL. References that were repointed in section 2 stay on
-- kept_id; move them back by hand only if the survivor was the wrong choice.
-- Rows stay in the archive after a restore; delete them from it explicitly
-- once a human has confirmed the restore.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.touchpoints_dedupe_archive
  (LIKE public.touchpoints INCLUDING ALL);

ALTER TABLE public.touchpoints_dedupe_archive
  ADD COLUMN IF NOT EXISTS archived_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS kept_id uuid;

ALTER TABLE public.touchpoints_dedupe_archive ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.touchpoints_dedupe_archive FROM anon, authenticated;

COMMENT ON TABLE public.touchpoints_dedupe_archive IS
  'Rows deleted by 20260826120000_touchpoint_external_ref_unique, copied here first. kept_id is the survivor their references were moved to. See the restore recipe in that migration.';

DO $$
DECLARE cols text; src_cols text;
BEGIN
  SELECT string_agg(quote_ident(a.column_name), ', ' ORDER BY a.ordinal_position),
         string_agg('t.' || quote_ident(a.column_name), ', ' ORDER BY a.ordinal_position)
    INTO cols, src_cols
  FROM information_schema.columns a
  JOIN information_schema.columns b
    ON b.table_schema = 'public'
   AND b.table_name = 'touchpoints_dedupe_archive'
   AND b.column_name = a.column_name
  WHERE a.table_schema = 'public' AND a.table_name = 'touchpoints';

  EXECUTE format(
    'INSERT INTO public.touchpoints_dedupe_archive (%s, archived_at, kept_id)
     SELECT %s, now(), d.keep_id
     FROM public.touchpoints t
     JOIN touchpoint_doomed d ON d.id = t.id',
    cols, src_cols
  );
END $$;

-- ---------------------------------------------------------------------------
-- 2. Repoint every reference at the survivor before deleting.
--
-- All four touchpoint_id foreign keys are ON DELETE SET NULL, so skipping this
-- would silently unlink the captured email or calendar event from its
-- touchpoint rather than fail loudly. Driven off pg_constraint so a fifth table
-- added later is covered too.
-- ---------------------------------------------------------------------------

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.conrelid::regclass AS tbl, a.attname AS col
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
    WHERE c.contype = 'f'
      AND c.confrelid = 'public.touchpoints'::regclass
      AND cardinality(c.conkey) = 1
  LOOP
    EXECUTE format(
      'UPDATE %s t SET %I = d.keep_id FROM touchpoint_doomed d WHERE t.%I = d.id',
      r.tbl, r.col, r.col
    );
  END LOOP;
END $$;

DELETE FROM public.touchpoints t USING touchpoint_doomed d WHERE t.id = d.id;

DROP TABLE touchpoint_doomed;
DROP TABLE touchpoint_survivor;

-- ---------------------------------------------------------------------------
-- 3. The constraint that makes a re-sync an UPDATE instead of a duplicate.
--
-- Deliberately NOT a partial index. Rows created in the app leave external_ref
-- null and must not collide with each other -- and they do not: a plain unique
-- index treats every null as distinct, so unlimited nulls are already allowed.
-- A `WHERE external_ref IS NOT NULL` predicate would buy nothing and cost the
-- upsert: Postgres refuses to infer an ON CONFLICT arbiter from a partial index
-- unless the statement repeats the predicate, which PostgREST cannot emit, and
-- the sync would fail 42P10 on every message.
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS touchpoints_external_ref_key
  ON public.touchpoints (external_ref);
