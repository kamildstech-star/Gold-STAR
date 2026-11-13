-- Read-only deployment review. Do not infer deployment from migration files.
-- These rows are an inventory for review, not a blanket pass/fail advisor.
SELECT p.oid::regprocedure AS signature, r.rolname AS owner,
       p.prosecdef AS security_definer, p.proconfig,
       has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_execute,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_execute
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
JOIN pg_roles r ON r.oid = p.proowner
WHERE n.nspname IN ('public', 'goldstar_private') AND p.prokind = 'f'
  AND p.prosecdef
ORDER BY signature::text;

-- Inspect selected function definitions privately in the SQL editor. Do not
-- dump all bodies into tool/CI logs: historical bodies may contain credentials.

-- Explicitly identify exposed-schema tables outside the status guard list.
SELECT n.nspname, c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
  AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid
    AND p.polname IN ('active_profile_required', 'profile_status_read_guard'))
ORDER BY c.relname;

SELECT id, public FROM storage.buckets ORDER BY id;
