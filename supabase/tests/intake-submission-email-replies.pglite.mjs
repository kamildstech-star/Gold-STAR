// Run with: node supabase/tests/intake-submission-email-replies.pglite.mjs <existing PGlite dist/index.js>
// In-memory fixtures only. The migration under test is READ FROM THE FILE.
//
// What it proves about 20261013121500:
//   1. it adds the source / source_* / field_review columns, every existing
//      row reads as source 'form' with an empty field_review, and it applies
//      twice;
//   2. source is 'form' or 'email_reply' only; field_review is an object;
//      the snippet is capped;
//   3. one suggestion per Graph message (a re-sync cannot file a second one),
//      while form rows (no message id) are unlimited;
//   4. an UPDATE — the review panel's per-field decisions — can change
//      field_review and status but never where the suggestion came from;
//   5. the job-scoped policies it found are untouched, the restrictive guards
//      are in place, anon holds nothing, and the trigger function is not
//      callable by signed-in users;
//   6. RLS still decides: a staff member who cannot manage the job cannot
//      write a decision on its suggestion.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const db = new PGlite();
const FILE = "20261013121500_intake_submission_email_replies.sql";
const migration = readFileSync(new URL("../migrations/" + FILE, import.meta.url), "utf8");

const MANAGER = "11111111-1111-4111-8111-111111111111";
const OUTSIDER = "22222222-2222-4222-8222-222222222222";
const JOB = "33333333-3333-4333-8333-333333333333";
const REQUEST = "44444444-4444-4444-8444-444444444444";

let assertions = 0;
const check = (value, what) => {
  assert.equal(value, true, what);
  assertions++;
};

