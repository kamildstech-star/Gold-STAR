-- Delete an estimate from a job's Billing tab, restorable from the Timeline.
--
-- UNAPPLIED when written (2026-10-06). REQUIRES 20261006150000_record_history
-- (PR #300) applied first. Until BOTH are applied the Billing tab offers no
-- Delete at all: it asks record_history_covers() (section 3) and a database
-- without it answers "no", so nothing is ever deleted that could not come
-- back.
--
-- Mark, of an empty "ESTIMATE-2 v1 DRAFT — $0" on a job's Billing tab: "add a
-- delete button here". In the same message: "in timeline have a restore
-- button for each item that gets removed or changed".
--
-- THE CONVENTION IS #300's, not a new one. Its brief entry says: "Hard delete
-- stays a hard DELETE. Do NOT add deleted_at / soft delete to a table to make
-- it restorable" — the "A_record_history" trigger writes the before-image and
-- the Timeline restores it. Estimates (with their scopes and lines) are
-- already covered by #300. Quick Estimates (`job_calculations`) were not; this
-- adds them by #300's own procedure for a new table (section 2).
--
-- 1. An invoiced estimate cannot be deleted (this section)
-- 2. record_history covers job_calculations
-- 3. record_history_covers(table): may the app offer Delete on it?
--
-- Re-runnable: CREATE OR REPLACE / DROP ... IF EXISTS throughout.

-- ---------------------------------------------------------------------------
-- 1. An invoiced estimate stays
-- ---------------------------------------------------------------------------
--
-- invoices.estimate_id (and job_calculation_id, 20261006161000) are ON DELETE
-- SET NULL. Deleting an estimate that was converted would quietly cut the
-- invoice off from the scope it billed — "vs estimate", "invoiced as", the
-- version it came from — and a restore brings the estimate back with the
-- link already gone. So it is refused here, whatever path the delete takes;
-- the Billing tab does not offer Delete on an invoiced row in the first place.
--
-- SECURITY DEFINER so the check sees an invoice the deleter's own RLS would
-- hide; all it reveals is the invoice number, to someone already allowed to
-- delete the estimate.
--
-- A whole job being deleted cascades into both tables after the job row is
-- gone; that is not this rule's business, and refusing it would make a job
-- with an invoiced estimate undeletable.
CREATE OR REPLACE FUNCTION public.refuse_deleting_invoiced_estimate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_number text;
BEGIN
  IF OLD.job_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = OLD.job_id) THEN
    RETURN OLD;
  END IF;
  IF TG_TABLE_NAME = 'estimates' THEN
    SELECT i.invoice_number INTO v_number
      FROM public.invoices i WHERE i.estimate_id = OLD.id
     ORDER BY i.created_at LIMIT 1;
  ELSIF TG_TABLE_NAME = 'job_calculations' AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'invoices'
       AND column_name = 'job_calculation_id'
  ) THEN
    -- Dynamic: the column arrives with 20261006161000, which may be applied
    -- before or after this file.
    EXECUTE 'SELECT i.invoice_number FROM public.invoices i
              WHERE i.job_calculation_id = $1 ORDER BY i.created_at LIMIT 1'
      INTO v_number USING OLD.id;
  END IF;
  IF v_number IS NOT NULL THEN
    RAISE EXCEPTION 'This estimate was invoiced as %, so it can''t be deleted — the invoice would lose the estimate it billed.', v_number
      USING ERRCODE = 'P0001';
  END IF;
  RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION public.refuse_deleting_invoiced_estimate() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS estimates_refuse_invoiced_delete ON public.estimates;
CREATE TRIGGER estimates_refuse_invoiced_delete BEFORE DELETE ON public.estimates
  FOR EACH ROW EXECUTE FUNCTION public.refuse_deleting_invoiced_estimate();

DROP TRIGGER IF EXISTS job_calculations_refuse_invoiced_delete ON public.job_calculations;
CREATE TRIGGER job_calculations_refuse_invoiced_delete BEFORE DELETE ON public.job_calculations
  FOR EACH ROW EXECUTE FUNCTION public.refuse_deleting_invoiced_estimate();

-- ---------------------------------------------------------------------------
-- 2. record_history covers job_calculations
-- ---------------------------------------------------------------------------
--
-- The procedure 20261006150000 documents for a new table, to the letter:
-- the CHECK, the CASE branches, the allow-lists, the trigger. Every function
-- below is that migration's own text with only the job_calculations lines
-- added (marked "job_calculations: begin/end", or `, 'job_calculations'` in
-- a list); src/lib/estimate-delete.test.ts strips them and compares with
-- 20261006150000 so a later change there cannot be silently undone here.

