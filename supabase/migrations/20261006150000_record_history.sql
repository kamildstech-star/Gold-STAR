-- Delete and edit history for job-scoped records, with Restore.
--
-- Mark, on a job: "in timeline have a restore button for each item that gets
-- removed or changed".
--
-- UNAPPLIED. Until this runs, the Timeline reads no history and shows no
-- Restore buttons; nothing else in the app changes.
--
-- ---------------------------------------------------------------------------
-- THE DESIGN
-- ---------------------------------------------------------------------------
--
-- 1. CAPTURE IS A TRIGGER, NOT APP CODE. A row can leave a job through the
--    app, through Lovable, through the SQL editor, or through an offline
--    replay hours later. Only a trigger sees all four, so the before-image is
--    written by `record_history_capture()`, AFTER DELETE OR UPDATE, on an
--    explicit allow-list of tables. A DELETE stores the whole row; an UPDATE
--    stores only the columns this file names for that table (old and new
--    values), and nothing at all when none of them moved — so the noise
--    columns (updated_at, totals recomputed by another trigger, a task's
--    completion, which has its own Reopen) cost no rows.
--
-- 2. DELETES STAY HARD DELETES. Soft delete would mean teaching every read
--    of every table — lists, counts, PDFs, totals, the scorecard SQL, the
--    portal — to skip a deleted_at, and the first one missed brings a deleted
--    row back on a customer's PDF. Instead Restore re-inserts the stored row
--    with its own id. Nothing that reads these tables changes.
--
-- 3. THE BEFORE-IMAGE NEVER LEAVES THE DATABASE. A stored row can carry a
--    column its reader is not allowed to see: estimate_lines.unit_cost is
--    withheld from every signed-in user (20260909100000_line_cost_policy).
--    So `authenticated` gets SELECT on the display columns of record_history
--    only — never old_row / new_row — and those columns are read by the two
--    functions below, in definer context, which return only display-safe
--    fields. `select("*")` on this table fails for the app, on purpose.
--
-- 4. RESTORE IS SECURITY DEFINER, AND CHECKS THE TABLE'S OWN RULE. The brief
--    prefers SECURITY INVOKER so a table's RLS decides. It cannot here, for
--    two reasons, either of which is enough:
--      - the before-image has to be read (point 3), and an invoker cannot;
--      - the INSERT policies pin authorship (job_notes, job_section_notes,
--        tasks, estimates all require author_id / created_by = auth.uid()),
--        so a manager who may delete a colleague's note could never put it
--        back under the colleague's name with a plain INSERT.
--    So `record_history_may_restore()` restates, clause by clause, the
--    DELETE policy of each table (for un-delete — you may bring back what you
--    could have removed) and its UPDATE policy USING + WITH CHECK (for a
--    revert, against the current row and the reverted one). Every clause
--    names the migration it mirrors. On top: signed in, an active approved
--    profile (the active_profile_required restrictive policy), and able to
--    see the job. The functions pin search_path, are revoked from PUBLIC and
--    anon, and touch only the tables on a hard-coded allow-list, checked
--    twice (the CHECK on record_history.table_name and again in the code) —
--    there is no path that writes caller-supplied JSON into a caller-named
--    table: the table and the row both come from a history row only the
--    trigger can write.
--
-- 5. CONFLICTS. A revert only writes a column whose current value is still
--    the value this change set; if any captured column has moved on since,
--    it refuses and the preview lists what moved ("Due date: now Oct 14").
--    Restoring twice is a no-op: one restore marker per entry (unique
--    index), the row lock on the entry serialises a double tap, and a row
--    that is already back answers "already back".
--
-- 6. MONEY IS OUT. Invoices, invoice lines, payments and money events are
--    not captured and cannot be restored here. Bringing back a deleted
--    payment re-opens a ledger entry an accountant may already have
--    reconciled or synced; an invoice number may have been re-issued. Those
--    tables keep their own trails (20260927121000_invoice_payment_audit) and
--    a mistake there is fixed by finance, deliberately. An estimate is a
--    quote, not a ledger entry, so it is in.
--
-- WHAT IS COVERED (first set): job notes, section notes, job contacts, job
-- tasks, and estimates (with their scopes and lines, which come back with
-- the estimate). To add a table: add it to the CHECK, to the CASEs in
-- record_history_capture(), record_history_may_restore() and
-- record_history_display(), and to the allow-list arrays, then attach the
-- trigger. The pglite proof is supabase/tests/record-history.pglite.mjs.
--
-- Re-runnable: IF NOT EXISTS / CREATE OR REPLACE / DROP ... IF EXISTS.

