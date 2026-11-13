-- Revert a change to the job's own fields, from the Timeline.
--
-- Mark, on a job: "in timeline have a restore button for each item that gets
-- removed or changed". The job's own fields — status, address, customer,
-- adjusters, dates — are the "changed" half for the job itself.
--
-- UNAPPLIED. Until this runs the Timeline shows field changes exactly as it
-- does today, without a Revert.
--
-- ---------------------------------------------------------------------------
-- THE DESIGN
-- ---------------------------------------------------------------------------
--
-- 1. NO NEW CAPTURE. Every change to a job already lands in job_field_changes
--    (trigger log_job_field_changes, 20260820184525): one row per column that
--    moved, old and new value as text, who, when. That trail goes back to
--    August, so a change made before this migration can be reverted too. The
--    generic record_history (20261006150000) is deliberately NOT attached to
--    jobs: two logs of the same edit would disagree sooner or later.
--
-- 2. ONE EDIT IS ONE ENTRY. A single save writes several rows with the same
--    changed_at (now() is fixed for the transaction): moving a job to a stage
--    writes stage_id and status; an address writes address, locality, lat,
--    lon. Revert takes the whole group back together, so a stage and its
--    status never come apart.
--
-- 3. SECURITY INVOKER — THE JOBS POLICY DECIDES. Unlike the record restore,
--    nothing here forces a definer: job_field_changes is readable by anyone
--    who can see the job (its own policy), the values in it are job fields
--    that same person can already read, and jobs has no authorship pin. So
--    the revert is a plain UPDATE of public.jobs run as the caller, and
--    jobs_update (can_manage_location OR crew_chief, USING and WITH CHECK)
--    allows it or not. It cannot write anything the caller could not have
--    typed into the job form.
--
-- 4. WHICH FIELDS. An explicit allow-list (JOB_REVERTABLE_FIELDS in
--    src/lib/job-field-revert.ts mirrors it; a test pins the two together).
--    Left out:
--      - money (deductible, estimated / approved / billed / collected
--        amounts, agreed price, deposit, commission): the same reasoning as
--        the record restore — billed/approved/collected are rollups of the
--        invoices, the rest drive commission, and the UI only shows them to
--        job.view_costs holders. A wrong number there is fixed by typing the
--        right one, on purpose;
--      - system and derived columns (ids, timestamps, created_by, geom,
--        pipeline_id and stage_entered_at — the stage trigger derives them,
--        external sync ids, first_response_at, is_demo, origin links).
--    When the group holds stage_id, status is not written: jobs_sync_stage_status
--    derives it from the stage, exactly as when the stage was first set.
--
-- 5. CONFLICTS AND REPEATS. A field is reverted only while it still holds
--    the value this change gave it. If any field in the group has been
--    changed again since, the revert refuses and names it. If every field
--    already holds its old value, it is a no-op ("already reverted").
--
-- 6. THE REVERT IS LOGGED BY THE SAME TRAIL. Reverting is an UPDATE of jobs,
--    so log_job_field_changes records it like any edit. The new column
--    reverts_id ties each of those rows to the row it undid, so the Timeline
--    can say "Reverted by Mona". The trigger sets it only when the new value
--    really is that row's old value, so it cannot be claimed for an edit that
--    did not undo anything; one revert per row (unique index).
--
-- Re-runnable.

