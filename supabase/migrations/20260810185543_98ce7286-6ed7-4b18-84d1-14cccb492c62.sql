-- Performance only: no change to who can read or write anything.
-- Postgres evaluates auth.uid() per row when it appears bare in a policy, but
-- once per statement when wrapped in a scalar subquery (an InitPlan). On tables
-- with thousands of rows this was the dominant cost of every list query.
DO $$
DECLARE
  p record;
  new_using text;
  new_check text;
  sql text;
BEGIN
  FOR p IN
    SELECT
      pol.polname,
      c.relname,
      pg_get_expr(pol.polqual, pol.polrelid) AS qual,
      pg_get_expr(pol.polwithcheck, pol.polrelid) AS withcheck
    FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
  LOOP
    new_using := p.qual;
    new_check := p.withcheck;

    IF new_using IS NOT NULL THEN
      new_using := replace(new_using, 'auth.uid()', '(select auth.uid())');
      new_using := replace(new_using, '( SELECT (select auth.uid()) AS uid)', '(select auth.uid())');
      new_using := replace(new_using, 'auth.jwt()', '(select auth.jwt())');
      new_using := replace(new_using, '( SELECT (select auth.jwt()) AS jwt)', '(select auth.jwt())');
    END IF;

    IF new_check IS NOT NULL THEN
      new_check := replace(new_check, 'auth.uid()', '(select auth.uid())');
      new_check := replace(new_check, '( SELECT (select auth.uid()) AS uid)', '(select auth.uid())');
      new_check := replace(new_check, 'auth.jwt()', '(select auth.jwt())');
      new_check := replace(new_check, '( SELECT (select auth.jwt()) AS jwt)', '(select auth.jwt())');
    END IF;

    IF new_using IS DISTINCT FROM p.qual OR new_check IS DISTINCT FROM p.withcheck THEN
      sql := format('ALTER POLICY %I ON public.%I', p.polname, p.relname);
      IF new_using IS NOT NULL THEN
        sql := sql || format(' USING (%s)', new_using);
      END IF;
      IF new_check IS NOT NULL THEN
        sql := sql || format(' WITH CHECK (%s)', new_check);
      END IF;
      EXECUTE sql;
    END IF;
  END LOOP;
END $$;