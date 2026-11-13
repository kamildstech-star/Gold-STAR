// Run with: node supabase/tests/intake-office-routing.pglite.mjs <existing PGlite dist/index.js>
// In-memory fixtures only. No connection string, network access or live writes.
//
// Which office an intake form goes to. Mark: "add in here a address match for
// intake, that will set certain states to certain offices that overrides the
// closest match". The migrations under test are READ FROM THE FILES, in order,
// never retyped here: 20260903223000 (the office on a submission and its RLS,
// live), 20261006170000 (the rules) and 20261006171000 (an office set by
// hand on the intake card — Mark: "give a way to switch the office quickly if
// they don't like the match").
//
// The matching itself is TypeScript (src/lib/intake-routing.ts, tested in
// intake-office-routing.test.ts); what the database owns is who may read and
// write the rules and what a stored rule or reason may look like.
//
// What it proves:
//   1. anyone signed in can read the rules; only a privileged user (the
//      Territory page's editors — the markets/zones predicate) can add,
//      change or remove one; anon has no privilege at all;
//   2. a rule is a two-letter state or a 3–5 digit ZIP prefix, one office per
//      state or prefix, and deleting an office takes its rules with it;
//   3. created_by is the signed-in user;
//   4. the reason column takes only the reasons the code writes;
//   5. portal customers are denied by the restrictive policy;
//   6. a privileged user can re-route a waiting general-link form (what the
//      Territory page does after a rule change); an office manager cannot
//      touch a form that is not in an office they manage;
//   7. the migrations can be run twice;
//   8. the quick switch: a manager of both offices can move a form between
//      them (an office link's form too); nobody can push a form into an
//      office they do not manage; the database stamps WHO and WHEN from the
//      session (a forged chooser is replaced by the caller) and marks it not
//      auto-assigned, so the rule re-route's filter never matches it again;
//      a write that chooses nothing keeps the stamp; the service role is not
//      stamped; nobody signed in can call the trigger function.
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

const admin = "11111111-1111-4111-8111-111111111111"; // privileged
const upMgr = "22222222-2222-4222-8222-222222222222"; // manages NY-Upstate only
const njMgr = "33333333-3333-4333-8333-333333333333"; // manages Lakewood only
const bothMgr = "44444444-4444-4444-8444-444444444444"; // manages Upstate and Lakewood
const newark = "99999999-9999-4999-8999-999999999999"; // managed by nobody but admin
const officeForm = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const nyUp = "66666666-6666-4666-8666-666666666666";
const lakewood = "77777777-7777-4777-8777-777777777777";
const doomed = "88888888-8888-4888-8888-888888888888";
const generalLink = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const upLink = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const scrantonForm = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const unroutedForm = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

