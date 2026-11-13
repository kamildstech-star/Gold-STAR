// Run with: node supabase/tests/accounts-owner-guard.pglite.mjs <PGlite dist/index.js>
// In-memory fixtures only. No connection string, network access or live writes.
//
// REGRESSION TEST for the accounts owner-column guard (20260914110000).
//
// `accounts_update` is `can_manage_location(uid, location_id) OR assigned_rep =
// uid` with no column-level restriction, because RLS decides ROWS and never
// COLUMNS. The obvious conclusion is that the assigned rep can write every
// column on their own row. PHASE 1 below MEASURES that rather than assuming it,
// and the measurement is why this file exists in this shape:
//
//   assigned_rep := someone else   REFUSED by the policy
//   assigned_rep := NULL           REFUSED by the policy
//   location_id  := another office ALLOWED   <-- the real hole
//   approval_state / all four      ALLOWED   <-- the real hole
//   notes, name                    ALLOWED   (correct, and must stay so)
//
// `assigned_rep` survives only because WITH CHECK is evaluated on the FINISHED
// row: writing somebody else into it makes the row fail the same predicate that
// admitted it. `location_id` does not survive, because the rep stays in
// `assigned_rep` and satisfies the OTHER half of the OR — so the account leaves
// its manager's oversight while the rep keeps it. The approval columns do not
// survive either, which is self-approval of a lead.
//
// PHASE 1 is therefore asserted as strictly as the fix itself. If a future
// policy edit makes `assigned_rep` writable — a second PERMISSIVE UPDATE policy
// would do it, since permissive policies are OR-ed — this file says so out
// loud instead of quietly passing, and the guard added in PHASE 2 is what
// stops it mattering.
//
// The policy is reproduced exactly as the live dump has it, and the trigger is
// READ FROM THE MIGRATION FILE rather than retyped, so this cannot drift from
// what ships.
//
// The three cases the brief asks for are (1), (2) and (3) in PHASE 2. (3) —
// a rep can still edit a normal field — is the one that matters most: a guard
// that blocks the attack and also blocks a rep renaming their own client would
// be reverted within a day, so it is re-asserted after every refusal.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const db = new PGlite();
const migration = readFileSync(
  new URL("../migrations/20260914110000_accounts_owner_column_guard.sql", import.meta.url),
  "utf8",
);

let assertions = 0;
const check = (value, what) => {
  assert.equal(value, true, what);
  assertions++;
};

const rep = "11111111-1111-4111-8111-111111111111";
const otherRep = "22222222-2222-4222-8222-222222222222";
const manager = "33333333-3333-4333-8333-333333333333";
const bothManager = "99999999-9999-4999-8999-999999999999";
const salesHead = "44444444-4444-4444-8444-444444444444";
const admin = "55555555-5555-4555-8555-555555555555";
const office = "66666666-6666-4666-8666-666666666666";
const otherOffice = "77777777-7777-4777-8777-777777777777";
const account = "88888888-8888-4888-8888-888888888888";

