// Run with: node supabase/tests/auth-security.pglite.mjs <existing PGlite dist/index.js>
// In-memory fixtures only. No connection string, network access or live writes.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const db = new PGlite();
const migration = (name) => readFileSync(new URL('../migrations/' + name, import.meta.url), 'utf8');
const admin = '00000000-0000-0000-0000-000000000001';
const target = '00000000-0000-0000-0000-000000000002';
const nonAdmin = '00000000-0000-0000-0000-000000000003';
let assertions = 0;
const check = (value) => { assert.equal(value, true); assertions++; };
try {
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
    CREATE TYPE public.app_role AS ENUM ('admin','owner','dev','crew');
    CREATE TABLE public.user_roles (user_id uuid, role public.app_role);
    INSERT INTO public.user_roles VALUES ('${admin}', 'admin');
    CREATE TABLE public.profiles (user_id uuid PRIMARY KEY, is_active boolean, approval_status text);
    INSERT INTO public.profiles VALUES ('${admin}', true, 'approved');
    GRANT SELECT ON public.profiles TO authenticated;
    CREATE FUNCTION public.is_privileged(_user_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
      SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id=_user_id AND role IN ('admin','owner','dev')) $$;
    CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
      SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id=_user_id AND role=_role) $$;
    CREATE TABLE public.permissions (key text PRIMARY KEY);
    INSERT INTO public.permissions VALUES ('job.view_costs');
    CREATE TABLE public.locations (id uuid PRIMARY KEY);
    CREATE TABLE public.regions (id uuid PRIMARY KEY);
  `);
  const original = migration('20260810223820_db63c2de-4d4b-4c26-bc0c-7e1ef9fafaef.sql');
  // Use the real table, constraints, grants and RLS from the repository.
  await db.exec(original.slice(original.indexOf('-- 3. Per-user overrides'), original.indexOf('-- updated_at triggers')));
  const atomic = migration('20260908010611_atomic_permission_override.sql');
  await db.exec(atomic);
  await db.exec(atomic); // replay does not widen grants or discard data
  const asUser = async (uid, sql) => {
    await db.exec(`SET ROLE authenticated; SET request.jwt.claim.sub = '${uid}';`);
    try { return await db.query(sql); } finally { await db.exec('RESET ROLE'); }
  };
  const call = (effect, location = 'NULL') => `SELECT public.replace_user_permission('${target}', 'job.view_costs', '${effect}', ${location})`;
  await asUser(admin, call('revoke'));
  let rows = (await db.query('SELECT * FROM public.user_permissions')).rows;
  check(rows.length === 1 && rows[0].effect === 'revoke' && rows[0].granted_by === admin);
  const oldId = rows[0].id;
  await assert.rejects(asUser(admin, call('grant', "'00000000-0000-0000-0000-000000000099'")), /foreign key/i); assertions++;
  rows = (await db.query('SELECT * FROM public.user_permissions')).rows;
  check(rows.length === 1 && rows[0].id === oldId && rows[0].effect === 'revoke');
  await assert.rejects(asUser(nonAdmin, call('grant')), /Only an owner/i); assertions++;
  check((await db.query('SELECT effect FROM public.user_permissions')).rows[0].effect === 'revoke');
  await asUser(admin, call('grant'));
  check((await db.query('SELECT effect FROM public.user_permissions')).rows[0].effect === 'grant');
  await db.exec(`UPDATE public.profiles SET is_active=false WHERE user_id='${admin}'`);
  await assert.rejects(asUser(admin, call('revoke')), /not approved or active/i); assertions++;
  check((await db.query('SELECT effect FROM public.user_permissions')).rows[0].effect === 'grant');
  await db.exec(`UPDATE public.profiles SET is_active=true WHERE user_id='${admin}'`);
  await assert.rejects(asUser(admin, call('bogus')), /Invalid permission/i); assertions++;
  check((await db.query('SELECT effect FROM public.user_permissions')).rows[0].effect === 'grant');
  await db.exec('SET ROLE anon');
  await assert.rejects(db.query(call('grant')), /permission denied/i); assertions++;
  await db.exec('RESET ROLE');
  // Representative definer callers isolate ACL behavior from commission math.
  await db.exec(`
    CREATE TABLE public.payout_probe (id int);
    CREATE FUNCTION public.compute_job_commissions(uuid) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$ BEGIN INSERT INTO payout_probe VALUES (1); RETURN 1; END $$;
    CREATE FUNCTION public.jobs_commission_sync() RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$ SELECT compute_job_commissions(NULL) $$;
    CREATE FUNCTION public.recompute_all_commissions() RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$ BEGIN IF NOT is_privileged(auth.uid()) THEN RAISE EXCEPTION 'denied'; END IF; RETURN compute_job_commissions(NULL); END $$;
    GRANT EXECUTE ON FUNCTION public.compute_job_commissions(uuid) TO authenticated;
  `);
  await asUser(nonAdmin, 'SELECT compute_job_commissions(NULL)');
  check((await db.query('SELECT count(*)::int AS n FROM payout_probe')).rows[0].n === 1);
  await db.exec(migration('20260908010058_restrict_internal_commission_rpc.sql'));
  await db.exec(migration('20260908010058_restrict_internal_commission_rpc.sql'));
  await assert.rejects(asUser(nonAdmin, 'SELECT compute_job_commissions(NULL)'), /permission denied/i); assertions++;
  const checks = await db.exec(readFileSync(new URL('./commission_rpc_grants.sql', import.meta.url), 'utf8'));
  for (const row of checks[0].rows) check(Object.values(row).every(Boolean));
  for (const row of checks[1].rows) check(row.internal_call_allowed);
  await asUser(admin, 'SELECT recompute_all_commissions()');
  check((await db.query('SELECT count(*)::int AS n FROM payout_probe')).rows[0].n === 2);
  // Status migration: permissive baseline policies deliberately allow reads
  // and writes; restrictive guards must win regardless of those old policies.
  const statusSql = migration('20260908013000_active_profile_access_guard.sql');
  const allowlist = statusSql.match(/FOREACH table_name IN ARRAY ARRAY\[([\s\S]*?)\]/)[1].match(/'([^']+)'/g).map((s) => s.slice(1, -1));
  await db.exec(`
    CREATE TABLE public.location_members (user_id uuid, location_id uuid);
    CREATE TABLE public.region_members (user_id uuid, region_id uuid);
    CREATE TABLE public.location_regions (location_id uuid, region_id uuid);
    CREATE TABLE public.role_permissions (role public.app_role, permission_key text);
    CREATE SCHEMA storage; CREATE TABLE storage.objects (id uuid DEFAULT gen_random_uuid());
    ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
    CREATE POLICY baseline ON storage.objects FOR ALL TO authenticated USING (true) WITH CHECK (true);
    GRANT USAGE ON SCHEMA storage TO authenticated, service_role;
    GRANT ALL ON storage.objects TO authenticated, service_role;
    ALTER ROLE service_role BYPASSRLS;
    ALTER TABLE public.profiles ADD COLUMN email text, ADD COLUMN full_name text;
    ALTER TABLE public.profiles ALTER COLUMN is_active SET DEFAULT true, ALTER COLUMN approval_status SET DEFAULT 'pending';
    GRANT ALL ON public.profiles TO authenticated, service_role;
    CREATE POLICY baseline ON public.profiles FOR ALL TO authenticated USING (true) WITH CHECK (true);
  `);
  for (const name of allowlist) {
    await db.exec(`CREATE TABLE IF NOT EXISTS public.${name} (id uuid DEFAULT gen_random_uuid());
      GRANT ALL ON public.${name} TO authenticated, anon, service_role;
      CREATE POLICY status_fixture_baseline ON public.${name} FOR ALL TO authenticated, anon USING (true) WITH CHECK (true);`);
  }
  await db.exec(`INSERT INTO public.jobs DEFAULT VALUES; INSERT INTO storage.objects DEFAULT VALUES;
    INSERT INTO public.profiles(user_id,is_active,approval_status) VALUES ('${target}',true,'pending'),('${nonAdmin}',true,'approved');
    INSERT INTO public.user_roles VALUES ('${target}','admin'),('${nonAdmin}','crew');
    INSERT INTO public.location_members VALUES ('${target}','${target}'),('${nonAdmin}','${target}');
    INSERT INTO public.role_permissions VALUES ('admin','job.view_costs');`);
  await db.exec(statusSql);
  await db.exec(statusSql);
  check((await asUser(admin, 'SELECT * FROM public.jobs')).rows.length === 1);
  check((await asUser(nonAdmin, 'SELECT * FROM public.jobs')).rows.length === 1);
  check((await asUser(target, 'SELECT * FROM public.jobs')).rows.length === 0);
  check((await asUser(target, 'SELECT * FROM public.profiles')).rows.length === 1);
  check((await asUser(target, `SELECT public.is_privileged('${target}') AS ok`)).rows[0].ok === false);
  check((await asUser(target, `SELECT public.has_permission('${target}','job.view_costs') AS ok`)).rows[0].ok === false);
  await assert.rejects(asUser(target, 'INSERT INTO public.jobs DEFAULT VALUES'), /row-level security/i); assertions++;
  // Restrictive UPDATE USING hides the pending row rather than allowing it to
  // be promoted. Assert the stored status, not merely the API's lack of error.
  await asUser(target, `UPDATE public.profiles SET approval_status='approved' WHERE user_id='${target}'`);
  check((await db.query(`SELECT approval_status FROM profiles WHERE user_id='${target}'`)).rows[0].approval_status === 'pending');
  await db.exec(`UPDATE public.profiles SET is_active=false WHERE user_id='${admin}'`);
  check((await asUser(admin, 'SELECT * FROM public.jobs')).rows.length === 0);
  check((await asUser(admin, 'SELECT * FROM storage.objects')).rows.length === 0);
  check((await asUser(admin, `SELECT public.is_privileged('${admin}') AS ok`)).rows[0].ok === false);
  await asUser(admin, 'DELETE FROM public.jobs');
  check((await db.query('SELECT * FROM public.jobs')).rows.length === 1);
  await assert.rejects(asUser(admin, 'INSERT INTO storage.objects DEFAULT VALUES'), /row-level security/i); assertions++;
  await db.exec(`UPDATE profiles SET is_active=true WHERE user_id='${admin}'`);
  await asUser(admin, 'INSERT INTO public.jobs DEFAULT VALUES');
  check((await db.query('SELECT * FROM public.jobs')).rows.length === 2);
  for (const helper of [`has_role('${target}','admin')`, `has_role_text('${target}','admin')`, `has_any_role_text('${target}',ARRAY['admin'])`, `is_member_of('${target}','${target}')`, `is_regional_for('${target}','${target}')`]) {
    check((await asUser(target, `SELECT public.${helper} AS ok`)).rows[0].ok === false);
  }
  await db.exec('SET ROLE anon');
  check((await db.query('SELECT * FROM public.jobs')).rows.length === 0);
  await db.exec('RESET ROLE; SET ROLE service_role');
  check((await db.query('SELECT * FROM public.jobs')).rows.length === 2);
  await db.query('INSERT INTO public.jobs DEFAULT VALUES');
  check((await db.query('SELECT * FROM public.jobs')).rows.length === 3);
  await db.exec('RESET ROLE');
  // The repository's actual signup trigger still creates a pending profile
  // despite the new client INSERT guard. Notifications are best-effort in it.
  await db.exec('CREATE TABLE auth.users(id uuid, email text, raw_user_meta_data jsonb)');
  const signup = migration('20260813171512_a33652c0-d9c8-44f3-8713-6b9cf6bca423.sql').match(/CREATE OR REPLACE FUNCTION public.handle_new_user\(\)[\s\S]*?\$function\$;/)[0];
  await db.exec(signup);
  await db.exec(`CREATE TRIGGER signup AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
    INSERT INTO auth.users VALUES ('00000000-0000-0000-0000-000000000004','new@example.test','{}');`);
  check((await asUser('00000000-0000-0000-0000-000000000004', 'SELECT * FROM profiles')).rows.length === 1);
  console.log(`${assertions} PostgreSQL role/rollback/ACL/status/bootstrap checks passed (in-memory fixtures; not deployed).`);
} finally { await db.close(); }
