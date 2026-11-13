-- Notify the person who assigned a task when somebody else completes it.
-- This belongs on the table because tasks can be completed from the main task
-- list, a job, the director board, or the offline replay queue.

CREATE OR REPLACE FUNCTION public.notify_task_creator_on_completion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor uuid := COALESCE((SELECT auth.uid()), NEW.assignee);
  actor_name text;
BEGIN
  IF OLD.status IS DISTINCT FROM 'done'::public.task_status
     AND NEW.status = 'done'::public.task_status
     AND NEW.created_by IS NOT NULL
     AND actor IS DISTINCT FROM NEW.created_by
     AND NOT EXISTS (
       SELECT 1
       FROM public.notification_preferences np
       WHERE np.user_id = NEW.created_by
         AND np.type = 'task_completed'::public.notification_type
         AND (NOT np.in_app OR np.delivery = 'off'::public.notification_delivery)
     ) THEN
    SELECT p.full_name INTO actor_name
    FROM public.profiles p
    WHERE p.user_id = actor;

    INSERT INTO public.notifications
      (user_id, type, title, body, entity_type, entity_id, href, priority)
    VALUES
      (NEW.created_by,
       'task_completed'::public.notification_type,
       COALESCE(actor_name, 'A teammate') || ' completed a task',
       NEW.title,
       'task',
       NEW.id,
       '/tasks',
       'normal'::public.notification_priority);
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.notify_task_creator_on_completion() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS tasks_notify_creator_on_completion ON public.tasks;
CREATE TRIGGER tasks_notify_creator_on_completion
  AFTER UPDATE OF status ON public.tasks
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_task_creator_on_completion();