try {
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth;
    GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;

    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
      $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

    CREATE TABLE public.user_roles (user_id uuid NOT NULL, role text NOT NULL);
    INSERT INTO public.user_roles VALUES
      ('${rep}', 'sales_person'),
      ('${otherRep}', 'sales_person'),
      ('${manager}', 'sales_manager'),
      ('${bothManager}', 'sales_manager'),
      ('${salesHead}', 'sales_head'),
      ('${admin}', 'admin');

    CREATE TABLE public.location_members (user_id uuid NOT NULL, location_id uuid NOT NULL);
    INSERT INTO public.location_members VALUES
      ('${rep}', '${office}'),
      ('${manager}', '${office}'),
      ('${bothManager}', '${office}'),
      ('${bothManager}', '${otherOffice}');

    -- The three helpers the guard calls, carrying the role lists the live
    -- definitions carry, and SECURITY DEFINER as the live ones are.
    -- can_manage_location is the one that matters: its role list does NOT
    -- include sales_head, which is why the guard names is_sales_lead too.
    CREATE FUNCTION public.is_privileged(_user_id uuid)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
      SELECT EXISTS (SELECT 1 FROM public.user_roles
                      WHERE user_id = _user_id AND role IN ('admin','owner','dev'))
    $$;

    CREATE FUNCTION public.is_sales_lead(_user_id uuid)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
      SELECT EXISTS (SELECT 1 FROM public.user_roles
                      WHERE user_id = _user_id AND role IN ('owner','admin','dev','sales_head'))
    $$;

    CREATE FUNCTION public.can_manage_location(_user_id uuid, _location_id uuid)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
      SELECT _location_id IS NOT NULL AND (
        public.is_privileged(_user_id)
        OR EXISTS (
          SELECT 1 FROM public.location_members m
           JOIN public.user_roles r ON r.user_id = m.user_id
           WHERE m.user_id = _user_id AND m.location_id = _location_id
             AND r.role IN ('office','location_manager','sales_manager')
        )
      )
    $$;

    CREATE TABLE public.accounts (
      id uuid PRIMARY KEY,
      name text NOT NULL,
      notes text,
      location_id uuid,
      assigned_rep uuid,
      stage_id uuid,
      status text NOT NULL DEFAULT 'prospect',
      approval_state text NOT NULL DEFAULT 'not_required',
      approved_by uuid,
      approved_at timestamptz,
      approval_due_on date,
      is_reference boolean NOT NULL DEFAULT false,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    GRANT SELECT, INSERT, UPDATE ON public.accounts TO authenticated;
    GRANT ALL ON public.accounts TO service_role;
    ALTER TABLE public.accounts ENABLE ROW LEVEL SECURITY;

    -- Verbatim from the live RLS dump. Note the absence of any column list:
    -- this is exactly the policy the measurement below is made against.
    CREATE POLICY accounts_select ON public.accounts FOR SELECT TO authenticated
      USING (public.can_manage_location(auth.uid(), location_id) OR assigned_rep = auth.uid());
    CREATE POLICY accounts_update ON public.accounts FOR UPDATE TO authenticated
      USING (public.can_manage_location(auth.uid(), location_id) OR assigned_rep = auth.uid())
      WITH CHECK (public.can_manage_location(auth.uid(), location_id) OR assigned_rep = auth.uid());
  `);

  const reset = () =>
    db.exec(`
      DELETE FROM public.accounts;
      INSERT INTO public.accounts (id, name, notes, location_id, assigned_rep, approval_state, approval_due_on)
      VALUES ('${account}', 'Brooklyn Realty 3', 'original note', '${office}', '${rep}', 'pending', current_date + 7);
    `);

  /** Run one statement as a signed-in user; never leaves the role set. */
  const as = async (uid, sql) => {
    await db.exec(`SET ROLE authenticated; SET request.jwt.claim.sub = '${uid}'`);
    try {
      return await db.query(sql);
    } finally {
      await db.exec("RESET ROLE; SELECT set_config('request.jwt.claim.sub','',false)");
    }
  };
  /** "ALLOWED" | "REFUSED:<sqlstate>" — what a rep can actually do to a column. */
  const attempt = async (uid, setClause) => {
    try {
      const r = await as(uid, `UPDATE public.accounts SET ${setClause} WHERE id = '${account}'`);
      return r.affectedRows === 1 ? "ALLOWED" : "NO ROWS";
    } catch (e) {
      return `REFUSED:${e.code}`;
    }
  };
  /**
   * A SECURITY DEFINER RPC called by `uid`: the ROLE is one that bypasses RLS,
   * the JWT subject is unchanged. That is exactly what Postgres does, and it is
   * why this guard reads auth.uid() rather than current_user.
   */
  const asDefiner = async (uid, setClause) => {
    await db.exec(`SET ROLE service_role; SET request.jwt.claim.sub = '${uid}'`);
    try {
      const r = await db.query(`UPDATE public.accounts SET ${setClause} WHERE id = '${account}'`);
      return r.affectedRows === 1 ? "ALLOWED" : "NO ROWS";
    } catch (e) {
      return `REFUSED:${e.code}`;
    } finally {
      await db.exec("RESET ROLE; SELECT set_config('request.jwt.claim.sub','',false)");
    }
  };
  const col = async (name) =>
    (await db.query(`SELECT ${name} FROM public.accounts WHERE id = '${account}'`)).rows[0][name];

  const STEAL = `assigned_rep = '${otherRep}'`;
  const ORPHAN = `assigned_rep = NULL`;
  const RELOCATE = `location_id = '${otherOffice}'`;
  const SELF_APPROVE = `approval_state = 'approved', approved_by = '${rep}', approved_at = now(), approval_due_on = NULL`;

  /* ================================================================== */
  /* PHASE 1 — the true baseline, with only the policy in force          */
  /* ================================================================== */
  await reset();

  // The policy DOES catch these two, on the finished row. Recorded so that a
  // later policy change which stops catching them cannot pass unnoticed.
  check((await attempt(rep, STEAL)) === "REFUSED:42501", "policy alone refuses reassignment");
  await reset();
  check((await attempt(rep, ORPHAN)) === "REFUSED:42501", "policy alone refuses orphaning");
  await reset();

  // The policy does NOT catch these. This is the hole the migration closes.
  check((await attempt(rep, RELOCATE)) === "ALLOWED", "policy alone lets a rep move the office");
  check(await col("location_id") === otherOffice, "and the account really did leave its office");
  await reset();

  check((await attempt(rep, SELF_APPROVE)) === "ALLOWED", "policy alone lets a rep self-approve");
  check(await col("approval_state") === "approved", "and the lead really was approved");
  check(await col("approved_by") === rep, "with the rep forged as the approver");
  await reset();

  /* ================================================================== */
  /* PHASE 2 — apply the migration                                       */
  /* ================================================================== */
  await db.exec(migration);

  /* ---- (1) a rep CANNOT change assigned_rep on their own account ----- */
  await assert.rejects(
    as(rep, `UPDATE public.accounts SET ${STEAL} WHERE id = '${account}'`),
    /Only a manager can change assigned_rep/i,
    "the refusal now names the column instead of the policy",
  );
  assertions++;
  check(await col("assigned_rep") === rep, "the refused update left the owner untouched");
  check((await attempt(rep, ORPHAN)) === "REFUSED:42501", "nor can a rep orphan the account");

  /* ---- the columns the policy was NOT catching ---------------------- */
  await assert.rejects(
    as(rep, `UPDATE public.accounts SET ${RELOCATE} WHERE id = '${account}'`),
    /Only a manager can change location_id/i,
    "a rep can no longer move their account to another office",
  );
  assertions++;
  check(await col("location_id") === office, "the account stayed in its office");

  await assert.rejects(
    as(rep, `UPDATE public.accounts SET ${SELF_APPROVE} WHERE id = '${account}'`),
    /approval_state, approved_by, approved_at, approval_due_on/,
    "self-approval is refused, and the error names every column of it",
  );
  assertions++;
  check(await col("approval_state") === "pending", "the lead is still pending");
  check(await col("approved_by") === null, "and no approver was forged");

  for (const [setClause, name] of [
    [`approval_state = 'approved'`, "approval_state"],
    [`approved_by = '${rep}'`, "approved_by"],
    [`approved_at = now()`, "approved_at"],
    [`approval_due_on = current_date + 90`, "approval_due_on"],
  ]) {
    await assert.rejects(
      as(rep, `UPDATE public.accounts SET ${setClause} WHERE id = '${account}'`),
      new RegExp(`Only a manager can change ${name}`, "i"),
      `a rep cannot change ${name} on its own either`,
    );
    assertions++;
  }

  /* ---- (3) a rep CAN still edit a normal field ---------------------- */
  const edit = await as(
    rep,
    `UPDATE public.accounts SET notes = 'rep edited this', name = 'Brooklyn Realty 3 LLC' WHERE id = '${account}'`,
  );
  check(edit.affectedRows === 1, "a rep may still edit normal fields on their own account");
  check(await col("notes") === "rep edited this", "and the edit really landed");
  check(await col("name") === "Brooklyn Realty 3 LLC", "including more than one at a time");
  check(
    (await attempt(rep, `notes = 'again'`)) === "ALLOWED",
    "normal edits keep working after a refusal",
  );

  /* ---- (2) a manager CAN -------------------------------------------- */
  check((await attempt(manager, STEAL)) === "ALLOWED", "a manager of the office may reassign");
  check(await col("assigned_rep") === otherRep, "and the reassignment landed");
  await reset();

  // Moving an account BETWEEN offices needs rights on both ends, and that is
  // RLS doing it, not this guard: the trigger passes a manager of the source
  // office, then WITH CHECK evaluates the finished row against the TARGET
  // office and refuses. Asserted so the division of labour stays visible.
  check(
    (await attempt(manager, RELOCATE)) === "REFUSED:42501",
    "a manager of only the source office is still stopped by the policy, not the guard",
  );
  await reset();
  check(
    (await attempt(bothManager, RELOCATE)) === "ALLOWED",
    "a manager of both offices may move the account between them",
  );
  check(await col("location_id") === otherOffice, "and the move landed");
  await reset();
  check((await attempt(manager, SELF_APPROVE)) === "ALLOWED", "a manager may approve");
  await reset();

  /* ---- the other roles the guard has to keep working ---------------- */
  // sales_head is neither privileged nor covered by can_manage_location, so a
  // DIRECT update is refused before the guard is even consulted — RLS does not
  // show them the row. That is why the sanctioned handover tool,
  // reassign_book_atomically, is SECURITY DEFINER.
  check(
    (await attempt(salesHead, STEAL)) === "NO ROWS",
    "a sales_head cannot update accounts directly — RLS, not this guard",
  );

  // So the handover is modelled as it actually runs: RLS bypassed by the
  // definer's role, but auth.uid() STILL the calling sales head, because
  // SECURITY DEFINER changes the role and never the JWT subject. This is the
  // case that would break if the guard did not name is_sales_lead.
  check((await asDefiner(salesHead, STEAL)) === "ALLOWED", "a sales_head may reassign a book");
  check(await col("assigned_rep") === otherRep, "the sales_head handover landed");
  await reset();

  // And the other half of that: a REP calling a definer function gets no free
  // pass. RLS is bypassed there, so this guard is the only thing left — which
  // is the strongest argument for it existing at all.
  check(
    (await asDefiner(rep, STEAL)) === "REFUSED:42501",
    "a rep is still refused inside a SECURITY DEFINER context, where RLS is not",
  );
  check(await col("assigned_rep") === rep, "and nothing moved");
  await reset();

  check(
    (await attempt(admin, STEAL)) === "ALLOWED",
    "an admin may reassign even with no office membership",
  );
  await reset();

  // service_role / cron: no JWT subject at all. The lead-escalation sweep runs
  // this way and writes approval_state.
  await db.exec("SET ROLE service_role");
  check(
    (await db.query(
      `UPDATE public.accounts SET assigned_rep = '${otherRep}', approval_state = 'escalated' WHERE id = '${account}'`,
    )).affectedRows === 1,
    "backend work with no signed-in user is not blocked",
  );
  await db.exec("RESET ROLE");
  await reset();

  /* ---- a rep who does not own the row is still stopped by RLS -------- */
  check(
    (await attempt(otherRep, `notes = 'not mine'`)) === "NO ROWS",
    "a rep who does not own the account is filtered out by the policy, not this guard",
  );

  /* ---- re-runnable --------------------------------------------------- */
  await db.exec(migration);
  check(
    (await db.query(`
      SELECT count(*)::int AS n FROM pg_trigger
       WHERE tgrelid = 'public.accounts'::regclass AND NOT tgisinternal
         AND tgname = 'guard_account_owner_columns'`)).rows[0].n === 1,
    "replaying the migration leaves exactly one trigger binding",
  );
  check((await attempt(rep, RELOCATE)) === "REFUSED:42501", "still refused after a replay");
  check((await attempt(rep, `notes = 'after replay'`)) === "ALLOWED", "and normal edits still work");

  console.log(`accounts-owner-guard.pglite: ${assertions} assertions passed`);
} finally {
  await db.close();
}