ALTER TABLE public.record_history DROP CONSTRAINT IF EXISTS record_history_table_allowed;
ALTER TABLE public.record_history ADD CONSTRAINT record_history_table_allowed CHECK (table_name IN (
  'job_notes', 'job_section_notes', 'job_contacts', 'tasks',
  'estimates', 'estimate_scopes', 'estimate_lines', 'job_calculations'
));

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
    -- job_calculations: begin
    WHEN 'job_calculations' THEN
      -- Deletes only, like an estimate. A sheet is re-priced by saving it
      -- again; what Mark asked to undo is one coming off the job's Billing
      -- tab. A sheet with no job has no Timeline to restore it from.
      IF TG_OP = 'UPDATE' THEN RETURN NULL; END IF;
      v_job := (v_old ->> 'job_id')::uuid;
      v_summary := 'Quick Estimate "' || CASE v_old ->> 'job_type'
          WHEN 'water' THEN 'Water'
          WHEN 'mold' THEN 'Mold'
          WHEN 'fire_smoke' THEN 'Fire / Smoke'
          ELSE COALESCE(v_old ->> 'job_type', 'Calculator')
        END || '" of ' || COALESCE(v_old ->> 'job_date', '?');
    -- job_calculations: end
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
    -- job_calculations: begin
    WHEN 'job_calculations' THEN
      -- 20260903172802 job_calculations_delete:
      --   can_manage_location(auth.uid(), location_id) OR created_by = auth.uid()
      RETURN _op = 'delete' AND (
        public.can_manage_location(_uid, (_row ->> 'location_id')::uuid)
        OR (_row ->> 'created_by')::uuid IS NOT DISTINCT FROM _uid
      );
    -- job_calculations: end
    ELSE
      -- estimate_scopes / estimate_lines come back only with their estimate,
      -- under the estimate's rule. Anything else is not on the list.
      RETURN false;
  END CASE;
END;
$$;

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
    -- job_calculations: begin
    -- Type and date only. The price is withheld from anyone without the
    -- calculator's cost rights (job_calculations_select), so it stays out.
    WHEN 'job_calculations' THEN jsonb_build_object(
      'type', CASE _image ->> 'job_type'
          WHEN 'water' THEN 'Water'
          WHEN 'mold' THEN 'Mold'
          WHEN 'fire_smoke' THEN 'Fire / Smoke'
          ELSE _image ->> 'job_type'
        END,
      'date', _image -> 'job_date')
    -- job_calculations: end
    ELSE '{}'::jsonb
  END;
$$;

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

  IF NOT (_h.table_name = ANY (ARRAY['job_notes', 'job_section_notes', 'job_contacts', 'tasks', 'estimates', 'job_calculations'])) THEN
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
    'estimates', 'estimate_scopes', 'estimate_lines', 'job_calculations'])) THEN
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
  IF NOT (v_h.table_name = ANY (ARRAY['job_notes', 'job_section_notes', 'job_contacts', 'tasks', 'estimates', 'job_calculations'])) THEN
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

-- Deletes only (see the capture branch). Same name, so it sorts before any
-- cascade like the others.
DROP TRIGGER IF EXISTS "A_record_history" ON public.job_calculations;
CREATE TRIGGER "A_record_history" AFTER DELETE ON public.job_calculations
  FOR EACH ROW EXECUTE FUNCTION public.record_history_capture();

-- Grants are unchanged by CREATE OR REPLACE; restated so this file reads whole.
REVOKE ALL ON FUNCTION public.record_history_capture() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_history_may_restore(uuid, text, text, jsonb, jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_history_display(text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_history_state(public.record_history, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_history_reinsert(text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.restore_record_history(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.restore_record_history(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. May the app offer Delete on this table?
-- ---------------------------------------------------------------------------
--
-- True when the table carries the "A_record_history" trigger — read from the
-- catalogue, so it is the truth about THIS database rather than a list that
-- could disagree with it. The Billing tab offers Delete on an estimate only
-- when this says estimates are covered, and on a Quick Estimate only when it
-- says job_calculations are. Before #300 or this file is applied the function
-- (or the trigger) is missing and the answer is no: a delete that could not
-- be restored is never offered.
--
-- Invoker rights: it reads only pg_trigger, which every role can already read.
CREATE OR REPLACE FUNCTION public.record_history_covers(_table text)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_trigger t
     WHERE t.tgrelid = to_regclass('public.' || quote_ident(_table))
       AND t.tgname = 'A_record_history'
       AND NOT t.tgisinternal
  );
$$;

REVOKE ALL ON FUNCTION public.record_history_covers(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_history_covers(text) TO authenticated, service_role;