-- ---------------------------------------------------------------------------
-- 1. Link a revert to what it undid
-- ---------------------------------------------------------------------------
ALTER TABLE public.job_field_changes
  ADD COLUMN IF NOT EXISTS reverts_id uuid REFERENCES public.job_field_changes(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS job_field_changes_one_revert
  ON public.job_field_changes (reverts_id) WHERE reverts_id IS NOT NULL;

-- The group lookup: one job, one instant.
CREATE INDEX IF NOT EXISTS job_field_changes_group_idx
  ON public.job_field_changes (job_id, changed_at);

-- The existing logger, unchanged except for reverts_id. The column list,
-- the exclusions and the definer context are 20260820184525's.
CREATE OR REPLACE FUNCTION public.log_job_field_changes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  col record;
  old_v text;
  new_v text;
  actor uuid := auth.uid();
  v_anchor uuid := NULLIF(current_setting('job_field_changes.reverting', true), '')::uuid;
  v_anchor_at timestamptz;
  v_reverts uuid;
BEGIN
  IF v_anchor IS NOT NULL THEN
    SELECT c.changed_at INTO v_anchor_at
      FROM public.job_field_changes c
     WHERE c.id = v_anchor AND c.job_id = NEW.id;
  END IF;

  FOR col IN
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'jobs'
      AND column_name NOT IN ('id','created_at','updated_at','geom','stage_entered_at','created_by')
  LOOP
    EXECUTE format('SELECT ($1).%I::text, ($2).%I::text', col.column_name, col.column_name)
      INTO old_v, new_v
      USING OLD, NEW;
    IF old_v IS DISTINCT FROM new_v THEN
      v_reverts := NULL;
      IF v_anchor_at IS NOT NULL THEN
        -- Only a true undo: same job, same original edit, same field, and
        -- the value going back to exactly what that edit replaced.
        SELECT c.id INTO v_reverts
          FROM public.job_field_changes c
         WHERE c.job_id = NEW.id
           AND c.changed_at = v_anchor_at
           AND c.field = col.column_name
           AND c.old_value IS NOT DISTINCT FROM new_v
           AND NOT EXISTS (SELECT 1 FROM public.job_field_changes r WHERE r.reverts_id = c.id)
         LIMIT 1;
      END IF;
      INSERT INTO public.job_field_changes (job_id, field, old_value, new_value, changed_by, reverts_id)
      VALUES (NEW.id, col.column_name, old_v, new_v, actor, v_reverts);
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. The allow-list
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.job_revertable_fields()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT ARRAY[
    'account_id', 'additional_work_pending', 'address', 'address_line2',
    'adjuster_email', 'adjuster_name', 'adjuster_phone', 'bill_to_account_id',
    'bill_to_attention', 'billing_location_id', 'call_date', 'call_time',
    'cash_payer_name', 'claim_number', 'community', 'completion_date', 'county',
    'crew_chief', 'customer_kind', 'customer_name', 'desk_adjuster_contact_id',
    'desk_adjuster_email', 'desk_adjuster_name', 'desk_adjuster_phone',
    'field_adjuster_contact_id', 'field_adjuster_email', 'field_adjuster_name',
    'field_adjuster_phone', 'field_next_step', 'hoa', 'important_instructions',
    'independent_reviewer_account_id', 'independent_reviewer_contact_id',
    'independent_reviewer_email', 'independent_reviewer_firm',
    'independent_reviewer_name', 'independent_reviewer_phone',
    'initial_loss_description', 'insurance_agency', 'insurance_agency_account_id',
    'insurance_agent_email', 'insurance_agent_name', 'insurance_agent_phone',
    'insurance_carrier', 'insurance_carrier_account_id', 'insurance_kind',
    'insurance_kind_detail', 'job_name', 'job_number', 'job_type',
    'job_type_detail', 'lat', 'locality', 'location_id', 'lon', 'loss_date',
    'loss_description', 'loss_description_detail', 'loss_type',
    'loss_type_detail', 'loss_type_id', 'office_next_step', 'payment_terms',
    'policy_number', 'postal_code', 'primary_contact_id', 'priority',
    'public_adjuster_account_id', 'public_adjuster_contact_id',
    'public_adjuster_email', 'public_adjuster_name', 'public_adjuster_phone',
    'referral_source_type', 'referral_source_type_detail',
    'referred_by_account_id', 'referred_by_contact_id', 'referred_by_name',
    'region', 'rehabbed_after_1978', 'reported_source_detail',
    'reported_source_id', 'scope', 'stage_id', 'start_date', 'status',
    'third_party_company', 'water_category', 'water_class'
  ]::text[];
$$;

REVOKE ALL ON FUNCTION public.job_revertable_fields() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.job_revertable_fields() TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. The state of one edit (shared by the preview and the revert)
-- ---------------------------------------------------------------------------
--
-- status: ready | already_reverted | conflict | nothing_revertable | gone
-- fields: [{field, before, after, now, moved, revertable, reverted}]
-- may_edit: a HINT for the dialog — the jobs_update predicate, restated. The
--   revert itself does not rely on it; the UPDATE runs under RLS.
CREATE OR REPLACE FUNCTION public.job_field_change_state(_change_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_anchor public.job_field_changes%ROWTYPE;
  v_job public.jobs%ROWTYPE;
  v_fields jsonb := '[]'::jsonb;
  v_now text;
  v_revertable boolean;
  v_any boolean := false;
  v_all_back boolean := true;
  v_conflict boolean := false;
  v_all_marked boolean := true;
  r record;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sign in to revert' USING ERRCODE = '42501';
  END IF;
  -- Read as the caller: job_field_changes' own policy (can_view_job) decides.
  SELECT * INTO v_anchor FROM public.job_field_changes WHERE id = _change_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That change is not available' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_job FROM public.jobs WHERE id = v_anchor.job_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('id', _change_id, 'status', 'gone');
  END IF;

  FOR r IN
    SELECT c.*,
           EXISTS (SELECT 1 FROM public.job_field_changes x WHERE x.reverts_id = c.id) AS reverted
      FROM public.job_field_changes c
     WHERE c.job_id = v_anchor.job_id AND c.changed_at = v_anchor.changed_at
     ORDER BY c.field
  LOOP
    v_revertable := r.field = ANY (public.job_revertable_fields());
    EXECUTE format('SELECT ($1).%I::text', r.field) INTO v_now USING v_job;
    v_fields := v_fields || jsonb_build_array(jsonb_build_object(
      'field', r.field, 'before', r.old_value, 'after', r.new_value, 'now', v_now,
      'revertable', v_revertable, 'reverted', r.reverted,
      'moved', v_revertable AND v_now IS DISTINCT FROM r.new_value
               AND v_now IS DISTINCT FROM r.old_value));
    IF v_revertable THEN
      v_any := true;
      IF NOT r.reverted THEN v_all_marked := false; END IF;
      IF v_now IS DISTINCT FROM r.old_value THEN v_all_back := false; END IF;
      IF v_now IS DISTINCT FROM r.new_value AND v_now IS DISTINCT FROM r.old_value THEN
        v_conflict := true;
      END IF;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'id', _change_id,
    'job_id', v_anchor.job_id,
    'changed_at', v_anchor.changed_at,
    'fields', v_fields,
    'may_edit', COALESCE(public.can_manage_location(v_uid, v_job.location_id), false)
                OR v_job.crew_chief IS NOT DISTINCT FROM v_uid,
    'status', CASE
      WHEN NOT v_any THEN 'nothing_revertable'
      WHEN v_all_back THEN 'already_reverted'
      WHEN v_conflict THEN 'conflict'
      ELSE 'ready'
    END,
    'all_marked', v_all_marked);
END;
$$;

REVOKE ALL ON FUNCTION public.job_field_change_state(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.job_field_change_state(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. The revert
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.revert_job_field_change(_change_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_state jsonb;
  v_status text;
  v_job uuid;
  v_at timestamptz;
  v_has_stage boolean;
  v_set text;
  v_moved text;
  v_count integer;
BEGIN
  v_state := public.job_field_change_state(_change_id);
  v_status := v_state ->> 'status';
  IF v_status = 'already_reverted' THEN
    RETURN v_state;
  ELSIF v_status = 'gone' THEN
    RAISE EXCEPTION 'That job no longer exists' USING ERRCODE = 'P0002';
  ELSIF v_status = 'nothing_revertable' THEN
    RAISE EXCEPTION 'Nothing in this change can be reverted here (money and system fields are left out).'
      USING ERRCODE = '22023';
  ELSIF v_status = 'conflict' THEN
    SELECT string_agg(f ->> 'field', ', ') INTO v_moved
      FROM jsonb_array_elements(v_state -> 'fields') f
     WHERE (f ->> 'moved')::boolean;
    RAISE EXCEPTION 'Changed again since (%). Nothing was reverted; edit the job by hand.', v_moved
      USING ERRCODE = '40001';
  END IF;

  v_job := (v_state ->> 'job_id')::uuid;
  v_at := (v_state ->> 'changed_at')::timestamptz;
  SELECT bool_or(f ->> 'field' = 'stage_id') INTO v_has_stage
    FROM jsonb_array_elements(v_state -> 'fields') f
   WHERE (f ->> 'revertable')::boolean;

  -- Each still-moved, allow-listed field back to its old text, cast to the
  -- column's own type. Column names come from the allow-list intersected
  -- with the catalogue; values are quoted literals.
  SELECT string_agg(
           format('%I = %L::%s', a.attname, f ->> 'before', format_type(a.atttypid, a.atttypmod)),
           ', ')
    INTO v_set
    FROM jsonb_array_elements(v_state -> 'fields') f
    JOIN pg_catalog.pg_attribute a
      ON a.attrelid = 'public.jobs'::regclass
     AND a.attname = f ->> 'field'
     AND a.attnum > 0 AND NOT a.attisdropped
   WHERE (f ->> 'revertable')::boolean
     AND (f ->> 'now') IS NOT DISTINCT FROM (f ->> 'after')
     AND (f ->> 'after') IS DISTINCT FROM (f ->> 'before')
     -- The stage drives status (jobs_sync_stage_status); write the stage only.
     AND NOT (COALESCE(v_has_stage, false) AND f ->> 'field' = 'status');

  IF v_set IS NULL THEN
    RETURN v_state || jsonb_build_object('status', 'already_reverted');
  END IF;

  PERFORM set_config('job_field_changes.reverting', _change_id::text, true);
  -- As the caller. jobs_update decides; a refused USING touches no row.
  EXECUTE format('UPDATE public.jobs SET %s WHERE id = $1', v_set) USING v_job;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  PERFORM set_config('job_field_changes.reverting', '', true);

  IF v_count = 0 THEN
    RAISE EXCEPTION 'You can''t change this job, so you can''t revert its fields.'
      USING ERRCODE = '42501';
  END IF;

  RETURN v_state || jsonb_build_object('status', 'reverted');
END;
$$;

REVOKE ALL ON FUNCTION public.revert_job_field_change(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.revert_job_field_change(uuid) TO authenticated, service_role;
