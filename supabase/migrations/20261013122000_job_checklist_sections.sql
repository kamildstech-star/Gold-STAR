-- Job checklists: a Water switch, admin-made sections, and job types read
-- from the service category the office actually picked.
--
-- WRITTEN, NOT APPLIED. One new table, one new helper function, two CHECK
-- constraints widened, one foreign key added, and ONE EXISTING FUNCTION
-- REPLACED: public.job_automatic_task_candidates(boolean), based on its only
-- definition in this repo (20261006174500) — diff it against live before
-- applying. No task, job or template row is changed or removed. The app
-- works before this is applied: src/lib/automatic-job-tasks.ts treats the
-- missing table as "no custom sections" and the missing 'water' switch row
-- as on, exactly as today.
--
-- Mark, 13 Oct, on Settings › Operations › Job checklists:
--   "these dont show up in the job";
--   "let him turn off drying log";
--   "also let him make a new section if he wants".
--
-- 1. "these dont show up in the job". Monitoring and Pick up equipment are
--    put on a job by the app (the placement write, the Tasks tab opening);
--    for open jobs that already had gear on site before that existed, only
--    the retroactive pass adds them, and the screen could only DRY-run it —
--    "Check open jobs" counted the missing tasks and added none. The screen
--    now has the button that runs it (src/components/job-task-templates-admin
--    .tsx). Here, the pass learns to read a job's type the way the office
--    sees it: jobs.loss_type is a legacy copy kept by trg_sync_loss_type,
--    which leaves it NULL whenever the picked option's key is not one
--    enum_for_loss_type_key knows. job_checklist_scope() falls back to the
--    picked option's key and then its label ("Water Mitigation"), so such a
--    job is still a water job. The app does the same (resolveScopeKey).
--
-- 2. "let him turn off drying log" — job_task_seeding_settings gains a
--    'water' row (default ON, today's behaviour): whether placing equipment
--    adds Monitoring and Pick up equipment on Water Mitigation jobs, like the
--    Mold and Fire switches. Off stops new tasks; nothing already on a job is
--    touched. The Drying log tab itself is unaffected.
--
-- 3. "also let him make a new section if he wants" — job_task_sections. One
--    row per checklist section. The six built-in sections are rows too
--    (builtin = true) so every template line's group_key has a parent, but
--    their behaviour stays in code (TASK_GROUPS) and their rows cannot be
--    edited or deleted. A section David makes chooses, once, from what the
--    built-in sections already do — no new engine:
--      * added_when: 'job_type' (the job is one of its types, from creation),
--        'additional_work' (the remediation flag is raised), or 'equipment'
--        (a unit is on site);
--      * due_rule: 'sync' (the day it goes on), 'drying_window' (end of the
--        72-hour window), 'retrieval' (equipment expected back);
--      * job_scopes: any of water / mold / fire_smoke.
--    Its lines are ordinary job_task_templates rows under its key. It can be
--    renamed, reordered and switched off; it can be DELETED only while no
--    task has ever been made from it (a trigger checks tasks and the ledger)
--    — otherwise it is switched off, like a line.
--
-- Re-runnable: IF NOT EXISTS / CREATE OR REPLACE / ON CONFLICT DO NOTHING /
-- constraints dropped and re-added by name.

-- ---------------------------------------------------------------------------
-- 1. The job's checklist type, from whichever of its three spellings maps
-- ---------------------------------------------------------------------------
-- 'Water Mitigation', 'water_mitigation' and 'water' are one type. Mirrors
-- automaticScopeTypeFor in src/lib/automatic-job-tasks.ts.
CREATE OR REPLACE FUNCTION public.job_checklist_scope_of(_value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE btrim(regexp_replace(lower(coalesce(_value, '')), '[^a-z0-9]+', '_', 'g'), '_')
    WHEN 'water' THEN 'water'
    WHEN 'water_mitigation' THEN 'water'
    WHEN 'mold' THEN 'mold'
    WHEN 'mold_remediation' THEN 'mold'
    WHEN 'fire' THEN 'fire_smoke'
    WHEN 'smoke' THEN 'fire_smoke'
    WHEN 'fire_smoke_cleaning' THEN 'fire_smoke'
  END
$$;

-- The legacy column first (what every job had before service categories were
-- data), then the picked option's key, then its label.
CREATE OR REPLACE FUNCTION public.job_checklist_scope(
  _loss_type text,
  _option_key text,
  _option_label text
)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT coalesce(public.job_checklist_scope_of(_loss_type),
                  public.job_checklist_scope_of(_option_key),
                  public.job_checklist_scope_of(_option_label))
$$;
REVOKE ALL ON FUNCTION public.job_checklist_scope_of(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.job_checklist_scope(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.job_checklist_scope_of(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.job_checklist_scope(text, text, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. The Water switch
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'public.job_task_seeding_settings'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%job_scope%'
  LOOP
    EXECUTE format('ALTER TABLE public.job_task_seeding_settings DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE public.job_task_seeding_settings
  ADD CONSTRAINT job_task_seeding_settings_job_scope_check
  CHECK (job_scope IN ('water', 'mold', 'fire_smoke'));

INSERT INTO public.job_task_seeding_settings (job_scope, seed_equipment_tasks)
VALUES ('water', true)
ON CONFLICT (job_scope) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. Sections
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.job_task_sections (
  -- Storage, like task_key: the middle of every cadence key seeded from it
  -- (`job-scope:<job>:<section>:<line>`), so it never changes.
  key text PRIMARY KEY
    DEFAULT ('s_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12))
    CHECK (key ~ '^[a-z0-9_]+$'),
  label text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 80),
  builtin boolean NOT NULL DEFAULT false,
  added_when text NOT NULL CHECK (added_when IN ('job_type', 'additional_work', 'equipment')),
  due_rule text NOT NULL CHECK (due_rule IN ('sync', 'drying_window', 'retrieval')),
  job_scopes text[] NOT NULL
    CHECK (cardinality(job_scopes) > 0
           AND job_scopes <@ ARRAY['water', 'mold', 'fire_smoke']::text[]),
  sort_order integer NOT NULL DEFAULT 1000,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid DEFAULT auth.uid()
);
CREATE INDEX IF NOT EXISTS job_task_sections_order_idx
  ON public.job_task_sections (sort_order);

-- The six that exist today, as TASK_GROUPS has them. Their rows are parents
-- for the template lines; the engine reads their behaviour from code.
INSERT INTO public.job_task_sections
  (key, label, builtin, added_when, due_rule, job_scopes, sort_order)
VALUES
  ('water_extraction', 'Water · Extraction', true, 'job_type', 'sync', ARRAY['water'], 10),
  ('water_remediation', 'Water · Remediation', true, 'additional_work', 'sync', ARRAY['water'], 20),
  ('water_monitoring', 'Monitoring', true, 'equipment', 'drying_window',
    ARRAY['water', 'mold', 'fire_smoke'], 30),
  ('water_pickup', 'Pick up equipment', true, 'equipment', 'retrieval',
    ARRAY['water', 'mold', 'fire_smoke'], 40),
  ('mold_remediation', 'Mold', true, 'job_type', 'sync', ARRAY['mold'], 50),
  ('fire_smoke', 'Fire', true, 'job_type', 'sync', ARRAY['fire_smoke'], 60)
ON CONFLICT (key) DO NOTHING;

-- What a section does is chosen once. A rename, a move or the switch is all
-- an edit can change; the rest is put back.
CREATE OR REPLACE FUNCTION public.tg_job_task_sections_touch()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.key := OLD.key;
  NEW.builtin := OLD.builtin;
  NEW.added_when := OLD.added_when;
  NEW.due_rule := OLD.due_rule;
  NEW.job_scopes := OLD.job_scopes;
  NEW.created_at := OLD.created_at;
  NEW.created_by := OLD.created_by;
  NEW.updated_at := now();
  NEW.updated_by := auth.uid();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.tg_job_task_sections_touch() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS job_task_sections_touch ON public.job_task_sections;
CREATE TRIGGER job_task_sections_touch BEFORE UPDATE ON public.job_task_sections
  FOR EACH ROW EXECUTE FUNCTION public.tg_job_task_sections_touch();

-- Delete only what never reached a job. Definer rights so the check sees
-- every task and the whole ledger, not just the ones the admin can read.
CREATE OR REPLACE FUNCTION public.tg_job_task_sections_guard_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF OLD.builtin THEN
    RAISE EXCEPTION 'A built-in checklist section cannot be deleted'
      USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM public.tasks t WHERE t.source = 'job_scope:' || OLD.key)
     OR EXISTS (SELECT 1 FROM public.job_task_seed_keys k
                 WHERE split_part(k.cadence_key, ':', 3) = OLD.key) THEN
    RAISE EXCEPTION 'Tasks were made from this section, so it cannot be deleted. Switch it off instead.'
      USING ERRCODE = '23503';
  END IF;
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION public.tg_job_task_sections_guard_delete() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS job_task_sections_guard_delete ON public.job_task_sections;
CREATE TRIGGER job_task_sections_guard_delete BEFORE DELETE ON public.job_task_sections
  FOR EACH ROW EXECUTE FUNCTION public.tg_job_task_sections_guard_delete();

-- A template line now belongs to a section row instead of one of six names.
-- Deleting an unused section takes its lines with it.
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'public.job_task_templates'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%group_key%'
  LOOP
    EXECUTE format('ALTER TABLE public.job_task_templates DROP CONSTRAINT %I', c.conname);
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.job_task_templates'::regclass
                    AND conname = 'job_task_templates_section_fk') THEN
    ALTER TABLE public.job_task_templates
      ADD CONSTRAINT job_task_templates_section_fk
      FOREIGN KEY (group_key) REFERENCES public.job_task_sections(key) ON DELETE CASCADE;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- RLS: job_task_templates' rule (20261006174500) — every signed-in staff
-- member reads, only is_privileged writes — plus: built-in rows are read-only,
-- a new row is never built-in and takes a generated key. The standard
-- restrictive denials (20260929121000, portal customers) on top.
-- ---------------------------------------------------------------------------
REVOKE ALL ON public.job_task_sections FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.job_task_sections TO authenticated;
GRANT ALL ON public.job_task_sections TO service_role;
ALTER TABLE public.job_task_sections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS job_task_sections_read ON public.job_task_sections;
CREATE POLICY job_task_sections_read ON public.job_task_sections
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS job_task_sections_insert ON public.job_task_sections;
CREATE POLICY job_task_sections_insert ON public.job_task_sections
  FOR INSERT TO authenticated
  WITH CHECK (public.is_privileged((SELECT auth.uid()))
              AND NOT builtin
              AND key ~ '^s_[0-9a-f]{12}$');
DROP POLICY IF EXISTS job_task_sections_update ON public.job_task_sections;
CREATE POLICY job_task_sections_update ON public.job_task_sections
  FOR UPDATE TO authenticated
  USING (public.is_privileged((SELECT auth.uid())) AND NOT builtin)
  WITH CHECK (public.is_privileged((SELECT auth.uid())) AND NOT builtin);
DROP POLICY IF EXISTS job_task_sections_delete ON public.job_task_sections;
CREATE POLICY job_task_sections_delete ON public.job_task_sections
  FOR DELETE TO authenticated
  USING (public.is_privileged((SELECT auth.uid())) AND NOT builtin);

DROP POLICY IF EXISTS active_profile_required ON public.job_task_sections;
CREATE POLICY active_profile_required ON public.job_task_sections
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT goldstar_private.profile_is_active(auth.uid())))
  WITH CHECK ((SELECT goldstar_private.profile_is_active(auth.uid())));
DROP POLICY IF EXISTS anonymous_business_access_denied ON public.job_task_sections;
CREATE POLICY anonymous_business_access_denied ON public.job_task_sections
  AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'portal_customer') THEN
    DROP POLICY IF EXISTS portal_customer_denied ON public.job_task_sections;
    CREATE POLICY portal_customer_denied ON public.job_task_sections
      AS RESTRICTIVE FOR ALL TO portal_customer USING (false) WITH CHECK (false);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4. The retroactive pass learns the three changes
-- ---------------------------------------------------------------------------
-- REPLACES public.job_automatic_task_candidates(boolean) from 20261006174500.
-- Diff against live before applying. Changed, and nothing else:
--   * open_jobs: the type is job_checklist_scope(loss_type, option key,
--     option label) instead of a CASE on loss_type alone;
--   * switches: a `water` column, and Monitoring / Pick up on a water job
--     only while it is on (it was unconditional);
--   * job_groups: each group carries its due rule, and active non-built-in
--     sections join the list by their own type / trigger;
--   * the description names a custom section by its label.
-- Return columns, arguments, grants and sync_job_automatic_tasks() are as
-- they were; sync_job_automatic_tasks() needs no change to insert a custom
-- section's lines (source and cadence key are built from group_key).
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
           public.job_checklist_scope(j.loss_type, v.key, v.label) AS scope
      FROM public.jobs j
      LEFT JOIN public.option_list_values v ON v.id = j.loss_type_id
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
                 WHERE s.job_scope = 'water'), true) AS water,
      coalesce((SELECT s.seed_equipment_tasks FROM public.job_task_seeding_settings s
                 WHERE s.job_scope = 'mold'), true) AS mold,
      coalesce((SELECT s.seed_equipment_tasks FROM public.job_task_seeding_settings s
                 WHERE s.job_scope = 'fire_smoke'), true) AS fire_smoke
  ),
  job_groups AS (
    SELECT o.id AS job_id, g.group_key,
           CASE g.due_rule
             WHEN 'drying_window' THEN
               coalesce(public.gsr_local_date(coalesce(r.last_reset_at, e.first_placed_at)
                                              + interval '72 hours'),
                        public.gsr_local_date(now()) + 3)
             WHEN 'retrieval' THEN
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
        SELECT 'water_extraction' AS group_key, 'sync' AS due_rule WHERE o.scope = 'water'
        UNION ALL SELECT 'water_remediation', 'sync' WHERE o.scope = 'water' AND o.additional_work_pending
        UNION ALL SELECT 'mold_remediation', 'sync' WHERE o.scope = 'mold'
        UNION ALL SELECT 'fire_smoke', 'sync' WHERE o.scope = 'fire_smoke'
        UNION ALL SELECT x.k, x.d
          FROM (VALUES ('water_monitoring', 'drying_window'), ('water_pickup', 'retrieval')) AS x(k, d)
         WHERE coalesce(e.on_site, false)
           AND ((o.scope = 'water' AND sw.water)
                OR (o.scope = 'mold' AND sw.mold)
                OR (o.scope = 'fire_smoke' AND sw.fire_smoke))
        UNION ALL SELECT c.key, c.due_rule
          FROM public.job_task_sections c
         WHERE NOT c.builtin AND c.active
           AND o.scope = ANY (c.job_scopes)
           AND (c.added_when = 'job_type'
                OR (c.added_when = 'additional_work' AND o.additional_work_pending)
                OR (c.added_when = 'equipment' AND coalesce(e.on_site, false)))
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
           || coalesce(CASE s.group_key
                WHEN 'water_extraction' THEN 'Water · Extraction'
                WHEN 'water_remediation' THEN 'Water · Remediation'
                WHEN 'water_monitoring' THEN 'Monitoring'
                WHEN 'water_pickup' THEN 'Pick up equipment'
                WHEN 'mold_remediation' THEN 'Mold'
                WHEN 'fire_smoke' THEN 'Fire'
              END, sec.label, s.group_key)
           || ' checklist.' || coalesce(' ' || nullif(btrim(t.description), ''), ''),
         s.due_date
    FROM scoped s
    JOIN public.job_task_templates t ON t.group_key = s.group_key AND t.active
    LEFT JOIN public.job_task_sections sec ON sec.key = s.group_key
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
