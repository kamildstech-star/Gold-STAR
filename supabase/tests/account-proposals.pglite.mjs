// Run with: node supabase/tests/account-proposals.pglite.mjs <existing PGlite dist/index.js>
// In-memory fixtures only. No connection string, network access or live writes.
//
// Proposals on a pipeline card (migration 20261012200000, READ FROM THE FILE).
// Mark: "Is there a way to make something in the pipeline a proposal?"
//
// What it proves:
//   1. the "Proposal sent" stage lands between its neighbours on both account
//      pipelines, the later stages shift down, and a second run changes
//      nothing;
//   2. who reads and writes: the account's rep and its office manager write;
//      the office reads; another office, a deactivated profile, a portal
//      customer and anon get nothing; nobody writes in someone else's name;
//   3. the money: line_total is quantity x unit price and cannot be written,
//      subtotal/total are the sum of the lines whatever the client sends;
//   4. the lifecycle: draft -> sent -> signed | declined | expired and nothing
//      else; only a draft is edited, its lines included; the stamps and the
//      automation's note cannot be forged; only a draft is deleted;
//   5. sent moves the card to Proposal sent through a plain stage_id update
//      (the history row is written by the account's own trigger and carries
//      the reason) — but never backwards, and not on a pipeline without the
//      stage;
//   6. the customer signing the document (as the service role, as
//      complete_document_signing_atomic does) marks the proposal signed and
//      activates the client through pipeline_activate_client, crediting the
//      rep who sent it; a move that blows up never fails the signature;
//   7. declined leaves the stage alone;
//   8. sales_rep_metrics counts quotes AND proposals sent in the window.
//
// The surrounding tables are stubs with only the columns the migration (and
// pipeline_activate_client, also read from its file) touch. auth.uid() reads a
// session setting, as the other fixtures do.
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
const refuses = async (promise, pattern, what) => {
  await assert.rejects(promise, pattern, what);
  assertions++;
};

const admin = "11111111-1111-4111-8111-1111111111aa";
const repA = "22222222-2222-4222-8222-2222222222aa"; // office A, the accounts' rep
const managerA = "33333333-3333-4333-8333-3333333333aa"; // office A location manager
const crewA = "44444444-4444-4444-8444-4444444444aa"; // office A, reads only
const repB = "55555555-5555-4555-8555-5555555555aa"; // office B
const gone = "66666666-6666-4666-8666-6666666666aa"; // office A, deactivated
const officeA = "a1000000-0000-4000-8000-000000000001";
const officeB = "a1000000-0000-4000-8000-000000000002";

const PROSPECTING = "22222222-2222-4222-8222-222222222222";
const RELATIONSHIP = "11111111-1111-4111-8111-111111111111";
const BARE = "99999999-9999-4999-8999-999999999999";

// Accounts, by where they start.
const acctConv = "ac000000-0000-4000-8000-000000000001"; // Conversation Established
const acctWon = "ac000000-0000-4000-8000-000000000002"; // already Active Client
const acctGhost = "ac000000-0000-4000-8000-000000000003"; // GOASTED
const acctBare = "ac000000-0000-4000-8000-000000000004"; // pipeline with no Proposal sent
const acctRel = "ac000000-0000-4000-8000-000000000005"; // Relationship, Meeting held
const acctBoom = "ac000000-0000-4000-8000-000000000006"; // its stage move blows up
const acctB = "ac000000-0000-4000-8000-000000000007"; // office B
const acctDecl = "ac000000-0000-4000-8000-000000000008"; // will decline

const tpl = "7e000000-0000-4000-8000-000000000001";
const tplV1 = "7e000000-0000-4000-8000-000000000011";
const otherTpl = "7e000000-0000-4000-8000-000000000002";
const otherV1 = "7e000000-0000-4000-8000-000000000022";

