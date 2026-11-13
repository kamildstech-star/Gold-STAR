// Run with: node supabase/tests/job-create-grant.pglite.mjs <existing PGlite dist/index.js>
// In-memory fixtures only. No connection string, network access or live writes.
//
// REGRESSION TEST for the job-creation path, which has now failed twice for
// two different reasons. It walks the whole path in order:
//
//   1. permission denied for function next_job_number (42501) — the trigger
//      ran as the caller, who had no EXECUTE.        fixed by 20260914090000
//   2. column reference "scope_key" is ambiguous — a PL/pgSQL local shares a
//      name with the column it inserts into.         fixed by 20260914100000
//
// Fault 2 hid behind fault 1: nothing could reach the numbering function at
// all until the first fix landed.
//
// BOTH BRANCHES OF next_job_number() ARE EXERCISED, and that is the point. The
// ambiguous statement only runs when `job_number_settings` HAS a row; with the
// table empty the function returns early and the bug is invisible. An earlier
// version of this file tested only the empty branch and passed against a
// broken function. Phases 2 and 3 below are that lesson.
//
// The function bodies under test are READ FROM THE MIGRATION FILES, never
// retyped here, so this cannot drift from what ships.
//
// POSTGIS IS STUBBED. PGlite has no PostGIS and the jobs trigger derives `geom`
// from lat/lon. Nothing under test depends on it — the rows carry no
// coordinates, so the stubbed branch is not even taken.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const db = new PGlite();
const migration = (name) => readFileSync(new URL('../migrations/' + name, import.meta.url), 'utf8');

let assertions = 0;
const check = (value, what) => { assert.equal(value, true, what); assertions++; };

