-- anon reaches nothing of ours: no function, no table, no public bucket.
--
-- WRITTEN, NOT APPLIED. Builds ON 20260924120000_revoke_anon_function_access,
-- which it does not repeat or replace. Re-runnable.
--
-- From the security review Mark commissioned (external-access hardening before
-- launch): the anon key and the URL are public by design, so the database has
-- to refuse an anonymous caller by itself.
--
-- WHAT 20260924120000 LEFT OPEN, and why this file exists:
--
--  1. THE SAFETY NET FOR NEW FUNCTIONS NEVER WORKED. 20260924120000 ended
--     with ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON
--     FUNCTIONS FROM PUBLIC. Postgres adds per-schema defaults on top of the
--     global ones and cannot subtract from them, and EXECUTE-to-PUBLIC is a
--     global built-in, so that line changed nothing: every function created
--     since still went to PUBLIC, and Supabase's own defaults also grant anon
--     BY NAME. What kept anon out since 09-24 is that every migration
--     remembered to REVOKE … FROM PUBLIC, anon itself — audited function by
--     function (src/lib/security/anon-surface.test.ts): all of them did. The
--     global default is fixed below, so the next one that forgets starts
--     closed anyway. (tg_automation_rules_validate, re-defined in
--     20260926121000 without a revoke, is not a slip: it dates from 20260806,
--     was swept on 09-24, and CREATE OR REPLACE keeps its privileges. It is
--     revoked by name below regardless.)
--
--  2. TABLES. RLS kept every table's rows from anon (tables answer []), but
--     anon still HOLDS SELECT/INSERT/UPDATE/DELETE on them by Supabase default,
--     so one permissive policy written TO public, or one table created without
--     RLS, is a leak. anon needs no table: nothing before sign-in reads the
--     database as anon — the public pages go through server functions holding
--     the service key (src/lib/security/public-surface.ts). Revoked, and the
--     defaults with them, so a table created tomorrow starts closed.
--
--  3. BUCKETS. Every bucket in the migrations is private, but buckets made from
--     the dashboard are not in the migrations. Nothing in the app builds a
--     public object URL, so any bucket still public is made private — except
--     those listed in PUBLIC_STORAGE_BUCKETS (none today).
--
-- WHY THIS IS SAFE FOR SIGNED-IN USERS: only anon and PUBLIC lose anything.
-- `authenticated` and `service_role` hold their own explicit grants (measured
-- for functions on 2026-09-24: all 1,011 authenticated-executable functions
-- held an explicit grant), and this file never revokes from them.
--
-- The deliberate public allowlist lives in ONE place, in code:
-- src/lib/security/public-surface.ts (ANON_EXECUTABLE_FUNCTIONS,
-- PUBLIC_STORAGE_BUCKETS). Both are empty; the arrays below mirror them, and
-- src/lib/security/anon-surface.test.ts fails if the two ever disagree.
--
-- Extension-owned objects (PostGIS, pg_trgm) are skipped by dependency, as in
-- 20260924120000: they are owned by supabase_admin, read no tables, and some
-- back the search indexes.
--
-- The audit at the end rolls the whole file back if anon can still reach any
-- function or relation this role owns. Objects owned by a role this migration
-- cannot revoke on are reported as a NOTICE, never silently.

DO $$
DECLARE
  allowed_functions text[] := ARRAY[]::text[];  -- mirrors ANON_EXECUTABLE_FUNCTIONS
  f record;
  revoked int := 0;
  skipped int := 0;
BEGIN
  FOR f IN
    SELECT p.oid, p.oid::regprocedure AS sig, p.proname, p.proacl, p.proowner
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname IN ('public', 'goldstar_private')
       AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                        WHERE d.classid = 'pg_catalog.pg_proc'::regclass
                          AND d.objid = p.oid AND d.deptype = 'e')
       AND NOT (p.proname = ANY (allowed_functions))
       AND has_function_privilege('anon', p.oid, 'EXECUTE')
  LOOP
    BEGIN
      -- PUBLIC's grant also reaches authenticated and service_role. Where one
      -- of them holds EXECUTE only through PUBLIC, give it the grant by name
      -- first, so dropping PUBLIC takes nothing from a signed-in user or the
      -- server. Only anon loses anything here.
      IF has_function_privilege('authenticated', f.oid, 'EXECUTE')
         AND NOT EXISTS (SELECT 1 FROM aclexplode(coalesce(f.proacl, acldefault('f', f.proowner))) a
                          WHERE a.grantee = 'authenticated'::regrole AND a.privilege_type = 'EXECUTE') THEN
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f.sig);
      END IF;
      IF has_function_privilege('service_role', f.oid, 'EXECUTE')
         AND NOT EXISTS (SELECT 1 FROM aclexplode(coalesce(f.proacl, acldefault('f', f.proowner))) a
                          WHERE a.grantee = 'service_role'::regrole AND a.privilege_type = 'EXECUTE') THEN
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.sig);
      END IF;
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon, PUBLIC', f.sig);
      revoked := revoked + 1;
    EXCEPTION WHEN insufficient_privilege THEN
      skipped := skipped + 1;
    END;
  END LOOP;
  RAISE NOTICE 'anon function sweep: % revoked, % skipped (not ours to revoke)', revoked, skipped;
END $$;

