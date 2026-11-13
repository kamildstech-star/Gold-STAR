-- Job checklists move out of the code and into a table David can edit.
--
-- WRITTEN, NOT APPLIED. Three new tables, one trigger on tasks, two
-- functions. Nothing is dropped and no existing row changes. The app works
-- before this is applied: src/lib/automatic-job-tasks.ts reads the templates
-- from here and falls back to the lists compiled into it when the table is
-- missing, so behaviour on day one is identical either way.
--
-- Mark, on PR #275's lists, three asks:
--   "for now yes, but make a way for him to disable it in the admin"
--     (Monitoring and Pick up equipment seeding on Mold and Fire jobs);
--   "i dont see the tasks live, it should work retroactively";
--   "like this for tasks" (a screenshot of Settings › Supply catalog).
--
-- 1. job_task_templates — one row per checklist line. group_key is the phase
--    (the six groups in automatic-job-tasks.ts); task_key is STORAGE: it is
--    the last part of every seeded task's cadence key
--    (`job-scope:<job>:<group>:<task_key>`), so it never changes. Renaming a
--    line changes `title` only, which is how a rename reaches tasks already on
--    jobs without retiring them. There is no DELETE grant: a line is switched
--    off (active = false), never removed, because removing it would orphan the
--    key that tasks on jobs still carry.
--
--    What is NOT here: which event seeds each group, and which date each
--    group is due on. Those are behaviour wired into code paths (job type,
--    the remediation flag, the placement write, the 72-hour drying clock), so
--    a column could not change them without a code change anyway. They live
--    once in TASK_GROUPS in automatic-job-tasks.ts and are mirrored in
--    job_automatic_task_candidates() below; automatic-job-task-templates.test.ts
--    holds the two together.
--
-- 2. job_task_seeding_settings — Mark's "make a way for him to disable it":
--    whether placing equipment seeds Monitoring and Pick up equipment on Mold
--    jobs and on Fire jobs. Both default ON ("for now yes"). Water is not a
--    row: Monitoring on a drying job is the point of the drying log, and the
--    question Mark answered was only whether it should ALSO apply to Mold and
--    Fire. A missing row reads as on.
--
-- 3. job_task_seed_keys — every automatic cadence key ever put on a job, kept
--    after the task is deleted. Reconciling is "insert what is missing", and
--    a task somebody deliberately deleted is missing; this ledger is how the
--    app and the backfill tell "never seeded" from "seeded, then removed", so
--    a deleted task is never put back. Filled by a trigger on tasks, so every
--    path (app, offline queue, backfill, Lovable, SQL) is covered, and primed
--    below from the tasks that exist today. Hard delete stays a hard DELETE
--    (the record_history convention); restoring a deleted task re-inserts
--    its key, which is already here, and nothing re-seeds it in between.
--
-- 4. sync_job_automatic_tasks(_dry_run, _only_seeded_groups) — the
--    retroactive pass. Only OPEN jobs (status new / scheduled / in_progress /
--    drying, OPEN_JOB_STATUSES in src/lib/jobs.ts). It inserts the active
--    lines a job should have and does not, skipping any key in the ledger,
--    and brings open tasks to the current title. It never reopens, re-dates,
--    cancels or deletes anything, and never touches a done task. DRY RUN IS
--    THE DEFAULT: `SELECT public.sync_job_automatic_tasks();` writes nothing
--    and reports what it would do.
--
-- Re-runnable: IF NOT EXISTS / CREATE OR REPLACE / ON CONFLICT DO NOTHING.

-- ---------------------------------------------------------------------------
-- 1. Templates
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.job_task_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_key text NOT NULL CHECK (group_key IN (
    'water_extraction', 'water_remediation', 'water_monitoring',
    'water_pickup', 'mold_remediation', 'fire_smoke')),
  -- A line added from the admin screen gets a generated key; Mark's original
  -- lines keep the keys the code has always used, so every task already on a
  -- job still matches its line.
  task_key text NOT NULL
    DEFAULT ('t_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12))
    CHECK (task_key ~ '^[a-z0-9_]+$'),
  title text NOT NULL CHECK (length(btrim(title)) > 0),
  description text,
  sort_order integer NOT NULL DEFAULT 1000,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid DEFAULT auth.uid(),
  CONSTRAINT job_task_templates_key UNIQUE (group_key, task_key)
);
CREATE INDEX IF NOT EXISTS job_task_templates_group_order_idx
  ON public.job_task_templates (group_key, sort_order);

