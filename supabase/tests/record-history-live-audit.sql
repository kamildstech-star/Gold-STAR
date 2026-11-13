-- Delete/edit history and Restore, checked against the LIVE database.
--
-- Read-only. Paste into the SQL editor after 20261006150000_record_history
-- (and 20261006163000, 20261006200000) are applied, and again after any
-- migration that touches a covered table's policies. Queries 1–4 should
-- return ZERO rows. Query 5 is informational: the live DELETE / UPDATE
-- policies of every covered table, to read beside the branches of
-- record_history_may_restore() — if one has changed, that function needs the
-- same change.

-- 1. A covered table without the capture trigger. Expect none. "Covered" is
--    read from the CHECK on record_history.table_name, so this follows
--    whichever of the migrations are applied.
SELECT m[1] AS table_missing_trigger
  FROM pg_catalog.pg_constraint con,
       regexp_matches(pg_get_constraintdef(con.oid), '''([a-z_]+)''', 'g') AS m
 WHERE con.conname = 'record_history_table_allowed'
   AND to_regclass(format('public.%I', m[1])) IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM pg_catalog.pg_trigger tg
      WHERE tg.tgrelid = to_regclass(format('public.%I', m[1]))
        AND tg.tgname = 'A_record_history'
        AND NOT tg.tgisinternal);

-- 2. The before-image readable, or history writable, by a signed-in user.
--    Expect none.
SELECT 'column ' || c AS privilege
  FROM unnest(ARRAY['old_row', 'new_row', 'txid']) AS c
 WHERE has_column_privilege('authenticated', 'public.record_history', c, 'SELECT')
UNION ALL
SELECT 'table ' || p
  FROM unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) AS p
 WHERE has_table_privilege('authenticated', 'public.record_history', p)
UNION ALL
SELECT 'anon can read record_history'
 WHERE has_table_privilege('anon', 'public.record_history', 'SELECT')
    OR has_column_privilege('anon', 'public.record_history', 'summary', 'SELECT');

-- 3. A record_history function callable by anon, or an internal one callable
--    by a signed-in user. Expect none.
SELECT p.oid::regprocedure AS function, r AS role
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  CROSS JOIN unnest(ARRAY['anon', 'authenticated']) AS r
 WHERE n.nspname = 'public'
   AND (p.proname LIKE 'record_history%' OR p.proname = 'restore_record_history')
   AND has_function_privilege(r, p.oid, 'EXECUTE')
   -- The two the app calls, and record_history_covers (20261006163000), which
   -- only reads pg_trigger.
   AND NOT (r = 'authenticated'
            AND p.proname IN ('restore_record_history', 'record_history_preview', 'record_history_covers'));

-- 4. RLS off, or a restrictive policy missing. Expect none.
SELECT 'rls disabled' AS problem
  FROM pg_catalog.pg_class WHERE oid = 'public.record_history'::regclass AND NOT relrowsecurity
UNION ALL
SELECT 'missing ' || want
  FROM unnest(ARRAY['active_profile_required', 'portal_customer_denied', 'record_history_select']) AS want
 WHERE NOT EXISTS (SELECT 1 FROM pg_policies
                    WHERE schemaname = 'public' AND tablename = 'record_history' AND policyname = want);

-- 5. Informational: the rules record_history_may_restore() restates.
SELECT tablename, policyname, cmd, permissive, qual, with_check
  FROM pg_policies
 WHERE schemaname = 'public'
   AND tablename IN ('job_notes', 'job_section_notes', 'job_contacts', 'tasks', 'estimates',
                     'job_calculations', 'photos', 'job_assignments', 'job_contact_methods',
                     'job_intake_answers', 'job_drying_readings', 'job_moisture_points',
                     'job_moisture_readings')
   AND cmd IN ('DELETE', 'UPDATE', 'ALL')
 ORDER BY tablename, cmd, policyname;
