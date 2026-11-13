// Run with: node supabase/tests/job-photo-day-counts.pglite.mjs <existing PGlite dist/index.js>
// In-memory fixtures only. No connection string, network access or live writes.
//
// `job_photo_day_counts` is what the job Pictures tab's headers print — the
// tab badge, "All photos", each room, each day — now that the photos
// themselves are paged and the loaded rows can no longer be the count. The
// migration under test is READ FROM THE FILE, never retyped here.
//
// What it proves:
//   1. album photos are counted per folder per day, in the zone asked for:
//      a photo taken at 02:30 UTC is on the previous day in New York;
//   2. a photo with no capture time counts on its upload day;
//   3. soft-deleted photos, and photos on another job, are not counted;
//   4. image documents count, except payment evidence, non-images, and rows
//      with no stored file — the page's own rules;
//   5. it runs as the caller: a user RLS keeps out of the project gets no
//      album rows, so it can never count a photo the caller could not open;
//   6. anon cannot execute it; authenticated can;
//   7. an unknown time zone raises (the page then falls back), it does not
//      silently count UTC days;
//   8. the keyset index exists with the order the page reads in.
//
// The surrounding tables are stubs with only the columns the function reads.
// auth.uid() reads a session setting, the way the other fixtures here do it.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const db = new PGlite();
const migration = (name) => readFileSync(new URL("../migrations/" + name, import.meta.url), "utf8");

let assertions = 0;
const check = (value, what) => {
  assert.equal(value, true, what);
  assertions++;
};

const crew = "11111111-1111-4111-8111-111111111111";
const stranger = "22222222-2222-4222-8222-222222222222";
const job = "88888888-8888-4888-8888-888888888888";
const otherJob = "99999999-9999-4999-8999-999999999999";
const album = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const scene = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const elsewhere = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const kitchen = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