try {
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role BYPASSRLS;
    CREATE ROLE portal_customer;
    CREATE SCHEMA auth;
    GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role, portal_customer;

    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
      $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);
    INSERT INTO auth.users VALUES ('${admin}'), ('${upMgr}'), ('${njMgr}'), ('${bothMgr}');

    CREATE TABLE public.locations (id uuid PRIMARY KEY, code text, name text);
    INSERT INTO public.locations VALUES
      ('${nyUp}', 'NY-UP', 'NY-Upstate'), ('${lakewood}', 'NJ', 'Lakewood'),
      ('${doomed}', 'OLD', 'Closing'), ('${newark}', 'NW', 'Newark');

    -- Stand-ins for the live helpers, with the same meaning.
    CREATE TABLE public.test_admins (user_id uuid);
    CREATE TABLE public.test_managers (user_id uuid, location_id uuid);
    INSERT INTO public.test_admins VALUES ('${admin}');
    INSERT INTO public.test_managers VALUES ('${upMgr}', '${nyUp}'), ('${njMgr}', '${lakewood}'),
      ('${bothMgr}', '${nyUp}'), ('${bothMgr}', '${lakewood}');
    CREATE FUNCTION public.is_privileged(u uuid) RETURNS boolean LANGUAGE sql STABLE
      SECURITY DEFINER AS $$ SELECT EXISTS (SELECT 1 FROM public.test_admins WHERE user_id = u) $$;
    CREATE FUNCTION public.can_manage_location(u uuid, l uuid) RETURNS boolean LANGUAGE sql STABLE
      SECURITY DEFINER AS $$ SELECT l IS NOT NULL AND (public.is_privileged(u) OR EXISTS (
        SELECT 1 FROM public.test_managers WHERE user_id = u AND location_id = l)) $$;
    CREATE FUNCTION public.can_view_location(u uuid, l uuid) RETURNS boolean LANGUAGE sql STABLE
      SECURITY DEFINER AS $$ SELECT public.can_manage_location(u, l) $$;
    CREATE FUNCTION public.can_view_job(u uuid, j uuid) RETURNS boolean LANGUAGE sql STABLE
      AS $$ SELECT false $$;
    CREATE FUNCTION public.can_manage_job(u uuid, j uuid) RETURNS boolean LANGUAGE sql STABLE
      AS $$ SELECT false $$;

    CREATE TABLE public.intake_requests (
      id uuid PRIMARY KEY, job_id uuid, location_id uuid, tradeshow_id uuid
    );
    CREATE TABLE public.intake_submissions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      request_id uuid NOT NULL REFERENCES public.intake_requests(id),
      job_id uuid,
      status text NOT NULL DEFAULT 'pending',
      fields jsonb NOT NULL DEFAULT '{}'
    );
    ALTER TABLE public.intake_submissions ENABLE ROW LEVEL SECURITY;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.intake_submissions, public.intake_requests
      TO authenticated;
    ALTER TABLE public.intake_requests ENABLE ROW LEVEL SECURITY;
    CREATE POLICY see_requests ON public.intake_requests FOR SELECT TO authenticated USING (true);
  `);

  await db.exec(migration("20260903223000_intake_general_links.sql"));
  await db.exec(migration("20261006170000_intake_office_rules.sql"));
  await db.exec(migration("20261006171000_intake_office_set_by_hand.sql"));
  // 7. Safe to re-run.
  await db.exec(migration("20261006170000_intake_office_rules.sql"));
  await db.exec(migration("20261006171000_intake_office_set_by_hand.sql"));
  check(
    (
      await db.query(`SELECT count(*)::int AS n FROM pg_constraint
                       WHERE conname = 'intake_submissions_location_route_reason_check'`)
    ).rows[0].n === 1,
    "one reason check after two runs",
  );

  await db.exec(`
    INSERT INTO public.intake_requests VALUES
      ('${generalLink}', NULL, NULL, NULL), ('${upLink}', NULL, '${nyUp}', NULL);
    INSERT INTO public.intake_submissions
      (id, request_id, fields, location_id, location_auto_assigned, location_route_reason)
    VALUES
      ('${scrantonForm}', '${generalLink}', '{"site_address":"740 Oak St, Scranton, PA 18508"}',
       '${nyUp}', true, 'nearest'),
      ('${unroutedForm}', '${generalLink}', '{"site_address":"1 Ocean Dr, Miami, FL"}',
       NULL, false, 'none'),
      ('${officeForm}', '${upLink}', '{"site_address":"9 Front St, Binghamton, NY"}',
       NULL, false, NULL);
  `);

  /** Run one statement as a signed-in user; never leaves the role set. */
  const as = async (uid, sql, role = "authenticated") => {
    await db.exec(`SET ROLE ${role}; SET request.jwt.claim.sub = '${uid}'`);
    try {
      return await db.query(sql);
    } finally {
      await db.exec("RESET ROLE; SELECT set_config('request.jwt.claim.sub','',false)");
    }
  };

  /* ---- 1 & 3: who reads, who writes ----------------------------------- */
  const added = await as(
    admin,
    `INSERT INTO public.intake_office_rules (match_kind, match_value, location_id)
     VALUES ('state', 'PA', '${lakewood}') RETURNING created_by`,
  );
  check(added.rows[0].created_by === admin, "created_by is the signed-in user");

  check(
    (await as(upMgr, `SELECT match_value FROM public.intake_office_rules`)).rows.length === 1,
    "an office manager can read the rules (the inbox re-route reads them)",
  );
  await refuses(
    as(
      upMgr,
      `INSERT INTO public.intake_office_rules (match_kind, match_value, location_id)
       VALUES ('state', 'NJ', '${nyUp}')`,
    ),
    /row-level security/,
    "a non-privileged user cannot add a rule",
  );
  check(
    (
      await as(
        upMgr,
        `UPDATE public.intake_office_rules SET location_id = '${nyUp}' WHERE match_value = 'PA'
         RETURNING id`,
      )
    ).rows.length === 0,
    "a non-privileged user cannot repoint a rule",
  );
  check(
    (await as(upMgr, `DELETE FROM public.intake_office_rules RETURNING id`)).rows.length === 0,
    "a non-privileged user cannot remove a rule",
  );
  await refuses(
    as(admin, `SELECT * FROM public.intake_office_rules`, "anon"),
    /permission denied/,
    "anon has no privilege on the rules",
  );

  /* ---- 2: what a rule may look like ----------------------------------- */
  const addAsAdmin = (kind, value, loc = nyUp) =>
    as(
      admin,
      `INSERT INTO public.intake_office_rules (match_kind, match_value, location_id)
       VALUES ('${kind}', '${value}', '${loc}')`,
    );
  await refuses(addAsAdmin("state", "pa"), /value_shape/, "a state is upper-case");
  await refuses(addAsAdmin("state", "PEN"), /value_shape/, "a state is two letters");
  await refuses(addAsAdmin("zip", "18"), /value_shape/, "a ZIP prefix is at least 3 digits");
  await refuses(addAsAdmin("zip", "185086"), /value_shape/, "a ZIP prefix is at most 5 digits");
  await refuses(addAsAdmin("county", "Lackawanna"), /check/, "only state and zip rules exist");
  await refuses(addAsAdmin("state", "PA"), /one_per_value/, "one office per state");
  await addAsAdmin("zip", "185");
  await addAsAdmin("zip", "18508", lakewood);
  check(true, "a ZIP prefix and a longer one under it can both exist");
  await refuses(addAsAdmin("zip", "185"), /one_per_value/, "one office per ZIP prefix");

  await addAsAdmin("state", "DE", doomed);
  await db.exec(`DELETE FROM public.locations WHERE id = '${doomed}'`);
  check(
    (await db.query(`SELECT 1 FROM public.intake_office_rules WHERE match_value = 'DE'`)).rows
      .length === 0,
    "deleting an office takes its rules with it",
  );

  /* ---- 4: the reason column ------------------------------------------ */
  await refuses(
    db.query(
      `UPDATE public.intake_submissions SET location_route_reason = 'guess' WHERE id = '${scrantonForm}'`,
    ),
    /location_route_reason_check/,
    "the reason column takes only the reasons the code writes",
  );

  /* ---- 5: portal customers ------------------------------------------- */
  check(
    (
      await db.query(`SELECT permissive, roles::text AS roles FROM pg_policies
                       WHERE tablename = 'intake_office_rules' AND policyname = 'portal_customer_denied'`)
    ).rows.some((p) => p.permissive === "RESTRICTIVE" && p.roles.includes("portal_customer")),
    "portal customers are denied by a restrictive policy",
  );

  /* ---- 6: re-routing a waiting form after a rule change ---------------- */
  // An office manager elsewhere cannot touch the Upstate form at all.
  check(
    (
      await as(
        njMgr,
        `UPDATE public.intake_submissions SET location_id = '${lakewood}'
          WHERE id = '${scrantonForm}' RETURNING id`,
      )
    ).rows.length === 0,
    "a Lakewood manager cannot pull an Upstate form into Lakewood",
  );
  // Nor can anyone but privileged staff route a form nothing matched.
  check(
    (
      await as(
        upMgr,
        `UPDATE public.intake_submissions SET location_id = '${nyUp}'
          WHERE id = '${unroutedForm}' RETURNING id`,
      )
    ).rows.length === 0,
    "an office manager cannot claim an unrouted general-link form",
  );
  // The Territory page's re-route, as the privileged user who saved PA → Lakewood.
  const moved = await as(
    admin,
    `UPDATE public.intake_submissions
        SET location_id = '${lakewood}', location_auto_assigned = true,
            location_route_reason = 'state_rule', location_route_detail = 'PA'
      WHERE id = '${scrantonForm}' AND job_id IS NULL AND status = 'pending'
        AND (location_auto_assigned OR location_id IS NULL)
      RETURNING location_route_reason, location_route_detail`,
  );
  check(
    moved.rows.length === 1 &&
      moved.rows[0].location_route_reason === "state_rule" &&
      moved.rows[0].location_route_detail === "PA",
    "a privileged user re-routes the waiting Scranton form by the new rule",
  );
  check(
    (
      await as(
        njMgr,
        `SELECT location_route_reason FROM public.intake_submissions WHERE id = '${scrantonForm}'`,
      )
    ).rows.length === 1,
    "once re-routed, the Lakewood office sees it",
  );
  check(
    (await as(upMgr, `SELECT 1 FROM public.intake_submissions WHERE id = '${scrantonForm}'`)).rows
      .length === 0,
    "and Upstate no longer does",
  );

  /* ---- 8: the quick switch on the intake card ----------------------- */
  const chosen = await as(
    bothMgr,
    `UPDATE public.intake_submissions
        SET location_id = '${nyUp}', location_auto_assigned = false, location_set_by = '${admin}'
      WHERE id = '${scrantonForm}' AND job_id IS NULL
      RETURNING location_set_by, location_set_at, location_auto_assigned`,
  );
  check(chosen.rows.length === 1, "a manager of both offices moves the form between them");
  check(
    chosen.rows[0].location_set_by === bothMgr,
    "the chooser is the caller, whoever the browser named",
  );
  check(chosen.rows[0].location_set_at instanceof Date, "and the time is stamped");
  check(chosen.rows[0].location_auto_assigned === false, "and it is no longer the address's guess");

  await refuses(
    as(
      upMgr,
      `UPDATE public.intake_submissions SET location_id = '${newark}', location_set_by = '${upMgr}'
        WHERE id = '${scrantonForm}'`,
    ),
    /row-level security/,
    "nobody can push a form into an office they do not manage",
  );
  check(
    (
      await as(
        njMgr,
        `UPDATE public.intake_submissions SET location_id = '${lakewood}', location_set_by = '${njMgr}'
          WHERE id = '${scrantonForm}' RETURNING id`,
      )
    ).rows.length === 0,
    "nor pull one out of an office they do not manage",
  );

  // The Territory page's re-route filter never matches a person's choice.
  check(
    (
      await as(
        admin,
        `UPDATE public.intake_submissions
            SET location_id = '${lakewood}', location_route_reason = 'state_rule'
          WHERE id = '${scrantonForm}' AND job_id IS NULL AND status = 'pending'
            AND (location_auto_assigned OR location_id IS NULL)
          RETURNING id`,
      )
    ).rows.length === 0,
    "a rule change does not move a form a person placed",
  );

  const stampedAt = (
    await db.query(
      `SELECT location_set_at FROM public.intake_submissions WHERE id = '${scrantonForm}'`,
    )
  ).rows[0].location_set_at.getTime();
  await as(
    bothMgr,
    `UPDATE public.intake_submissions SET location_set_at = '2001-01-01' WHERE id = '${scrantonForm}'`,
  );
  check(
    (
      await db.query(
        `SELECT location_set_at FROM public.intake_submissions WHERE id = '${scrantonForm}'`,
      )
    ).rows[0].location_set_at.getTime() === stampedAt,
    "a write that chooses nothing cannot rewrite when the choice was made",
  );

  const moved2 = await as(
    bothMgr,
    `UPDATE public.intake_submissions
        SET location_id = '${lakewood}', location_auto_assigned = false, location_set_by = '${bothMgr}'
      WHERE id = '${officeForm}' RETURNING location_set_by`,
  );
  check(
    moved2.rows.length === 1 && moved2.rows[0].location_set_by === bothMgr,
    "a form from an office's own link can be handed to another office the manager runs",
  );

  await db.query(
    `UPDATE public.intake_submissions SET location_set_by = '${upMgr}', location_id = '${nyUp}'
      WHERE id = '${officeForm}'`,
  );
  check(
    (
      await db.query(
        `SELECT location_set_by FROM public.intake_submissions WHERE id = '${officeForm}'`,
      )
    ).rows[0].location_set_by === upMgr,
    "with no session (the service role) nothing is stamped over",
  );

  check(
    (
      await db.query(
        `SELECT has_function_privilege('authenticated', 'public.stamp_intake_office_choice()', 'EXECUTE') AS ok`,
      )
    ).rows[0].ok === false,
    "nobody signed in can call the trigger function",
  );

  console.log(`intake-office-routing.pglite: ${assertions} assertions passed`);
} finally {
  await db.close();
}
