// Run with: node supabase/tests/client-portal-security.pglite.mjs <existing PGlite dist/index.js>
// In-memory fixtures only. No connection string, network access or live writes.
//
// The client portal's security acceptance criteria, as database tests. David,
// 24 Sep: "they should only have access to whatever is shared to them on a
// job-by-job basis." Both migrations are READ FROM THE FILES, never retyped
// here, so this cannot drift from what ships.
//
// The staff side of the schema is stubbed with only the columns the portal
// touches, and with the WORST policies the review worried about: a table
// readable by any signed-in session (`TO authenticated USING (true)`), a
// table readable by anyone at all (`TO public USING (true)`), a table with no
// RLS, a storage bucket open to every signed-in user, and a staff SECURITY
// DEFINER function left executable by PUBLIC. Supabase's default privileges
// are reproduced, so every stub table is granted to anon and authenticated
// exactly as a real one would be.
//
// What it proves:
//   1. DENY BY DEFAULT — a customer session reads, writes and calls nothing
//      outside the five portal functions: every staff table, the no-RLS
//      table, storage, and the PUBLIC-executable staff function all refuse.
//      A table created AFTER the migration is refused too.
//   2. ISOLATION — customer A never sees customer B's job, documents, photos
//      or invoices, whichever id is passed; an unshared job and a made-up id
//      return exactly what a real-but-foreign id returns: nothing.
//   3. PER-FIELD — what comes back carries no cost, margin, note or EXIF field.
//   4. SHARING — nothing is visible until chosen; unsharing an item or the job
//      takes effect on the very next read; a job or item can only be shared
//      if it belongs to that customer's job.
//   5. IDENTITY — invitations are single-use, expiring, superseded by a new
//      one; a portal sign-in gets no staff profile; can never be given a role,
//      office, region, permission or profile; can never have its auth role
//      switched to a staff one; a staff email can never become a customer.
//   6. STAFF are refused the customer functions, and staff access to their own
//      tables is unchanged by the sweep.
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

// Random-looking v4 uuids throughout, as production uses.
const U = {
  staff: "5a1f0c3e-8d2b-4e61-9c7a-0b3d4e5f6a71",
  crew: "6b2e1d4f-9e3c-4f72-8d8b-1c4e5f6a7b82",
  custA: "7c3f2e5a-0f4d-4a83-9e9c-2d5f6a7b8c93",
  custB: "8d4a3f6b-1a5e-4b94-8fad-3e6a7b8c9da4",
  stranger: "9e5b4a7c-2b6f-4ca5-90be-4f7b8c9daeb5",
};
const LOC = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
const ACC_A = "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e";
const ACC_B = "c3d4e5f6-a7b8-4c9d-8e1f-2a3b4c5d6e7f";
const CON_A = "d4e5f6a7-b8c9-4d0e-9f2a-3b4c5d6e7f80";
const CON_B = "e5f6a7b8-c9d0-4e1f-8a3b-4c5d6e7f8091";
const JOB_A = "f6a7b8c9-d0e1-4f2a-9b4c-5d6e7f8091a2";
const JOB_A2 = "0718293a-4b5c-4d6e-8f70-8192a3b4c5d6";
const JOB_B = "1829304b-5c6d-4e7f-9081-92a3b4c5d6e7";
const DOC_A1 = "2930415c-6d7e-4f80-81a2-a3b4c5d6e7f8";
const DOC_A2 = "3a41526d-7e8f-4091-92b3-b4c5d6e7f809";
const DOC_A_DRAFT = "4b52637e-8f90-41a2-a3c4-c5d6e7f8091a";
const DOC_B1 = "5c63748f-90a1-42b3-b4d5-d6e7f8091a2b";
const ALB_A = "6d748590-a1b2-43c4-85e6-e7f8091a2b3c";
const FOLD_A = "7e8596a1-b2c3-44d5-96f7-f8091a2b3c4d";
const ALB_B = "8f96a7b2-c3d4-45e6-a708-091a2b3c4d5e";
// Photo ids are ULIDs, as src/lib/photos.ts makes them: photos.id is TEXT in
// production (20260728175932), not uuid. The stubs below used to say uuid,
// which is why this fixture passed a migration the live database refused.
const PH_A1 = "01J8Z3K4M5N6P7Q8R9S0T1V2W3";
const PH_A2 = "01J8Z3K4M5N6P7Q8R9S0T1V2W4";
const PH_B1 = "01J8Z3K4M5N6P7Q8R9S0T1V2W5";
const INV_A = "c3daebf6-0718-492a-ab4c-4d5e6f708192";
const INV_A_DRAFT = "d4ebfc07-1829-4a3b-bc5d-5e6f708192a3";
const INV_B = "e5fc0d18-293a-4b4c-8d6e-6f708192a3b4";

const hash = (c) => c.repeat(64); // a valid 64-hex token hash per invitation
const H = { a: hash("a"), b: hash("b"), a2: hash("c"), aOld: hash("d"), expired: hash("e") };

