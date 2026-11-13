DO $mig$
DECLARE
  def text;
  a int;
  b int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'seed_demo_data';

  a := strpos(def, '  ---------------------------------------------------------------- equipment' || E'\n');
  b := strpos(def, '  ---------------------------------------------------------------- invoices' || E'\n');

  IF a = 0 OR b = 0 OR b <= a THEN
    RAISE EXCEPTION 'seed_demo_data: equipment/invoices markers not found (a=%, b=%)', a, b;
  END IF;

  def := left(def, a - 1) || substr(def, b);

  IF position('public.equipment' in def) > 0 THEN
    RAISE EXCEPTION 'seed_demo_data: equipment insert still present after edit';
  END IF;

  EXECUTE def;
END
$mig$;