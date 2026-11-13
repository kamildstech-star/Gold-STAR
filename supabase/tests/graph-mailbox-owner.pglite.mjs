// Run with: node supabase/tests/graph-mailbox-owner.pglite.mjs <existing PGlite dist/index.js>
// In-memory fixtures only. The migration under test is READ FROM THE FILE.
//
// What it proves about 20261007210000:
//   1. it adds graph_mailboxes.owner_user_id, nullable, and is re-runnable;
//   2. removing the owner's profile clears the owner (the mailbox then reads
//      "needs an owner"), it never deletes the mailbox;
//   3. it changes no grant and no policy on graph_mailboxes.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const db = new PGlite();
const FILE = "20261007210000_graph_mailbox_owner.sql";
const migration = readFileSync(new URL("../migrations/" + FILE, import.meta.url), "utf8");

let assertions = 0;
const check = (value, what) => {
  assert.equal(value, true, what);
  assertions++;
};

try {
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE TABLE public.profiles (user_id uuid PRIMARY KEY);
    CREATE TABLE public.graph_mailboxes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      upn text NOT NULL UNIQUE,
      kind text NOT NULL DEFAULT 'user',
      user_id uuid REFERENCES public.profiles(user_id) ON DELETE SET NULL
    );
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.graph_mailboxes TO authenticated;
    ALTER TABLE public.graph_mailboxes ENABLE ROW LEVEL SECURITY;
    CREATE POLICY "graph mailboxes viewable by staff" ON public.graph_mailboxes
      FOR SELECT TO authenticated USING (true);
    INSERT INTO public.profiles VALUES ('11111111-1111-4111-8111-111111111111');
  `);
  const snapshot = async () =>
    JSON.stringify([
      (
        await db.query(
          `SELECT policyname, cmd, roles::text FROM pg_policies WHERE tablename = 'graph_mailboxes' ORDER BY 1`,
        )
      ).rows,
      (
        await db.query(
          `SELECT grantee, privilege_type FROM information_schema.role_table_grants WHERE table_name = 'graph_mailboxes' ORDER BY 1, 2`,
        )
      ).rows,
    ]);
  const before = await snapshot();

  await db.exec(migration);
  await db.exec(migration);
  check(true, "applies twice");

  const col = await db.query(
    `SELECT is_nullable, data_type FROM information_schema.columns
      WHERE table_name = 'graph_mailboxes' AND column_name = 'owner_user_id'`,
  );
  check(
    col.rows.length === 1 && col.rows[0].is_nullable === "YES",
    "owner_user_id exists and is nullable",
  );
  check(col.rows[0].data_type === "uuid", "owner_user_id is a uuid");

  await db.exec(`INSERT INTO public.graph_mailboxes (upn, kind, owner_user_id)
    VALUES ('office@goldstar.test', 'shared_office', '11111111-1111-4111-8111-111111111111')`);
  await db.exec(`DELETE FROM public.profiles`);
  const after = await db.query(
    `SELECT owner_user_id FROM public.graph_mailboxes WHERE upn = 'office@goldstar.test'`,
  );
  check(after.rows.length === 1, "removing the owner's profile keeps the mailbox");
  check(after.rows[0].owner_user_id === null, "and clears its owner");

  await assert.rejects(
    db.exec(
      `UPDATE public.graph_mailboxes SET owner_user_id = '22222222-2222-4222-8222-222222222222'`,
    ),
    /foreign key/i,
  );
  assertions++;

  check((await snapshot()) === before, "no grant or policy on graph_mailboxes changed");
  console.log(`graph-mailbox-owner.pglite: ${assertions} assertions passed`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await db.close();
}