try {
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth;
    GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;

    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
      $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

    CREATE TABLE public.projects (id uuid PRIMARY KEY, job_id uuid);
    CREATE TABLE public.project_members (project_id uuid, user_id uuid);
    CREATE TABLE public.photos (
      id text PRIMARY KEY,
      project_id uuid NOT NULL,
      folder_id uuid,
      captured_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    );
    CREATE TABLE public.documents (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      job_id uuid,
      mime text,
      doc_type text NOT NULL DEFAULT 'other',
      storage_bucket text,
      storage_path text,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    -- Stand-in for can_view_project: a member of the project sees it.
    ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.photos ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;
    CREATE POLICY see_projects ON public.projects FOR SELECT TO authenticated
      USING (EXISTS (SELECT 1 FROM public.project_members m
                      WHERE m.project_id = id AND m.user_id = auth.uid()));
    CREATE POLICY see_photos ON public.photos FOR SELECT TO authenticated
      USING (EXISTS (SELECT 1 FROM public.project_members m
                      WHERE m.project_id = photos.project_id AND m.user_id = auth.uid()));
    CREATE POLICY see_documents ON public.documents FOR SELECT TO authenticated USING (true);
    GRANT SELECT ON public.projects, public.project_members, public.photos, public.documents
      TO authenticated;

    INSERT INTO public.projects VALUES ('${album}', '${job}'), ('${scene}', '${job}'),
                                       ('${elsewhere}', '${otherJob}');
    INSERT INTO public.project_members VALUES ('${album}', '${crew}'), ('${scene}', '${crew}'),
                                              ('${elsewhere}', '${crew}');

    INSERT INTO public.photos (id, project_id, folder_id, captured_at, created_at, deleted_at) VALUES
      -- Kitchen, 5 Oct in UTC but 4 Oct in New York (02:30Z = 22:30 EDT the night before)
      ('p1', '${album}', '${kitchen}', '2026-10-05T02:30:00Z', '2026-10-05T03:00:00Z', NULL),
      ('p2', '${album}', '${kitchen}', '2026-10-05T15:00:00Z', '2026-10-05T15:05:00Z', NULL),
      -- unfiled, from the chaser's scene album
      ('p3', '${scene}', NULL, '2026-10-05T16:00:00Z', '2026-10-05T16:01:00Z', NULL),
      -- no capture time: counts on the upload day
      ('p4', '${scene}', NULL, NULL, '2026-10-06T12:00:00Z', NULL),
      -- removed from the job: not counted
      ('p5', '${album}', '${kitchen}', '2026-10-05T15:30:00Z', '2026-10-05T15:31:00Z', '2026-10-05T18:00:00Z'),
      -- another job entirely
      ('p6', '${elsewhere}', NULL, '2026-10-05T15:00:00Z', '2026-10-05T15:00:00Z', NULL);

    INSERT INTO public.documents (job_id, mime, doc_type, storage_bucket, storage_path, created_at) VALUES
      ('${job}', 'image/jpeg', 'other',  'documents', 'a.jpg', '2026-10-05T14:00:00Z'),
      -- a photographed cheque: payment evidence, never a gallery tile
      ('${job}', 'image/jpeg', 'carrier_correspondence', 'documents', 'cheque.jpg', '2026-10-05T14:00:00Z'),
      ('${job}', 'application/pdf', 'other', 'documents', 'scope.pdf', '2026-10-05T14:00:00Z'),
      ('${job}', 'image/png', 'other', 'documents', NULL, '2026-10-05T14:00:00Z'),
      ('${otherJob}', 'image/jpeg', 'other', 'documents', 'b.jpg', '2026-10-05T14:00:00Z');
  `);

  // The function is created by superuser in production too; then the grants decide.
  await db.exec(migration("20261005191500_job_photo_day_counts.sql"));

  const asUser = async (user, sql, params = []) => {
    await db.exec(
      `SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub', '${user}', false);`,
    );
    try {
      return (await db.query(sql, params)).rows;
    } finally {
      await db.exec(`RESET ROLE;`);
    }
  };
  const key = (r) => `${r.source}|${r.folder_id ?? "-"}|${String(r.day).slice(0, 10)}|${r.n}`;
  const dayOf = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

  /* 1–4: New York */
  const ny = await asUser(crew, `SELECT * FROM public.job_photo_day_counts($1, $2)`, [
    job,
    "America/New_York",
  ]);
  const nyKeys = new Set(
    ny.map((r) => `${r.source}|${r.folder_id ?? "-"}|${dayOf(r.day)}|${Number(r.n)}`),
  );
  check(nyKeys.has(`album|${kitchen}|2026-10-04|1`), "02:30Z is the 4th in New York");
  check(nyKeys.has(`album|${kitchen}|2026-10-05|1`), "15:00Z is the 5th in New York");
  check(nyKeys.has(`album|-|2026-10-05|1`), "the unfiled scene-album photo is counted");
  check(nyKeys.has(`album|-|2026-10-06|1`), "no capture time counts on the upload day");
  check(nyKeys.has(`document|-|2026-10-05|1`), "one image document counts");
  const total = ny.reduce((s, r) => s + Number(r.n), 0);
  check(total === 5, `four live album photos and one document, got ${total} (${ny.map(key)})`);

  /* 1 again: UTC puts both kitchen photos on the 5th */
  const utc = await asUser(crew, `SELECT * FROM public.job_photo_day_counts($1, 'UTC')`, [job]);
  const kitchenUtc = utc.filter((r) => r.folder_id === kitchen);
  check(
    kitchenUtc.length === 1 &&
      Number(kitchenUtc[0].n) === 2 &&
      dayOf(kitchenUtc[0].day) === "2026-10-05",
    "in UTC both kitchen photos are on the 5th",
  );

  /* 5: RLS applies — a stranger sees no album rows, only what documents RLS lets through */
  const theirs = await asUser(stranger, `SELECT * FROM public.job_photo_day_counts($1, 'UTC')`, [
    job,
  ]);
  check(
    theirs.every((r) => r.source === "document"),
    "a user kept out of the projects counts none of their photos",
  );

  /* 6: anon cannot execute */
  await db.exec(`SET ROLE anon;`);
  let anonRefused = false;
  try {
    await db.query(`SELECT * FROM public.job_photo_day_counts($1, 'UTC')`, [job]);
  } catch (e) {
    anonRefused = /permission denied/i.test(String(e?.message ?? e));
  } finally {
    await db.exec(`RESET ROLE;`);
  }
  check(anonRefused, "anon is refused EXECUTE");

  const grants = (
    await db.query(
      `SELECT has_function_privilege('authenticated', 'public.job_photo_day_counts(uuid, text)', 'EXECUTE') AS auth,
              has_function_privilege('anon', 'public.job_photo_day_counts(uuid, text)', 'EXECUTE') AS anon`,
    )
  ).rows[0];
  check(grants.auth === true && grants.anon === false, "authenticated may execute, anon may not");

  const fn = (
    await db.query(`SELECT prosecdef FROM pg_proc WHERE proname = 'job_photo_day_counts'`)
  ).rows[0];
  check(fn.prosecdef === false, "SECURITY INVOKER — it has no privilege of its own");

  /* 7: an unknown zone raises */
  let badZone = false;
  try {
    await asUser(crew, `SELECT * FROM public.job_photo_day_counts($1, 'Mars/Olympus_Mons')`, [job]);
  } catch {
    badZone = true;
  }
  check(badZone, "an unknown time zone raises rather than counting UTC days");

  /* 8: the keyset index */
  const idx = (
    await db.query(`SELECT indexdef FROM pg_indexes WHERE indexname = 'photos_album_page_idx'`)
  ).rows[0];
  check(
    !!idx &&
      /captured_at DESC NULLS LAST, created_at DESC, id DESC/.test(idx.indexdef) &&
      /WHERE \(deleted_at IS NULL\)/.test(idx.indexdef),
    "the keyset index matches the page order, live rows only",
  );

  console.log(`job-photo-day-counts.pglite: ${assertions} assertions passed`);
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  await db.close();
}
