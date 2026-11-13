-- Read-only. Paste into the Supabase SQL editor on the live project at any time
-- after 20260929120000 (and 20260929121000) are applied. Every query should
-- return ZERO rows; any row is a door open to an unauthenticated caller, or to
-- a signed-in account that has not been approved.
--
-- The deliberate allowlists are src/lib/security/public-surface.ts (both empty
-- today). Extension-owned objects (PostGIS, pg_trgm) are excluded.

-- 1. Functions anon can EXECUTE.
SELECT p.oid::regprocedure AS function, pg_get_userbyid(p.proowner) AS owner
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname IN ('public', 'goldstar_private')
   AND has_function_privilege('anon', p.oid, 'EXECUTE')
   AND NOT EXISTS (SELECT 1 FROM pg_depend d
                    WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e');

-- 2. Tables, views and sequences anon holds any privilege on.
SELECT format('%I.%I', n.nspname, c.relname) AS relation, c.relkind
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname IN ('public', 'goldstar_private')
   AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
   AND NOT EXISTS (SELECT 1 FROM pg_depend d
                    WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
   AND CASE WHEN c.relkind = 'S' THEN has_sequence_privilege('anon', c.oid, 'USAGE,SELECT,UPDATE')
            ELSE has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') END;

-- 3. Public buckets.
SELECT id FROM storage.buckets WHERE public;

-- 4. Default privileges that would hand the NEXT object to anon or PUBLIC.
SELECT pg_get_userbyid(d.defaclrole) AS for_role, n.nspname AS in_schema, d.defaclobjtype, d.defaclacl
  FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
 WHERE array_to_string(d.defaclacl, ',') ~ '(^|,)(anon)?='  -- anon=… or a PUBLIC (=…) entry
   AND pg_get_userbyid(d.defaclrole) IN ('postgres', 'supabase_admin');

-- 5. Tables a signed-in but UNAPPROVED account could still read: RLS on, but
--    no active_profile_required guard (20260929121000 adds it everywhere).
SELECT format('public.%I', c.relname) AS table_without_guard
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relrowsecurity
   AND c.relname <> 'profiles'
   AND NOT EXISTS (SELECT 1 FROM pg_policies pp
                    WHERE pp.schemaname = 'public' AND pp.tablename = c.relname
                      AND pp.policyname = 'active_profile_required');

-- 6. Tables with NO row-level security that authenticated can read. RLS is the
--    data boundary; each row here is decided by grants alone. Not fixed
--    automatically, because turning RLS on without policies would lock staff
--    out — review each and add policies.
SELECT format('public.%I', c.relname) AS table_without_rls
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity
   AND has_table_privilege('authenticated', c.oid, 'SELECT')
   AND NOT EXISTS (SELECT 1 FROM pg_depend d
                    WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e');
