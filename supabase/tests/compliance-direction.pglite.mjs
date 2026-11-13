// Run with: node supabase/tests/compliance-direction.pglite.mjs <PGlite dist/index.js>
// In-memory fixtures only. No connection string, network access or live writes.
//
// REGRESSION TEST for the compliance requirement DIRECTION (20260914120000),
// the schema half of phase 1 of the two-track client-health build.
//
// Paperwork runs both ways — what Gold Star owes the client, and what the
// client owes Gold Star — and `account_compliance_requirements` only ever
// modelled the first. The migration adds `direction`, widens uniqueness so both
// can exist for one requirement type, and fixes one thing that is a correctness
// bug rather than a passthrough:
//
//   A client_to_gsr requirement must NEVER be satisfied by a row in
//   `company_credentials`. Those are GOLD STAR'S OWN insurance and licences.
//   Left ungated, a 'w9' the CLIENT owes us would be marked satisfied by GOLD
//   STAR'S w9 — the wrong company's paperwork — and the health card would go
//   green for a document nobody has chased. That is the assertion this file
//   exists for.
//
// The migration is READ FROM THE FILE rather than retyped, so this cannot
// drift from what ships. The tables are built as the live migrations define
// them (20260807221741, 20260810200240) minus columns nothing here reads.
//
// NOT TESTED HERE, because phase 1 does not build it: day-aging bands, the
// Non-Compliant badge, onboarding bands, the Critical workflow, commission.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const db = new PGlite();
const migration = readFileSync(
  new URL("../migrations/20260914120000_compliance_requirement_direction.sql", import.meta.url),
  "utf8",
);

let assertions = 0;
const check = (value, what) => {
  assert.equal(value, true, what);
  assertions++;
};

const account = "11111111-1111-4111-8111-111111111111";
const office = "22222222-2222-4222-8222-222222222222";

