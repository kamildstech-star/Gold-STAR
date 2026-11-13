// Run with: node supabase/tests/signed-document-folders.pglite.mjs <existing PGlite dist/index.js>
// In-memory fixtures only. No connection string, network access or live writes.
//
// Migration 20261027170000, READ FROM THE FILE, over the live shapes of
// documents (signed-row freeze policy + immutability trigger) and
// document_folders. can_manage_location is stubbed.
//
// What it proves:
//   1. An ordinary update cannot file a signed document (the bug: it changed
//      no row and said nothing).
//   2. move_document_to_folder files it — folder_id only — for its author or
//      an office manager, and refuses anyone else and a folder on another job.
//   3. Existing signed work authorizations land in one "Work Authorizations"
//      folder per job; an existing folder of that name is reused.
//   4. Re-runnable; anon cannot call it.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const db = new PGlite();
const AUTO = readFileSync(
  new URL("../migrations/20261027180000_work_authorization_auto_folder.sql", import.meta.url),
  "utf8",
);
const SQL = readFileSync(
  new URL("../migrations/20261027170000_signed_document_folders.sql", import.meta.url),
  "utf8",
);

let assertions = 0;
const check = (value, what) => {
  assert.equal(value, true, what);
  assertions++;
};

const loc = "10000000-0000-4000-8000-000000000001";
const author = "20000000-0000-4000-8000-000000000001";
const manager = "20000000-0000-4000-8000-000000000002";
const stranger = "20000000-0000-4000-8000-000000000003";
const job1 = "30000000-0000-4000-8000-000000000001";
const job2 = "30000000-0000-4000-8000-000000000002";
const wa1 = "40000000-0000-4000-8000-000000000001";
const wa2 = "40000000-0000-4000-8000-000000000002";
const wa3 = "40000000-0000-4000-8000-000000000003";
const other = "40000000-0000-4000-8000-000000000004";
const fJob2 = "50000000-0000-4000-8000-000000000002";

const as = async (user, sql, params) => {
  await db.exec(
    `SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub', '${user}', false);`,
  );
  try {
    return await db.query(sql, params);
  } finally {
    await db.exec("RESET ROLE;");
  }
};
const folderOf = async (id) =>
  (await db.query("SELECT folder_id FROM public.documents WHERE id = $1", [id])).rows[0].folder_id;

