-- READ ONLY. Run as the database administrator in the Goldstar project.
-- Never select Vault decrypted_secret values or app_settings credential JSON.
-- Results are evidence for review, not an automated declaration of safety.
BEGIN TRANSACTION READ ONLY;

-- Any public bucket intentionally bypasses Storage read policies. Confirm each
-- exception contains only material approved for publication.
SELECT id, name, public, file_size_limit, allowed_mime_types
FROM storage.buckets ORDER BY id;

-- User-data tables must have reviewed row policies. RLS enabled alone is not
-- proof of isolation: examine both permissive and restrictive expressions.
SELECT n.nspname AS schema_name, c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname IN ('public', 'storage') AND c.relkind IN ('r', 'p')
ORDER BY 1, 2;
SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
FROM pg_policies WHERE schemaname IN ('public', 'storage')
ORDER BY schemaname, tablename, policyname;

-- Privileged functions callable with a browser credential need an internal
-- authorization guard. Read source separately in the SQL editor; do not dump
-- function bodies to logs because historical functions can contain secrets.
SELECT p.oid::regprocedure AS function_name, p.prosecdef,
       p.proconfig,
       has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_execute,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS user_execute
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.prosecdef
ORDER BY 1;

-- Compare to files individually; this ledger may not represent schema applied
-- out of band. Do not run every pending migration blindly.
SELECT version, name FROM supabase_migrations.schema_migrations ORDER BY version;

-- Counts only: no profile identities, MFA secrets or session tokens returned.
SELECT approval_status, is_active, count(*) FROM public.profiles GROUP BY 1, 2;
SELECT status, factor_type, count(*) FROM auth.mfa_factors GROUP BY 1, 2;
COMMIT;

-- Also inspect Auth settings in the dashboard: CAPTCHA enforcement, password
-- policy, email confirmation, signup policy, JWT lifetime and redirect origins.
-- Inspect cron schedules and caller headers privately; don't print secrets.
-- Confirm deployed hooks reject missing/incorrect credentials and accept the
-- real scheduler. A 200 HTML SPA fallback is not a successful hook test.