try {
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    GRANT USAGE ON SCHEMA auth TO authenticated, anon;
    CREATE SCHEMA goldstar_private;
    GRANT USAGE ON SCHEMA goldstar_private TO authenticated;
    CREATE FUNCTION goldstar_private.profile_is_active(uuid) RETURNS boolean
      LANGUAGE sql STABLE AS $$ SELECT $1 IS NOT NULL $$;
    CREATE FUNCTION public.can_view_job(_u uuid, _j uuid) RETURNS boolean
      LANGUAGE sql STABLE AS $$ SELECT _u IS NOT NULL $$;
    CREATE FUNCTION public.can_manage_job(_u uuid, _j uuid) RETURNS boolean
      LANGUAGE sql STABLE AS $$ SELECT _u = '${MANAGER}'::uuid $$;

    CREATE TABLE public.intake_requests (id uuid PRIMARY KEY);
    INSERT INTO public.intake_requests VALUES ('${REQUEST}');
    CREATE TABLE public.intake_submissions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      request_id uuid NOT NULL REFERENCES public.intake_requests(id),
      job_id uuid,
      submitted_by_name text,
      submitted_by_email text,
      answers jsonb NOT NULL DEFAULT '{}'::jsonb,
      fields jsonb NOT NULL DEFAULT '{}'::jsonb,
      status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','dismissed')),
      reviewed_by uuid,
      reviewed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.intake_submissions TO authenticated;
    GRANT ALL ON public.intake_submissions TO service_role;
    ALTER TABLE public.intake_submissions ENABLE ROW LEVEL SECURITY;
    CREATE POLICY intake_submissions_select ON public.intake_submissions FOR SELECT TO authenticated
      USING (public.can_view_job((SELECT auth.uid()), job_id));
    CREATE POLICY intake_submissions_write ON public.intake_submissions FOR ALL TO authenticated
      USING (public.can_manage_job((SELECT auth.uid()), job_id))
      WITH CHECK (public.can_manage_job((SELECT auth.uid()), job_id));

    INSERT INTO public.intake_submissions (request_id, job_id, fields)
      VALUES ('${REQUEST}', '${JOB}', '{"loss_date":"2026-10-03"}');
  `);

  const jobPolicies = async () =>
    JSON.stringify(
      (
        await db.query(
          `SELECT policyname, permissive, cmd, qual, with_check FROM pg_policies
            WHERE tablename = 'intake_submissions'
              AND policyname LIKE 'intake_submissions_%' ORDER BY 1`,
        )
      ).rows,
    );
  const before = await jobPolicies();

  await db.exec(migration);
  await db.exec(migration);
  check(true, "applies twice");

  // 1. Existing rows ------------------------------------------------------
  const old = await db.query(
    `SELECT source, field_review, source_message_id FROM public.intake_submissions`,
  );
  check(old.rows[0].source === "form", "an existing row reads as a form submission");
  check(JSON.stringify(old.rows[0].field_review) === "{}", "with no field decisions yet");
  check(old.rows[0].source_message_id === null, "and no message id");

  // 2. Shape --------------------------------------------------------------
  const insertReply = (messageId) =>
    db.exec(`INSERT INTO public.intake_submissions
      (request_id, job_id, source, source_message_id, source_subject, source_excerpt, fields)
      VALUES ('${REQUEST}', '${JOB}', 'email_reply', '${messageId}',
              'RE: Request for information', 'Date of loss: 10/3', '{"loss_date":"2026-10-03"}')`);

  await insertReply("graph-1");
  check(true, "an email_reply suggestion inserts");
  await assert.rejects(
    db.exec(`INSERT INTO public.intake_submissions (request_id, job_id, source)
      VALUES ('${REQUEST}', '${JOB}', 'sms')`),
    /intake_submissions_source_check/,
  );
  assertions++;
  await assert.rejects(
    db.exec(`INSERT INTO public.intake_submissions (request_id, job_id, field_review)
      VALUES ('${REQUEST}', '${JOB}', '[]')`),
    /intake_submissions_field_review_check/,
  );
  assertions++;
  await assert.rejects(
    db.exec(`INSERT INTO public.intake_submissions (request_id, job_id, source, source_excerpt)
      VALUES ('${REQUEST}', '${JOB}', 'email_reply', repeat('x', 4001))`),
    /intake_submissions_source_text_check/,
  );
  assertions++;

  // 3. One per message ----------------------------------------------------
  await assert.rejects(
    insertReply("graph-1"),
    /intake_submissions_source_message_uniq|duplicate key/,
  );
  assertions++;
  await db.exec(`INSERT INTO public.intake_submissions (request_id, job_id) VALUES ('${REQUEST}', '${JOB}');
                 INSERT INTO public.intake_submissions (request_id, job_id) VALUES ('${REQUEST}', '${JOB}');`);
  check(true, "form rows without a message id are not limited");

  // 4 + 6. Decisions through RLS -------------------------------------------
  await db.exec(
    `SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub', '${MANAGER}', false);`,
  );
  await db.exec(`UPDATE public.intake_submissions
      SET field_review = '{"f:loss_date":{"status":"applied","value":"2026-10-03"}}',
          status = 'applied',
          source = 'form', source_message_id = 'forged', source_excerpt = 'forged', source_subject = 'forged'
      WHERE source_message_id = 'graph-1'`);
  await db.exec(`RESET ROLE`);
  const decided = await db.query(
    `SELECT status, field_review, source, source_message_id, source_excerpt, source_subject
       FROM public.intake_submissions WHERE source_message_id = 'graph-1'`,
  );
  check(decided.rows.length === 1, "the suggestion keeps its message id");
  check(decided.rows[0].status === "applied", "the manager closed it");
  check(
    decided.rows[0].field_review["f:loss_date"].status === "applied",
    "and stored the per-field decision",
  );
  check(
    decided.rows[0].source === "email_reply" &&
      decided.rows[0].source_excerpt === "Date of loss: 10/3" &&
      decided.rows[0].source_subject === "RE: Request for information",
    "but could not rewrite where it came from",
  );

  await db.exec(
    `SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub', '${OUTSIDER}', false);`,
  );
  const outsider = await db.query(`UPDATE public.intake_submissions SET status = 'dismissed'
      WHERE source_message_id = 'graph-1' RETURNING id`);
  await db.exec(`RESET ROLE`);
  check(outsider.rows.length === 0, "someone who cannot manage the job cannot decide for it");

  // 5. Grants and guards ---------------------------------------------------
  check((await jobPolicies()) === before, "the job-scoped policies are untouched");
  const guards = await db.query(
    `SELECT policyname, permissive, roles::text FROM pg_policies
      WHERE tablename = 'intake_submissions'
        AND policyname IN ('active_profile_required', 'anonymous_business_access_denied')
      ORDER BY 1`,
  );
  check(
    guards.rows.length === 2 && guards.rows.every((r) => r.permissive === "RESTRICTIVE"),
    "both restrictive guards are in place",
  );
  const anon = await db.query(
    `SELECT privilege_type FROM information_schema.role_table_grants
      WHERE table_name = 'intake_submissions' AND grantee = 'anon'`,
  );
  check(anon.rows.length === 0, "anon holds nothing on intake_submissions");
  const fn = await db.query(
    `SELECT has_function_privilege('authenticated', 'public.tg_intake_submissions_keep_source()', 'EXECUTE') AS can`,
  );
  check(fn.rows[0].can === false, "the trigger function is not callable by signed-in users");

  console.log(`intake-submission-email-replies.pglite: ${assertions} assertions passed`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await db.close();
}