-- ---------------------------------------------------------------------------
-- 1. The table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.record_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Tie-breaker for rows written in the same instant (a cascade writes many).
  seq bigint GENERATED ALWAYS AS IDENTITY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  -- Which transaction: an estimate's lines are linked to the estimate's own
  -- row through this, since by the time they cascade the estimate is gone.
  txid bigint NOT NULL DEFAULT txid_current(),
  table_name text NOT NULL,
  row_pk uuid NOT NULL,
  op text NOT NULL,
  -- History follows its job: deleting a whole job takes its history with it.
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  actor_id uuid,
  -- Display-safe label of the item as it was: 'note "Water in basement…"'.
  summary text NOT NULL,
  -- Display-safe {column: {before, after}} for an edit.
  changes jsonb,
  changed_columns text[],
  -- The before-image. NEVER granted to authenticated (see point 3).
  old_row jsonb,
  new_row jsonb,
  -- A line or scope that went with its estimate points at the estimate's row.
  parent_id uuid REFERENCES public.record_history(id) ON DELETE CASCADE,
  -- A restore marker points at the entry it restored.
  restores_id uuid REFERENCES public.record_history(id) ON DELETE CASCADE,
  CONSTRAINT record_history_op CHECK (op IN ('delete', 'update', 'restore')),
  CONSTRAINT record_history_table_allowed CHECK (table_name IN (
    'job_notes', 'job_section_notes', 'job_contacts', 'tasks',
    'estimates', 'estimate_scopes', 'estimate_lines'
  )),
  CONSTRAINT record_history_restore_shape CHECK ((op = 'restore') = (restores_id IS NOT NULL)),
  CONSTRAINT record_history_has_image CHECK (op = 'restore' OR old_row IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS record_history_job_idx
  ON public.record_history (job_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS record_history_row_idx
  ON public.record_history (table_name, row_pk, seq);
CREATE INDEX IF NOT EXISTS record_history_parent_idx
  ON public.record_history (parent_id) WHERE parent_id IS NOT NULL;
-- One restore per entry, ever: the database's half of "idempotent".
CREATE UNIQUE INDEX IF NOT EXISTS record_history_one_restore
  ON public.record_history (restores_id) WHERE op = 'restore';

ALTER TABLE public.record_history ENABLE ROW LEVEL SECURITY;

-- Display columns only. No INSERT / UPDATE / DELETE for anybody but the
-- functions below: the trail cannot be forged, edited or pruned from the app.
REVOKE ALL ON public.record_history FROM PUBLIC, anon, authenticated;
GRANT SELECT (
  id, seq, occurred_at, table_name, row_pk, op, job_id, actor_id,
  summary, changes, changed_columns, parent_id, restores_id
) ON public.record_history TO authenticated;
GRANT ALL ON public.record_history TO service_role;

-- You see a job's history exactly when you can see the job. Every captured
-- table's own SELECT is at least this wide for the display columns kept here
-- (notes, contacts and job tasks are visible with the job; an estimate's
-- number and title are already on the job Timeline through record_activity).
-- An estimate's lines and scopes are NOT visible with the job — their policy
-- follows the estimate's office — so their rows (parent_id set) are not
-- readable at all; the preview reports only how many there are.
DROP POLICY IF EXISTS record_history_select ON public.record_history;
CREATE POLICY record_history_select ON public.record_history
  FOR SELECT TO authenticated
  USING (parent_id IS NULL AND public.can_view_job((SELECT auth.uid()), job_id));

DROP POLICY IF EXISTS active_profile_required ON public.record_history;
CREATE POLICY active_profile_required ON public.record_history
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT goldstar_private.profile_is_active(auth.uid())))
  WITH CHECK ((SELECT goldstar_private.profile_is_active(auth.uid())));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'portal_customer') THEN
    DROP POLICY IF EXISTS portal_customer_denied ON public.record_history;
    CREATE POLICY portal_customer_denied ON public.record_history
      AS RESTRICTIVE FOR ALL TO portal_customer USING (false) WITH CHECK (false);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Capture