try {
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role BYPASSRLS;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

    CREATE TABLE public.accounts (
      id uuid PRIMARY KEY,
      name text NOT NULL,
      location_id uuid
    );
    INSERT INTO public.accounts VALUES ('${account}', 'Brooklyn Realty 3', '${office}');

    CREATE TABLE public.account_locations (account_id uuid, location_id uuid);

    -- Gold Star's OWN credentials. The whole point of the fix is that these
    -- must not answer a requirement the client owes us.
    CREATE TABLE public.company_credentials (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      active boolean NOT NULL DEFAULT true,
      kind text NOT NULL,
      name text,
      category text,
      document_id uuid,
      issuer text,
      carrier text,
      policy_number text,
      effective_date date,
      expiry_date date,
      limit_occurrence numeric,
      limit_aggregate numeric,
      currency text DEFAULT 'USD',
      state_code text,
      holder_location_id uuid,
      holder_user_id uuid,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE public.account_compliance_requirements (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
      requirement_type text NOT NULL,
      mandatory boolean NOT NULL DEFAULT true,
      required_amount numeric(14,2),
      required_currency text NOT NULL DEFAULT 'USD',
      required_value text,
      must_name_account boolean NOT NULL DEFAULT false,
      renewal_lead_days integer NOT NULL DEFAULT 30,
      notes text,
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (account_id, requirement_type)
    );

    CREATE TABLE public.compliance_requirement_files (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      requirement_id uuid NOT NULL REFERENCES public.account_compliance_requirements(id) ON DELETE CASCADE,
      account_id uuid NOT NULL,
      slot text NOT NULL CHECK (slot IN ('sample','certificate')),
      storage_path text NOT NULL,
      file_name text NOT NULL,
      is_current boolean NOT NULL DEFAULT true,
      policy_number text,
      expiry_date date,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    -- Verbatim from 20260807221741 / 20260820102608.
    CREATE FUNCTION public.compliance_status_of(
      _has_doc boolean, _expiry date, _covered numeric, _required numeric, _lead_days integer
    ) RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public AS $$
      SELECT CASE
        WHEN NOT _has_doc THEN 'missing'
        WHEN _expiry IS NOT NULL AND _expiry < current_date THEN 'expired'
        WHEN _required IS NOT NULL AND (_covered IS NULL OR _covered < _required) THEN 'insufficient'
        WHEN _expiry IS NOT NULL
          AND _expiry <= current_date + GREATEST(COALESCE(_lead_days, 30), 0) THEN 'expiring_soon'
        ELSE 'satisfied'
      END;
    $$;
  `);

  /* ---- PHASE 1: before the migration -------------------------------- */
  await assert.rejects(
    db.query(`
      INSERT INTO public.account_compliance_requirements (account_id, requirement_type, direction)
      VALUES ('${account}', 'w9', 'client_to_gsr')`),
    /column "direction" .* does not exist|does not exist/i,
    "direction does not exist before the migration",
  );
  assertions++;

  await db.exec(`
    INSERT INTO public.account_compliance_requirements (account_id, requirement_type)
    VALUES ('${account}', 'w9');
  `);
  await assert.rejects(
    db.query(`
      INSERT INTO public.account_compliance_requirements (account_id, requirement_type)
      VALUES ('${account}', 'w9')`),
    /duplicate key|unique/i,
    "one requirement type per account is all the old shape allowed",
  );
  assertions++;

  /* ---- PHASE 2: apply the migration ---------------------------------- */
  await db.exec(migration);

  /** Directions on the w9 requirement(s), sorted — deterministic once both exist. */
  const dirsOf = async () =>
    (await db.query(
      `SELECT direction FROM public.account_compliance_requirements
        WHERE requirement_type='w9' ORDER BY direction`,
    )).rows.map((r) => r.direction).join(",");
  check((await dirsOf()) === "gsr_to_client", "an existing row keeps the meaning it always had");

  // Both directions of the same requirement type can now coexist. Without the
  // widened uniqueness the two-track model cannot express its ordinary case.
  await db.exec(`
    INSERT INTO public.account_compliance_requirements (account_id, requirement_type, direction)
    VALUES ('${account}', 'w9', 'client_to_gsr');
  `);
  check(
    (await db.query(
      `SELECT count(*)::int AS n FROM public.account_compliance_requirements WHERE requirement_type='w9'`,
    )).rows[0].n === 2,
    "the same requirement type exists in both directions",
  );

  await assert.rejects(
    db.query(`
      INSERT INTO public.account_compliance_requirements (account_id, requirement_type, direction)
      VALUES ('${account}', 'w9', 'client_to_gsr')`),
    /duplicate key|unique/i,
    "but still only once per direction",
  );
  assertions++;

  await assert.rejects(
    db.query(`
      INSERT INTO public.account_compliance_requirements (account_id, requirement_type, direction)
      VALUES ('${account}', 'coi', 'subcontractor_to_gsr')`),
    /check constraint|violates/i,
    "and only the two directions the model has",
  );
  assertions++;

  /* ---- THE CORRECTNESS FIX ------------------------------------------- */
  // Gold Star holds a current W9 of its own. It answers the requirement WE owe
  // the client, and must not answer the one the CLIENT owes US.
  await db.exec(`
    INSERT INTO public.company_credentials (active, kind, name, expiry_date, holder_location_id)
    VALUES (true, 'w9', 'Gold Star W9', current_date + 365, NULL);
  `);

  const statusRows = async () =>
    (await db.query(`
      SELECT direction, status, credential_id, cert_file_id
        FROM public.account_compliance_status
       WHERE requirement_type = 'w9'
       ORDER BY direction`)).rows;

  const rows = await statusRows();
  const ours = rows.find((r) => r.direction === "gsr_to_client");
  const theirs = rows.find((r) => r.direction === "client_to_gsr");

  check(ours.credential_id !== null, "Gold Star's own W9 answers what Gold Star owes the client");
  check(ours.status === "satisfied", "so that direction is satisfied");
  check(
    theirs.credential_id === null,
    "Gold Star's W9 must NOT be matched against what the client owes us",
  );
  check(
    theirs.status === "missing",
    "so the client-owed W9 is still outstanding — the bug this fix exists for",
  );

  // The client sends theirs in. Only then does that direction go green, and
  // only via a file filed against the requirement.
  await db.exec(`
    INSERT INTO public.compliance_requirement_files
      (requirement_id, account_id, slot, storage_path, file_name, expiry_date)
    SELECT id, account_id, 'certificate', 'p/1', 'client-w9.pdf', current_date + 365
      FROM public.account_compliance_requirements
     WHERE requirement_type = 'w9' AND direction = 'client_to_gsr';
  `);
  const after = (await statusRows()).find((r) => r.direction === "client_to_gsr");
  check(after.status === "satisfied", "a file filed against it does satisfy the client-owed row");
  check(after.credential_id === null, "and it is still not answered by a company credential");

  /* ---- the states the TypeScript band mapping reads ------------------ */
  await db.exec(`
    INSERT INTO public.account_compliance_requirements (account_id, requirement_type, direction, required_amount)
    VALUES ('${account}', 'general_liability', 'gsr_to_client', 1000000);
    INSERT INTO public.company_credentials (active, kind, name, expiry_date, limit_occurrence)
    VALUES (true, 'general_liability', 'GL', current_date - 1, 2000000);
  `);
  check(
    (await db.query(`
      SELECT status FROM public.account_compliance_status
       WHERE requirement_type = 'general_liability'`)).rows[0].status === "expired",
    "an expired credential still reads as expired, which the track bands Critical",
  );

  /* ---- PHASE 3: requested_at, the clock the bands read (20260914130000) */
  const requestedMigration = readFileSync(
    new URL("../migrations/20260914130000_compliance_requested_at.sql", import.meta.url),
    "utf8",
  );

  // Age one row so the backfill has something to preserve: a requirement
  // raised 40 days ago must still read as 40 days outstanding afterwards, not
  // reset to today. Resetting is the failure mode that would hide exactly the
  // long-outstanding paperwork phase 2 exists to surface.
  await db.exec(`
    UPDATE public.account_compliance_requirements
       SET created_at = now() - interval '40 days'
     WHERE requirement_type = 'w9' AND direction = 'client_to_gsr';
  `);

  await db.exec(requestedMigration);

  check(
    (await db.query(
      `SELECT count(*)::int AS n FROM public.account_compliance_requirements
        WHERE requested_at IS NULL`,
    )).rows[0].n === 0,
    "the backfill leaves no requirement unageable",
  );
  check(
    (await db.query(
      `SELECT count(*)::int AS n FROM public.account_compliance_requirements
        WHERE requested_at <> created_at`,
    )).rows[0].n === 0,
    "and it used each row's own creation date, not today",
  );
  check(
    Number((await db.query(
      `SELECT EXTRACT(day FROM now() - requested_at)::int AS d
         FROM public.account_compliance_requirements
        WHERE requirement_type = 'w9' AND direction = 'client_to_gsr'`,
    )).rows[0].d) === 40,
    "a requirement raised 40 days ago still reads as 40 days outstanding",
  );
  check(
    (await db.query(
      `SELECT requested_at IS NOT NULL AS ok FROM public.account_compliance_status
        WHERE requirement_type = 'w9' AND direction = 'gsr_to_client'`,
    )).rows[0].ok === true,
    "the view exposes it, so one read can age every requirement",
  );

  // New rows get it without anyone remembering to set it.
  await db.exec(`
    INSERT INTO public.account_compliance_requirements (account_id, requirement_type, direction)
    VALUES ('${account}', 'vendor_agreement', 'client_to_gsr');
  `);
  check(
    (await db.query(
      `SELECT requested_at IS NOT NULL AS ok FROM public.account_compliance_requirements
        WHERE requirement_type = 'vendor_agreement'`,
    )).rows[0].ok === true,
    "and the default fills it for a new requirement",
  );

  /* ---- re-runnable ---------------------------------------------------- */
  await db.exec(migration);
  await db.exec(requestedMigration);
  check(
    Number((await db.query(
      `SELECT EXTRACT(day FROM now() - requested_at)::int AS d
         FROM public.account_compliance_requirements
        WHERE requirement_type = 'w9' AND direction = 'client_to_gsr'`,
    )).rows[0].d) === 40,
    "replaying the backfill does not reset an existing clock",
  );
  check(
    (await dirsOf()) === "client_to_gsr,gsr_to_client",
    "a replay changes no row's direction",
  );
  check(
    (await db.query(
      `SELECT count(*)::int AS n FROM public.account_compliance_status WHERE requirement_type='w9'`,
    )).rows[0].n === 2,
    "a replay leaves both directions readable",
  );
  check(
    (await db.query(`
      SELECT count(*)::int AS n FROM pg_constraint
       WHERE conrelid = 'public.account_compliance_requirements'::regclass
         AND contype = 'u'`)).rows[0].n === 1,
    "and exactly one uniqueness rule, not the old one plus the new",
  );

  console.log(`compliance-direction.pglite: ${assertions} assertions passed`);
} finally {
  await db.close();
}