try {
  /* ---- A minimal Supabase ------------------------------------------- */
  await db.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE ROLE authenticator NOINHERIT;
    GRANT anon, authenticated, service_role TO authenticator;
    CREATE SCHEMA auth;
    CREATE SCHEMA storage;
    CREATE SCHEMA goldstar_private;
    GRANT USAGE ON SCHEMA public, auth, storage TO anon, authenticated, service_role;
    GRANT USAGE ON SCHEMA goldstar_private TO authenticated, service_role;

    -- Supabase's own default privileges: every new table, function and
    -- sequence in public handed to all three API roles.
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;

    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
      $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS
      $$ SELECT coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
    GRANT EXECUTE ON FUNCTION auth.uid(), auth.jwt() TO anon, authenticated, service_role;

    CREATE TABLE auth.users (
      id uuid PRIMARY KEY,
      email text,
      role text,
      raw_user_meta_data jsonb NOT NULL DEFAULT '{}',
      raw_app_meta_data jsonb NOT NULL DEFAULT '{}'
    );

    CREATE TYPE public.app_role AS ENUM ('admin', 'owner', 'crew');
    CREATE TYPE public.notification_type AS ENUM ('user_signup');
    CREATE TYPE public.notification_priority AS ENUM ('high');
    CREATE TYPE public.invoice_status AS ENUM ('draft', 'sent', 'partial', 'paid');

    CREATE TABLE public.profiles (
      user_id uuid PRIMARY KEY, email text, full_name text,
      approval_status text NOT NULL DEFAULT 'pending', is_active boolean NOT NULL DEFAULT true
    );
    CREATE TABLE public.user_roles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, role public.app_role NOT NULL);
    CREATE TABLE public.location_members (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, location_id uuid NOT NULL, role text);
    CREATE TABLE public.region_members (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, region_id uuid NOT NULL);
    CREATE TABLE public.user_permissions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, permission_key text NOT NULL);
    CREATE TABLE public.notifications (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, type public.notification_type,
      title text, body text, entity_type text, entity_id uuid, href text, priority public.notification_priority
    );
    CREATE TABLE public.locations (id uuid PRIMARY KEY);
    CREATE TABLE public.accounts (id uuid PRIMARY KEY, name text, location_id uuid);
    CREATE TABLE public.contacts (
      id uuid PRIMARY KEY, account_id uuid, full_name text, email text, phone text,
      location_id uuid, archived_at timestamptz
    );
    CREATE TABLE public.jobs (
      id uuid PRIMARY KEY, job_number text, address text, locality text, region text, postal_code text,
      location_id uuid, account_id uuid, bill_to_account_id uuid, public_adjuster_account_id uuid,
      primary_contact_id uuid, public_adjuster_contact_id uuid, field_adjuster_contact_id uuid,
      desk_adjuster_contact_id uuid, independent_reviewer_contact_id uuid,
      agreed_price numeric, important_instructions text
    );
    CREATE TABLE public.job_contacts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_id uuid, contact_id uuid);
    CREATE TABLE public.job_notes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_id uuid, body text);
    CREATE TABLE public.documents (
      id uuid PRIMARY KEY, job_id uuid, name text, mime text, size_bytes int,
      created_at timestamptz NOT NULL DEFAULT now(), storage_bucket text, storage_path text,
      voided_at timestamptz, merge_data jsonb
    );
    CREATE TABLE public.projects (id uuid PRIMARY KEY, job_id uuid, name text, archived_at timestamptz);
    CREATE TABLE public.photo_folders (id uuid PRIMARY KEY, project_id uuid, parent_folder_id uuid, name text);
    -- Key types exactly as production declares them; stub-types.test.ts
    -- checks these against the real CREATE TABLEs so they cannot drift again.
    CREATE TABLE public.photos (
      id text PRIMARY KEY, project_id uuid, folder_id uuid, storage_bucket text,
      storage_path_original text, mime text, deleted_at timestamptz, captured_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(), exif_lat numeric, exif_lon numeric
    );
    CREATE TABLE public.photo_variants (photo_id text, variant text, storage_path text);
    CREATE TABLE public.invoices (
      id uuid PRIMARY KEY, job_id uuid, invoice_number text, title text, issue_date date, due_date date,
      status public.invoice_status NOT NULL DEFAULT 'draft', subtotal numeric, tax numeric, tax_rate numeric,
      total numeric, customer_name text, address text, address_line2 text, locality text, region text,
      postal_code text, office_name text, office_phone text, office_email text, office_address text,
      notes text, collected_amount numeric, carrier_shortfall numeric
    );
    CREATE TABLE public.invoice_lines (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), invoice_id uuid, position int, name text,
      description text, quantity numeric, uom text, unit_price numeric, unit_cost numeric,
      subtotal numeric, is_discount boolean DEFAULT false, note text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    -- No RLS at all: only grants stand between this and a session.
    CREATE TABLE public.staff_ledger (id serial PRIMARY KEY, margin numeric);

    -- The worst policies. Every signed-in session, and literally anyone.
    DO $$ DECLARE t text; BEGIN
      FOREACH t IN ARRAY ARRAY['profiles','user_roles','location_members','region_members',
        'user_permissions','accounts','contacts','jobs','job_contacts','documents','projects',
        'photo_folders','photos','photo_variants','invoices','invoice_lines'] LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('CREATE POLICY any_signed_in ON public.%I FOR ALL TO authenticated USING (true) WITH CHECK (true)', t);
      END LOOP;
    END $$;
    ALTER TABLE public.job_notes ENABLE ROW LEVEL SECURITY;
    CREATE POLICY anyone_at_all ON public.job_notes FOR ALL TO public USING (true) WITH CHECK (true);

    CREATE TABLE storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text, name text);
    ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
    CREATE POLICY photos_read ON storage.objects FOR SELECT TO authenticated USING (bucket_id = 'project-photos');
    GRANT ALL ON storage.objects TO anon, authenticated, service_role;

    -- The helpers the migration leans on, with production's meaning.
    CREATE FUNCTION public.is_privileged(_u uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS
      $$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _u AND role IN ('admin','owner')) $$;
    CREATE FUNCTION public.can_manage_location(_u uuid, _l uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS
      $$ SELECT public.is_privileged(_u) OR EXISTS (SELECT 1 FROM public.location_members WHERE user_id = _u AND location_id = _l AND role = 'manager') $$;
    CREATE FUNCTION public.can_view_job(_u uuid, _j uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS
      $$ SELECT EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = _j AND (public.is_privileged(_u)
           OR EXISTS (SELECT 1 FROM public.location_members m WHERE m.user_id = _u AND m.location_id = j.location_id))) $$;
    CREATE FUNCTION public.can_manage_job(_u uuid, _j uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS
      $$ SELECT EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = _j AND public.can_manage_location(_u, j.location_id)) $$;

    -- A staff definer function created the way a later migration might:
    -- Postgres grants EXECUTE on it to PUBLIC.
    CREATE FUNCTION public.staff_margin_report() RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER AS
      $$ SELECT coalesce(sum(agreed_price), 0) FROM public.jobs $$;

    -- Production's signup trigger; the migration replaces the function body.
    CREATE FUNCTION public.handle_new_user() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
    BEGIN
      INSERT INTO public.profiles (user_id, email, approval_status) VALUES (NEW.id, NEW.email, 'pending');
      RETURN NEW;
    END $$;
    CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users
      FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

    /* ---- The office, its staff and two unrelated customers ---------- */
    INSERT INTO public.locations VALUES ('${LOC}');
    INSERT INTO auth.users (id, email, role) VALUES
      ('${U.staff}', 'dana@goldstar.test', 'authenticated'),
      ('${U.crew}', 'crew@goldstar.test', 'authenticated');
    UPDATE public.profiles SET approval_status = 'approved';
    INSERT INTO public.user_roles (user_id, role) VALUES ('${U.staff}', 'admin'), ('${U.crew}', 'crew');
    INSERT INTO public.location_members (user_id, location_id, role) VALUES ('${U.crew}', '${LOC}', 'crew');

    INSERT INTO public.accounts VALUES ('${ACC_A}', 'Maple Towers', '${LOC}'), ('${ACC_B}', 'Oak Court', '${LOC}');
    INSERT INTO public.contacts (id, account_id, full_name, email, location_id) VALUES
      ('${CON_A}', '${ACC_A}', 'Alice Owner', 'Alice@Maple.test', '${LOC}'),
      ('${CON_B}', '${ACC_B}', 'Bob Owner', 'bob@oak.test', '${LOC}');
    INSERT INTO public.jobs (id, job_number, address, location_id, account_id, primary_contact_id, agreed_price, important_instructions) VALUES
      ('${JOB_A}', 'GS-1001', '12 Maple Ave', '${LOC}', '${ACC_A}', '${CON_A}', 17350, 'gate code 4471'),
      ('${JOB_A2}', 'GS-1002', '12 Maple Ave unit 2', '${LOC}', '${ACC_A}', NULL, 900, NULL),
      ('${JOB_B}', 'GS-2001', '7 Oak Ct', '${LOC}', '${ACC_B}', '${CON_B}', 22000, NULL);
    INSERT INTO public.job_notes (job_id, body) VALUES ('${JOB_A}', 'customer is slow to pay');
    INSERT INTO public.documents (id, job_id, name, mime, storage_bucket, storage_path, merge_data) VALUES
      ('${DOC_A1}', '${JOB_A}', 'Moisture map.pdf', 'application/pdf', 'documents', 'jobs/${JOB_A}/map.pdf', '{"margin": 41}'),
      ('${DOC_A2}', '${JOB_A}', 'Internal estimate.pdf', 'application/pdf', 'documents', 'jobs/${JOB_A}/est.pdf', NULL),
      ('${DOC_A_DRAFT}', '${JOB_A}', 'Unrendered', NULL, NULL, NULL, NULL),
      ('${DOC_B1}', '${JOB_B}', 'Oak contract.pdf', 'application/pdf', 'documents', 'jobs/${JOB_B}/contract.pdf', NULL);
    INSERT INTO public.projects VALUES ('${ALB_A}', '${JOB_A}', 'Kitchen loss', NULL), ('${ALB_B}', '${JOB_B}', 'Oak photos', NULL);
    INSERT INTO public.photo_folders VALUES ('${FOLD_A}', '${ALB_A}', NULL, 'Day 1');
    INSERT INTO public.photos (id, project_id, folder_id, storage_bucket, storage_path_original, mime, exif_lat) VALUES
      ('${PH_A1}', '${ALB_A}', '${FOLD_A}', 'project-photos', '${ALB_A}/a1.jpg', 'image/jpeg', 40.7),
      ('${PH_A2}', '${ALB_A}', NULL, 'project-photos', '${ALB_A}/a2.jpg', 'image/jpeg', 40.7),
      ('${PH_B1}', '${ALB_B}', NULL, 'project-photos', '${ALB_B}/b1.jpg', 'image/jpeg', 40.8);
    INSERT INTO public.photo_variants VALUES ('${PH_A1}', 'display', '${ALB_A}/a1.display.webp'),
      ('${PH_A1}', 'thumb', '${ALB_A}/a1.thumb.webp');
    INSERT INTO public.invoices (id, job_id, invoice_number, status, total, notes, collected_amount, carrier_shortfall) VALUES
      ('${INV_A}', '${JOB_A}', 'INV-1001', 'sent', 18500, 'chase hard', 0, 3200),
      ('${INV_A_DRAFT}', '${JOB_A}', 'INV-1001-D', 'draft', 999, NULL, 0, 0),
      ('${INV_B}', '${JOB_B}', 'INV-2001', 'sent', 22000, NULL, 0, 0);
    INSERT INTO public.invoice_lines (invoice_id, position, name, quantity, unit_price, unit_cost, subtotal, note) VALUES
      ('${INV_A}', 1, 'Water extraction', 1, 18500, 6100, 18500, 'we lose money if under 12k');
    INSERT INTO storage.objects (bucket_id, name) VALUES ('project-photos', '${ALB_B}/b1.jpg');
  `);

  /* ---- The migrations, verbatim --------------------------------------- */
  await db.exec(migration("20260928130000_client_portal_foundation.sql"));
  await db.exec(migration("20260928131000_client_portal_read_functions.sql"));

  /** Run SQL as a session: `role` is the JWT role claim PostgREST switches into. */
  const as = async (uid, role, sql, params) => {
    await db.exec(`SET ROLE ${role};
      SELECT set_config('request.jwt.claim.sub', '${uid ?? ""}', false),
             set_config('request.jwt.claims', '${JSON.stringify({ sub: uid, role })}', false)`);
    try {
      return await db.query(sql, params);
    } finally {
      await db.exec(`RESET ROLE;
        SELECT set_config('request.jwt.claim.sub', '', false), set_config('request.jwt.claims', '', false)`);
    }
  };
  const staff = (sql, p) => as(U.staff, "authenticated", sql, p);
  const crew = (sql, p) => as(U.crew, "authenticated", sql, p);
  const custA = (sql, p) => as(U.custA, "portal_customer", sql, p);
  const custB = (sql, p) => as(U.custB, "portal_customer", sql, p);
  const service = (sql, p) => as(null, "service_role", sql, p);
  const one = async (q) => (await q).rows[0];

  /* ---- 5. Identity: invite, accept ------------------------------------ */
  // An older invitation for Alice, then a new one: the first is revoked.
  await staff(`SELECT * FROM public.portal_invite('${CON_A}', '${H.aOld}', _job_id => '${JOB_A}')`);
  const invA = await one(
    staff(`SELECT * FROM public.portal_invite('${CON_A}', '${H.a}', _job_id => '${JOB_A}')`),
  );
  check(invA.email === "alice@maple.test", "the portal email is the contact's, lower-cased");
  const invB = await one(
    staff(`SELECT * FROM public.portal_invite('${CON_B}', '${H.b}', _job_id => '${JOB_B}')`),
  );
  check(
    !!invB.portal_customer_id && invB.portal_customer_id !== invA.portal_customer_id,
    "two customers, two identities",
  );

  check(
    (await one(service(`SELECT status FROM public.portal_invitation_lookup('${H.aOld}')`)))
      .status === "revoked",
    "a newer invitation revokes the older one",
  );
  check(
    (await one(service(`SELECT status FROM public.portal_invitation_lookup('${hash("f")}')`)))
      .status === "not_found",
    "an unknown token is simply not found",
  );

  await refuses(
    staff(`SELECT * FROM public.portal_invite('${CON_B}', '${hash("9")}', _job_id => '${JOB_A}')`),
    /not on this job/,
    "a customer can not be invited from a job they are not on",
  );
  await refuses(
    crew(`SELECT * FROM public.portal_invite('${CON_A}', '${hash("8")}', _job_id => '${JOB_A}')`),
    /can't give out access/,
    "crew who can see the job but not manage it can not invite",
  );
  await refuses(
    staff(`SELECT * FROM public.portal_invite('${CON_A}', 'not-a-hash', _job_id => '${JOB_A}')`),
    /Invalid invitation token/,
    "the token hash is validated",
  );
  await refuses(
    staff(
      `SELECT * FROM public.portal_invite('${CON_A}', '${hash("7")}', _job_id => '${JOB_A}', _email => 'dana@goldstar.test')`,
    ),
    /staff sign-in/,
    "a staff member's email can never become a customer identity",
  );

  // What the auth server does: insert (marked), then set the role.
  await db.exec(`INSERT INTO auth.users (id, email, role, raw_user_meta_data) VALUES
    ('${U.custA}', 'alice@maple.test', '', '{"portal_invitation": "true"}'),
    ('${U.custB}', 'bob@oak.test', '', '{"portal_invitation": "true"}')`);
  check(
    (
      await one(
        db.query(
          `SELECT count(*)::int AS n FROM public.profiles WHERE user_id IN ('${U.custA}','${U.custB}')`,
        ),
      )
    ).n === 0,
    "a portal sign-in never gets a staff profile from the signup trigger",
  );
  await db.exec(
    `UPDATE auth.users SET role = 'portal_customer' WHERE id IN ('${U.custA}', '${U.custB}')`,
  );

  await refuses(
    service(`SELECT public.portal_accept_invitation('${H.a}', '${U.custB}')`),
    /this invitation's address/,
    "an invitation can only attach the sign-in for its own address",
  );
  check(
    !!(await one(service(`SELECT public.portal_accept_invitation('${H.a}', '${U.custA}') AS id`)))
      .id,
    "Alice accepts",
  );
  check(
    !!(await one(service(`SELECT public.portal_accept_invitation('${H.b}', '${U.custB}') AS id`)))
      .id,
    "Bob accepts",
  );
  await refuses(
    service(`SELECT public.portal_accept_invitation('${H.a}', '${U.custA}')`),
    /no longer valid/,
    "an invitation is single-use",
  );
  check(
    (await one(service(`SELECT status FROM public.portal_invitation_lookup('${H.a}')`))).status ===
      "used",
    "and says so",
  );
  await refuses(
    service(`SELECT public.portal_accept_invitation('${H.aOld}', '${U.custA}')`),
    /no longer valid/,
    "a revoked invitation can not be accepted",
  );
  await staff(
    `SELECT * FROM public.portal_invite('${CON_A}', '${H.expired}', _job_id => '${JOB_A}')`,
  );
  await db.exec(
    `UPDATE public.portal_invitations SET expires_at = now() - interval '1 minute' WHERE token_hash = '${H.expired}'`,
  );
  check(
    (await one(service(`SELECT status FROM public.portal_invitation_lookup('${H.expired}')`)))
      .status === "expired",
    "invitations expire",
  );
  await refuses(
    service(`SELECT public.portal_accept_invitation('${H.expired}', '${U.custA}')`),
    /no longer valid/,
    "an expired invitation can not be accepted",
  );

  // Only the service role may look up or accept.
  for (const [who, run] of [
    ["anon", (s) => as(null, "anon", s)],
    ["staff", staff],
    ["a customer", custA],
  ]) {
    await refuses(
      run(`SELECT * FROM public.portal_invitation_lookup('${H.a}')`),
      /permission denied/,
      `${who} can not look up invitations`,
    );
    await refuses(
      run(`SELECT public.portal_accept_invitation('${H.a}', '${U.custA}')`),
      /permission denied/,
      `${who} can not accept invitations`,
    );
  }

  /* ---- 5. Never staff -------------------------------------------------- */
  await refuses(
    db.query(`INSERT INTO public.user_roles (user_id, role) VALUES ('${U.custA}', 'admin')`),
    /never hold a staff role/,
    "not even the table owner can give a customer a role",
  );
  await refuses(
    staff(`INSERT INTO public.user_roles (user_id, role) VALUES ('${U.custA}', 'crew')`),
    /never hold a staff role/,
    "an admin can not give a customer a role",
  );
  await refuses(
    service(
      `INSERT INTO public.location_members (user_id, location_id, role) VALUES ('${U.custA}', '${LOC}', 'crew')`,
    ),
    /never hold a staff role/,
    "the service role can not give a customer an office",
  );
  await refuses(
    db.query(
      `INSERT INTO public.region_members (user_id, region_id) VALUES ('${U.custA}', '${LOC}')`,
    ),
    /never hold a staff role/,
    "nor a region",
  );
  await refuses(
    db.query(
      `INSERT INTO public.user_permissions (user_id, permission_key) VALUES ('${U.custA}', 'data.export')`,
    ),
    /never hold a staff role/,
    "nor a permission grant",
  );
  await refuses(
    db.query(
      `INSERT INTO public.profiles (user_id, email, approval_status) VALUES ('${U.custA}', 'x', 'approved')`,
    ),
    /never hold a staff role/,
    "nor a profile to be approved",
  );
  await refuses(
    db.query(`UPDATE public.user_roles SET user_id = '${U.custA}' WHERE user_id = '${U.crew}'`),
    /never hold a staff role/,
    "nor by moving someone else's role onto them",
  );
  await refuses(
    db.query(`UPDATE auth.users SET role = 'authenticated' WHERE id = '${U.custA}'`),
    /never become a staff sign-in/,
    "a customer's auth role can not be switched to staff",
  );
  await refuses(
    db.query(`UPDATE auth.users SET role = 'portal_customer' WHERE id = '${U.crew}'`),
    /can not be turned into a customer/,
    "a staff sign-in can not be switched into a customer",
  );

  /* ---- 4. Sharing ------------------------------------------------------ */
  const shareA = (
    await one(
      staff(`INSERT INTO public.portal_job_shares (job_id, portal_customer_id)
    VALUES ('${JOB_A}', '${invA.portal_customer_id}') RETURNING id`),
    )
  ).id;
  await staff(
    `INSERT INTO public.portal_job_shares (job_id, portal_customer_id) VALUES ('${JOB_B}', '${invB.portal_customer_id}')`,
  );

  await refuses(
    staff(
      `INSERT INTO public.portal_job_shares (job_id, portal_customer_id) VALUES ('${JOB_B}', '${invA.portal_customer_id}')`,
    ),
    /not on this job/,
    "a job can not be shared with a customer who is not on it",
  );
  await refuses(
    crew(
      `INSERT INTO public.portal_job_shares (job_id, portal_customer_id) VALUES ('${JOB_A2}', '${invA.portal_customer_id}')`,
    ),
    /row-level security/,
    "crew can not share a job",
  );

  // Default: nothing shared.
  const empty = (await one(custA(`SELECT public.portal_job('${JOB_A}') AS j`))).j;
  check(
    empty.documents.length === 0 && empty.photo_sets.length === 0 && empty.invoices.length === 0,
    "a freshly shared job shows nothing until something is chosen",
  );

  const addItem = (kind, id, share = shareA) =>
    staff(
      `INSERT INTO public.portal_share_items (share_id, item_kind, item_id) VALUES ('${share}', '${kind}', '${id}') RETURNING id`,
    );
  await addItem("document", DOC_A1);
  await addItem("photo_folder", FOLD_A);
  await addItem("invoice", INV_A);
  await refuses(
    addItem("document", DOC_B1),
    /not part of this job/,
    "another job's document can not ride on this share",
  );
  await refuses(addItem("photo_album", ALB_B), /not part of this job/, "nor another job's album");
  await refuses(addItem("invoice", INV_B), /not part of this job/, "nor another job's invoice");
  await refuses(
    addItem("invoice", INV_A_DRAFT),
    /not part of this job/,
    "a draft invoice can not be shared",
  );
  await refuses(
    addItem("document", DOC_A_DRAFT),
    /not part of this job/,
    "a document with no file can not be shared",
  );

  /* ---- 2 & 3. What Alice sees ------------------------------------------ */
  const jobsA = (await custA(`SELECT * FROM public.portal_my_jobs()`)).rows;
  check(jobsA.length === 1 && jobsA[0].job_id === JOB_A, "Alice sees exactly her one shared job");
  check(
    jobsA[0].documents === 1 && jobsA[0].photo_sets === 1 && jobsA[0].invoices === 1,
    "with its counts",
  );

  const jobA = (await one(custA(`SELECT public.portal_job('${JOB_A}') AS j`))).j;
  check(jobA.documents.map((d) => d.id).join() === DOC_A1, "only the chosen document");
  check(
    jobA.photo_sets.length === 1 &&
      jobA.photo_sets[0].id === FOLD_A &&
      jobA.photo_sets[0].photo_count === 1,
    "only the chosen folder, with only its photos",
  );
  check(jobA.invoices.map((i) => i.id).join() === INV_A, "only the chosen invoice");
  const jobJson = JSON.stringify(jobA);
  for (const leak of [
    "agreed_price",
    "17350",
    "gate code",
    "merge_data",
    "margin",
    "notes",
    "slow to pay",
    "location_id",
  ])
    check(!jobJson.includes(leak), `the job payload carries no ${leak}`);

  const invoiceA = (await one(custA(`SELECT public.portal_invoice('${INV_A}') AS v`))).v;
  check(
    invoiceA.total === 18500 && invoiceA.lines.length === 1,
    "Alice can read her shared invoice",
  );
  const invJson = JSON.stringify(invoiceA);
  for (const leak of [
    "unit_cost",
    "6100",
    "we lose money",
    "chase hard",
    "collected_amount",
    "carrier_shortfall",
    "3200",
  ])
    check(!invJson.includes(leak), `the invoice payload carries no ${leak}`);

  // Changing an id in the request.
  const nothing = async (run, sql) => {
    const r = (await one(run(sql)))?.x;
    return r === null || r === undefined;
  };
  check(
    await nothing(custA, `SELECT public.portal_job('${JOB_B}') AS x`),
    "Bob's job id returns nothing to Alice",
  );
  check(
    await nothing(custA, `SELECT public.portal_job('${JOB_A2}') AS x`),
    "Alice's own unshared job returns nothing",
  );
  check(
    await nothing(custA, `SELECT public.portal_job(gen_random_uuid()) AS x`),
    "a made-up job id returns the same nothing",
  );
  check(
    await nothing(custA, `SELECT public.portal_invoice('${INV_B}') AS x`),
    "Bob's invoice returns nothing to Alice",
  );
  check(
    await nothing(custA, `SELECT public.portal_invoice('${INV_A_DRAFT}') AS x`),
    "an unshared invoice on her job returns nothing",
  );
  check(
    (await custA(`SELECT * FROM public.portal_photos('${JOB_B}', 'photo_album', '${ALB_B}')`)).rows
      .length === 0,
    "Bob's album returns no photos to Alice",
  );
  check(
    (await custA(`SELECT * FROM public.portal_photos('${JOB_A}', 'photo_album', '${ALB_A}')`)).rows
      .length === 0,
    "the whole album is not reachable when only one folder of it is shared",
  );
  check(
    (
      await custA(`SELECT * FROM public.portal_photos('${JOB_A}', 'photo_folder', '${FOLD_A}')`)
    ).rows
      .map((r) => r.photo_id)
      .join() === PH_A1,
    "the shared folder's photos",
  );

  // Storage coordinates: only for shared files, whatever ids are asked for.
  const docRefs = (
    await custA(
      `SELECT * FROM public.portal_file_refs('document', ARRAY['${DOC_A1}','${DOC_A2}','${DOC_B1}']::text[])`,
    )
  ).rows;
  check(
    docRefs.length === 1 && docRefs[0].id === DOC_A1,
    "file refs only for the shared document, never a neighbour's",
  );
  const photoRefs = (
    await custA(
      `SELECT * FROM public.portal_file_refs('photo', ARRAY['${PH_A1}','${PH_A2}','${PH_B1}']::text[], 'display')`,
    )
  ).rows;
  check(
    photoRefs.length === 1 && photoRefs[0].id === PH_A1,
    "file refs only for photos in the shared folder",
  );
  check(
    photoRefs[0].path.endsWith(".display.webp"),
    "and the EXIF-free variant rather than the original",
  );
  check(
    (
      await custA(
        `SELECT * FROM public.portal_file_refs('photo', ARRAY['${PH_A1}']::text[], 'thumb')`,
      )
    ).rows[0].path.endsWith(".thumb.webp"),
    "thumbnails are the thumb variant",
  );
  check(
    (await custA(`SELECT * FROM public.portal_file_refs('bogus', ARRAY['${DOC_A1}']::text[])`)).rows
      .length === 0,
    "an unknown kind returns nothing",
  );

  // Bob, symmetrically.
  const jobsB = (await custB(`SELECT * FROM public.portal_my_jobs()`)).rows;
  check(jobsB.length === 1 && jobsB[0].job_id === JOB_B, "Bob sees only his job");
  check(
    await nothing(custB, `SELECT public.portal_job('${JOB_A}') AS x`),
    "Alice's job returns nothing to Bob",
  );
  check(
    (await custB(`SELECT * FROM public.portal_file_refs('document', ARRAY['${DOC_A1}']::text[])`))
      .rows.length === 0,
    "Alice's document is unreachable for Bob",
  );

  /* ---- 1. Deny by default ---------------------------------------------- */
  const STAFF_TABLES = [
    "jobs",
    "job_notes",
    "contacts",
    "accounts",
    "documents",
    "photos",
    "photo_variants",
    "projects",
    "photo_folders",
    "invoices",
    "invoice_lines",
    "profiles",
    "user_roles",
    "location_members",
    "notifications",
    "staff_ledger",
    "portal_customers",
    "portal_invitations",
    "portal_job_shares",
    "portal_share_items",
  ];
  for (const t of STAFF_TABLES) {
    await refuses(
      custA(`SELECT count(*) FROM public.${t}`),
      /permission denied/,
      `a customer can not read ${t}`,
    );
  }
  await refuses(
    custA(`INSERT INTO public.job_notes (job_id, body) VALUES ('${JOB_A}', 'x')`),
    /permission denied/,
    "a TO public policy does not let a customer write",
  );
  await refuses(
    custA(
      `INSERT INTO public.portal_share_items (share_id, item_kind, item_id) VALUES ('${shareA}', 'document', '${DOC_A2}')`,
    ),
    /permission denied/,
    "a customer can not share things with themself",
  );
  await refuses(
    custA(`SELECT count(*) FROM storage.objects`),
    /permission denied/,
    "a customer can not list storage",
  );
  await refuses(
    custA(`SELECT public.staff_margin_report()`),
    /permission denied/,
    "a PUBLIC-executable staff function is closed to customers",
  );
  await refuses(
    custA(`SELECT public.can_view_job('${U.custA}', '${JOB_A}')`),
    /permission denied/,
    "so are the staff helpers",
  );
  await refuses(
    custA(`SELECT * FROM public.portal_job_candidates('${JOB_A}')`),
    /permission denied/,
    "and the staff portal functions",
  );
  await refuses(
    custA(`SELECT * FROM public.portal_invite('${CON_A}', '${hash("6")}', _job_id => '${JOB_A}')`),
    /permission denied/,
    "a customer can not invite anyone",
  );
  await refuses(
    custA(`SELECT goldstar_private.is_portal_user('${U.custA}')`),
    /permission denied/,
    "nor reach the private schema",
  );

  // A table added by a later migration: Supabase's defaults grant it to the
  // API roles, and still not to the customer.
  await db.exec(`CREATE TABLE public.added_later (id int); ALTER TABLE public.added_later ENABLE ROW LEVEL SECURITY;
    CREATE POLICY open_to_all ON public.added_later FOR ALL TO public USING (true);`);
  await refuses(
    custA(`SELECT count(*) FROM public.added_later`),
    /permission denied/,
    "a table created after the migration is closed too",
  );

  // The catalog, the way the migration's own audit reads it.
  const reach = await one(
    db.query(`
    SELECT count(*) FILTER (WHERE has_table_privilege('portal_customer', c.oid, 'SELECT,INSERT,UPDATE,DELETE')) AS tables
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname IN ('public', 'storage', 'auth', 'goldstar_private') AND c.relkind IN ('r','v','m','p')`),
  );
  check(Number(reach.tables) === 0, "portal_customer holds privileges on no table in any schema");
  const fns = (
    await db.query(`
    SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname IN ('public', 'goldstar_private') AND has_function_privilege('portal_customer', p.oid, 'EXECUTE')
       AND p.prorettype <> 'trigger'::regtype ORDER BY 1`)
  ).rows.map((r) => r.proname);
  check(
    fns.join() === "portal_file_refs,portal_invoice,portal_job,portal_my_jobs,portal_photos",
    `portal_customer executes exactly the five portal functions (got ${fns.join()})`,
  );
  const restrictive = await one(
    db.query(`SELECT count(*)::int AS n FROM pg_policies
    WHERE policyname = 'portal_customer_denied' AND permissive = 'RESTRICTIVE'`),
  );
  check(restrictive.n >= 20, "every RLS table, and storage.objects, carries the restrictive deny");

  /* ---- 6. Staff are unchanged, and refused the customer's doors -------- */
  check(
    Number((await one(staff(`SELECT public.staff_margin_report() AS m`))).m) > 0,
    "staff keep EXECUTE on the function whose PUBLIC grant was narrowed",
  );
  check(
    (await staff(`SELECT count(*)::int AS n FROM public.jobs`)).rows[0].n === 3,
    "staff still read their tables",
  );
  check(
    (await as(null, "anon", `SELECT count(*)::int AS n FROM public.job_notes`)).rows[0].n === 1,
    "anon keeps exactly what it had (the sweep changes only the customer)",
  );
  for (const f of [
    "portal_my_jobs()",
    `portal_job('${JOB_A}')`,
    `portal_invoice('${INV_A}')`,
    `portal_photos('${JOB_A}', 'photo_folder', '${FOLD_A}')`,
    `portal_file_refs('document', ARRAY['${DOC_A1}']::text[])`,
  ]) {
    await refuses(
      staff(`SELECT * FROM public.${f}`),
      /permission denied/,
      `staff can not call ${f}`,
    );
  }
  // A customer whose token somehow said "authenticated": the portal doors are
  // shut, because they are granted to portal_customer alone.
  await refuses(
    as(U.custA, "authenticated", `SELECT * FROM public.portal_my_jobs()`),
    /permission denied/,
    "a customer arriving as authenticated can not use the portal functions",
  );
  // And a portal_customer session whose JWT does not say so gets nothing.
  await db.exec(`SET ROLE portal_customer; SELECT set_config('request.jwt.claim.sub', '${U.custA}', false),
                 set_config('request.jwt.claims', '{"role":"authenticated"}', false)`);
  await refuses(
    db.query(`SELECT * FROM public.portal_my_jobs()`),
    /Customer portal sessions only/,
    "the functions check the JWT role, not only the database role",
  );
  await db.exec(`RESET ROLE; SELECT set_config('request.jwt.claims', '', false)`);

  const cands = (await staff(`SELECT * FROM public.portal_job_candidates('${JOB_A}')`)).rows;
  check(
    cands.length === 1 &&
      cands[0].contact_id === CON_A &&
      cands[0].signed_up === true &&
      !!cands[0].share_id,
    "staff see who on the job has the portal and whether it is shared",
  );
  await refuses(
    as(U.stranger, "authenticated", `SELECT * FROM public.portal_job_candidates('${JOB_A}')`),
    /Not permitted/,
    "a signed-in stranger with no profile sees nothing",
  );

  /* ---- 4. Unshare takes effect immediately ----------------------------- */
  await staff(
    `DELETE FROM public.portal_share_items WHERE share_id = '${shareA}' AND item_kind = 'document'`,
  );
  check(
    (await one(custA(`SELECT public.portal_job('${JOB_A}') AS j`))).j.documents.length === 0,
    "an unshared document vanishes on the next read",
  );
  check(
    (await custA(`SELECT * FROM public.portal_file_refs('document', ARRAY['${DOC_A1}']::text[])`))
      .rows.length === 0,
    "and can no longer be signed",
  );

  await db.exec(`UPDATE public.invoices SET status = 'draft' WHERE id = '${INV_A}'`);
  check(
    await nothing(custA, `SELECT public.portal_invoice('${INV_A}') AS x`),
    "an invoice put back to draft drops out without unsharing",
  );
  await db.exec(`UPDATE public.invoices SET status = 'sent' WHERE id = '${INV_A}'`);

  await staff(`SELECT public.portal_set_customer_disabled('${invA.portal_customer_id}', true)`);
  await refuses(
    custA(`SELECT * FROM public.portal_my_jobs()`),
    /Customer portal sessions only/,
    "turning access off shuts the portal",
  );
  await staff(`SELECT public.portal_set_customer_disabled('${invA.portal_customer_id}', false)`);
  check(
    (await custA(`SELECT * FROM public.portal_my_jobs()`)).rows.length === 1,
    "and turning it back on reopens it",
  );

  await staff(`DELETE FROM public.portal_job_shares WHERE id = '${shareA}'`);
  check(
    (await custA(`SELECT * FROM public.portal_my_jobs()`)).rows.length === 0,
    "unsharing the job removes it at once",
  );
  check(
    await nothing(custA, `SELECT public.portal_job('${JOB_A}') AS x`),
    "and its page returns nothing",
  );
  check(
    (await custA(`SELECT * FROM public.portal_file_refs('photo', ARRAY['${PH_A1}']::text[])`)).rows
      .length === 0,
    "and its photos can no longer be signed",
  );

  console.log(`client-portal-security.pglite: ${assertions} assertions passed`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await db.close();
}