try {
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE SCHEMA auth;
    GRANT USAGE ON SCHEMA public, auth TO anon, authenticated;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
      $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE FUNCTION public.can_manage_location(_u uuid, _l uuid) RETURNS boolean
      LANGUAGE sql STABLE AS $$ SELECT _u = '${manager}'::uuid $$;
    CREATE FUNCTION public.can_view_location(_u uuid, _l uuid) RETURNS boolean
      LANGUAGE sql STABLE AS $$ SELECT _u IS NOT NULL $$;

    CREATE TABLE public.document_folders (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid NOT NULL,
      job_id uuid, account_id uuid, project_id uuid, parent_folder_id uuid,
      name text NOT NULL, sort_order integer NOT NULL DEFAULT 0, created_by uuid,
      created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE public.documents (
      id uuid PRIMARY KEY, location_id uuid NOT NULL, job_id uuid, account_id uuid, project_id uuid,
      doc_type text NOT NULL, status text NOT NULL, created_by uuid, folder_id uuid,
      content_hash text, locked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
    GRANT SELECT, UPDATE ON public.documents TO authenticated;
    GRANT SELECT ON public.document_folders TO authenticated;
    ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;
    CREATE POLICY documents_select ON public.documents FOR SELECT TO authenticated USING (true);
    CREATE POLICY documents_update ON public.documents FOR UPDATE TO authenticated
      USING (status <> 'signed' AND (public.can_manage_location(auth.uid(), location_id) OR created_by = auth.uid()));
    CREATE FUNCTION public.enforce_document_immutability() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.locked_at IS NULL THEN RETURN NEW; END IF;
      IF NEW.content_hash IS DISTINCT FROM OLD.content_hash OR NEW.locked_at IS DISTINCT FROM OLD.locked_at THEN
        RAISE EXCEPTION 'This document is signed and locked.';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER trg_documents_immutable BEFORE UPDATE ON public.documents
      FOR EACH ROW EXECUTE FUNCTION public.enforce_document_immutability();

    INSERT INTO public.document_folders (id, location_id, job_id, name)
      VALUES ('${fJob2}', '${loc}', '${job2}', 'work authorizations');
    INSERT INTO public.documents (id, location_id, job_id, account_id, doc_type, status, created_by, content_hash, locked_at) VALUES
      ('${wa1}', '${loc}', '${job1}', gen_random_uuid(), 'work_authorization', 'signed', '${author}', 'h1', now()),
      ('${wa2}', '${loc}', '${job1}', NULL, 'work_authorization', 'signed', '${author}', 'h2', now()),
      ('${wa3}', '${loc}', '${job2}', NULL, 'work_authorization', 'signed', '${author}', 'h3', now()),
      ('${other}', '${loc}', '${job1}', NULL, 'insurance', 'signed', '${author}', 'h4', now());
  `);

  // 1. The bug: an ordinary update of a signed row changes nothing, silently.
  const plain = await as(
    author,
    "UPDATE public.documents SET folder_id = $1 WHERE id = $2 RETURNING id",
    [fJob2, other],
  );
  check(plain.rows.length === 0, "an ordinary update cannot file a signed document");

  await db.exec(SQL);

  // 3. Backfill.
  const job1Folders = (
    await db.query("SELECT id, name FROM public.document_folders WHERE job_id = $1", [job1])
  ).rows;
  check(
    job1Folders.length === 1 && job1Folders[0].name === "Work Authorizations",
    "one Work Authorizations folder is made for job 1",
  );
  check((await folderOf(wa1)) === job1Folders[0].id, "job 1's first authorization is filed");
  check((await folderOf(wa2)) === job1Folders[0].id, "job 1's second authorization is filed");
  check((await folderOf(wa3)) === fJob2, "job 2 reuses its existing folder of that name");
  check((await folderOf(other)) === null, "other signed documents are left where they are");
  check(
    (await db.query("SELECT 1 FROM public.document_folders WHERE job_id = $1", [job2])).rows
      .length === 1,
    "no second folder on job 2",
  );
  check(
    (await db.query("SELECT locked_at IS NOT NULL AS l FROM public.documents WHERE id = $1", [wa1]))
      .rows[0].l,
    "the document stays signed and locked",
  );

  // 2. The function.
  const f1 = job1Folders[0].id;
  await as(author, "SELECT public.move_document_to_folder($1, $2)", [other, f1]);
  check((await folderOf(other)) === f1, "the author files a signed document");
  await as(manager, "SELECT public.move_document_to_folder($1, NULL)", [other]);
  check((await folderOf(other)) === null, "an office manager moves it back to the top level");
  await assert.rejects(
    as(stranger, "SELECT public.move_document_to_folder($1, $2)", [other, f1]),
    /cannot file/,
  );
  assertions++;
  await assert.rejects(
    as(author, "SELECT public.move_document_to_folder($1, $2)", [other, fJob2]),
    /not on this document/,
  );
  assertions++;
  check((await folderOf(other)) === null, "refused moves change nothing");

  // 4. Re-runnable, and closed to anon.
  await db.exec(SQL);
  check(
    (await db.query("SELECT 1 FROM public.document_folders")).rows.length === 2,
    "re-running makes no new folders",
  );
  const anon = (
    await db.query(
      "SELECT has_function_privilege('anon', 'public.move_document_to_folder(uuid, uuid)', 'EXECUTE') AS ok",
    )
  ).rows[0].ok;
  check(anon === false, "anon cannot call move_document_to_folder");

  // 5. 20261027180000: the database files them, whatever app version signed.
  const job3 = "30000000-0000-4000-8000-000000000003";
  const stray = "40000000-0000-4000-8000-000000000005";
  // Signed by an old client after 20261027170000: lands at the top level.
  await db.query(
    `INSERT INTO public.documents (id, location_id, job_id, doc_type, status, created_by)
     VALUES ($1, $2, $3, 'work_authorization', 'signed', $4)`,
    [stray, loc, job1, author],
  );
  check((await folderOf(stray)) === null, "before the trigger, an old client's signing is unfiled");
  await db.exec(AUTO);
  check((await folderOf(stray)) === f1, "the straggler is filed into the job's existing folder");
  const ins = async (id, job, type, folder = null) => {
    await db.query(
      `INSERT INTO public.documents (id, location_id, job_id, doc_type, status, created_by, folder_id)
       VALUES ($1, $2, $3, $4, 'pending_signature', $5, $6)`,
      [id, loc, job, type, author, folder],
    );
    return folderOf(id);
  };
  check(
    (await ins("40000000-0000-4000-8000-000000000006", job1, "work_authorization")) === f1,
    "a new work authorization with no folder goes into Work Authorizations",
  );
  const made = await ins("40000000-0000-4000-8000-000000000007", job3, "work_authorization");
  const job3Folders = (
    await db.query("SELECT id, name FROM public.document_folders WHERE job_id = $1", [job3])
  ).rows;
  check(
    job3Folders.length === 1 &&
      made === job3Folders[0].id &&
      job3Folders[0].name === "Work Authorizations",
    "a job with no folder gets one, made by the first",
  );
  check(
    (await ins("40000000-0000-4000-8000-000000000008", job1, "work_authorization", fJob2)) ===
      fJob2,
    "a folder the app chose is kept",
  );
  check(
    (await ins("40000000-0000-4000-8000-000000000009", job1, "insurance")) === null,
    "other documents are not filed",
  );
  check(
    (await ins("40000000-0000-4000-8000-00000000000a", null, "work_authorization")) === null,
    "an authorization with no job stays at the top level",
  );
  await db.exec(AUTO);
  check(
    (await db.query("SELECT 1 FROM public.document_folders")).rows.length === 3,
    "re-running makes no new folders",
  );
  const anonAuto = (
    await db.query(
      "SELECT has_function_privilege('authenticated', 'public.file_work_authorization()', 'EXECUTE') AS ok",
    )
  ).rows[0].ok;
  check(anonAuto === false, "nobody calls the filing function directly");

  console.log(`signed-document-folders.pglite: ${assertions} assertions passed`);
} finally {
  await db.close();
}
