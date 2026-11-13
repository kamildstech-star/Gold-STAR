-- Delete and edit history: the second set of job tables.
--
-- Mark, on a job: "in timeline have a restore button for each item that gets
-- removed or changed".
--
-- UNAPPLIED. REQUIRES 20261006150000_record_history (#300) and
-- 20261006163000_estimate_delete (#312) applied first — every shared function
-- below is the latest text of those two plus this file's tables, and
-- record-history-migrations.test.ts fails if a later redefinition drops a
-- table an earlier one covered. Until this is applied, these tables behave
-- exactly as today.
--
-- ADDED HERE
--
--   photos                Restore a removed photo. Photos already soft-delete
--                         (deleted_at; the file is never removed), so Restore
--                         clears deleted_at instead of re-inserting. Removing
--                         several at once is ONE entry ("Restore 12 photos"):
--                         the first photo of the removal is the entry, the
--                         rest hang off it as children. Photos removed before
--                         this migration are backfilled, so every removed
--                         photo on a job has its Restore.
--   job_assignments       Crew taken off a job.
--   job_contact_methods   A phone or email removed or edited.
--   job_intake_answers    A questionnaire answer cleared (the app deletes the
--                         row) or changed.
--   job_drying_readings   A reading deleted or its numbers edited. Weather
--                         rows are the system's, not anybody's edit: skipped.
--   job_moisture_points   A moisture point deleted (its readings come back
--                         with it) or edited — including "removed", which is
--                         this table's own soft remove (removed_at), so it
--                         reverts like any edit.
--   job_moisture_readings A moisture reading deleted or edited.
--
-- LEFT FOR LATER, AND WHY
--
--   job_rooms             Its children are changing under the Rooms work
--                         (#299 adds openings and cabinets that cascade with a
--                         room) and four tables point at it ON DELETE SET
--                         NULL. A room should come back with all of that, so
--                         it waits until the Rooms PRs land.
--   documents             Deleting one cascades its signatures and events,
--                         which a restore could not honestly bring back; the
--                         app never deletes documents (only the demo purge).
--   field_work_tickets    Deleting one cascades its job-cost line (money).
--   equipment_placements  Only an admin can delete one; a re-insert would flip
--                         the unit's status and can collide with its next job.
--
-- ALSO CHANGED
--
--   record_history.row_pk becomes text: photo ids are text (client ULIDs).
--   Lookups cast to the table's own id type, so indexes still apply.
--
-- Permission rules restated, as before, from each table's own policies (the
-- live ones — see each branch). The pglite proof is
-- supabase/tests/record-history-more.pglite.mjs.
--
-- Re-runnable.

-- ---------------------------------------------------------------------------
-- 1. Shape
-- ---------------------------------------------------------------------------
ALTER TABLE public.record_history ALTER COLUMN row_pk TYPE text USING row_pk::text;

ALTER TABLE public.record_history DROP CONSTRAINT IF EXISTS record_history_table_allowed;
ALTER TABLE public.record_history ADD CONSTRAINT record_history_table_allowed CHECK (table_name IN (
  'job_notes', 'job_section_notes', 'job_contacts', 'tasks',
  'estimates', 'estimate_scopes', 'estimate_lines', 'job_calculations',
  'photos', 'job_assignments', 'job_contact_methods', 'job_intake_answers',
  'job_drying_readings', 'job_moisture_points', 'job_moisture_readings'
));

-- The table's own id type, for `WHERE id = $1::<type>`.
CREATE OR REPLACE FUNCTION public.record_history_id_type(_table text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT format_type(a.atttypid, a.atttypmod)
    FROM pg_catalog.pg_attribute a
   WHERE a.attrelid = format('public.%I', _table)::regclass
     AND a.attname = 'id' AND NOT a.attisdropped;
$$;

REVOKE ALL ON FUNCTION public.record_history_id_type(text) FROM PUBLIC, anon, authenticated;

-- A value as a person reads it: people and questions by name, not id.
CREATE OR REPLACE FUNCTION public.record_history_display_value(_column text, _value jsonb)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN _value IS NULL OR _value = 'null'::jsonb THEN 'null'::jsonb
    WHEN _column IN ('assignee', 'author_id', 'created_by', 'user_id') THEN
      to_jsonb(COALESCE(
        (SELECT p.full_name FROM public.profiles p WHERE p.user_id = (_value #>> '{}')::uuid),
        'someone'))
    WHEN _column = 'question_id' THEN
      to_jsonb(COALESCE(
        (SELECT q.prompt FROM public.intake_questions q WHERE q.id = (_value #>> '{}')::uuid),
        'a question'))
    ELSE _value
  END;
$$;

REVOKE ALL ON FUNCTION public.record_history_display_value(text, jsonb) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Capture
-- ---------------------------------------------------------------------------
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
  v_op text := lower(TG_OP);
  v_children integer;
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
         AND h.row_pk = v_old ->> 'estimate_id'
         AND h.txid = txid_current()
       ORDER BY h.seq DESC
       LIMIT 1;
      IF v_parent IS NULL THEN RETURN NULL; END IF;
      v_summary := CASE TG_TABLE_NAME WHEN 'estimate_scopes' THEN 'scope "' ELSE 'line "' END
        || COALESCE(v_old ->> 'name', '') || '"';
    WHEN 'job_calculations' THEN
      -- Deletes only, like an estimate (20261006163000).
      IF TG_OP = 'UPDATE' THEN RETURN NULL; END IF;
      v_job := (v_old ->> 'job_id')::uuid;
      v_summary := 'Quick Estimate "' || CASE v_old ->> 'job_type'
          WHEN 'water' THEN 'Water'
          WHEN 'mold' THEN 'Mold'
          WHEN 'fire_smoke' THEN 'Fire / Smoke'
          ELSE COALESCE(v_old ->> 'job_type', 'Calculator')
        END || '" of ' || COALESCE(v_old ->> 'job_date', '?');
    WHEN 'photos' THEN
      -- A photo is removed by setting deleted_at (the file stays). Only that
      -- moment is captured, as a delete; folder moves and the like are not.
      IF TG_OP <> 'UPDATE' THEN RETURN NULL; END IF;
      IF (v_old ->> 'deleted_at') IS NOT NULL OR (v_new ->> 'deleted_at') IS NULL THEN
        RETURN NULL;
      END IF;
      v_op := 'delete';
      SELECT p.job_id INTO v_job FROM public.projects p WHERE p.id = (v_old ->> 'project_id')::uuid;
      v_summary := 'photo taken ' || COALESCE(to_char((v_old ->> 'captured_at')::timestamptz, 'Mon DD'), 'earlier');
      -- Removing twelve at once is one entry: the first photo of this
      -- removal is it, the rest are its children.
      SELECT h.id INTO v_parent
        FROM public.record_history h
       WHERE h.table_name = 'photos' AND h.op = 'delete' AND h.parent_id IS NULL
         AND h.txid = txid_current() AND h.job_id = v_job
         AND h.actor_id IS NOT DISTINCT FROM auth.uid()
       ORDER BY h.seq
       LIMIT 1;
    WHEN 'job_assignments' THEN
      -- Removals only. A role change is a re-pick in the crew list.
      IF TG_OP = 'UPDATE' THEN RETURN NULL; END IF;
      v_job := (v_old ->> 'job_id')::uuid;
      v_summary := 'crew ' || (public.record_history_display_value('user_id', v_old -> 'user_id') #>> '{}')
        || ' (' || replace(COALESCE(v_old ->> 'role', 'crew'), '_', ' ') || ')';
    WHEN 'job_contact_methods' THEN
      v_job := (v_old ->> 'job_id')::uuid;
      -- is_preferred is left out: "make preferred" clears it on every other
      -- row of the job first, and those are not edits anybody meant.
      v_cols := ARRAY['label', 'value', 'extension'];
      v_summary := COALESCE(v_old ->> 'kind', 'contact') || ' ' || COALESCE(v_old ->> 'value', '');
    WHEN 'job_intake_answers' THEN
      v_job := (v_old ->> 'job_id')::uuid;
      v_cols := ARRAY['answer_text', 'answer_bool', 'answer_date'];
      v_summary := 'answer to "'
        || left(public.record_history_display_value('question_id', v_old -> 'question_id') #>> '{}', 120) || '"';
    WHEN 'job_drying_readings' THEN
      -- The daily weather row is fetched by the system; not an edit.
      IF v_old ->> 'source' = 'weather' THEN RETURN NULL; END IF;
      v_job := (v_old ->> 'job_id')::uuid;
      v_cols := ARRAY['temperature_f', 'relative_humidity', 'dew_point_f', 'grains_per_pound', 'notes'];
      v_summary := 'drying reading ' || COALESCE(NULLIF(v_old ->> 'label', ''), v_old ->> 'point', '')
        || ' of ' || COALESCE(v_old ->> 'reading_date', '?');
    WHEN 'job_moisture_points' THEN
      v_job := (v_old ->> 'job_id')::uuid;
      v_cols := ARRAY['material', 'location', 'dry_standard', 'removed_at'];
      v_summary := 'moisture point ' || COALESCE(v_old ->> 'material', '')
        || COALESCE(' at ' || NULLIF(v_old ->> 'location', ''), '');
    WHEN 'job_moisture_readings' THEN
      v_job := (v_old ->> 'job_id')::uuid;
      v_cols := ARRAY['moisture_pct', 'notes'];
      v_summary := 'moisture reading ' || COALESCE(v_old ->> 'moisture_pct', '?') || '% of '
        || COALESCE(v_old ->> 'reading_date', '?');
      IF TG_OP = 'DELETE'
         AND NOT EXISTS (SELECT 1 FROM public.job_moisture_points p WHERE p.id = (v_old ->> 'point_id')::uuid) THEN
        -- Cascading with its point: hang off the point's row, which the
        -- trigger's name makes sure was written first.
        SELECT h.id INTO v_parent
          FROM public.record_history h
         WHERE h.table_name = 'job_moisture_points' AND h.op = 'delete'
           AND h.row_pk = v_old ->> 'point_id' AND h.txid = txid_current()
         ORDER BY h.seq DESC
         LIMIT 1;
        IF v_parent IS NULL THEN RETURN NULL; END IF;
      END IF;
    ELSE
      RAISE EXCEPTION 'record_history_capture() is not configured for %', TG_TABLE_NAME;
  END CASE;

  IF v_job IS NULL THEN RETURN NULL; END IF;
  -- Deleting a whole job cascades into these tables after the job row is
  -- gone. There is nothing to restore into, and the history goes with it.
  IF NOT EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = v_job) THEN RETURN NULL; END IF;

  IF v_op = 'update' THEN
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
      (TG_TABLE_NAME, v_old ->> 'id', 'update', v_job, auth.uid(), v_summary,
       v_display, v_changed, v_old_vals, v_new_vals);
  ELSE
    INSERT INTO public.record_history
      (table_name, row_pk, op, job_id, actor_id, summary, old_row, parent_id)
    VALUES
      (TG_TABLE_NAME, v_old ->> 'id', 'delete', v_job, auth.uid(), v_summary,
       v_old, v_parent);
    -- A batch of photos reads as a count on its one entry.
    IF TG_TABLE_NAME = 'photos' AND v_parent IS NOT NULL THEN
      SELECT count(*) + 1 INTO v_children FROM public.record_history WHERE parent_id = v_parent;
      UPDATE public.record_history SET summary = v_children || ' photos' WHERE id = v_parent;
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.record_history_capture() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Who may restore: each table's own rule, restated
-- ---------------------------------------------------------------------------
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
    WHEN 'job_calculations' THEN
      -- 20260903172802 job_calculations_delete (via 20261006163000):
      --   can_manage_location(auth.uid(), location_id) OR created_by = auth.uid()
      RETURN _op = 'delete' AND (
        public.can_manage_location(_uid, (_row ->> 'location_id')::uuid)
        OR (_row ->> 'created_by')::uuid IS NOT DISTINCT FROM _uid
      );
    WHEN 'photos' THEN
      -- Removing and restoring a photo are both UPDATEs. 20260728175932
      -- photos_update_manage (USING = CHECK, same project either side):
      --   can_manage_project(auth.uid(), project_id)
      RETURN public.can_manage_project(_uid, (_row ->> 'project_id')::uuid);
    WHEN 'job_assignments' THEN
      -- 20260728041824 job_assignments_write (FOR ALL):
      --   can_manage_job(auth.uid(), job_id)
      RETURN public.can_manage_job(_uid, v_job);
    WHEN 'job_contact_methods' THEN
      -- 20260803205051 job_contact_methods_write (FOR ALL):
      --   can_manage_job(auth.uid(), job_id)
      RETURN public.can_manage_job(_uid, v_job);
    WHEN 'job_intake_answers' THEN
      -- 20260818181614 job_intake_answers_write (FOR ALL):
      --   can_manage_job(auth.uid(), job_id)
      RETURN public.can_manage_job(_uid, v_job);
    WHEN 'job_drying_readings', 'job_moisture_points', 'job_moisture_readings' THEN
      -- The live policies (20260901120000 drying log; 20260928161000
      -- moisture points and readings — the same four rules each):
      --   DELETE  is_privileged(auth.uid())
      --   UPDATE  created_by = auth.uid() OR can_manage_job(auth.uid(), job_id)
      --           (USING = CHECK; created_by and job_id are not reverted)
      -- A fresh replay also carries Lovable's looser drying policies from
      -- 20260902172552; production does not (drying_log dropped them), and
      -- this mirrors production.
      IF _op = 'delete' THEN
        RETURN public.is_privileged(_uid);
      END IF;
      RETURN (_row ->> 'created_by')::uuid IS NOT DISTINCT FROM _uid
          OR public.can_manage_job(_uid, v_job);
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
    WHEN 'photos' THEN jsonb_build_object('taken', _image -> 'captured_at')
    WHEN 'job_assignments' THEN jsonb_build_object(
      'person', public.record_history_display_value('user_id', _image -> 'user_id'),
      'role', _image -> 'role', 'start_date', _image -> 'start_date', 'end_date', _image -> 'end_date')
    WHEN 'job_contact_methods' THEN jsonb_build_object(
      'kind', _image -> 'kind', 'label', _image -> 'label', 'value', _image -> 'value',
      'extension', _image -> 'extension')
    WHEN 'job_intake_answers' THEN jsonb_build_object(
      'question', public.record_history_display_value('question_id', _image -> 'question_id'),
      'answer', COALESCE(_image -> 'answer_text', _image -> 'answer_bool', _image -> 'answer_date'))
    WHEN 'job_drying_readings' THEN jsonb_build_object(
      'reading_date', _image -> 'reading_date', 'point', COALESCE(_image -> 'label', _image -> 'point'),
      'temperature_f', _image -> 'temperature_f', 'relative_humidity', _image -> 'relative_humidity',
      'grains_per_pound', _image -> 'grains_per_pound', 'notes', _image -> 'notes')
    WHEN 'job_moisture_points' THEN jsonb_build_object(
      'material', _image -> 'material', 'location', _image -> 'location',
      'dry_standard', _image -> 'dry_standard')
    WHEN 'job_moisture_readings' THEN jsonb_build_object(
      'reading_date', _image -> 'reading_date', 'moisture_pct', _image -> 'moisture_pct',
      'notes', _image -> 'notes')
    ELSE '{}'::jsonb
  END;
$$;

REVOKE ALL ON FUNCTION public.record_history_display(text, jsonb) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. The state of one entry (shared by the preview and the restore)
-- ---------------------------------------------------------------------------
--
-- Adds to #300's statuses:
--   purged — a removed photo whose row has since been deleted outright (its
--            project went); nothing left to bring back.
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
  v_ids text[];
  v_present integer;
  v_removed integer;
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

  IF NOT (_h.table_name = ANY (ARRAY[
    'job_notes', 'job_section_notes', 'job_contacts', 'tasks', 'estimates', 'job_calculations',
    'photos', 'job_assignments', 'job_contact_methods', 'job_intake_answers',
    'job_drying_readings', 'job_moisture_points', 'job_moisture_readings'])) THEN
    RETURN v_base || jsonb_build_object('status', 'not_allowed');
  END IF;

  -- The current row, read as the owner; only display-safe parts leave.
  EXECUTE format('SELECT to_jsonb(t) FROM public.%I t WHERE t.id = $1::%s',
                 _h.table_name, public.record_history_id_type(_h.table_name))
    INTO v_current USING _h.row_pk;

  IF _h.op = 'delete' THEN
    SELECT jsonb_build_object(
             'scopes', count(*) FILTER (WHERE ch.table_name = 'estimate_scopes'),
             'lines', count(*) FILTER (WHERE ch.table_name = 'estimate_lines'),
             'photos', count(*) FILTER (WHERE ch.table_name = 'photos'),
             'readings', count(*) FILTER (WHERE ch.table_name = 'job_moisture_readings'))
      INTO v_children
      FROM public.record_history ch WHERE ch.parent_id = _h.id;
    v_base := v_base || jsonb_build_object(
      'detail', public.record_history_display(_h.table_name, _h.old_row),
      'children', v_children);

    IF _h.table_name = 'photos' THEN
      -- A soft delete: "back" means deleted_at is clear again, for the
      -- entry's photo and every photo removed with it.
      SELECT array_agg(x) INTO v_ids
        FROM (SELECT _h.row_pk AS x
              UNION ALL SELECT ch.row_pk FROM public.record_history ch WHERE ch.parent_id = _h.id) s;
      SELECT count(*), count(*) FILTER (WHERE p.deleted_at IS NOT NULL)
        INTO v_present, v_removed
        FROM public.photos p WHERE p.id = ANY (v_ids);
      IF v_present = 0 THEN
        RETURN v_base || jsonb_build_object('status', 'purged');
      ELSIF v_removed = 0 THEN
        RETURN v_base || jsonb_build_object('status', 'already_present');
      END IF;
      IF NOT public.record_history_may_restore(_uid, 'photos', 'delete', _h.old_row, NULL) THEN
        RETURN v_base || jsonb_build_object('status', 'not_allowed');
      END IF;
      RETURN v_base || jsonb_build_object('status', 'ready');
    END IF;

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
CREATE OR REPLACE FUNCTION public.record_history_reinsert(_table text, _image jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cols text;
BEGIN
  -- photos is not here: a removed photo is never re-inserted, only un-removed.
  IF NOT (_table = ANY (ARRAY[
    'job_notes', 'job_section_notes', 'job_contacts', 'tasks',
    'estimates', 'estimate_scopes', 'estimate_lines', 'job_calculations',
    'job_assignments', 'job_contact_methods', 'job_intake_answers',
    'job_drying_readings', 'job_moisture_points', 'job_moisture_readings'])) THEN
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
  IF NOT (v_h.table_name = ANY (ARRAY[
    'job_notes', 'job_section_notes', 'job_contacts', 'tasks', 'estimates', 'job_calculations',
    'photos', 'job_assignments', 'job_contact_methods', 'job_intake_answers',
    'job_drying_readings', 'job_moisture_points', 'job_moisture_readings'])) THEN
    RAISE EXCEPTION 'Restore is not available for %', v_h.table_name USING ERRCODE = '42501';
  END IF;

  v_state := public.record_history_state(v_h, v_uid);
  v_status := v_state ->> 'status';

  IF v_status IN ('already_restored', 'already_present', 'already_reverted') THEN
    RETURN v_state;
  ELSIF v_status = 'child' THEN
    RAISE EXCEPTION 'This came off with something else. Restore that entry to bring it back.'
      USING ERRCODE = '22023';
  ELSIF v_status = 'gone' THEN
    RAISE EXCEPTION 'It was deleted after this change. Restore the deletion first.'
      USING ERRCODE = '55000';
  ELSIF v_status = 'purged' THEN
    RAISE EXCEPTION 'That photo has since been deleted for good; there is nothing left to restore.'
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
    IF v_h.table_name = 'photos' THEN
      -- Un-remove: the entry's photo and every photo removed with it that
      -- is still removed. Nothing else about them is touched.
      UPDATE public.photos p
         SET deleted_at = NULL, deleted_by = NULL, deleted_reason = NULL
       WHERE p.deleted_at IS NOT NULL
         AND p.id IN (SELECT v_h.row_pk
                      UNION ALL
                      SELECT ch.row_pk FROM public.record_history ch WHERE ch.parent_id = v_h.id);
    ELSIF v_h.op = 'delete' THEN
      PERFORM public.record_history_reinsert(v_h.table_name, v_h.old_row);
      -- Children after their parent; an estimate's scopes before its lines
      -- (a line may name its scope).
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
        'UPDATE public.%I t SET %s FROM jsonb_populate_record(NULL::public.%I, $1) r WHERE t.id = $2::%s',
        v_h.table_name, v_set, v_h.table_name, public.record_history_id_type(v_h.table_name))
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
          WHEN v_constraint LIKE 'job_intake_answers%' THEN
            'Can''t put it back: that question has been answered again since.'
          WHEN v_constraint LIKE 'job_assignments%' THEN
            'Can''t put it back: that person is already on the job in that role.'
          WHEN v_constraint LIKE '%weather%' THEN
            'Can''t put it back: that day already has a weather reading.'
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

-- ---------------------------------------------------------------------------
-- 6. The triggers
-- ---------------------------------------------------------------------------
-- Same name as the others: "A_…" fires before any ON DELETE CASCADE, so a
-- moisture point's row exists before its readings cascade.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'job_assignments', 'job_contact_methods', 'job_intake_answers',
    'job_drying_readings', 'job_moisture_points', 'job_moisture_readings'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS "A_record_history" ON public.%I', t);
    EXECUTE format(
      'CREATE TRIGGER "A_record_history" AFTER UPDATE OR DELETE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION public.record_history_capture()', t);
  END LOOP;
END $$;

-- Photos: only the moment deleted_at is set.
DROP TRIGGER IF EXISTS "A_record_history" ON public.photos;
CREATE TRIGGER "A_record_history" AFTER UPDATE OF deleted_at ON public.photos
  FOR EACH ROW EXECUTE FUNCTION public.record_history_capture();

-- ---------------------------------------------------------------------------
-- 7. Photos removed before today
-- ---------------------------------------------------------------------------
-- Each currently removed photo on a job gets its entry, dated when it was
-- removed and naming who removed it, so the Timeline's existing "Photo
-- deleted" rows all gain a Restore. The image is the photo as it was before
-- the removal (the three deleted_* columns cleared). Re-runnable.
INSERT INTO public.record_history (occurred_at, table_name, row_pk, op, job_id, actor_id, summary, old_row)
SELECT ph.deleted_at, 'photos', ph.id, 'delete', pr.job_id, ph.deleted_by,
       'photo taken ' || COALESCE(to_char(ph.captured_at, 'Mon DD'), 'earlier'),
       to_jsonb(ph) || '{"deleted_at": null, "deleted_by": null, "deleted_reason": null}'::jsonb
  FROM public.photos ph
  JOIN public.projects pr ON pr.id = ph.project_id
  JOIN public.jobs j ON j.id = pr.job_id
 WHERE ph.deleted_at IS NOT NULL
   AND ph.is_demo IS NOT TRUE
   AND NOT EXISTS (SELECT 1 FROM public.record_history h
                    WHERE h.table_name = 'photos' AND h.row_pk = ph.id);
