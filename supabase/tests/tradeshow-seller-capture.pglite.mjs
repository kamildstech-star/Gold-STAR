// Offline security regression for the seller and manager Trade Show capture RPC.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const db = new PGlite();
const migration = readFileSync(
  new URL("../migrations/20260908183526_capture_tradeshow_lead_account.sql", import.meta.url),
  "utf8",
);

const seller = "11111111-1111-4111-8111-111111111111";
const manager = "22222222-2222-4222-8222-222222222222";
const deactivatedSeller = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const rejectedSeller = "abababab-abab-4bab-8bab-abababababab";
const office = "33333333-3333-4333-8333-333333333333";
const otherOffice = "44444444-4444-4444-8444-444444444444";
const show = "55555555-5555-4555-8555-555555555555";
const account = "66666666-6666-4666-8666-666666666666";
const collision = "77777777-7777-4777-8777-777777777777";
const pipeline = "88888888-8888-4888-8888-888888888888";
const stage = "99999999-9999-4999-8999-999999999999";
const wonStage = "15151515-1515-4515-8515-151515151515";
const lostStage = "16161616-1616-4616-8616-161616161616";
const source = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const managerAccount = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

try {
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth;
    GRANT USAGE ON SCHEMA public, auth TO authenticated, service_role;

    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
      $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

    CREATE TABLE public.profiles (
      user_id uuid PRIMARY KEY,
      is_active boolean NOT NULL,
      approval_status text NOT NULL,
      deactivated_at timestamptz
    );
    INSERT INTO public.profiles VALUES
      ('${seller}', true, 'approved', NULL),
      ('${manager}', true, 'approved', NULL),
      ('${deactivatedSeller}', false, 'approved', now()),
      ('${rejectedSeller}', true, 'rejected', NULL);

    CREATE TABLE public.user_roles (user_id uuid NOT NULL, role text NOT NULL);
    INSERT INTO public.user_roles VALUES
      ('${seller}', 'sales_person'),
      ('${manager}', 'sales_manager'),
      ('${deactivatedSeller}', 'sales_person'),
      ('${rejectedSeller}', 'sales_person');
    CREATE FUNCTION public.has_any_role_text(_user_id uuid, _roles text[])
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
      SELECT EXISTS (SELECT 1 FROM public.user_roles
        WHERE user_id = _user_id AND role = ANY(_roles))
    $$;

    CREATE TABLE public.location_members (user_id uuid NOT NULL, location_id uuid NOT NULL);
    INSERT INTO public.location_members VALUES
      ('${seller}', '${office}'),
      ('${manager}', '${office}'),
      ('${deactivatedSeller}', '${office}'),
      ('${rejectedSeller}', '${office}');
    CREATE FUNCTION public.can_view_location(_user_id uuid, _location_id uuid)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
      SELECT EXISTS (SELECT 1 FROM public.location_members
        WHERE user_id = _user_id AND location_id = _location_id)
    $$;
    CREATE FUNCTION public.can_manage_location(_user_id uuid, _location_id uuid)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
      SELECT _user_id = '${manager}'::uuid AND _location_id = '${office}'::uuid
    $$;

    CREATE TABLE public.tradeshows (id uuid PRIMARY KEY, name text NOT NULL, location_id uuid);
    GRANT SELECT ON public.tradeshows TO authenticated;
    INSERT INTO public.tradeshows VALUES ('${show}', 'RIMS 2026', '${office}');
    CREATE TABLE public.pipelines (
      id uuid PRIMARY KEY, entity_type text NOT NULL, is_active boolean NOT NULL, location_id uuid
    );
    INSERT INTO public.pipelines VALUES ('${pipeline}', 'account', true, '${office}');
    CREATE TABLE public.pipeline_stages (
      id uuid PRIMARY KEY, pipeline_id uuid NOT NULL, is_active boolean NOT NULL,
      is_won boolean NOT NULL DEFAULT false, is_lost boolean NOT NULL DEFAULT false
    );
    INSERT INTO public.pipeline_stages VALUES
      ('${stage}', '${pipeline}', true, false, false),
      ('${wonStage}', '${pipeline}', true, true, false),
      ('${lostStage}', '${pipeline}', true, false, true);
    CREATE TABLE public.option_lists (id uuid PRIMARY KEY, key text NOT NULL);
    CREATE TABLE public.option_list_values (
      id uuid PRIMARY KEY, option_list_id uuid NOT NULL, active boolean NOT NULL
    );
    INSERT INTO public.option_lists VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'lead_source');
    INSERT INTO public.option_list_values VALUES
      ('${source}', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', true);

    CREATE TABLE public.accounts (
      id uuid PRIMARY KEY, name text NOT NULL, location_id uuid NOT NULL,
      tradeshow_id uuid, lead_source_id uuid, lead_source_detail text,
      assigned_rep uuid, created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
      phone text, email text, notes text, stage_id uuid, pipeline_id uuid
    );
    ALTER TABLE public.accounts ENABLE ROW LEVEL SECURITY;
    GRANT SELECT ON public.accounts TO authenticated;
    CREATE POLICY assigned_account_select ON public.accounts FOR SELECT TO authenticated
      USING (assigned_rep = auth.uid());
    CREATE POLICY managers_only_insert ON public.accounts FOR INSERT TO authenticated
      WITH CHECK (false);
    CREATE TABLE public.account_locations (
      account_id uuid NOT NULL, location_id uuid NOT NULL, created_by uuid,
      PRIMARY KEY (account_id, location_id)
    );

    CREATE TABLE public.contacts (
      id uuid PRIMARY KEY, account_id uuid NOT NULL, created_by uuid NOT NULL
    );
    ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;
    GRANT INSERT ON public.contacts TO authenticated;
    CREATE POLICY contacts_write ON public.contacts FOR INSERT TO authenticated WITH CHECK (
      created_by = auth.uid() AND EXISTS (
        SELECT 1 FROM public.accounts a WHERE a.id = account_id AND a.assigned_rep = auth.uid()
      )
    );
    CREATE TABLE public.touchpoints (
      id uuid PRIMARY KEY, account_id uuid NOT NULL, created_by uuid NOT NULL
    );
    ALTER TABLE public.touchpoints ENABLE ROW LEVEL SECURITY;
    GRANT INSERT ON public.touchpoints TO authenticated;
    CREATE POLICY touchpoints_insert ON public.touchpoints FOR INSERT TO authenticated WITH CHECK (
      created_by = auth.uid() AND EXISTS (
        SELECT 1 FROM public.accounts a WHERE a.id = account_id AND a.assigned_rep = auth.uid()
      )
    );
    CREATE TABLE public.tradeshow_lead_media (
      id uuid PRIMARY KEY, tradeshow_id uuid NOT NULL, account_id uuid NOT NULL, created_by uuid NOT NULL
    );
    ALTER TABLE public.tradeshow_lead_media ENABLE ROW LEVEL SECURITY;
    GRANT INSERT ON public.tradeshow_lead_media TO authenticated;
    CREATE POLICY tradeshow_lead_media_insert ON public.tradeshow_lead_media
      FOR INSERT TO authenticated WITH CHECK (
        created_by = auth.uid() AND EXISTS (
          SELECT 1 FROM public.tradeshows t WHERE t.id = tradeshow_id
            AND (t.location_id IS NULL OR public.can_view_location(auth.uid(), t.location_id))
        )
      );

    INSERT INTO public.accounts(id,name,location_id,tradeshow_id,assigned_rep,created_by)
      VALUES ('${collision}','Existing','${office}','${show}','${manager}','${manager}');
  `);

  await db.exec(migration);

  const call = `SELECT capture_tradeshow_lead_account(
    '${account}', '${show}', '${office}', 'Harbour Point', '2026-09-08T12:00:00Z',
    '555-0100', NULL, 'Met at booth', '${source}', '${pipeline}', '${stage}'
  ) AS id`;

  await db.exec(`SET ROLE authenticated; SET request.jwt.claim.sub='${seller}'`);
  const made = await db.query(call);
  assert.equal(made.rows[0].id, account, "seller can file a lead in their office");
  await db.query(call);
  await db.exec(`
    INSERT INTO contacts VALUES ('12121212-1212-4212-8212-121212121212','${account}','${seller}');
    INSERT INTO touchpoints VALUES ('13131313-1313-4313-8313-131313131313','${account}','${seller}');
    INSERT INTO tradeshow_lead_media VALUES
      ('14141414-1414-4414-8414-141414141414','${show}','${account}','${seller}');
  `);
  await db.exec("RESET ROLE");

  const saved = (await db.query(`SELECT * FROM accounts WHERE id='${account}'`)).rows[0];
  assert.equal(saved.assigned_rep, seller, "RPC pins the assigned rep to the caller");
  assert.equal(saved.created_by, seller, "RPC pins the creator to the caller");
  assert.equal(saved.lead_source_detail, "RIMS 2026", "show name is read by the database");
  assert.equal(
    Number((await db.query(`SELECT count(*) AS n FROM accounts WHERE id='${account}'`)).rows[0].n),
    1,
    "replay remains idempotent",
  );
  assert.equal(
    Number(
      (await db.query(`SELECT count(*) AS n FROM account_locations WHERE account_id='${account}'`))
        .rows[0].n,
    ),
    1,
    "owning-office serving relation is created once",
  );
  assert.equal(
    Number((await db.query("SELECT count(*) AS n FROM contacts")).rows[0].n),
    1,
    "assigned-account contact policy accepts the seller's row",
  );
  assert.equal(
    Number((await db.query("SELECT count(*) AS n FROM touchpoints")).rows[0].n),
    1,
    "assigned-account touchpoint policy accepts the seller's row",
  );
  assert.equal(
    Number((await db.query("SELECT count(*) AS n FROM tradeshow_lead_media")).rows[0].n),
    1,
    "caller-owned Trade Show media policy accepts the seller's row",
  );

  await db.exec(`SET ROLE authenticated; SET request.jwt.claim.sub='${manager}'`);
  const managerMade = await db.query(call.replace(`'${account}'`, `'${managerAccount}'`));
  assert.equal(
    managerMade.rows[0].id,
    managerAccount,
    "an existing office manager path still works",
  );
  await db.exec(`SET request.jwt.claim.sub='${seller}'`);
  await assert.rejects(
    db.query(call.replace(`'${office}', 'Harbour Point'`, `'${otherOffice}', 'Harbour Point'`)),
    /outside your access/,
  );
  await assert.rejects(db.query(call.replace(`'${account}'`, `'${collision}'`)), /already in use/);
  await assert.rejects(
    db.query(call.replace(`'${pipeline}', '${stage}'`, `'${pipeline}', '${wonStage}'`)),
    /stage is unavailable/,
  );
  await assert.rejects(
    db.query(call.replace(`'${pipeline}', '${stage}'`, `'${pipeline}', '${lostStage}'`)),
    /stage is unavailable/,
  );
  await db.exec(`SET request.jwt.claim.sub='${deactivatedSeller}'`);
  await assert.rejects(
    db.query(call.replace(`'${account}'`, `'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'`)),
    /active signed-in user/,
  );
  await db.exec(`SET request.jwt.claim.sub='${rejectedSeller}'`);
  await assert.rejects(
    db.query(call.replace(`'${account}'`, `'edededed-eded-4ded-8ded-edededededed'`)),
    /active signed-in user/,
  );
  await db.exec("RESET ROLE; SET ROLE anon");
  await assert.rejects(db.query(call));

  console.log(
    "Trade Show seller-capture security scenarios passed (in-memory fixtures; not deployed).",
  );
} finally {
  await db.close();
}
