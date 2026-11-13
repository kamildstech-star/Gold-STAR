CREATE OR REPLACE FUNCTION public.tg_automation_notify()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  cfg jsonb;
  hook_url text;
  hook_key text;
  triggers jsonb;
BEGIN
  SELECT value INTO cfg FROM public.app_settings WHERE key = 'automations';
  IF cfg IS NULL THEN RETURN NULL; END IF;
  IF COALESCE((cfg->>'event_driven')::boolean, true) IS FALSE THEN RETURN NULL; END IF;

  hook_url := cfg->>'hook_url';
  hook_key := cfg->>'apikey';
  IF hook_url IS NULL OR hook_key IS NULL THEN RETURN NULL; END IF;

  triggers := COALESCE(TG_ARGV[0]::jsonb, '[]'::jsonb);

  PERFORM net.http_post(
    url := hook_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'apikey', hook_key),
    body := jsonb_build_object('triggers', triggers)
  );
  RETURN NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.tg_automation_notify() FROM anon, PUBLIC;

DROP TRIGGER IF EXISTS trg_automation_accounts ON public.accounts;
CREATE TRIGGER trg_automation_accounts
AFTER INSERT OR UPDATE OF stage_id ON public.accounts
FOR EACH STATEMENT
EXECUTE FUNCTION public.tg_automation_notify('["stage_enter","stage_leave","deal_created","deal_won","deal_lost","stage_rot"]');

DROP TRIGGER IF EXISTS trg_automation_stage_history ON public.account_stage_history;
CREATE TRIGGER trg_automation_stage_history
AFTER INSERT ON public.account_stage_history
FOR EACH STATEMENT
EXECUTE FUNCTION public.tg_automation_notify('["stage_enter","stage_leave","deal_won","deal_lost"]');

DROP TRIGGER IF EXISTS trg_automation_tasks ON public.tasks;
CREATE TRIGGER trg_automation_tasks
AFTER INSERT OR UPDATE OF due_date, status ON public.tasks
FOR EACH STATEMENT
EXECUTE FUNCTION public.tg_automation_notify('["task_past_due"]');

DROP TRIGGER IF EXISTS trg_automation_touchpoints ON public.touchpoints;
CREATE TRIGGER trg_automation_touchpoints
AFTER INSERT ON public.touchpoints
FOR EACH STATEMENT
EXECUTE FUNCTION public.tg_automation_notify('["no_activity"]');