-- Re-defined without a revoke in 20260926121000; it kept its swept privileges,
-- but it is named here so no reader has to work that out. Trigger function:
-- no role needs to call it.
DO $$
BEGIN
  REVOKE ALL ON FUNCTION public.tg_automation_rules_validate() FROM PUBLIC, anon, authenticated;
EXCEPTION WHEN undefined_function THEN
  RAISE NOTICE 'tg_automation_rules_validate not present here; nothing to revoke';
END $$;

-- Tables, views, materialized views, foreign tables and sequences: anon holds
-- none of them.
DO $$
DECLARE
  r record;
  revoked int := 0;
  skipped int := 0;
BEGIN
  FOR r IN
    SELECT c.oid, format('%I.%I', n.nspname, c.relname) AS name, c.relkind
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname IN ('public', 'goldstar_private')
       AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
       AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                        WHERE d.classid = 'pg_catalog.pg_class'::regclass
                          AND d.objid = c.oid AND d.deptype = 'e')
  LOOP
    BEGIN
      IF r.relkind = 'S' THEN
        EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM anon', r.name);
      ELSE
        EXECUTE format('REVOKE ALL ON TABLE %s FROM anon', r.name);
      END IF;
      revoked := revoked + 1;
    EXCEPTION WHEN insufficient_privilege THEN
      skipped := skipped + 1;
    END;
  END LOOP;
  RAISE NOTICE 'anon relation sweep: % revoked, % skipped', revoked, skipped;
END $$;

-- Tomorrow's objects. Default privileges are per creating role: this role's
-- are set here; supabase_admin's are attempted and, where refused, reported.
--
-- FOUND WHILE TESTING THIS FILE: 20260924120000's
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC
-- does nothing. Postgres adds per-schema defaults ON TOP OF the global ones and
-- cannot subtract from them, and EXECUTE-to-PUBLIC is a GLOBAL built-in
-- default. So every function created since has still gone to PUBLIC (and so to
-- anon). The global form below is the one that works. It covers every schema,
-- which is intended: goldstar_private functions are granted to authenticated
-- by name in their own migrations, and public ones by Supabase's defaults.
-- supabase/tests/anon-surface.pglite.mjs proves a function created after this
-- file starts closed to anon.
DO $$
BEGIN
  EXECUTE 'ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC';
  EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon';
  EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon';
  EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'default privileges unchanged: not permitted as %', current_user;
END $$;

DO $$
BEGIN
  EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC';
  EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon';
  EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE ALL ON TABLES FROM anon';
  EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon';
EXCEPTION WHEN insufficient_privilege OR undefined_object THEN
  RAISE NOTICE 'supabase_admin default privileges unchanged: not permitted as %', current_user;
END $$;

-- Buckets: private unless deliberately public.
DO $$
DECLARE
  allowed_buckets text[] := ARRAY[]::text[];  -- mirrors PUBLIC_STORAGE_BUCKETS
  n int;
BEGIN
  UPDATE storage.buckets SET public = false
   WHERE public AND NOT (id = ANY (allowed_buckets));
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'storage: % bucket(s) made private', n;
EXCEPTION WHEN undefined_table OR invalid_schema_name OR insufficient_privilege THEN
  RAISE NOTICE 'storage.buckets not reachable here; buckets unchanged';
END $$;

-- The audit. Refuses to finish if anon can still reach anything this role
-- owns; lists, as a NOTICE, anything left that belongs to someone else.
DO $$
DECLARE
  allowed_functions text[] := ARRAY[]::text[];
  bad text;
  foreign_left text;
BEGIN
  SELECT string_agg(p.oid::regprocedure::text, ', ') FILTER (WHERE pg_has_role(p.proowner, 'USAGE')),
         string_agg(p.oid::regprocedure::text, ', ') FILTER (WHERE NOT pg_has_role(p.proowner, 'USAGE'))
    INTO bad, foreign_left
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname IN ('public', 'goldstar_private')
     AND has_function_privilege('anon', p.oid, 'EXECUTE')
     AND NOT (p.proname = ANY (allowed_functions))
     AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                      WHERE d.classid = 'pg_catalog.pg_proc'::regclass
                        AND d.objid = p.oid AND d.deptype = 'e');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'anon audit: anon can still execute: %', bad;
  END IF;
  IF foreign_left IS NOT NULL THEN
    RAISE NOTICE 'anon audit: executable by anon but owned by another role (revoke as that role): %', foreign_left;
  END IF;

  SELECT string_agg(format('%I.%I', n.nspname, c.relname), ', ') FILTER (WHERE pg_has_role(c.relowner, 'USAGE')),
         string_agg(format('%I.%I', n.nspname, c.relname), ', ') FILTER (WHERE NOT pg_has_role(c.relowner, 'USAGE'))
    INTO bad, foreign_left
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname IN ('public', 'goldstar_private')
     AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
     AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                      WHERE d.classid = 'pg_catalog.pg_class'::regclass
                        AND d.objid = c.oid AND d.deptype = 'e')
     AND CASE WHEN c.relkind = 'S'
              THEN has_sequence_privilege('anon', c.oid, 'USAGE,SELECT,UPDATE')
              ELSE has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') END;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'anon audit: anon still holds privileges on: %', bad;
  END IF;
  IF foreign_left IS NOT NULL THEN
    RAISE NOTICE 'anon audit: anon holds privileges on relations owned by another role: %', foreign_left;
  END IF;

  RAISE NOTICE 'anon audit passed';
END $$;