/** Pull one function definition out of a migration, so nothing is retyped. */
function functionFrom(file, signature) {
  const sql = migration(file);
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION ${signature}`);
  assert.notEqual(start, -1, `${signature} not found in ${file}`);
  const end = sql.indexOf('END $$;', start);
  assert.notEqual(end, -1, `end of ${signature} not found in ${file}`);
  return sql.slice(start, end + 'END $$;'.length);
}

const ORIGINAL = '20260805193344_cbbbc26a-7073-477b-90e7-aaae58635dca.sql';
/** As shipped before either fix: invoker trigger, ambiguous numbering function. */
const BEFORE_TRIGGER = functionFrom(ORIGINAL, 'public.jobs_before_write()');
const BEFORE_NUMBER = functionFrom(ORIGINAL, 'public.next_job_number()');

try {
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

    -- PostGIS stand-ins (see header).
    CREATE DOMAIN public.geography AS text;
    CREATE FUNCTION public.ST_MakePoint(float8, float8) RETURNS text
      LANGUAGE sql IMMUTABLE AS $$ SELECT 'POINT(' || $1 || ' ' || $2 || ')' $$;
    CREATE FUNCTION public.ST_SetSRID(text, int) RETURNS text
      LANGUAGE sql IMMUTABLE AS $$ SELECT $1 $$;

    -- The numbering tables, column for column as 20260805193344 defines them.
    CREATE TABLE public.job_number_settings (
      id boolean PRIMARY KEY DEFAULT true CHECK (id),
      prefix text NOT NULL DEFAULT '',
      pattern text NOT NULL DEFAULT '{YY}{MM}{DD}{SEQ}',
      seq_padding integer NOT NULL DEFAULT 1 CHECK (seq_padding BETWEEN 1 AND 8),
      seq_scope text NOT NULL DEFAULT 'daily' CHECK (seq_scope IN ('daily','monthly','yearly','global')),
      updated_by uuid,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE public.job_number_counters (
      scope_key text PRIMARY KEY,
      last_value integer NOT NULL DEFAULT 0
    );
    CREATE SEQUENCE public.jobs_number_seq;

    CREATE TABLE public.jobs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      job_number text,
      location_id uuid,
      address text,
      lat double precision,
      lon double precision,
      geom public.geography,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    GRANT SELECT, INSERT, UPDATE ON public.jobs TO authenticated;
  `);

  await db.exec(BEFORE_NUMBER);
  await db.exec(BEFORE_TRIGGER);
  await db.exec(`
    -- THE GRANT STATE UNDER TEST: revoked exactly as 20260806223501 and
    -- 20260818170611 leave it. Nothing grants it back, here or in either fix.
    REVOKE ALL ON FUNCTION public.next_job_number() FROM PUBLIC, anon, authenticated;
    DROP TRIGGER IF EXISTS trg_jobs_before_write ON public.jobs;
    CREATE TRIGGER trg_jobs_before_write BEFORE INSERT OR UPDATE ON public.jobs
      FOR EACH ROW EXECUTE FUNCTION public.jobs_before_write();
  `);

  const asAuthenticated = async (sql) => {
    await db.exec('SET ROLE authenticated;');
    try { return await db.query(sql); } finally { await db.exec('RESET ROLE'); }
  };
  const insert = `INSERT INTO public.jobs (address) VALUES ('1 QA Test Street') RETURNING job_number`;
  const jobCount = async () =>
    (await db.query('SELECT count(*)::int AS n FROM public.jobs')).rows[0].n;

  /* ---- PHASE 1: fault 1, the missing EXECUTE grant -------------------- */
  await assert.rejects(
    asAuthenticated(insert),
    /permission denied for function next_job_number/i,
    'a non-service role should be blocked before 20260914090000',
  );
  assertions++;
  check(await jobCount() === 0, 'no job row should exist after the refused insert');

  /* ---- PHASE 2: fix 1 applied. Empty settings -> the EARLY branch ----- */
  await db.exec(migration('20260914090000_jobs_before_write_security_definer.sql'));

  const early = await asAuthenticated(insert);
  check(/^GS-\d{4}-\d{5}$/.test(early.rows[0].job_number),
    `empty settings should give GS-YYYY-NNNNN, got ${early.rows[0].job_number}`);
  check(await jobCount() === 1, 'exactly one job row should exist');

  // This is as far as the first version of this test went — and the function
  // was already broken for any database with a settings row.

  /* ---- PHASE 3: fault 2, reached only once settings exist ------------- */
  await db.exec(`
    INSERT INTO public.job_number_settings (id, prefix, pattern, seq_padding, seq_scope)
    VALUES (true, 'GS-', '{YYYY}-{SEQ}', 5, 'yearly');
  `);

  await assert.rejects(
    asAuthenticated(insert),
    /scope_key.*ambiguous/i,
    'with a settings row the ON CONFLICT path must expose the ambiguity',
  );
  assertions++;
  check(await jobCount() === 1, 'the failed insert must not have written a job row');
  check((await db.query('SELECT count(*)::int AS n FROM public.job_number_counters')).rows[0].n === 0,
    'a failed allocation must not leave a counter row behind');

  /* ---- PHASE 4: fix 2 applied ---------------------------------------- */
  await db.exec(migration('20260914100000_next_job_number_scope_key_ambiguous.sql'));

  const first = await asAuthenticated(insert);
  const year = new Date().getUTCFullYear();
  check(first.rows[0].job_number === `GS-${year}-00001`,
    `expected GS-${year}-00001, got ${first.rows[0].job_number}`);
  check(/^GS-\d{4}-\d{5}$/.test(first.rows[0].job_number),
    'the configured pattern should still read as GS-YYYY-NNNNN');

  const second = await asAuthenticated(insert);
  check(second.rows[0].job_number === `GS-${year}-00002`,
    `a second insert should increment, got ${second.rows[0].job_number}`);
  check((await db.query('SELECT last_value FROM public.job_number_counters')).rows[0].last_value === 2,
    'the counter should hold 2 after two allocations');
  check(await jobCount() === 3, 'three jobs should now exist');

  /* ---- PHASE 5: the guarantees that are easy to undo by accident ------ */
  await assert.rejects(
    asAuthenticated('SELECT public.next_job_number()'),
    /permission denied for function next_job_number/i,
    'end users must still not be able to burn job numbers directly',
  );
  assertions++;
  for (const role of ['anon', 'authenticated']) {
    check(
      (await db.query(
        `SELECT has_function_privilege('${role}', 'public.next_job_number()', 'EXECUTE') AS ok`,
      )).rows[0].ok === false,
      `${role} must not hold EXECUTE on next_job_number()`,
    );
  }

  check((await db.query(`
    SELECT count(*)::int AS n FROM pg_trigger
     WHERE tgrelid = 'public.jobs'::regclass AND NOT tgisinternal
       AND tgname = 'trg_jobs_before_write'`)).rows[0].n === 1,
    'the trigger binding should survive CREATE OR REPLACE');

  await assert.rejects(
    asAuthenticated(`UPDATE public.jobs SET job_number = 'GS-0000-00000'`),
    /job_number is immutable once assigned/i,
    'the UPDATE guard must still be in force',
  );
  assertions++;

  /* The ON CONFLICT target must still be the COLUMN, not a variable. */
  const src = (await db.query(
    `SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname='public' AND p.proname='next_job_number'`)).rows[0].prosrc;
  check(src.includes('ON CONFLICT (scope_key)'),
    'ON CONFLICT must still name the column');
  check(/\bv_scope_key\s+text;/.test(src) && !/^\s*scope_key\s+text;/m.test(src),
    'the local must be v_scope_key, with no scope_key local left');

  /* ---- Re-runnable ---------------------------------------------------- */
  await db.exec(migration('20260914090000_jobs_before_write_security_definer.sql'));
  await db.exec(migration('20260914100000_next_job_number_scope_key_ambiguous.sql'));
  const third = await asAuthenticated(insert);
  check(third.rows[0].job_number === `GS-${year}-00003`,
    'a replay of both migrations must leave numbering working and advancing');
  check((await db.query(
    `SELECT has_function_privilege('authenticated', 'public.next_job_number()', 'EXECUTE') AS ok`,
  )).rows[0].ok === false, 'a replay must not widen the grant');

  console.log(`job-create-grant.pglite: ${assertions} assertions passed`);
} finally {
  await db.close();
}
