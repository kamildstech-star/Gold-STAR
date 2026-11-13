// Offline regression fixture for Melly's seller access, task notification and
// tracked review-link migrations. It never connects to a remote database.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const db = new PGlite();
const migration = (name) => readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");

const creator = "11111111-1111-4111-8111-111111111111";
const assignee = "22222222-2222-4222-8222-222222222222";
const office = "33333333-3333-4333-8333-333333333333";
const account = "44444444-4444-4444-8444-444444444444";
const contact = "55555555-5555-4555-8555-555555555555";
const task = "66666666-6666-4666-8666-666666666666";
const otherOffice = "77777777-7777-4777-8777-777777777777";
const otherAccount = "88888888-8888-4888-8888-888888888888";
const otherContact = "99999999-9999-4999-8999-999999999999";
let checks = 0;
const check = (value, message) => {
  assert.equal(value, true, message);
  checks++;
};

try {
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
      $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;

    CREATE TYPE public.app_role AS ENUM
      ('sales_person','sales_rep','outside_sales_rep');
    CREATE TYPE public.task_status AS ENUM ('open','in_progress','done','cancelled');
    CREATE TYPE public.notification_priority AS ENUM ('low','normal','high','urgent');
    CREATE TYPE public.notification_type AS ENUM ('task_due_today');
    CREATE TYPE public.notification_delivery AS ENUM ('immediate','daily_digest','off');

    CREATE TABLE public.permissions (
      key text PRIMARY KEY,
      label text NOT NULL,
      perm_group text NOT NULL,
      description text,
      sort_order integer NOT NULL DEFAULT 0
    );
    CREATE TABLE public.role_permissions (
      role public.app_role NOT NULL,
      permission_key text NOT NULL,
      PRIMARY KEY (role, permission_key)
    );
    CREATE TABLE public.profiles (user_id uuid PRIMARY KEY, full_name text);
    INSERT INTO public.profiles VALUES
      ('${creator}','Melly'), ('${assignee}','Saul');
    CREATE TABLE public.locations (id uuid PRIMARY KEY);
    INSERT INTO public.locations VALUES ('${office}'), ('${otherOffice}');
    CREATE TABLE public.accounts (id uuid PRIMARY KEY, location_id uuid NOT NULL);
    INSERT INTO public.accounts VALUES
      ('${account}','${office}'), ('${otherAccount}','${otherOffice}');
    CREATE TABLE public.contacts (id uuid PRIMARY KEY, account_id uuid NOT NULL);
    INSERT INTO public.contacts VALUES
      ('${contact}','${account}'), ('${otherContact}','${otherAccount}');
    GRANT SELECT ON public.accounts, public.contacts, public.locations TO authenticated;

    CREATE FUNCTION public.can_view_location(u uuid, l uuid) RETURNS boolean
      LANGUAGE sql STABLE AS $$
        SELECT u IN ('${creator}'::uuid, '${assignee}'::uuid)
          AND l IN ('${office}'::uuid, '${otherOffice}'::uuid)
      $$;
    CREATE FUNCTION public.can_manage_location(u uuid, l uuid) RETURNS boolean
      LANGUAGE sql STABLE AS $$ SELECT u='${creator}'::uuid AND l='${office}'::uuid $$;

    CREATE TABLE public.tasks (
      id uuid PRIMARY KEY,
      title text NOT NULL,
      assignee uuid,
      created_by uuid,
      status public.task_status NOT NULL DEFAULT 'open'
    );
    CREATE TABLE public.notifications (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL,
      type public.notification_type NOT NULL, title text NOT NULL, body text,
      entity_type text, entity_id uuid, href text,
      priority public.notification_priority NOT NULL DEFAULT 'normal'
    );
    CREATE TABLE public.notification_preferences (
      user_id uuid NOT NULL,
      type public.notification_type NOT NULL,
      in_app boolean NOT NULL DEFAULT true,
      delivery public.notification_delivery NOT NULL DEFAULT 'immediate',
      PRIMARY KEY (user_id, type)
    );
    GRANT SELECT, INSERT, UPDATE ON public.tasks TO authenticated;
    GRANT SELECT ON public.notifications TO authenticated;
    GRANT ALL ON public.tasks, public.notifications TO service_role;
    ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
    CREATE POLICY own_notifications ON public.notifications FOR ALL TO authenticated
      USING (user_id=auth.uid()) WITH CHECK (user_id=auth.uid());
  `);

  for (const name of [
    "20260908142838_melly_seller_page_access.sql",
    "20260908142840_task_completed_notification_type.sql",
    "20260908142842_task_completion_notifications.sql",
    "20260908142844_google_review_link_tracking.sql",
    "20260908171508_tighten_google_review_link_grants.sql",
    "20260908171733_fix_google_review_link_insert_scope.sql",
  ]) {
    await db.exec(migration(name));
  }

  // The production seed already contains the legacy sales_rep rows; this
  // repair migration adds the two current role names that were omitted.
  const expected = 2 * 7;
  check(
    Number((await db.query("SELECT count(*) AS n FROM role_permissions")).rows[0].n) === expected,
    "both omitted relationship seller roles receive all seven workflow pages",
  );
  check(
    Number(
      (await db.query("SELECT count(*) AS n FROM permissions WHERE key LIKE 'page.%'")).rows[0].n,
    ) === 7,
    "the seven required page catalogue keys are seeded",
  );
  check(
    (await db.query("SELECT has_table_privilege('anon','google_review_links','SELECT') AS ok"))
      .rows[0].ok === false,
    "anonymous callers have no review-link table privilege",
  );
  check(
    (
      await db.query(
        "SELECT has_table_privilege('authenticated','google_review_links','UPDATE') AS ok",
      )
    ).rows[0].ok === false,
    "authenticated callers cannot update review-link counters or fields",
  );

  await db.exec(
    `INSERT INTO tasks VALUES ('${task}','Call the client','${assignee}','${creator}','open')`,
  );
  await db.exec(`SET ROLE authenticated; SET request.jwt.claim.sub='${assignee}'`);
  await db.exec(`UPDATE tasks SET status='done' WHERE id='${task}'`);
  await db.exec("RESET ROLE");
  const notice = (await db.query("SELECT title,body,user_id FROM notifications")).rows[0];
  check(notice.user_id === creator, "creator receives the notification");
  check(notice.title === "Saul completed a task", "notification identifies the completer");
  check(notice.body === "Call the client", "notification identifies the task");

  await db.exec(
    `INSERT INTO notification_preferences VALUES ('${creator}','task_completed',false,'immediate')`,
  );
  await db.exec(`UPDATE tasks SET status='open' WHERE id='${task}'`);
  await db.exec(`SET ROLE authenticated; SET request.jwt.claim.sub='${assignee}'`);
  await db.exec(`UPDATE tasks SET status='done' WHERE id='${task}'`);
  await db.exec("RESET ROLE");
  check(
    Number((await db.query("SELECT count(*) AS n FROM notifications")).rows[0].n) === 1,
    "creator's in-app notification opt-out is respected",
  );

  await db.exec(`SET ROLE authenticated; SET request.jwt.claim.sub='${creator}'`);
  await assert.rejects(
    db.query(`INSERT INTO google_review_links(account_id,location_id,destination_url,created_by)
      VALUES('${account}','${office}','https://google.com.evil.example/review','${creator}')`),
  );
  checks++;
  await assert.rejects(
    db.query(`INSERT INTO google_review_links(account_id,location_id,destination_url,created_by)
      VALUES('${account}','${otherOffice}','https://g.page/r/example/review','${creator}')`),
  );
  checks++;
  await assert.rejects(
    db.query(`INSERT INTO google_review_links(account_id,contact_id,location_id,destination_url,created_by)
      VALUES('${account}','${otherContact}','${office}','https://g.page/r/example/review','${creator}')`),
  );
  checks++;
  const made = await db.query(
    `INSERT INTO google_review_links(account_id,contact_id,location_id,destination_url,created_by)
     VALUES($1,$2,$3,'https://g.page/r/example/review',$4) RETURNING token`,
    [account, contact, office, creator],
  );
  const token = made.rows[0].token;
  await assert.rejects(db.query("SELECT record_google_review_click($1)", [token]));
  checks++;
  await db.exec("RESET ROLE; SET ROLE service_role");
  const clicked = await db.query("SELECT record_google_review_click($1) AS destination", [token]);
  check(clicked.rows[0].destination === "https://g.page/r/example/review", "redirect resolves");
  check(
    Number((await db.query("SELECT click_count AS n FROM google_review_links")).rows[0].n) === 1,
    "redirect increments atomically",
  );
  await db.exec("RESET ROLE; SET ROLE anon");
  await assert.rejects(db.query("SELECT * FROM google_review_links"));
  checks++;

  console.log(
    `${checks} Melly workflow migration checks passed (in-memory fixtures; not deployed).`,
  );
} finally {
  await db.close();
}