CREATE OR REPLACE FUNCTION public.tg_job_task_templates_touch()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := now();
  NEW.updated_by := auth.uid();
  -- The key is the link to every task already seeded from this line.
  NEW.task_key := OLD.task_key;
  NEW.group_key := OLD.group_key;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.tg_job_task_templates_touch() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS job_task_templates_touch ON public.job_task_templates;
CREATE TRIGGER job_task_templates_touch BEFORE UPDATE ON public.job_task_templates
  FOR EACH ROW EXECUTE FUNCTION public.tg_job_task_templates_touch();

-- Mark's lists exactly as automatic-job-tasks.ts has them on 6 Oct (PR #275),
-- in his order. Water · Remediation's first six lines are "Same as above":
-- copies of Extraction with keys of their own, so the second visit takes its
-- own readings and David can word the two independently.
INSERT INTO public.job_task_templates (group_key, task_key, title, description, sort_order) VALUES
  ('water_extraction', 'inspection', 'Inspection', NULL, 10),
  ('water_extraction', 'extraction', 'Extraction', NULL, 20),
  ('water_extraction', 'readings', 'Readings', NULL, 30),
  ('water_extraction', 'setup_equipment_scan', 'Set up equipment – Scan', NULL, 40),
  ('water_extraction', 'scope_if_needed', 'Scope of work – if needed', NULL, 50),
  ('water_extraction', 'pictures', 'Pictures', NULL, 60),

  ('water_remediation', 'inspection', 'Inspection', NULL, 10),
  ('water_remediation', 'extraction', 'Extraction', NULL, 20),
  ('water_remediation', 'readings', 'Readings', NULL, 30),
  ('water_remediation', 'setup_equipment_scan', 'Set up equipment – Scan', NULL, 40),
  ('water_remediation', 'scope_if_needed', 'Scope of work – if needed', NULL, 50),
  ('water_remediation', 'pictures', 'Pictures', NULL, 60),
  ('water_remediation', 'containment_if_needed', 'Containment if needed', NULL, 70),
  ('water_remediation', 'cover_contents_if_needed', 'Cover contents if needed', NULL, 80),
  ('water_remediation', 'remove_equipment', 'Remove equipment', NULL, 90),
  ('water_remediation', 'remediate_surfaces', 'Remediate walls/ceiling as needed', NULL, 100),
  ('water_remediation', 'treat_clean', 'Treat and clean', NULL, 110),
  ('water_remediation', 'reset_equipment', 'Set back up equipment', NULL, 120),
  ('water_remediation', 'reset_drying', 'Reset 3 days of drying time',
    'Press Reset 3-day drying (Tasks, Drying or Work ticket tab). It restarts the 72 hours and moves every unit''s expected retrieval date out to match, so the equipment alerts and the Monitoring and Pick up equipment tasks follow.',
    130),
  ('water_remediation', 'remediation_pictures', 'Pictures', NULL, 140),
  ('water_remediation', 'sketch', 'Sketch', NULL, 150),
  ('water_remediation', 'write_up', 'Write up', NULL, 160),
  ('water_remediation', 'clean_property', 'Make sure property is clean', NULL, 170),

  ('water_monitoring', 'check_drying_progress', 'Check drying progress within first 3 days to make sure it''s drying', NULL, 10),
  ('water_monitoring', 'readings', 'Readings', NULL, 20),
  ('water_monitoring', 'pictures', 'Pictures', NULL, 30),

  ('water_pickup', 'confirm_dry', 'Confirm everything is dry (readings)', NULL, 10),
  ('water_pickup', 'dry_pictures', 'Pictures to confirm dry', NULL, 20),
  ('water_pickup', 'purge_dehu', 'Purge Dehu', NULL, 30),
  ('water_pickup', 'scan_all_equipment', 'Scan all equipment', NULL, 40),
  ('water_pickup', 'clean_property', 'Make sure property is clean', NULL, 50),

  ('mold_remediation', 'inspection', 'Inspection', NULL, 10),
  ('mold_remediation', 'containment', 'Set up containment', NULL, 20),
  ('mold_remediation', 'negative_air', 'Set up Negative air – Scan scrubber', NULL, 30),
  ('mold_remediation', 'remediate', 'Remediate as needed', NULL, 40),
  ('mold_remediation', 'hepa_process', 'Wipe/HEPA/Wipe (must use HEPA vac) or HEPA/Wipe/HEPA – as needed', NULL, 50),
  ('mold_remediation', 'treat_clean', 'Treat and clean', NULL, 60),
  ('mold_remediation', 'dehu_if_needed', 'Set up Dehu if needed', NULL, 70),
  ('mold_remediation', 'leave_scrubber', 'Leave scrubber', NULL, 80),
  ('mold_remediation', 'encapsulate_if_needed', 'Encapsulate – as needed', NULL, 90),
  ('mold_remediation', 'pictures', 'Pictures', NULL, 100),

  ('fire_smoke', 'inspection', 'Inspection', NULL, 10),
  ('fire_smoke', 'board_up', 'Board up', NULL, 20),
  ('fire_smoke', 'extraction', 'Extraction', NULL, 30),
  ('fire_smoke', 'readings', 'Readings', NULL, 40),
  ('fire_smoke', 'seal_scene', 'Seal off fire scene', NULL, 50),
  ('fire_smoke', 'secure_property', 'Secure property', NULL, 60),
  ('fire_smoke', 'winterize', 'Winterize areas that will not have heat', NULL, 70),
  ('fire_smoke', 'release_form', 'Release form', NULL, 80),
  ('fire_smoke', 'setup_equipment_scan', 'Set up equipment – Scan', NULL, 90),
  ('fire_smoke', 'scope_if_needed', 'Scope of work – if needed', NULL, 100),
  ('fire_smoke', 'pictures', 'Pictures', NULL, 110),
  ('fire_smoke', 'remediate_if_needed', 'Remediate – as needed', NULL, 120)
