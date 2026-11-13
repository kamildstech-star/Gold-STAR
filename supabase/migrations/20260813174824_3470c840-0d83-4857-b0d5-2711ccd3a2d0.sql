DO $$
DECLARE d text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'seed_demo_jobs';

  IF d IS NULL THEN
    RAISE EXCEPTION 'seed_demo_jobs not found';
  END IF;

  d := replace(
    d,
    'CASE WHEN a.account_type = ''residential'' THEN ''residential'' ELSE ''commercial'' END',
    'CASE WHEN a.account_type = ''residential'' THEN ''person'' ELSE ''company'' END'
  );

  EXECUTE d;
END $$;