-- Reassign a book, one atomic call per slice.
--
-- When a salesperson leaves, their whole book comes to the Reassign page and
-- is split up: some accounts to the New York rep, some to the Georgia rep.
-- Each slice is one call to this function so the batch row, the per-account
-- handover rows, the account update, the timeline entry, the task moves and
-- the notification all commit or roll back together. The client used to do
-- these as four separate requests, which could leave a batch recorded with
-- no accounts moved (or the reverse).
--
-- Permissions are the ones the tables already carry: `reassignment_batches`
-- and `deal_reassignments` accept inserts from `is_sales_lead` only, so that
-- is the gate here, plus the active-profile requirement every business table
-- enforces through RLS. SECURITY DEFINER is needed for exactly one write:
-- `account_stage_history` has no INSERT policy (the stage trigger is its only
-- door), and this move is a rep change, not a stage change, so the trigger
-- does not fire. Nothing is deleted; the previous rep stays on the batch, on
-- every `deal_reassignments` row and in the history reason, so a mistaken
-- slice is reversed by reassigning it back.
--
-- Re-runnable: CREATE OR REPLACE and idempotent grants.

CREATE OR REPLACE FUNCTION public.reassign_book_atomically(
  _from_user_id uuid,
  _to_user_id uuid,
  _account_ids uuid[],
  _reason public.reassignment_reason,
  _reason_note text DEFAULT NULL,
  _do_differently text DEFAULT NULL,
  _move_tasks boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  actor uuid := auth.uid();
  actor_name text;
  from_name text;
  to_name text;
  to_active boolean;
  wanted integer := coalesce(array_length(_account_ids, 1), 0);
  held integer;
  batch_id uuid;
  history_reason text;
  reason_label text;
  tasks_found integer := 0;
  tasks_cadence_found integer := 0;
  tasks_moved integer := 0;
  tasks_cadence_moved integer := 0;
BEGIN
  IF actor IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '28000';
  END IF;

  -- Same two gates the reassignment tables' RLS applies to a direct insert.
  IF NOT goldstar_private.profile_is_active(actor) THEN
    RAISE EXCEPTION 'active approved profile required' USING ERRCODE = '42501';
  END IF;
  IF NOT public.is_sales_lead(actor) THEN
    RAISE EXCEPTION 'Only the Sales Head, an owner or an admin can reassign a book.'
      USING ERRCODE = '42501';
  END IF;

  IF _from_user_id IS NULL OR _to_user_id IS NULL THEN
    RAISE EXCEPTION 'Pick who the book is coming from and going to.' USING ERRCODE = '22023';
  END IF;
  IF _from_user_id = _to_user_id THEN
    RAISE EXCEPTION 'Those are the same person.' USING ERRCODE = '22023';
  END IF;
  IF wanted = 0 THEN
    RAISE EXCEPTION 'Select at least one account.' USING ERRCODE = '22023';
  END IF;

  SELECT p.full_name INTO actor_name FROM public.profiles p WHERE p.user_id = actor;
  -- The departing rep may already be deactivated; that is the normal case.
  SELECT p.full_name INTO from_name FROM public.profiles p WHERE p.user_id = _from_user_id;
  SELECT p.full_name, coalesce(p.is_active, false) INTO to_name, to_active
    FROM public.profiles p WHERE p.user_id = _to_user_id;
  IF to_name IS NULL AND to_active IS NULL THEN
    RAISE EXCEPTION 'The receiving rep has no profile.' USING ERRCODE = '22023';
  END IF;
  IF NOT to_active THEN
    RAISE EXCEPTION 'The receiving rep is deactivated — pick someone who can work the book.'
      USING ERRCODE = '22023';
  END IF;

  -- Lock the slice. Every selected account must still sit with the departing
  -- rep; if one moved under us the whole slice is refused rather than half
  -- applied, and the page reloads the book.
  SELECT count(*) INTO held
    FROM (
      SELECT a.id
        FROM public.accounts a
       WHERE a.id = ANY (_account_ids)
         AND a.assigned_rep = _from_user_id
         AND a.archived_at IS NULL
         AND coalesce(a.is_reference, false) = false
         FOR UPDATE OF a
    ) locked;
  IF held <> wanted THEN
    RAISE EXCEPTION '% of the % selected accounts are no longer with %. Reload the book and select again.',
      wanted - held, wanted, coalesce(from_name, 'that rep')
      USING ERRCODE = '40001';
  END IF;

  reason_label := CASE _reason
    WHEN 'no_close_6_months' THEN 'Hasn''t closed in 6 months'
    WHEN 'rep_departed' THEN 'Rep left the company'
    WHEN 'territory_change' THEN 'Territory change'
    WHEN 'account_request' THEN 'Account asked for a change'
    ELSE 'Other'
  END;

  INSERT INTO public.reassignment_batches
    (from_user_id, to_user_id, reason, reason_note, do_differently, account_count, created_by, is_demo)
  VALUES
    (_from_user_id, _to_user_id, _reason::text, nullif(btrim(_reason_note), ''),
     nullif(btrim(_do_differently), ''), wanted, actor,
     (SELECT bool_and(coalesce(a.is_demo, false)) FROM public.accounts a WHERE a.id = ANY (_account_ids)))
  RETURNING id INTO batch_id;

  INSERT INTO public.deal_reassignments
    (batch_id, account_id, from_user_id, to_user_id, reason, reason_note, do_differently,
     stage_at_transfer, days_in_pipeline, created_by, is_demo)
  SELECT batch_id, a.id, _from_user_id, _to_user_id, _reason::text,
         nullif(btrim(_reason_note), ''), nullif(btrim(_do_differently), ''),
         a.stage,
         greatest(0, floor(extract(epoch FROM (now() - a.created_at)) / 86400))::integer,
         actor, coalesce(a.is_demo, false)
    FROM public.accounts a
   WHERE a.id = ANY (_account_ids);

  UPDATE public.accounts a
     SET assigned_rep = _to_user_id
   WHERE a.id = ANY (_account_ids);

  -- The timeline line: who it came from, who has it now, who did it. The
  -- previous rep is named here on purpose — it is the undo instruction.
  history_reason := 'Reassigned from ' || coalesce(from_name, 'unassigned')
    || ' to ' || coalesce(to_name, 'a rep')
    || ' by ' || coalesce(actor_name, 'a manager')
    || ' — ' || reason_label
    || CASE WHEN nullif(btrim(_reason_note), '') IS NULL THEN '' ELSE ': ' || btrim(_reason_note) END;

  INSERT INTO public.account_stage_history
    (account_id, from_stage, to_stage, from_stage_id, to_stage_id, reason, changed_by, is_demo)
  SELECT a.id, a.stage, a.stage, a.stage_id, a.stage_id, history_reason, actor, coalesce(a.is_demo, false)
    FROM public.accounts a
   WHERE a.id = ANY (_account_ids);

  -- What else belongs to the book: open work on these accounts that the
  -- departing rep still holds, including the cadence and automation tasks
  -- the sweeps created for them. Counted first so the caller can say what
  -- was found even when the move is declined.
  SELECT count(*),
         count(*) FILTER (WHERE t.cadence_key IS NOT NULL
                             OR t.source IN ('cadence', 'automation', 'followup_rule'))
    INTO tasks_found, tasks_cadence_found
    FROM public.tasks t
   WHERE t.assignee = _from_user_id
     AND t.status IN ('open', 'in_progress')
     AND (t.account_id = ANY (_account_ids)
          OR (t.entity_type = 'account' AND t.entity_id = ANY (_account_ids)));

  IF _move_tasks AND tasks_found > 0 THEN
    WITH moved AS (
      UPDATE public.tasks t
         SET assignee = _to_user_id
       WHERE t.assignee = _from_user_id
         AND t.status IN ('open', 'in_progress')
         AND (t.account_id = ANY (_account_ids)
              OR (t.entity_type = 'account' AND t.entity_id = ANY (_account_ids)))
      RETURNING t.cadence_key, t.source
    )
    SELECT count(*),
           count(*) FILTER (WHERE cadence_key IS NOT NULL
                               OR source IN ('cadence', 'automation', 'followup_rule'))
      INTO tasks_moved, tasks_cadence_moved
      FROM moved;
  END IF;

  INSERT INTO public.notifications
    (user_id, type, title, body, entity_type, entity_id, href, priority)
  VALUES
    (_to_user_id, 'book_reassigned',
     wanted || ' account' || CASE WHEN wanted = 1 THEN '' ELSE 's' END || ' transferred to you'
       || CASE WHEN from_name IS NULL THEN '' ELSE ' from ' || from_name END,
     'Reason: ' || reason_label
       || CASE WHEN nullif(btrim(_do_differently), '') IS NULL THEN ''
               ELSE '. Next time: ' || btrim(_do_differently) END
       || CASE WHEN tasks_moved > 0
               THEN '. ' || tasks_moved || ' open task' || CASE WHEN tasks_moved = 1 THEN '' ELSE 's' END || ' moved with them.'
               ELSE '' END,
     'reassignment_batch', batch_id, '/accounts', 'high');

  RETURN jsonb_build_object(
    'batch_id', batch_id,
    'account_count', wanted,
    'tasks_found', tasks_found,
    'tasks_cadence_found', tasks_cadence_found,
    'tasks_moved', tasks_moved,
    'tasks_cadence_moved', tasks_cadence_moved,
    'from_name', from_name,
    'to_name', to_name
  );
END;
$function$;

ALTER FUNCTION public.reassign_book_atomically(uuid, uuid, uuid[], public.reassignment_reason, text, text, boolean)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.reassign_book_atomically(uuid, uuid, uuid[], public.reassignment_reason, text, text, boolean)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reassign_book_atomically(uuid, uuid, uuid[], public.reassignment_reason, text, text, boolean)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.reassign_book_atomically(uuid, uuid, uuid[], public.reassignment_reason, text, text, boolean) IS
  'Moves one slice of a rep''s book to another rep in one transaction: batch + per-account handover rows, assigned_rep, a "Reassigned from X to Y by Z" history line, open tasks (optional) and the notification. Sales-lead only.';

NOTIFY pgrst, 'reload schema';
