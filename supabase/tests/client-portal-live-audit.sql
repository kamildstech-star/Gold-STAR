-- Client portal: deny-by-default, checked against the LIVE database.
--
-- Read-only. Paste into the SQL editor after 20260928130000 and 20260928131000
-- are applied, and again after any later migration. Every query should return
-- ZERO rows except the last two, which are informational. The same checks run
-- inside 20260928131000 at apply time and abort it if they fail.

-- 1. Any table, view or sequence the customer role can reach. Expect none.
SELECT n.nspname AS schema, c.relname AS relation, c.relkind
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
   AND n.nspname NOT LIKE 'pg\_%'
   AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
   AND has_schema_privilege('portal_customer', n.oid, 'USAGE')
   AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                    WHERE d.classid = 'pg_catalog.pg_class'::regclass
                      AND d.objid = c.oid AND d.deptype = 'e')
   AND CASE WHEN c.relkind = 'S'
            THEN has_sequence_privilege('portal_customer', c.oid, 'USAGE,SELECT,UPDATE')
            ELSE has_table_privilege('portal_customer', c.oid,
                   'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') END;

-- 2. Any callable function beyond the five portal ones. Expect none.
SELECT p.oid::regprocedure AS function
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname IN ('public', 'goldstar_private')
   AND p.prorettype NOT IN ('pg_catalog.trigger'::regtype, 'pg_catalog.event_trigger'::regtype)
   AND has_function_privilege('portal_customer', p.oid, 'EXECUTE')
   AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                    WHERE d.classid = 'pg_catalog.pg_proc'::regclass
                      AND d.objid = p.oid AND d.deptype = 'e')
   AND p.proname NOT IN ('portal_my_jobs', 'portal_job', 'portal_photos', 'portal_invoice', 'portal_file_refs');

-- 3. Any portal function a staff or anonymous session can call. Expect none.
SELECT p.proname
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN ('portal_my_jobs', 'portal_job', 'portal_photos', 'portal_invoice', 'portal_file_refs')
   AND (has_function_privilege('authenticated', p.oid, 'EXECUTE')
        OR has_function_privilege('anon', p.oid, 'EXECUTE'));

-- 4. RLS tables in public missing the restrictive customer deny (e.g. created
--    after the portal migration). Expect none; if any appear, re-run section 9
--    of 20260928130000 or add the policy in the migration that made the table.
SELECT c.relname
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relrowsecurity
   AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                    WHERE d.classid = 'pg_catalog.pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
   AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policies pol
                    WHERE pol.schemaname = 'public' AND pol.tablename = c.relname
                      AND pol.policyname = 'portal_customer_denied');

-- 5. Any portal customer holding anything that makes a sign-in staff. Expect none.
SELECT pc.id, pc.email
  FROM public.portal_customers pc
 WHERE pc.user_id IS NOT NULL AND goldstar_private.has_staff_footprint(pc.user_id);

-- 6. Any portal customer whose sign-in is not the customer role. Expect none.
SELECT pc.id, pc.email, u.role
  FROM public.portal_customers pc JOIN auth.users u ON u.id = pc.user_id
 WHERE u.role IS DISTINCT FROM 'portal_customer';

-- 7. Informational: PostgREST can switch into the role (expect one row).
SELECT r.rolname AS member_of_portal_customer
  FROM pg_catalog.pg_auth_members m
  JOIN pg_catalog.pg_roles r ON r.oid = m.member
 WHERE m.roleid = 'portal_customer'::regrole;

-- 8. Informational: what is shared right now, per customer.
SELECT pc.email, j.job_number, count(i.id) AS items_shared
  FROM public.portal_job_shares s
  JOIN public.portal_customers pc ON pc.id = s.portal_customer_id
  JOIN public.jobs j ON j.id = s.job_id
  LEFT JOIN public.portal_share_items i ON i.share_id = s.id
 GROUP BY pc.email, j.job_number
 ORDER BY pc.email, j.job_number;