-- ---------------------------------------------------------------------------

-- A value as a person reads it. An assignee is a name, not a uuid.
CREATE OR REPLACE FUNCTION public.record_history_display_value(_column text, _value jsonb)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN _value IS NULL OR _value = 'null'::jsonb THEN 'null'::jsonb
    WHEN _column IN ('assignee', 'author_id', 'created_by') THEN
      to_jsonb(COALESCE(
        (SELECT p.full_name FROM public.profiles p WHERE p.user_id = (_value #>> '{}')::uuid),
        'someone'))
    ELSE _value
  END;
$$;

CREATE OR REPLACE FUNCTION public.record_history_capture()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old jsonb := to_jsonb(OLD);
  v_new jsonb;
  v_job uuid;
  v_parent uuid;
  v_cols text[] := '{}';
  v_changed text[] := '{}';
  v_old_vals jsonb := '{}'::jsonb;
  v_new_vals jsonb := '{}'::jsonb;
  v_display jsonb := '{}'::jsonb;
  v_summary text;
  c text;
BEGIN
  -- A restore's own writes are the restore; its marker records them.
  IF COALESCE(current_setting('record_history.restoring', true), '') <> '' THEN
    RETURN NULL;
  END IF;
  -- Demo seed and purge are not anybody's edits.
  IF (v_old ->> 'is_demo')::boolean IS TRUE THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    v_new := to_jsonb(NEW);
  END IF;

  CASE TG_TABLE_NAME
    WHEN 'job_notes' THEN
      v_job := (v_old ->> 'job_id')::uuid;
      v_cols := ARRAY['body'];
      v_summary := 'note "' || left(COALESCE(v_old ->> 'body', ''), 140) || '"';
    WHEN 'job_section_notes' THEN
      v_job := (v_old ->> 'job_id')::uuid;
      v_cols := ARRAY['body'];
      v_summary := replace(COALESCE(v_old ->> 'section_key', ''), '_', ' ') || ' note "'
        || left(COALESCE(v_old ->> 'body', ''), 140) || '"';
    WHEN 'job_contacts' THEN
      v_job := (v_old ->> 'job_id')::uuid;
      -- The relinks (contact_id / account_id) are left out: they point at
      -- another office's records, and "revert" there is a picker's job.
      v_cols := ARRAY['role', 'full_name', 'email', 'phone', 'notes', 'is_default_contact'];
      v_summary := 'contact ' || COALESCE(NULLIF(v_old ->> 'full_name', ''), '(no name)')
        || ' (' || replace(COALESCE(v_old ->> 'role', 'other'), '_', ' ') || ')';
    WHEN 'tasks' THEN
      -- An account task has no job, so no job Timeline to restore it from.
      v_job := (v_old ->> 'job_id')::uuid;
      -- status / completed_at are left out: Complete and Reopen already undo
      -- each other, and a revert here would skip the completion notices.
      v_cols := ARRAY['title', 'description', 'assignee', 'due_date', 'due_time', 'priority'];
      v_summary := 'task "' || COALESCE(v_old ->> 'title', '') || '"';
    WHEN 'estimates' THEN
      -- Deletes only. An estimate's edits are already versioned
      -- (record_revisions: v1, v2 … with totals), and its status is workflow.
      IF TG_OP = 'UPDATE' THEN RETURN NULL; END IF;
      v_job := (v_old ->> 'job_id')::uuid;
      v_summary := 'estimate ESTIMATE-' || COALESCE(v_old ->> 'seq', '?')
        || COALESCE(' "' || NULLIF(v_old ->> 'title', '') || '"', '');
    WHEN 'estimate_scopes', 'estimate_lines' THEN
      -- Only as part of the estimate's own deletion, so the estimate comes
      -- back whole. Removing one line while editing is the editor's business
      -- (and the estimate's revisions keep the before).
      IF TG_OP = 'UPDATE' THEN RETURN NULL; END IF;
      IF EXISTS (SELECT 1 FROM public.estimates e WHERE e.id = (v_old ->> 'estimate_id')::uuid) THEN
        RETURN NULL;
      END IF;
      -- The estimate's own row, written moments ago in this transaction: the
      -- trigger is named to fire before the cascade (see its CREATE below).
      SELECT h.id, h.job_id INTO v_parent, v_job
        FROM public.record_history h
       WHERE h.table_name = 'estimates' AND h.op = 'delete'
         AND h.row_pk = (v_old ->> 'estimate_id')::uuid
         AND h.txid = txid_current()
       ORDER BY h.seq DESC
       LIMIT 1;
      IF v_parent IS NULL THEN RETURN NULL; END IF;
      v_summary := CASE TG_TABLE_NAME WHEN 'estimate_scopes' THEN 'scope "' ELSE 'line "' END
        || COALESCE(v_old ->> 'name', '') || '"';
    ELSE
      RAISE EXCEPTION 'record_history_capture() is not configured for %', TG_TABLE_NAME;
  END CASE;

  IF v_job IS NULL THEN RETURN NULL; END IF;
  -- Deleting a whole job cascades into these tables after the job row is
  -- gone. There is nothing to restore into, and the history goes with it.
  IF NOT EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = v_job) THEN RETURN NULL; END IF;

  IF TG_OP = 'UPDATE' THEN
    FOREACH c IN ARRAY v_cols LOOP
      IF (v_old -> c) IS DISTINCT FROM (v_new -> c) THEN
        v_changed := v_changed || c;
        v_old_vals := v_old_vals || jsonb_build_object(c, v_old -> c);
        v_new_vals := v_new_vals || jsonb_build_object(c, v_new -> c);
        v_display := v_display || jsonb_build_object(c, jsonb_build_object(
          'before', public.record_history_display_value(c, v_old -> c),
          'after', public.record_history_display_value(c, v_new -> c)));
      END IF;
    END LOOP;
    IF cardinality(v_changed) = 0 THEN RETURN NULL; END IF;

    INSERT INTO public.record_history
      (table_name, row_pk, op, job_id, actor_id, summary, changes, changed_columns, old_row, new_row)
    VALUES
      (TG_TABLE_NAME, (v_old ->> 'id')::uuid, 'update', v_job, auth.uid(), v_summary,
       v_display, v_changed, v_old_vals, v_new_vals);
  ELSE
    INSERT INTO public.record_history
      (table_name, row_pk, op, job_id, actor_id, summary, old_row, parent_id)
    VALUES
      (TG_TABLE_NAME, (v_old ->> 'id')::uuid, 'delete', v_job, auth.uid(), v_summary,
       v_old, v_parent);
  END IF;
  RETURN NULL;
END;
$$;

-- Trigger functions are fired, never called.
REVOKE ALL ON FUNCTION public.record_history_capture() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_history_display_value(text, jsonb) FROM PUBLIC, anon, authenticated;

-- The name starts with a capital A on purpose. AFTER triggers on one event
-- fire in name order, and a foreign key's ON DELETE CASCADE is itself an
-- AFTER trigger called "RI_ConstraintTrigger_…". Sorting first means an
-- estimate's own history row exists before its lines cascade, so the lines
-- can find it (txid + row_pk) and hang off it as children.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'job_notes', 'job_section_notes', 'job_contacts', 'tasks',
    'estimates', 'estimate_scopes', 'estimate_lines'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS "A_record_history" ON public.%I', t);
    EXECUTE format(
      'CREATE TRIGGER "A_record_history" AFTER UPDATE OR DELETE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION public.record_history_capture()', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Who may restore: each table's own rule, restated
-- ---------------------------------------------------------------------------
--
-- _op 'delete': may _uid bring back _row? = could _uid have deleted it.
-- _op 'update': may _uid revert? = the UPDATE policy's USING holds on the
-- current row (_row) AND its WITH CHECK holds on the reverted row
-- (_reverted). Seeing the job is checked by the callers for every table.
--
-- If one of these policies changes, change its branch here in the same
-- migration. supabase/tests/record-history-live-audit.sql prints the live
-- policies beside these so drift is visible.
CREATE OR REPLACE FUNCTION public.record_history_may_restore(
  _uid uuid, _table text, _op text, _row jsonb, _reverted jsonb
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job uuid := (_row ->> 'job_id')::uuid;
BEGIN
  IF _uid IS NULL THEN RETURN false; END IF;
  CASE _table
    WHEN 'job_notes' THEN
      -- 20260728041824 job_notes_delete / job_notes_update (USING = CHECK):
      --   author_id = auth.uid() OR is_privileged(auth.uid())
      RETURN (_row ->> 'author_id')::uuid IS NOT DISTINCT FROM _uid
          OR public.is_privileged(_uid);
    WHEN 'job_section_notes' THEN
      -- 20260810194233 "Authors and managers delete/edit section notes":
      --   author_id = auth.uid() OR can_manage_job(auth.uid(), job_id)
      RETURN (_row ->> 'author_id')::uuid IS NOT DISTINCT FROM _uid
          OR public.can_manage_job(_uid, v_job);
    WHEN 'job_contacts' THEN
      -- 20260805193344 job_contacts_write (FOR ALL):
      --   can_manage_job(auth.uid(), job_id)
      RETURN public.can_manage_job(_uid, v_job);
    WHEN 'tasks' THEN
      IF _op = 'delete' THEN
        -- 20260804184212 "tasks delete own":
        --   created_by = auth.uid()
        --   OR (location_id IS NOT NULL AND can_manage_location(auth.uid(), location_id))
        RETURN (_row ->> 'created_by')::uuid IS NOT DISTINCT FROM _uid
            OR ((_row ->> 'location_id') IS NOT NULL
                AND public.can_manage_location(_uid, (_row ->> 'location_id')::uuid));
      END IF;
      -- 20260806211227 "tasks update in scope", USING on the row as it is now
      -- and WITH CHECK on the row as the revert would leave it:
      --   assignee = auth.uid() OR created_by = auth.uid()
      --   OR (location_id IS NOT NULL AND can_manage_location(auth.uid(), location_id))
      RETURN (
          (_row ->> 'assignee')::uuid IS NOT DISTINCT FROM _uid
          OR (_row ->> 'created_by')::uuid IS NOT DISTINCT FROM _uid
          OR ((_row ->> 'location_id') IS NOT NULL
              AND public.can_manage_location(_uid, (_row ->> 'location_id')::uuid))
        ) AND (
          (_reverted ->> 'assignee')::uuid IS NOT DISTINCT FROM _uid
          OR (_reverted ->> 'created_by')::uuid IS NOT DISTINCT FROM _uid
          OR ((_reverted ->> 'location_id') IS NOT NULL
              AND public.can_manage_location(_uid, (_reverted ->> 'location_id')::uuid))
        );
    WHEN 'estimates' THEN
      -- 20260813172023 estimates_delete:
      --   can_manage_location(auth.uid(), location_id) OR created_by = auth.uid()
      RETURN _op = 'delete' AND (
        public.can_manage_location(_uid, (_row ->> 'location_id')::uuid)
        OR (_row ->> 'created_by')::uuid IS NOT DISTINCT FROM _uid
      );
    ELSE
      -- estimate_scopes / estimate_lines come back only with their estimate,
      -- under the estimate's rule. Anything else is not on the list.
      RETURN false;
  END CASE;
END;
$$;

REVOKE ALL ON FUNCTION public.record_history_may_restore(uuid, text, text, jsonb, jsonb)
  FROM PUBLIC, anon, authenticated;

-- What the confirm dialog may show of a deleted row: per table, the columns
-- its readers could already see. Never the whole image.
CREATE OR REPLACE FUNCTION public.record_history_display(_table text, _image jsonb)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE _table
    WHEN 'job_notes' THEN jsonb_build_object(
      'body', _image -> 'body',
      'author', public.record_history_display_value('author_id', _image -> 'author_id'))
    WHEN 'job_section_notes' THEN jsonb_build_object(
      'section', _image -> 'section_key',
      'body', _image -> 'body',
      'author', public.record_history_display_value('author_id', _image -> 'author_id'))
    WHEN 'job_contacts' THEN jsonb_build_object(
      'name', _image -> 'full_name', 'role', _image -> 'role',
      'phone', _image -> 'phone', 'email', _image -> 'email', 'notes', _image -> 'notes')
    WHEN 'tasks' THEN jsonb_build_object(
      'title', _image -> 'title', 'description', _image -> 'description',
      'due_date', _image -> 'due_date', 'priority', _image -> 'priority',
      'status', _image -> 'status',
      'assignee', public.record_history_display_value('assignee', _image -> 'assignee'))
    -- Number and title only. No totals: who may see an estimate's money is
    -- estimates_select's call (20260823090000), not the Timeline's.
    WHEN 'estimates' THEN jsonb_build_object(
      'number', 'ESTIMATE-' || COALESCE(_image ->> 'seq', '?'),
      'title', _image -> 'title', 'status', _image -> 'status')
    ELSE '{}'::jsonb
  END;
$$;

REVOKE ALL ON FUNCTION public.record_history_display(text, jsonb) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. The state of one entry: shared by the preview and the restore, so the
--    dialog and the button can never disagree.
-- ---------------------------------------------------------------------------
--
-- status:
--   ready             — Restore will do exactly what the preview shows
--   already_restored  — somebody restored this entry (restored_by/at)
--   already_present   — the row is back already (nothing to do)
--   already_reverted  — every changed field already holds its old value
--   gone              — an edit to a row that has since been deleted
--   conflict          — a changed field has been edited again since
--   not_allowed       — the table's own rule says no (see section 3)
--   child             — a line or scope: restore its estimate instead
CREATE OR REPLACE FUNCTION public.record_history_state(_h public.record_history, _uid uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_marker public.record_history%ROWTYPE;
  v_current jsonb;
  v_reverted jsonb;
  v_fields jsonb := '[]'::jsonb;
  v_conflict boolean := false;
  v_all_back boolean := true;
  v_children jsonb;
  v_base jsonb;
  c text;
BEGIN
  v_base := jsonb_build_object(
    'id', _h.id, 'op', _h.op, 'table_name', _h.table_name, 'summary', _h.summary);

  IF _h.parent_id IS NOT NULL THEN
    RETURN v_base || jsonb_build_object('status', 'child');
  END IF;

  SELECT * INTO v_marker FROM public.record_history m
   WHERE m.restores_id = _h.id AND m.op = 'restore';
  IF FOUND THEN
    RETURN v_base || jsonb_build_object(
      'status', 'already_restored',
      'restored_at', v_marker.occurred_at,
      'restored_by', public.record_history_display_value('created_by', to_jsonb(v_marker.actor_id)));
  END IF;

  IF NOT (_h.table_name = ANY (ARRAY['job_notes', 'job_section_notes', 'job_contacts', 'tasks', 'estimates'])) THEN
    RETURN v_base || jsonb_build_object('status', 'not_allowed');
  END IF;

  -- The current row, read as the owner; only display-safe parts leave.
  EXECUTE format('SELECT to_jsonb(t) FROM public.%I t WHERE t.id = $1', _h.table_name)
    INTO v_current USING _h.row_pk;

  IF _h.op = 'delete' THEN
    SELECT jsonb_build_object(
             'scopes', count(*) FILTER (WHERE ch.table_name = 'estimate_scopes'),
             'lines', count(*) FILTER (WHERE ch.table_name = 'estimate_lines'))
      INTO v_children
      FROM public.record_history ch WHERE ch.parent_id = _h.id;
    v_base := v_base || jsonb_build_object(
      'detail', public.record_history_display(_h.table_name, _h.old_row),
      'children', v_children);
    IF v_current IS NOT NULL THEN
      RETURN v_base || jsonb_build_object('status', 'already_present');
    END IF;
    IF NOT public.record_history_may_restore(_uid, _h.table_name, 'delete', _h.old_row, NULL) THEN
      RETURN v_base || jsonb_build_object('status', 'not_allowed');
    END IF;
    RETURN v_base || jsonb_build_object('status', 'ready');
  END IF;

  -- An edit.
  IF v_current IS NULL THEN
    RETURN v_base || jsonb_build_object('status', 'gone');
  END IF;
  FOREACH c IN ARRAY _h.changed_columns LOOP
    v_fields := v_fields || jsonb_build_array(jsonb_build_object(
      'column', c,
      'before', public.record_history_display_value(c, _h.old_row -> c),
      'after', public.record_history_display_value(c, _h.new_row -> c),
      'now', public.record_history_display_value(c, v_current -> c),
      'moved', (v_current -> c) IS DISTINCT FROM (_h.new_row -> c)
               AND (v_current -> c) IS DISTINCT FROM (_h.old_row -> c)));
    IF (v_current -> c) IS DISTINCT FROM (_h.old_row -> c) THEN
      v_all_back := false;
    END IF;
    IF (v_current -> c) IS DISTINCT FROM (_h.new_row -> c)
       AND (v_current -> c) IS DISTINCT FROM (_h.old_row -> c) THEN
      v_conflict := true;
    END IF;
  END LOOP;
  v_base := v_base || jsonb_build_object('fields', v_fields);

  IF v_all_back THEN
    RETURN v_base || jsonb_build_object('status', 'already_reverted');
  END IF;
  IF v_conflict THEN
    RETURN v_base || jsonb_build_object('status', 'conflict');
  END IF;
  v_reverted := v_current || _h.old_row;
  IF NOT public.record_history_may_restore(_uid, _h.table_name, 'update', v_current, v_reverted) THEN
    RETURN v_base || jsonb_build_object('status', 'not_allowed');
  END IF;
  RETURN v_base || jsonb_build_object('status', 'ready');
END;
$$;

REVOKE ALL ON FUNCTION public.record_history_state(public.record_history, uuid)
  FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Putting a row back
-- ---------------------------------------------------------------------------

-- Re-insert one stored row into one allow-listed table, keeping its id. The
-- column list is the table's columns today that the image has, minus the
-- generated ones (estimate_lines.subtotal) — so a column added since the
-- delete takes its default, and one dropped since is ignored.
CREATE OR REPLACE FUNCTION public.record_history_reinsert(_table text, _image jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cols text;
BEGIN
  IF NOT (_table = ANY (ARRAY[
    'job_notes', 'job_section_notes', 'job_contacts', 'tasks',
    'estimates', 'estimate_scopes', 'estimate_lines'])) THEN
    RAISE EXCEPTION 'Restore is not available for %', _table USING ERRCODE = '42501';
  END IF;

  SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum)
    INTO v_cols
    FROM pg_catalog.pg_attribute a
   WHERE a.attrelid = format('public.%I', _table)::regclass
     AND a.attnum > 0
     AND NOT a.attisdropped
     AND a.attgenerated = ''
     AND a.attidentity = ''
     AND _image ? a.attname;

  EXECUTE format(
    'INSERT INTO public.%I (%s) SELECT %s FROM jsonb_populate_record(NULL::public.%I, $1)',
    _table, v_cols, v_cols, _table)
  USING _image;
END;
$$;

REVOKE ALL ON FUNCTION public.record_history_reinsert(text, jsonb) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.restore_record_history(_history_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_h public.record_history%ROWTYPE;
  v_state jsonb;
  v_status text;
  v_child record;
  v_set text;
  v_marker uuid;
  v_constraint text;
  v_moved text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sign in to restore' USING ERRCODE = '42501';
  END IF;
  -- The active_profile_required restrictive policy, which a definer skips.
  IF NOT goldstar_private.profile_is_active(v_uid) THEN
    RAISE EXCEPTION 'Your account is not active' USING ERRCODE = '42501';
  END IF;

  -- The row lock serialises a double tap: the second waits, then sees the
  -- first one's marker and answers "already restored".
  SELECT * INTO v_h FROM public.record_history WHERE id = _history_id FOR UPDATE;
  -- Same answer for "no such entry" and "not your job": no probing.
  IF NOT FOUND OR NOT public.can_view_job(v_uid, v_h.job_id) THEN
    RAISE EXCEPTION 'That history entry is not available' USING ERRCODE = 'P0002';
  END IF;
  IF v_h.op = 'restore' THEN
    RAISE EXCEPTION 'That entry is a restore; there is nothing to put back' USING ERRCODE = '22023';
  END IF;
  -- The allow-list, again, in code: the CHECK on the table is one guard,
  -- this is the other.
  IF NOT (v_h.table_name = ANY (ARRAY['job_notes', 'job_section_notes', 'job_contacts', 'tasks', 'estimates'])) THEN
    RAISE EXCEPTION 'Restore is not available for %', v_h.table_name USING ERRCODE = '42501';
  END IF;

  v_state := public.record_history_state(v_h, v_uid);
  v_status := v_state ->> 'status';

  IF v_status IN ('already_restored', 'already_present', 'already_reverted') THEN
    RETURN v_state;
  ELSIF v_status = 'child' THEN
    RAISE EXCEPTION 'This came off with its estimate. Restore the estimate to bring it back.'
      USING ERRCODE = '22023';
  ELSIF v_status = 'gone' THEN
    RAISE EXCEPTION 'It was deleted after this change. Restore the deletion first.'
      USING ERRCODE = '55000';
  ELSIF v_status = 'conflict' THEN
    SELECT string_agg(f ->> 'column', ', ') INTO v_moved
      FROM jsonb_array_elements(v_state -> 'fields') f
     WHERE (f ->> 'moved')::boolean;
    RAISE EXCEPTION 'Changed again since (%). Nothing was reverted; edit it by hand.', v_moved
      USING ERRCODE = '40001';
  ELSIF v_status = 'not_allowed' THEN
    RAISE EXCEPTION 'You can''t restore this. Only someone who could have removed or edited it can.'
      USING ERRCODE = '42501';
  ELSIF v_status IS DISTINCT FROM 'ready' THEN
    RAISE EXCEPTION 'Restore is not available (%)', v_status USING ERRCODE = '55000';
  END IF;

  PERFORM set_config('record_history.restoring', v_h.id::text, true);
  BEGIN
    IF v_h.op = 'delete' THEN
      PERFORM public.record_history_reinsert(v_h.table_name, v_h.old_row);
      -- An estimate's scopes before its lines (a line may name its scope).
      FOR v_child IN
        SELECT ch.table_name, ch.old_row
          FROM public.record_history ch
         WHERE ch.parent_id = v_h.id
         ORDER BY CASE ch.table_name WHEN 'estimate_scopes' THEN 0 ELSE 1 END, ch.seq
      LOOP
        PERFORM public.record_history_reinsert(v_child.table_name, v_child.old_row);
      END LOOP;
    ELSE
      -- Only the captured columns, back to their old values. The state check
      -- above has already refused if any of them moved on since.
      SELECT string_agg(format('%I = r.%I', col, col), ', ')
        INTO v_set
        FROM unnest(v_h.changed_columns) AS col;
      EXECUTE format(
        'UPDATE public.%I t SET %s FROM jsonb_populate_record(NULL::public.%I, $1) r WHERE t.id = $2',
        v_h.table_name, v_set, v_h.table_name)
      USING v_h.old_row, v_h.row_pk;
    END IF;
  EXCEPTION
    WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
      RAISE EXCEPTION '%', CASE
          WHEN v_constraint LIKE 'estimates_job_id_seq%' THEN
            'Can''t put it back: another estimate on this job now has that number.'
          WHEN v_constraint = 'job_contacts_one_default_idx' THEN
            'Can''t put it back: another contact is now the default for this job.'
          WHEN v_constraint LIKE '%cadence%' THEN
            'Can''t put it back: the job''s checklist has already re-created this task.'
          ELSE 'Can''t put it back: something else now uses the same ' || COALESCE(v_constraint, 'key') || '.'
        END
        USING ERRCODE = '23505';
    WHEN foreign_key_violation THEN
      RAISE EXCEPTION 'Can''t put it back: something it pointed at has since been deleted.'
        USING ERRCODE = '23503';
  END;
  PERFORM set_config('record_history.restoring', '', true);

  INSERT INTO public.record_history (table_name, row_pk, op, job_id, actor_id, summary, restores_id)
  VALUES (v_h.table_name, v_h.row_pk, 'restore', v_h.job_id, v_uid, v_h.summary, v_h.id)
  RETURNING id INTO v_marker;

  RETURN v_state || jsonb_build_object('status', 'restored', 'restore_id', v_marker);
END;
$$;

REVOKE ALL ON FUNCTION public.restore_record_history(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.restore_record_history(uuid) TO authenticated, service_role;

-- What the confirm dialog shows. Same gate as the restore, same answer for
-- an entry that does not exist and one on a job you cannot see.
CREATE OR REPLACE FUNCTION public.record_history_preview(_history_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_h public.record_history%ROWTYPE;
BEGIN
  IF v_uid IS NULL OR NOT goldstar_private.profile_is_active(v_uid) THEN
    RAISE EXCEPTION 'Sign in to restore' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_h FROM public.record_history WHERE id = _history_id;
  IF NOT FOUND OR NOT public.can_view_job(v_uid, v_h.job_id) THEN
    RAISE EXCEPTION 'That history entry is not available' USING ERRCODE = 'P0002';
  END IF;
  IF v_h.op = 'restore' THEN
    RETURN jsonb_build_object('id', v_h.id, 'op', 'restore', 'status', 'restore');
  END IF;
  RETURN public.record_history_state(v_h, v_uid);
END;
$$;

REVOKE ALL ON FUNCTION public.record_history_preview(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_history_preview(uuid) TO authenticated, service_role;