ON CONFLICT (group_key, task_key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. Per-job-type switches
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.job_task_seeding_settings (
  job_scope text PRIMARY KEY CHECK (job_scope IN ('mold', 'fire_smoke')),
  seed_equipment_tasks boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid DEFAULT auth.uid()
);

INSERT INTO public.job_task_seeding_settings (job_scope, seed_equipment_tasks)
VALUES ('mold', true), ('fire_smoke', true)
ON CONFLICT (job_scope) DO NOTHING;

-- ---------------------------------------------------------------------------
-- RLS for both config tables: the Supply catalog's own rule
-- (20260818173022 supply_items_read / supply_items_manage). Every signed-in
-- staff member reads them — the seeding runs as whoever placed the unit or
-- opened the Tasks tab — and only is_privileged (owner, admin, dev) writes.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON public.job_task_templates TO authenticated;
GRANT ALL ON public.job_task_templates TO service_role;
ALTER TABLE public.job_task_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS job_task_templates_read ON public.job_task_templates;
CREATE POLICY job_task_templates_read ON public.job_task_templates
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS job_task_templates_insert ON public.job_task_templates;
CREATE POLICY job_task_templates_insert ON public.job_task_templates
  FOR INSERT TO authenticated
  WITH CHECK (public.is_privileged((SELECT auth.uid())));
DROP POLICY IF EXISTS job_task_templates_update ON public.job_task_templates;
CREATE POLICY job_task_templates_update ON public.job_task_templates
  FOR UPDATE TO authenticated
  USING (public.is_privileged((SELECT auth.uid())))
  WITH CHECK (public.is_privileged((SELECT auth.uid())));

GRANT SELECT, INSERT, UPDATE ON public.job_task_seeding_settings TO authenticated;
GRANT ALL ON public.job_task_seeding_settings TO service_role;
ALTER TABLE public.job_task_seeding_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS job_task_seeding_settings_read ON public.job_task_seeding_settings;
CREATE POLICY job_task_seeding_settings_read ON public.job_task_seeding_settings
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS job_task_seeding_settings_insert ON public.job_task_seeding_settings;
CREATE POLICY job_task_seeding_settings_insert ON public.job_task_seeding_settings
  FOR INSERT TO authenticated
  WITH CHECK (public.is_privileged((SELECT auth.uid())));
DROP POLICY IF EXISTS job_task_seeding_settings_update ON public.job_task_seeding_settings;
CREATE POLICY job_task_seeding_settings_update ON public.job_task_seeding_settings
  FOR UPDATE TO authenticated
  USING (public.is_privileged((SELECT auth.uid())))
  WITH CHECK (public.is_privileged((SELECT auth.uid())));

-- ---------------------------------------------------------------------------
-- 3. The seeded-key ledger
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.job_task_seed_keys (
  cadence_key text PRIMARY KEY CHECK (cadence_key LIKE 'job-scope:%'),
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  first_seeded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS job_task_seed_keys_job_idx ON public.job_task_seed_keys (job_id);

-- Readable with the job, like the job's tasks (20260925121000). Nobody
-- writes it directly: no INSERT / UPDATE / DELETE grant at all.
GRANT SELECT ON public.job_task_seed_keys TO authenticated;
GRANT ALL ON public.job_task_seed_keys TO service_role;
ALTER TABLE public.job_task_seed_keys ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS job_task_seed_keys_read ON public.job_task_seed_keys;
CREATE POLICY job_task_seed_keys_read ON public.job_task_seed_keys
  FOR SELECT TO authenticated
  USING (public.can_view_job((SELECT auth.uid()), job_id));

-- Definer rights because the inserting user has no grant on the ledger, by
-- design. It only ever copies the new task's own key and job.
CREATE OR REPLACE FUNCTION public.tg_tasks_record_seed_key()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.job_task_seed_keys (cadence_key, job_id)
  VALUES (NEW.cadence_key, NEW.job_id)
  ON CONFLICT (cadence_key) DO NOTHING;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.tg_tasks_record_seed_key() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS tasks_record_seed_key ON public.tasks;
CREATE TRIGGER tasks_record_seed_key AFTER INSERT ON public.tasks
  FOR EACH ROW
  WHEN (NEW.cadence_key LIKE 'job-scope:%' AND NEW.job_id IS NOT NULL)
  EXECUTE FUNCTION public.tg_tasks_record_seed_key();

-- Prime it with every automatic task on a job today. A task deleted BEFORE
-- this migration left no trace and cannot be told apart from one never
-- seeded; the dry run below is how to see whether that matters.
INSERT INTO public.job_task_seed_keys (cadence_key, job_id, first_seeded_at)
SELECT t.cadence_key, t.job_id, t.created_at
  FROM public.tasks t
  JOIN public.jobs j ON j.id = t.job_id
 WHERE t.cadence_key LIKE 'job-scope:%'
ON CONFLICT (cadence_key) DO NOTHING;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'portal_customer') THEN
    DROP POLICY IF EXISTS portal_customer_denied ON public.job_task_templates;
    CREATE POLICY portal_customer_denied ON public.job_task_templates
      AS RESTRICTIVE FOR ALL TO portal_customer USING (false) WITH CHECK (false);
    DROP POLICY IF EXISTS portal_customer_denied ON public.job_task_seeding_settings;
    CREATE POLICY portal_customer_denied ON public.job_task_seeding_settings
      AS RESTRICTIVE FOR ALL TO portal_customer USING (false) WITH CHECK (false);
    DROP POLICY IF EXISTS portal_customer_denied ON public.job_task_seed_keys;
    CREATE POLICY portal_customer_denied ON public.job_task_seed_keys
      AS RESTRICTIVE FOR ALL TO portal_customer USING (false) WITH CHECK (false);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4. The retroactive pass
-- ---------------------------------------------------------------------------

-- What every open job should have and does not, one row per missing task,
-- plus the open tasks whose title no longer matches their line. Internal:
-- only sync_job_automatic_tasks calls it. The rules mirror
-- buildAutomaticTaskSyncPlan in src/lib/automatic-job-tasks.ts:
--   * the service category (jobs.loss_type) picks Water · Extraction, Mold or
--     Fire; an unmapped category gets nothing;
--   * Water · Remediation only where additional_work_pending is already true;
--   * Monitoring and Pick up equipment only where a unit is ON SITE now, on
--     Water always, on Mold / Fire only while their switch is on;
--   * active lines only, and never a key the ledger has seen;
--   * due: the sync groups today (office calendar, gsr_local_date); Monitoring
--     at the end of the 72-hour drying window (newest reset, else the first
--     placement — dryingClockStart); Pick up on the earliest expected
--     retrieval among units still on site, else the window's end.
-- _only_seeded_groups narrows it to groups the job already has (any key in
-- the ledger): what the admin screen runs after a line is added or switched
-- back on, so a new line follows its checklist onto open jobs without the
-- first full backfill happening behind anybody's back.
CREATE OR REPLACE FUNCTION public.job_automatic_task_candidates(_only_seeded_groups boolean)
RETURNS TABLE (
  kind text,
  job_id uuid,
  task_id uuid,
  group_key text,
  task_key text,
  title text,
  description text,
  due_date date
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH open_jobs AS (
    SELECT j.id, j.additional_work_pending,
           CASE lower(btrim(coalesce(j.loss_type, '')))
             WHEN 'water' THEN 'water'
             WHEN 'water_mitigation' THEN 'water'
             WHEN 'mold' THEN 'mold'
             WHEN 'mold_remediation' THEN 'mold'
             WHEN 'fire' THEN 'fire_smoke'
             WHEN 'smoke' THEN 'fire_smoke'
             WHEN 'fire_smoke_cleaning' THEN 'fire_smoke'
           END AS scope
      FROM public.jobs j
     WHERE j.status::text IN ('new', 'scheduled', 'in_progress', 'drying')
  ),
  equipment AS (
    SELECT p.job_id,
           bool_or(p.retrieved_at IS NULL) AS on_site,
           min(p.placed_at) AS first_placed_at,
           min(p.expected_retrieval_date) FILTER (WHERE p.retrieved_at IS NULL) AS retrieval_on
      FROM public.equipment_placements p
     WHERE p.job_id IN (SELECT id FROM open_jobs)
     GROUP BY p.job_id
  ),
  resets AS (
    SELECT r.job_id, max(r.reset_at) AS last_reset_at
      FROM public.job_drying_resets r
     WHERE r.job_id IN (SELECT id FROM open_jobs)
     GROUP BY r.job_id
  ),
  switches AS (
    SELECT
      coalesce((SELECT s.seed_equipment_tasks FROM public.job_task_seeding_settings s
                 WHERE s.job_scope = 'mold'), true) AS mold,
      coalesce((SELECT s.seed_equipment_tasks FROM public.job_task_seeding_settings s
                 WHERE s.job_scope = 'fire_smoke'), true) AS fire_smoke
  ),
  job_groups AS (
    SELECT o.id AS job_id, g.group_key,
           CASE g.group_key
             WHEN 'water_monitoring' THEN
               coalesce(public.gsr_local_date(coalesce(r.last_reset_at, e.first_placed_at)
                                              + interval '72 hours'),
                        public.gsr_local_date(now()) + 3)
             WHEN 'water_pickup' THEN
               coalesce(e.retrieval_on,
                        public.gsr_local_date(coalesce(r.last_reset_at, e.first_placed_at)
                                              + interval '72 hours'),
                        public.gsr_local_date(now()) + 3)
             ELSE public.gsr_local_date(now())
           END AS due_date
      FROM open_jobs o
      CROSS JOIN switches sw
      LEFT JOIN equipment e ON e.job_id = o.id
      LEFT JOIN resets r ON r.job_id = o.id
      CROSS JOIN LATERAL (
        SELECT 'water_extraction' AS group_key WHERE o.scope = 'water'
        UNION ALL SELECT 'water_remediation' WHERE o.scope = 'water' AND o.additional_work_pending
        UNION ALL SELECT 'mold_remediation' WHERE o.scope = 'mold'
        UNION ALL SELECT 'fire_smoke' WHERE o.scope = 'fire_smoke'
        UNION ALL SELECT x.k FROM (VALUES ('water_monitoring'), ('water_pickup')) AS x(k)
         WHERE coalesce(e.on_site, false)
           AND (o.scope = 'water'
                OR (o.scope = 'mold' AND sw.mold)
                OR (o.scope = 'fire_smoke' AND sw.fire_smoke))
      ) g
  ),
  scoped AS (
    SELECT jg.* FROM job_groups jg
     WHERE NOT _only_seeded_groups
        OR EXISTS (
             SELECT 1 FROM public.job_task_seed_keys k
              WHERE k.job_id = jg.job_id
                AND k.cadence_key LIKE 'job-scope:' || jg.job_id::text || ':' || jg.group_key || ':%')
  )
  SELECT 'insert', s.job_id, NULL::uuid, s.group_key, t.task_key, t.title,
         'Automatically generated from the '
           || CASE s.group_key
                WHEN 'water_extraction' THEN 'Water · Extraction'
                WHEN 'water_remediation' THEN 'Water · Remediation'
                WHEN 'water_monitoring' THEN 'Monitoring'
                WHEN 'water_pickup' THEN 'Pick up equipment'
                WHEN 'mold_remediation' THEN 'Mold'
                WHEN 'fire_smoke' THEN 'Fire'
              END
           || ' checklist.' || coalesce(' ' || nullif(btrim(t.description), ''), ''),
         s.due_date
    FROM scoped s
    JOIN public.job_task_templates t ON t.group_key = s.group_key AND t.active
   WHERE NOT EXISTS (
           SELECT 1 FROM public.job_task_seed_keys k
            WHERE k.cadence_key = 'job-scope:' || s.job_id::text || ':' || s.group_key || ':' || t.task_key)
     AND NOT EXISTS (
           SELECT 1 FROM public.tasks x
            WHERE x.cadence_key = 'job-scope:' || s.job_id::text || ':' || s.group_key || ':' || t.task_key)
  UNION ALL
  -- Renames: an unfinished task on an open job takes its line's current
  -- title. Done tasks keep the words they were ticked under; cancelled ones
  -- are retired and left as they were.
  SELECT 'rename', x.job_id, x.id, t.group_key, t.task_key, t.title, NULL, NULL
    FROM public.tasks x
    JOIN open_jobs o ON o.id = x.job_id
    JOIN public.job_task_templates t
      ON x.cadence_key = 'job-scope:' || x.job_id::text || ':' || t.group_key || ':' || t.task_key
   WHERE x.cadence_key LIKE 'job-scope:%'
     AND x.status::text IN ('open', 'in_progress')
     AND x.title IS DISTINCT FROM t.title
$$;
REVOKE ALL ON FUNCTION public.job_automatic_task_candidates(boolean) FROM PUBLIC, anon, authenticated;

-- The one entry point. Callable from the SQL editor (no auth.uid(): the
-- operator is trusted) or by an owner / admin / dev from the app; anyone
-- else is refused. Returns what it did (or, dry, would do):
--   { dry_run, only_seeded_groups, open_jobs, jobs_gaining_tasks,
--     tasks_added, tasks_renamed, added_by_group: { group: n },
--     added_already_overdue, skipped_previously_deleted }
CREATE OR REPLACE FUNCTION public.sync_job_automatic_tasks(
  _dry_run boolean DEFAULT true,
  _only_seeded_groups boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_added integer := 0;
  v_renamed integer := 0;
  v_jobs integer := 0;
  v_open integer := 0;
  v_by_group jsonb := '{}'::jsonb;
  v_deleted integer := 0;
  v_overdue integer := 0;
BEGIN
  IF v_uid IS NOT NULL AND NOT public.is_privileged(v_uid) THEN
    RAISE EXCEPTION 'Only an owner or admin can sync the job checklists'
      USING ERRCODE = '42501';
  END IF;

  CREATE TEMP TABLE IF NOT EXISTS pg_temp.job_task_sync_candidates (
    kind text, job_id uuid, task_id uuid, group_key text, task_key text,
    title text, description text, due_date date
  ) ON COMMIT DROP;
  TRUNCATE pg_temp.job_task_sync_candidates;
  INSERT INTO pg_temp.job_task_sync_candidates
  SELECT * FROM public.job_automatic_task_candidates(coalesce(_only_seeded_groups, false));

  -- Overdue on arrival: an old job's Monitoring window, or gear already past
  -- its expected retrieval date. Honest — the tab-open reconcile dates them
  -- the same way — but worth seeing before they land in Needs you today.
  SELECT count(*) FILTER (WHERE kind = 'insert'),
         count(*) FILTER (WHERE kind = 'rename'),
         count(DISTINCT job_id) FILTER (WHERE kind = 'insert'),
         count(*) FILTER (WHERE kind = 'insert' AND due_date < public.gsr_local_date(now()))
    INTO v_added, v_renamed, v_jobs, v_overdue
    FROM pg_temp.job_task_sync_candidates;

  SELECT coalesce(jsonb_object_agg(group_key, n), '{}'::jsonb) INTO v_by_group
    FROM (SELECT group_key, count(*) AS n FROM pg_temp.job_task_sync_candidates
           WHERE kind = 'insert' GROUP BY group_key) g;

  SELECT count(*) INTO v_open FROM public.jobs j
   WHERE j.status::text IN ('new', 'scheduled', 'in_progress', 'drying');

  -- Keys the ledger remembers whose task is gone: deliberately removed, and
  -- deliberately left out above. Reported so the dry run shows the guard
  -- working rather than asking to be trusted.
  SELECT count(*) INTO v_deleted
    FROM public.job_task_seed_keys k
    JOIN public.jobs j ON j.id = k.job_id
   WHERE j.status::text IN ('new', 'scheduled', 'in_progress', 'drying')
     AND NOT EXISTS (SELECT 1 FROM public.tasks x WHERE x.cadence_key = k.cadence_key);

  IF NOT coalesce(_dry_run, true) THEN
    INSERT INTO public.tasks (
      title, description, assignee, due_date, priority, status, entity_type,
      entity_id, account_id, job_id, location_id, source, cadence_key, created_by)
    SELECT c.title, c.description, j.crew_chief, c.due_date, 'normal', 'open', 'job',
           j.id, j.account_id, j.id, j.location_id, 'job_scope:' || c.group_key,
           'job-scope:' || j.id::text || ':' || c.group_key || ':' || c.task_key, v_uid
      FROM pg_temp.job_task_sync_candidates c
      JOIN public.jobs j ON j.id = c.job_id
     WHERE c.kind = 'insert'
    ON CONFLICT (cadence_key) WHERE cadence_key IS NOT NULL DO NOTHING;
    GET DIAGNOSTICS v_added = ROW_COUNT;

    UPDATE public.tasks x
       SET title = c.title
      FROM pg_temp.job_task_sync_candidates c
     WHERE c.kind = 'rename' AND x.id = c.task_id;
    GET DIAGNOSTICS v_renamed = ROW_COUNT;
  END IF;

  RETURN jsonb_build_object(
    'dry_run', coalesce(_dry_run, true),
    'only_seeded_groups', coalesce(_only_seeded_groups, false),
    'open_jobs', v_open,
    'jobs_gaining_tasks', v_jobs,
    'tasks_added', v_added,
    'tasks_renamed', v_renamed,
    'added_by_group', v_by_group,
    'added_already_overdue', v_overdue,
    'skipped_previously_deleted', v_deleted);
END;
$$;
REVOKE ALL ON FUNCTION public.sync_job_automatic_tasks(boolean, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sync_job_automatic_tasks(boolean, boolean) TO authenticated, service_role;