try {
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role BYPASSRLS;
    CREATE ROLE portal_customer NOLOGIN NOINHERIT;
    CREATE SCHEMA auth;
    CREATE SCHEMA goldstar_private;
    GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role, portal_customer;
    GRANT USAGE ON SCHEMA goldstar_private TO authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;

    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
      $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

    CREATE TABLE public.profiles (
      user_id uuid PRIMARY KEY, full_name text, is_active boolean NOT NULL DEFAULT true);
    CREATE FUNCTION goldstar_private.profile_is_active(_user_id uuid)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
      SELECT EXISTS (SELECT 1 FROM public.profiles p WHERE p.user_id = _user_id AND p.is_active);
    $$;
    GRANT EXECUTE ON FUNCTION goldstar_private.profile_is_active(uuid) TO authenticated, service_role;

    CREATE TABLE public.user_roles (user_id uuid, role text);
    CREATE TABLE public.location_members (user_id uuid, location_id uuid);
    CREATE FUNCTION public.is_privileged(_user_id uuid) RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
      $$ SELECT EXISTS (SELECT 1 FROM public.user_roles
                         WHERE user_id = _user_id AND role IN ('owner', 'admin', 'dev')) $$;
    CREATE FUNCTION public.can_view_location(_user_id uuid, _location_id uuid) RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
      $$ SELECT public.is_privileged(_user_id) OR EXISTS (
           SELECT 1 FROM public.location_members m
            WHERE m.user_id = _user_id AND m.location_id = _location_id) $$;
    CREATE FUNCTION public.can_manage_location(_user_id uuid, _location_id uuid) RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
      $$ SELECT _location_id IS NOT NULL AND (public.is_privileged(_user_id) OR EXISTS (
           SELECT 1 FROM public.location_members m JOIN public.user_roles r ON r.user_id = m.user_id
            WHERE m.user_id = _user_id AND m.location_id = _location_id
              AND r.role IN ('office', 'location_manager', 'sales_manager'))) $$;
    GRANT EXECUTE ON FUNCTION public.is_privileged(uuid), public.can_view_location(uuid, uuid),
      public.can_manage_location(uuid, uuid) TO authenticated;

    CREATE TABLE public.pipelines (id uuid PRIMARY KEY, name text, is_active boolean NOT NULL DEFAULT true);
    CREATE TABLE public.pipeline_stages (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      pipeline_id uuid NOT NULL REFERENCES public.pipelines(id),
      key text NOT NULL, name text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
      color text NOT NULL DEFAULT '#64748B', probability numeric NOT NULL DEFAULT 0,
      is_won boolean NOT NULL DEFAULT false, is_lost boolean NOT NULL DEFAULT false,
      is_active boolean NOT NULL DEFAULT true, description text,
      UNIQUE (pipeline_id, key));

    CREATE TABLE public.accounts (
      id uuid PRIMARY KEY, name text NOT NULL, location_id uuid NOT NULL, assigned_rep uuid,
      pipeline_id uuid, stage_id uuid REFERENCES public.pipeline_stages(id), stage text,
      stage_changed_at timestamptz, status text NOT NULL DEFAULT 'prospect',
      green_light_date date, health_pipeline_id uuid, health_stage_id uuid,
      health_changed_at timestamptz, annual_meeting_due_on date, lost_reason text);
    CREATE TABLE public.account_stage_history (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL,
      from_stage_id uuid, to_stage_id uuid, from_stage text, to_stage text, reason text,
      changed_by uuid, changed_at timestamptz NOT NULL DEFAULT clock_timestamp());

    -- What trg_accounts_stage_normalize + trg_accounts_stage_history do on a
    -- stage move: pipeline and key follow the stage, a lost stage needs a
    -- reason, and the move is written to history as auth.uid().
    CREATE FUNCTION public.stub_stage_normalize() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE s public.pipeline_stages%ROWTYPE;
    BEGIN
      SELECT * INTO s FROM public.pipeline_stages WHERE id = NEW.stage_id;
      NEW.pipeline_id := s.pipeline_id; NEW.stage := s.key;
      IF s.is_lost AND coalesce(btrim(NEW.lost_reason), '') = '' THEN
        RAISE EXCEPTION 'A reason is required when an account is marked lost';
      END IF;
      IF NEW.name = 'Explodes' AND TG_OP = 'UPDATE' AND NEW.stage_id IS DISTINCT FROM OLD.stage_id THEN
        RAISE EXCEPTION 'boom';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER stub_stage_normalize BEFORE INSERT OR UPDATE ON public.accounts
      FOR EACH ROW EXECUTE FUNCTION public.stub_stage_normalize();
    CREATE FUNCTION public.stub_stage_history() RETURNS trigger LANGUAGE plpgsql
      SECURITY DEFINER SET search_path = public AS $$
    BEGIN
      IF NEW.stage_id IS DISTINCT FROM OLD.stage_id THEN
        INSERT INTO public.account_stage_history
          (account_id, from_stage_id, to_stage_id, from_stage, to_stage, reason, changed_by)
        VALUES (NEW.id, OLD.stage_id, NEW.stage_id, OLD.stage, NEW.stage, NEW.lost_reason, auth.uid());
      END IF;
      RETURN NULL;
    END $$;
    CREATE TRIGGER stub_stage_history AFTER UPDATE ON public.accounts
      FOR EACH ROW EXECUTE FUNCTION public.stub_stage_history();

    -- The live column types are enums, which is what makes the casts matter.
    CREATE TYPE public.notification_type AS ENUM ('automation_task', 'task_overdue');
    CREATE TYPE public.notification_priority AS ENUM ('low', 'normal', 'high', 'urgent');
    CREATE TABLE public.notifications (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL,
      type public.notification_type NOT NULL, title text NOT NULL, body text, entity_type text,
      entity_id uuid, href text, priority public.notification_priority NOT NULL DEFAULT 'normal');
    CREATE TABLE public.document_templates (id uuid PRIMARY KEY, name text);
    CREATE TABLE public.document_template_versions (
      id uuid PRIMARY KEY, template_id uuid REFERENCES public.document_templates(id), version int);
    CREATE TYPE public.document_status AS ENUM
      ('draft', 'pending_signature', 'signed', 'active', 'expired', 'void', 'sent', 'viewed', 'declined');
    CREATE TABLE public.documents (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid, location_id uuid,
      status public.document_status NOT NULL DEFAULT 'draft', declined_reason text,
      signed_at timestamptz, created_by uuid);

    -- What sales_rep_metrics reads besides the new table.
    CREATE TABLE public.jobs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid,
      created_at timestamptz NOT NULL DEFAULT now(), job_type text);
    CREATE TABLE public.touchpoints (created_by uuid, type text, occurred_at timestamptz,
      meeting_held boolean);
    CREATE TABLE public.quotes (created_by uuid, status text, created_at timestamptz);

    INSERT INTO public.profiles VALUES
      ('${admin}', 'Admin', true), ('${repA}', 'Rita Rep', true), ('${managerA}', 'Manny', true),
      ('${crewA}', 'Cody Crew', true), ('${repB}', 'Bea Rep', true), ('${gone}', 'Gone', false);
    INSERT INTO public.user_roles VALUES
      ('${admin}', 'admin'), ('${repA}', 'sales_rep'), ('${managerA}', 'location_manager'),
      ('${crewA}', 'crew'), ('${repB}', 'sales_rep'), ('${gone}', 'sales_rep');
    INSERT INTO public.location_members VALUES
      ('${repA}', '${officeA}'), ('${managerA}', '${officeA}'), ('${crewA}', '${officeA}'),
      ('${gone}', '${officeA}'), ('${repB}', '${officeB}');

    INSERT INTO public.pipelines VALUES
      ('${PROSPECTING}', 'Prospecting', true), ('${RELATIONSHIP}', 'Relationship pipeline', false),
      ('${BARE}', 'Bare', true);
    INSERT INTO public.pipeline_stages (pipeline_id, key, name, sort_order, is_won, is_lost) VALUES
      ('${PROSPECTING}', 'ready', 'Ready', 30, false, false),
      ('${PROSPECTING}', 'active_outreach', 'Active Outreach', 40, false, false),
      ('${PROSPECTING}', 'conversation_established', 'Conversation Established', 50, false, false),
      ('${PROSPECTING}', 'active_client', 'Active Client', 60, true, false),
      ('${PROSPECTING}', 'no_service_needed', 'No Service Needed', 70, false, true),
      ('${PROSPECTING}', 'goasted', 'GOASTED', 80, false, true),
      ('${RELATIONSHIP}', 'target', 'Target', 10, false, false),
      ('${RELATIONSHIP}', 'meeting_held', 'Meeting held', 50, false, false),
      ('${RELATIONSHIP}', 'vendor_onboarding', 'Vendor onboarding', 60, false, false),
      ('${RELATIONSHIP}', 'active', 'Active', 70, true, false),
      ('${RELATIONSHIP}', 'lost', 'Lost', 100, false, true),
      ('${BARE}', 'open', 'Open', 10, false, false),
      ('${BARE}', 'done', 'Done', 20, true, false);

    INSERT INTO public.document_templates VALUES ('${tpl}', 'Service proposal'), ('${otherTpl}', 'Other');
    INSERT INTO public.document_template_versions VALUES ('${tplV1}', '${tpl}', 1), ('${otherV1}', '${otherTpl}', 1);
  `);

  const stageId = async (pipeline, key) =>
    (
      await db.query(
        `SELECT id::text FROM public.pipeline_stages WHERE pipeline_id = '${pipeline}' AND key = '${key}'`,
      )
    ).rows[0]?.id;
  const addAccount = async (id, name, office, pipeline, key, rep = repA, lost = null) =>
    db.exec(
      `INSERT INTO public.accounts (id, name, location_id, assigned_rep, stage_id, lost_reason)
       VALUES ('${id}', '${name}', '${office}', '${rep}', '${await stageId(pipeline, key)}',
               ${lost ? `'${lost}'` : "NULL"})`,
    );
  await addAccount(acctConv, "Flatbush Co-op", officeA, PROSPECTING, "conversation_established");
  await addAccount(acctWon, "Already Won LLC", officeA, PROSPECTING, "active_client");
  await addAccount(acctGhost, "Quiet Towers", officeA, PROSPECTING, "goasted", repA, "No reply");
  await addAccount(acctBare, "Bare Pipe Co", officeA, BARE, "open");
  await addAccount(acctRel, "Partner Ltd", officeA, RELATIONSHIP, "meeting_held");
  await addAccount(acctBoom, "Explodes", officeA, PROSPECTING, "conversation_established");
  await addAccount(acctB, "Office B Co", officeB, PROSPECTING, "active_outreach", repB);
  await addAccount(acctDecl, "Says No Inc", officeA, PROSPECTING, "active_outreach");

  // The real activation RPC, as live, read from its own file.
  await db.exec(migration("20260914150000_activate_client_starts_at_watch.sql"));
  await db.exec(migration("20261012200000_account_proposals.sql"));

  /* ---- 1: the stage ------------------------------------------------------- */
  const order = async (pipeline) =>
    (
      await db.query(
        `SELECT key, sort_order FROM public.pipeline_stages WHERE pipeline_id = '${pipeline}'
          ORDER BY sort_order`,
      )
    ).rows;
  const prospecting = await order(PROSPECTING);
  check(
    prospecting.map((r) => r.key).join(",") ===
      "ready,active_outreach,conversation_established,proposal_sent,active_client,no_service_needed,goasted",
    "Prospecting: Proposal sent sits after Conversation Established, before Active Client",
  );
  check(
    prospecting.find((r) => r.key === "proposal_sent").sort_order === 60 &&
      prospecting.find((r) => r.key === "active_client").sort_order === 70 &&
      prospecting.find((r) => r.key === "goasted").sort_order === 90,
    "and every later stage shifted down 10",
  );
  check(
    (await order(RELATIONSHIP)).map((r) => r.key).join(",") ===
      "target,meeting_held,proposal_sent,vendor_onboarding,active,lost",
    "Relationship: after Meeting held, before Vendor onboarding",
  );
  check((await order(BARE)).length === 2, "a pipeline that was not asked for is untouched");
  const ps = (
    await db.query(
      `SELECT name, color, is_won, is_lost, probability::int AS p FROM public.pipeline_stages
        WHERE pipeline_id = '${PROSPECTING}' AND key = 'proposal_sent'`,
    )
  ).rows[0];
  check(
    ps.name === "Proposal sent" &&
      ps.color === "#EA580C" &&
      !ps.is_won &&
      !ps.is_lost &&
      ps.p === 80,
    "named, coloured and weighted between its neighbours",
  );
  await db.exec(migration("20261012200000_account_proposals.sql"));
  check(
    JSON.stringify(await order(PROSPECTING)) === JSON.stringify(prospecting),
    "a second run neither adds a stage nor shifts the order again",
  );

  /* ---- helpers ------------------------------------------------------------ */
  const as = async (uid, sql, role = "authenticated") => {
    await db.exec(`SET ROLE ${role}; SET request.jwt.claim.sub = '${uid ?? ""}'`);
    try {
      return await db.query(sql);
    } finally {
      await db.exec("RESET ROLE; SELECT set_config('request.jwt.claim.sub','',false)");
    }
  };
  const one = async (sql) => (await db.query(sql)).rows[0];
  const create = async (by, account, title) =>
    (
      await as(
        by,
        `INSERT INTO public.account_proposals (account_id, title, created_by)
         VALUES ('${account}', '${title}', '${by}')
         RETURNING id::text, status, subtotal::text, pipeline_id::text`,
      )
    ).rows[0];
  const line = (by, proposal, desc, qty, price) =>
    as(
      by,
      `INSERT INTO public.account_proposal_lines (proposal_id, position, description, quantity, unit_price)
       VALUES ('${proposal}', 0, '${desc}', ${qty}, ${price})`,
    );
  const setStatus = (by, id, status, more = "") =>
    as(
      by,
      `UPDATE public.account_proposals SET status = '${status}'${more} WHERE id = '${id}'
       RETURNING id`,
    );
  const proposal = (id) =>
    one(
      `SELECT status, subtotal::text, total::text, sent_at, sent_by::text, signed_at, declined_at,
              declined_reason, expired_at, stage_note, document_id::text
         FROM public.account_proposals WHERE id = '${id}'`,
    );
  const stageOf = async (account) =>
    (
      await one(
        `SELECT s.key FROM public.accounts a JOIN public.pipeline_stages s ON s.id = a.stage_id
          WHERE a.id = '${account}'`,
      )
    ).key;
  const lastHistory = (account) =>
    one(
      `SELECT h.reason, h.changed_by::text, s.key FROM public.account_stage_history h
         JOIN public.pipeline_stages s ON s.id = h.to_stage_id
        WHERE h.account_id = '${account}' ORDER BY h.changed_at DESC LIMIT 1`,
    );

  /* ---- 2: who reads and writes ------------------------------------------- */
  const p1 = await create(repA, acctConv, "Annual water mitigation agreement");
  check(p1.status === "draft", "the account's rep writes a proposal, and it starts as a draft");
  check(p1.pipeline_id === PROSPECTING, "stamped with the account's pipeline");
  check(
    (await as(managerA, `SELECT count(*)::int AS n FROM public.account_proposals`)).rows[0].n === 1,
    "the office manager reads it",
  );
  check(
    (await as(crewA, `SELECT count(*)::int AS n FROM public.account_proposals`)).rows[0].n === 1,
    "so does anyone in the office",
  );
  check(
    (await as(repB, `SELECT count(*)::int AS n FROM public.account_proposals`)).rows[0].n === 0,
    "another office sees nothing — accounts are company-wide, prices are not",
  );
  await refuses(
    create(crewA, acctConv, "Crew offer"),
    /row-level security/,
    "someone who cannot move the account cannot write its proposal",
  );
  await refuses(
    create(repB, acctConv, "Poach"),
    /row-level security/,
    "nor can another office's rep",
  );
  await refuses(
    as(
      repA,
      `INSERT INTO public.account_proposals (account_id, title, created_by)
       VALUES ('${acctConv}', 'Forged', '${managerA}')`,
    ),
    /row-level security/,
    "nobody writes one in someone else's name",
  );
  const crewEdit = await as(
    crewA,
    `UPDATE public.account_proposals SET title = 'x' WHERE id = '${p1.id}' RETURNING id`,
  );
  check(crewEdit.rows.length === 0, "the office can read it but not change it");
  const mgrEdit = await as(
    managerA,
    `UPDATE public.account_proposals SET notes = 'Net 30' WHERE id = '${p1.id}' RETURNING id`,
  );
  check(mgrEdit.rows.length === 1, "the office manager can");
  check(
    (await as(gone, `SELECT count(*)::int AS n FROM public.account_proposals`)).rows[0].n === 0,
    "a deactivated profile reads nothing",
  );
  await refuses(
    as(crewA, `SELECT count(*) FROM public.account_proposals`, "portal_customer"),
    /permission denied/,
    "a portal customer has no grant",
  );
  await db.exec(`GRANT SELECT ON public.account_proposals TO portal_customer`);
  check(
    (await as(crewA, `SELECT count(*)::int AS n FROM public.account_proposals`, "portal_customer"))
      .rows[0].n === 0,
    "and a stray grant still shows nothing (portal_customer_denied)",
  );
  await db.exec(`REVOKE SELECT ON public.account_proposals FROM portal_customer`);
  await refuses(
    as(null, `SELECT count(*) FROM public.account_proposals`, "anon"),
    /permission denied/,
    "anon has no grant on proposals",
  );
  await refuses(
    as(null, `SELECT count(*) FROM public.account_proposal_lines`, "anon"),
    /permission denied/,
    "or on their lines",
  );
  check(
    (
      await db.query(
        `SELECT grantee FROM information_schema.role_table_grants
          WHERE table_name IN ('account_proposals', 'account_proposal_lines')
            AND grantee IN ('anon', 'PUBLIC')`,
      )
    ).rows.length === 0,
    "no anon or PUBLIC grant at all",
  );
  check(
    (
      await db.query(
        `SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname LIKE '%account_proposal%'
            AND p.prosecdef AND NOT ('search_path=""' = ANY (p.proconfig))`,
      )
    ).rows.length === 0,
    "every SECURITY DEFINER function here pins an empty search_path",
  );
  check(
    (
      await db.query(
        `SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname LIKE '%account_proposal%'
            AND (has_function_privilege('anon', p.oid, 'EXECUTE')
              OR (p.proname LIKE 'tg_%' AND has_function_privilege('authenticated', p.oid, 'EXECUTE')))`,
      )
    ).rows.length === 0,
    "anon executes none of them, and no client role holds a trigger function",
  );

  /* ---- 3: the money ------------------------------------------------------- */
  await line(repA, p1.id, "Monthly moisture survey", 2, 150.5);
  await line(repA, p1.id, "Emergency call-out retainer", 3, 33.333);
  let row = await proposal(p1.id);
  check(row.subtotal === "400.99" && row.total === "400.99", "subtotal = 2 x 150.50 + 3 x 33.33");
  const lt = (
    await as(
      repA,
      `SELECT line_total::text AS t FROM public.account_proposal_lines
        WHERE proposal_id = '${p1.id}' ORDER BY line_total`,
    )
  ).rows.map((r) => r.t);
  check(lt.join(",") === "99.99,301.00", "each line's total is its quantity times its price");
  await refuses(
    as(
      repA,
      `INSERT INTO public.account_proposal_lines (proposal_id, description, quantity, unit_price, line_total)
       VALUES ('${p1.id}', 'Free money', 1, 1, 1000000)`,
    ),
    /generated|cannot insert/i,
    "a line total cannot be written",
  );
  await as(
    repA,
    `UPDATE public.account_proposals SET subtotal = 1, total = 1 WHERE id = '${p1.id}'`,
  );
  row = await proposal(p1.id);
  check(row.total === "400.99", "a client's subtotal/total are ignored");
  await as(
    repA,
    `UPDATE public.account_proposal_lines SET quantity = 1 WHERE proposal_id = '${p1.id}'
        AND description = 'Monthly moisture survey'`,
  );
  check((await proposal(p1.id)).total === "250.49", "changing a line changes the total");
  await refuses(
    line(repA, p1.id, "Negative", 1, -5),
    /check constraint/,
    "a negative price is refused",
  );
  check(
    (await as(repB, `SELECT count(*)::int AS n FROM public.account_proposal_lines`)).rows[0].n ===
      0,
    "lines follow their proposal: another office sees none",
  );
  await refuses(
    line(crewA, p1.id, "Crew line", 1, 1),
    /row-level security/,
    "and only its writers add them",
  );

  /* ---- 4: the lifecycle --------------------------------------------------- */
  await refuses(
    as(
      repA,
      `INSERT INTO public.account_proposals (account_id, title, created_by, status)
       VALUES ('${acctConv}', 'Born signed', '${repA}', 'signed')`,
    ),
    /starts as a draft/,
    "a proposal cannot be born signed",
  );
  await refuses(
    setStatus(repA, p1.id, "signed"),
    /cannot be marked signed/,
    "draft -> signed is refused",
  );
  await refuses(
    as(
      repA,
      `UPDATE public.account_proposals SET template_id = '${tpl}', template_version_id = '${otherV1}'
        WHERE id = '${p1.id}'`,
    ),
    /different template/,
    "a template version must belong to its template",
  );
  await as(
    repA,
    `UPDATE public.account_proposals SET template_id = '${tpl}', template_version_id = '${tplV1}',
            stage_note = 'forged', sent_at = '2020-01-01'
      WHERE id = '${p1.id}'`,
  );
  row = await proposal(p1.id);
  check(
    row.stage_note === null && row.sent_at === null,
    "stamps and the automation note cannot be forged",
  );

  // A document on another account cannot be linked to this proposal.
  const strayDoc = (
    await one(
      `INSERT INTO public.documents (account_id, location_id, created_by)
       VALUES ('${acctWon}', '${officeA}', '${repA}') RETURNING id::text`,
    )
  ).id;
  await refuses(
    setStatus(repA, p1.id, "sent", `, document_id = '${strayDoc}'`),
    /not on this account/,
    "the signing document must be on the same account",
  );
  const doc1 = (
    await one(
      `INSERT INTO public.documents (account_id, location_id, status, created_by)
       VALUES ('${acctConv}', '${officeA}', 'pending_signature', '${repA}') RETURNING id::text`,
    )
  ).id;

  /* ---- 5: sent moves the card -------------------------------------------- */
  await setStatus(repA, p1.id, "sent", `, document_id = '${doc1}'`);
  row = await proposal(p1.id);
  check(row.status === "sent" && row.sent_at !== null, "draft -> sent stamps sent_at");
  check(row.sent_by === repA && row.document_id === doc1, "and who sent it, and the document");
  check((await stageOf(acctConv)) === "proposal_sent", "the card moved to Proposal sent");
  let hist = await lastHistory(acctConv);
  check(
    hist.key === "proposal_sent" && hist.changed_by === repA,
    "through the account's own history trigger, as the rep — a drag's history row",
  );
  check(
    hist.reason === "Automation rule: proposal sent — Annual water mitigation agreement",
    "carrying what moved it",
  );
  check(row.stage_note === "Moved to Proposal sent.", "and the proposal says so");
  await refuses(
    as(repA, `UPDATE public.account_proposals SET title = 'Changed' WHERE id = '${p1.id}'`),
    /Only a draft/,
    "a sent proposal's wording is fixed",
  );
  await refuses(line(repA, p1.id, "Sneaky extra", 1, 99), /row-level security/, "so are its lines");
  await refuses(
    setStatus(repA, p1.id, "draft"),
    /cannot be marked draft/,
    "sent -> draft is refused",
  );
  check(
    (await as(repA, `DELETE FROM public.account_proposals WHERE id = '${p1.id}' RETURNING id`)).rows
      .length === 0,
    "a sent proposal cannot be deleted",
  );

  const sendFresh = async (account, title) => {
    const p = await create(repA, account, title);
    await line(repA, p.id, "Service", 1, 1000);
    await setStatus(repA, p.id, "sent");
    return p.id;
  };
  const pWon = await sendFresh(acctWon, "Upsell");
  check((await stageOf(acctWon)) === "active_client", "never backwards: a won client stays won");
  check(
    (await proposal(pWon)).stage_note === "Not moved: already at Active Client.",
    "and the proposal says why",
  );
  await sendFresh(acctGhost, "Last try");
  check((await stageOf(acctGhost)) === "goasted", "a card past it (GOASTED) stays too");
  const pBare = await sendFresh(acctBare, "No stage");
  check(
    (await stageOf(acctBare)) === "open" &&
      (await proposal(pBare)).stage_note === "Not moved: this pipeline has no Proposal sent stage.",
    "a pipeline without the stage leaves the card alone",
  );
  const pRel = await sendFresh(acctRel, "Vendor programme");
  check((await stageOf(acctRel)) === "proposal_sent", "the Relationship pipeline moves too");

  /* ---- 6: the customer signs ---------------------------------------------- */
  // As complete_document_signing_atomic does: the service role, nobody signed in.
  await as(
    null,
    `UPDATE public.documents SET status = 'signed', signed_at = now() WHERE id = '${doc1}'`,
    "service_role",
  );
  row = await proposal(p1.id);
  check(
    row.status === "signed" && row.signed_at !== null,
    "the signed document signs the proposal",
  );
  check((await stageOf(acctConv)) === "active_client", "and the client is activated");
  const acct = await one(
    `SELECT status, green_light_date::text AS g, lost_reason FROM public.accounts WHERE id = '${acctConv}'`,
  );
  check(
    acct.status === "active" && acct.g !== null && acct.lost_reason === null,
    "through pipeline_activate_client: status, green light, no stray reason",
  );
  hist = await lastHistory(acctConv);
  check(
    hist.key === "active_client" && hist.changed_by === repA,
    "credited to the rep who sent it",
  );
  check(
    hist.reason.startsWith(
      "Automation rule: proposal signed — Annual water mitigation agreement",
    ) && hist.reason.includes("Green light"),
    "with what moved it, and the activation's own green-light note",
  );
  const notes = (
    await db.query(
      `SELECT user_id::text, title, body FROM public.notifications WHERE entity_id = '${acctConv}'`,
    )
  ).rows;
  check(
    notes.length === 1 && notes[0].user_id === repA && /onboarding/.test(notes[0].body),
    "the rep is told, once, and asked to finish onboarding",
  );
  await refuses(setStatus(repA, p1.id, "declined"), /cannot be marked declined/, "signed is final");

  // Relationship: its won stage is Active.
  await setStatus(repA, pRel, "signed");
  check((await stageOf(acctRel)) === "active", "a hand Mark signed wins the Relationship card too");
  check(
    (await lastHistory(acctRel)).changed_by === repA &&
      (await db.query(`SELECT 1 FROM public.notifications WHERE entity_id = '${acctRel}'`)).rows
        .length === 0,
    "as the rep who pressed it, with no notification to themselves",
  );

  // A move that blows up never fails the signature.
  const pBoom = await create(repA, acctBoom, "Fragile");
  const docBoom = (
    await one(
      `INSERT INTO public.documents (account_id, location_id, status, created_by)
       VALUES ('${acctBoom}', '${officeA}', 'pending_signature', '${repA}') RETURNING id::text`,
    )
  ).id;
  await db.exec(`UPDATE public.accounts SET name = 'Fine for now' WHERE id = '${acctBoom}'`);
  await setStatus(repA, pBoom.id, "sent", `, document_id = '${docBoom}'`);
  await db.exec(`UPDATE public.accounts SET name = 'Explodes' WHERE id = '${acctBoom}'`);
  await as(
    null,
    `UPDATE public.documents SET status = 'signed' WHERE id = '${docBoom}'`,
    "service_role",
  );
  check(
    (await one(`SELECT status::text AS s FROM public.documents WHERE id = '${docBoom}'`)).s ===
      "signed",
    "the signature stands",
  );
  row = await proposal(pBoom.id);
  check(
    row.status === "signed" && row.stage_note === "Not moved: boom",
    "and the proposal says why it did not move",
  );
  check((await stageOf(acctBoom)) === "proposal_sent", "the card stays where it was");

  /* ---- 7: declined and expired ------------------------------------------- */
  const pDecl = await sendFresh(acctDecl, "Too pricey");
  check((await stageOf(acctDecl)) === "proposal_sent", "sent from Active Outreach moves it too");
  await setStatus(repA, pDecl, "declined", `, declined_reason = '  Went with a cheaper vendor  '`);
  row = await proposal(pDecl);
  check(
    row.status === "declined" && row.declined_at !== null,
    "sent -> declined stamps declined_at",
  );
  check(row.declined_reason === "Went with a cheaper vendor", "and keeps the reason, trimmed");
  check((await stageOf(acctDecl)) === "proposal_sent", "declined leaves the stage alone");
  check(row.stage_note === "Declined — the card stays where it is.", "and says so");
  const pExp = await sendFresh(acctBare, "Will lapse");
  await setStatus(repA, pExp, "expired");
  check((await proposal(pExp)).expired_at !== null, "sent -> expired stamps expired_at");

  // Withdrawing the signing document (deleting it before it is signed)
  // unlinks it; the proposal stays sent and keeps its wording.
  const pUnlink = await create(repA, acctBare, "Withdrawn link");
  await line(repA, pUnlink.id, "Service", 1, 10);
  const docUnlink = (
    await one(
      `INSERT INTO public.documents (account_id, location_id, status, created_by)
       VALUES ('${acctBare}', '${officeA}', 'pending_signature', '${repA}') RETURNING id::text`,
    )
  ).id;
  await setStatus(repA, pUnlink.id, "sent", `, document_id = '${docUnlink}'`);
  await db.exec(`DELETE FROM public.documents WHERE id = '${docUnlink}'`);
  row = await proposal(pUnlink.id);
  check(
    row.document_id === null && row.status === "sent" && row.total === "10.00",
    "deleting an unsigned signing document unlinks it and leaves the proposal sent",
  );
  await refuses(
    as(
      repA,
      `UPDATE public.account_proposals SET document_id = '${doc1}' WHERE id = '${pUnlink.id}'`,
    ),
    /Only a draft/,
    "but a sent proposal cannot be pointed at another document",
  );

  // Only a draft is deleted, by its writers.
  const draft = await create(repA, acctDecl, "Scratch");
  await line(repA, draft.id, "x", 1, 1);
  check(
    (await as(crewA, `DELETE FROM public.account_proposals WHERE id = '${draft.id}' RETURNING id`))
      .rows.length === 0,
    "the office cannot delete a draft",
  );
  check(
    (await as(repA, `DELETE FROM public.account_proposals WHERE id = '${draft.id}' RETURNING id`))
      .rows.length === 1,
    "its rep can",
  );
  check(
    (
      await one(
        `SELECT count(*)::int AS n FROM public.account_proposal_lines WHERE proposal_id = '${draft.id}'`,
      )
    ).n === 0,
    "and its lines go with it",
  );

  /* ---- 8: Proposals sent ------------------------------------------------- */
  await db.exec(`
    INSERT INTO public.quotes VALUES
      ('${repA}', 'submitted', now()), ('${repA}', 'draft', now()),
      ('${repA}', 'approved', now() - interval '90 days');
    -- Even the table owner cannot backdate a send through the guard...
    UPDATE public.account_proposals SET sent_at = now() - interval '90 days' WHERE id = '${pExp}';
  `);
  check(
    (
      await one(
        `SELECT sent_at > now() - interval '1 day' AS fresh FROM public.account_proposals WHERE id = '${pExp}'`,
      )
    ).fresh,
    "a backdated sent_at is ignored, so the count cannot be gamed",
  );
  // ...so the fixture steps round it to put one proposal outside the window.
  await db.exec(`
    ALTER TABLE public.account_proposals DISABLE TRIGGER account_proposals_guard;
    UPDATE public.account_proposals SET sent_at = now() - interval '90 days' WHERE id = '${pExp}';
    ALTER TABLE public.account_proposals ENABLE TRIGGER account_proposals_guard;
  `);
  const metrics = async () =>
    (
      await as(
        admin,
        `SELECT user_id::text, proposals_sent::int AS n FROM public.sales_rep_metrics(
           now() - interval '7 days', now() + interval '1 minute')`,
      )
    ).rows;
  const m = await metrics();
  const sentInWindow = (
    await one(
      `SELECT count(*)::int AS n FROM public.account_proposals
        WHERE sent_by = '${repA}' AND sent_at >= now() - interval '7 days'`,
    )
  ).n;
  check(sentInWindow === 8, "eight proposals sent by the rep this week in the fixture");
  check(
    m.find((r) => r.user_id === repA).n === 1 + sentInWindow,
    "Proposals sent = submitted quotes + proposals sent in the window (drafts and old ones out)",
  );
  check(m.find((r) => r.user_id === repB).n === 0, "another rep's count is their own");

  console.log(`account-proposals.pglite: ${assertions} assertions passed`);
} finally {
  await db.close();
}
