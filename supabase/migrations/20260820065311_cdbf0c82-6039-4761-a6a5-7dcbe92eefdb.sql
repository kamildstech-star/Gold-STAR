CREATE OR REPLACE FUNCTION public.tg_stage_advance_touch()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  payload jsonb := to_jsonb(NEW);
  acc uuid;
BEGIN
  IF TG_TABLE_NAME = 'documents' AND coalesce(payload->>'status', '') <> 'signed' THEN
    RETURN NULL;
  END IF;

  BEGIN
    acc := nullif(payload->>'account_id', '')::uuid;
  EXCEPTION WHEN OTHERS THEN
    acc := NULL;
  END;

  IF acc IS NOT NULL THEN
    PERFORM public.stage_advance_evaluate(acc);
  END IF;
  RETURN NULL;
END;
$$;