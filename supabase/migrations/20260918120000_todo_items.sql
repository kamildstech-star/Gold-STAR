-- A rep's own to-do list.
--
-- WRITTEN, NOT APPLIED. One new table with RLS, one function, three indexes.
-- Nothing else changes and nothing is dropped. The app works without it:
-- `fetchTodo` in src/lib/todo.ts treats a missing table as "not set up yet",
-- the dashboard card and the pin buttons hide, and /todo says so.
--
-- Mark: "Can we add a to do list (linked to jobs) which would be user
-- specific & potentially tied to tasks the in jobs where you can choose to
-- add that task to the to do list"
--
-- "Tasks assigned to me" already exists (/tasks, Mine). This is different: a
-- personal, curated list the rep chooses what goes on. A row is one of two
-- things:
--
--   a PIN   -- task_id set. A job task the rep wants on their list, including
--              one assigned to somebody else that they want to keep an eye
--              on. Pinning never touches the task; ticking a pin completes the
--              real task (the app's one `completeTask`), and the pin reads
--              done from the task's own status. Unpinning removes it from
--              this list only.
--   a QUICK -- task_id null, title set. "Call the adjuster back", "pick up
--              dehumidifier filters": the rep's own note to self, not a formal
--              task, optionally tied to a job. `done_at` is its tick. It can
--              be promoted to a real task later (see promote_todo_item).
--
-- `job_id` is only for a quick item: a pin's job is the task's job, and
-- keeping a second copy here would let the two disagree once a task is moved.
--
-- OWNER ONLY, all four verbs, no manager read. It is a personal list, not a
-- work record; the work record is `tasks`, which managers already see by
-- office. If Mark wants managers to see reps' lists, that is one more SELECT
-- policy here and nothing else.

CREATE TABLE IF NOT EXISTS public.todo_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  task_id uuid REFERENCES public.tasks(id) ON DELETE CASCADE,
  job_id uuid REFERENCES public.jobs(id) ON DELETE SET NULL,
  title text,
  done_at timestamptz,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- A quick item is its title; a pin reads the task's. Neither is allowed to
  -- be a blank row.
  CONSTRAINT todo_items_quick_needs_title
    CHECK (task_id IS NOT NULL OR (title IS NOT NULL AND btrim(title) <> '')),
  -- One pin per task per person. Quick items have a null task_id, and nulls
  -- are distinct to a unique constraint, so any number of them fit. Being a
  -- plain constraint (not a partial index) is what lets the app upsert a pin
  -- ON CONFLICT (user_id, task_id) and make a replayed pin a no-op.
  CONSTRAINT todo_items_one_pin_per_task UNIQUE (user_id, task_id)
);

CREATE INDEX IF NOT EXISTS todo_items_by_owner
  ON public.todo_items (user_id, sort_order, created_at);
CREATE INDEX IF NOT EXISTS todo_items_by_task
  ON public.todo_items (task_id) WHERE task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS todo_items_by_job
  ON public.todo_items (job_id) WHERE job_id IS NOT NULL;

ALTER TABLE public.todo_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "todo_items_select_own" ON public.todo_items
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "todo_items_insert_own" ON public.todo_items
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "todo_items_update_own" ON public.todo_items
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "todo_items_delete_own" ON public.todo_items
  FOR DELETE TO authenticated
  USING (user_id = auth.uid());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.todo_items TO authenticated;
GRANT ALL ON public.todo_items TO service_role;

-- "Make this a task": a quick item becomes a real `tasks` row assigned to the
-- caller, on the item's job, and the item becomes the pin for it. Two writes
-- that have to land together -- a task with no pin looks like the button did
-- nothing, a pin pointing at nothing is a broken row -- so they are one
-- function call and therefore one transaction: if the second write fails the
-- first rolls back with it.
--
-- SECURITY INVOKER, deliberately. Every row it touches is governed by the
-- policies above and by the tasks policies (insert: created_by = auth.uid()),
-- so it cannot do anything the caller could not do by hand.
--
-- `_task_id` is chosen by the caller before the call and is the task's
-- primary key, so a replay after a lost response -- the offline queue does
-- exactly this -- finds the item already pointing at that task and returns
-- without filing a second one. A replay against an item that was since
-- deleted or that already belongs to a different task raises, so the queue
-- can report it rather than invent a task on its own.
--
-- The task's `location_id` is picked the way `createTask` picks it in the
-- app: the job's office, then the caller's primary office, then the first
-- office they belong to. A task with no office is visible only to its
-- assignee and creator, which for a self-assigned task is the same person,
-- so that fallback is acceptable here where it would not be for a task
-- handed to someone else.
CREATE OR REPLACE FUNCTION public.promote_todo_item(
  _todo_id uuid,
  _task_id uuid,
  _due_date date DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_item public.todo_items%ROWTYPE;
  v_location uuid;
  v_account uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Sign in to make a task' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_item FROM public.todo_items
   WHERE id = _todo_id AND user_id = auth.uid()
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That to-do is no longer on your list' USING ERRCODE = 'P0002';
  END IF;

  -- Already promoted by an earlier attempt whose response was lost.
  IF v_item.task_id = _task_id THEN
    RETURN _task_id;
  END IF;
  IF v_item.task_id IS NOT NULL THEN
    RAISE EXCEPTION 'That to-do is already a task' USING ERRCODE = '23505';
  END IF;

  SELECT j.location_id, j.account_id INTO v_location, v_account
    FROM public.jobs j WHERE j.id = v_item.job_id;
  IF v_location IS NULL THEN
    SELECT p.primary_location_id INTO v_location
      FROM public.profiles p WHERE p.user_id = auth.uid();
  END IF;
  IF v_location IS NULL THEN
    SELECT lm.location_id INTO v_location
      FROM public.location_members lm
     WHERE lm.user_id = auth.uid()
     ORDER BY lm.created_at ASC
     LIMIT 1;
  END IF;

  INSERT INTO public.tasks (
    id, title, assignee, due_date, priority, status, source,
    job_id, account_id, location_id, entity_type, entity_id, created_by
  ) VALUES (
    _task_id, btrim(v_item.title), auth.uid(), _due_date, 'normal', 'open', 'todo',
    v_item.job_id, v_account, v_location,
    CASE WHEN v_item.job_id IS NULL THEN NULL ELSE 'job' END, v_item.job_id,
    auth.uid()
  );

  -- The title stays on the row: harmless, and it keeps the item readable if
  -- the task is ever hidden from this user by a later reassignment.
  UPDATE public.todo_items
     SET task_id = _task_id, job_id = NULL, done_at = NULL
   WHERE id = _todo_id;

  RETURN _task_id;
END $$;

REVOKE ALL ON FUNCTION public.promote_todo_item(uuid, uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.promote_todo_item(uuid, uuid, date) TO authenticated, service_role;
