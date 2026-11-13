// Run with: node supabase/tests/tradeshow-raffles.pglite.mjs <PGlite dist/index.js>
// In-memory fixtures only. No connection string, network access or live writes.
//
// Trade show raffles (20261110210000): the public form enters once per email,
// only while open; the draw is a manager's, fills each prize to its quantity
// and no further, never draws the same person twice, skips the disqualified,
// closes entries, and a forfeited slot can be drawn again.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const db = new PGlite();
const migration = readFileSync(
  new URL("../migrations/20261110210000_tradeshow_raffles.sql", import.meta.url),
  "utf8",
);
const industryMigration = readFileSync(
  new URL("../migrations/20261111140000_raffle_entry_industry.sql", import.meta.url),
  "utf8",
);
const capMigration = readFileSync(
  new URL("../migrations/20261111090000_raffle_max_entries.sql", import.meta.url),
  "utf8",
);

let assertions = 0;
const check = (value, what) => {
  assert.equal(value, true, what);
  assertions++;
};
const one = async (sql) => (await db.query(sql)).rows[0];
const as = async (uid) =>
  db.exec(`SELECT set_config('request.jwt.claim.sub', '${uid ?? ""}', false)`);
const refused = async (sql) => {
  try {
    await db.exec(sql);
    return "ALLOWED";
  } catch (e) {
    return `REFUSED:${e.message}`;
  }
};

const manager = "33333333-3333-4333-8333-333333333333";
const rep = "11111111-1111-4111-8111-111111111111";
const office = "66666666-6666-4666-8666-666666666666";
const show = "77777777-7777-4777-8777-777777777777";

try {
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);
    INSERT INTO auth.users VALUES ('${manager}'), ('${rep}');
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
      $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE FUNCTION public.update_updated_at_column() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$;
    CREATE FUNCTION public.can_view_location(_uid uuid, _loc uuid) RETURNS boolean
      LANGUAGE sql STABLE AS $$ SELECT _uid IN ('${manager}'::uuid, '${rep}'::uuid) $$;
    CREATE FUNCTION public.can_manage_location(_uid uuid, _loc uuid) RETURNS boolean
      LANGUAGE sql STABLE AS $$ SELECT false $$;
    CREATE FUNCTION public.is_sales_manager(_uid uuid) RETURNS boolean
      LANGUAGE sql STABLE AS $$ SELECT _uid = '${manager}'::uuid $$;
    CREATE TABLE public.tradeshows (
      id uuid PRIMARY KEY, location_id uuid, name text, city text, state text,
      starts_on date, ends_on date
    );
    INSERT INTO public.tradeshows VALUES
      ('${show}', '${office}', 'Restoration Expo', 'Miami', 'FL', '2026-11-12', '2026-11-14');
  `);
  await db.exec(migration);
  await db.exec(capMigration);
  await db.exec(industryMigration);
  await db.exec(`GRANT USAGE ON SCHEMA public, auth TO authenticated;
                 GRANT SELECT ON public.tradeshows TO authenticated;`);

  // A raffle with two prizes: one grand prize, two gift cards.
  await db.exec(`
    INSERT INTO public.tradeshow_raffles (id, tradeshow_id, title, token)
    VALUES ('aaaaaaaa-0000-4000-8000-000000000001', '${show}', 'Booth raffle', 'tok_open_raffle_0001');
    INSERT INTO public.tradeshow_raffle_prizes (id, raffle_id, position, name, quantity) VALUES
      ('bbbbbbbb-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 1, 'YETI cooler', 1),
      ('bbbbbbbb-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001', 2, 'Gift card', 2);
  `);
  const RAFFLE = "aaaaaaaa-0000-4000-8000-000000000001";
  const GRAND = "bbbbbbbb-0000-4000-8000-000000000001";
  const CARD = "bbbbbbbb-0000-4000-8000-000000000002";

  // ---- the public form
  const load = await one(`SELECT public.raffle_public_load('tok_open_raffle_0001') AS j`);
  check(load.j.ok === true && load.j.open === true, "an open raffle loads as open");
  check(
    load.j.prizes.length === 2 && load.j.show_name === "Restoration Expo",
    "form sees prizes and show",
  );
  check(!("token" in load.j) && !("id" in load.j), "the form gets no ids back");
  const missing = await one(`SELECT public.raffle_public_load('nope_nope_nope_nope') AS j`);
  check(
    missing.j.ok === false && missing.j.reason === "not_found",
    "an unknown token is not found",
  );

  // The form reaches the database as service_role (the server function), never
  // as the signed-in user; the test runs it as the owner and puts the role back.
  const enter = async (email, extra = {}) => {
    const role = (await one(`SELECT current_user AS r`)).r;
    await db.exec(`RESET ROLE`);
    const out = (
      await one(
        `SELECT public.raffle_public_enter('tok_open_raffle_0001', '${JSON.stringify({
          first_name: "Pat",
          last_name: "Doe",
          email,
          consent_terms: true,
          ...extra,
        })}'::jsonb) AS j`,
      )
    ).j;
    if (role !== "postgres") await db.exec(`SET ROLE ${role}`);
    return out;
  };

  for (let i = 1; i <= 6; i++)
    check((await enter(`person${i}@example.com`)).ok, `entry ${i} lands`);
  check(
    (await enter("PERSON1@Example.com ")).reason === "duplicate",
    "the same email twice is a duplicate",
  );
  check(
    (await enter("x@example.com", { consent_terms: false })).reason === "invalid",
    "terms must be accepted",
  );
  check((await enter("not-an-email")).reason === "invalid", "a bad email is refused");
  check(
    (await one(`SELECT count(*)::int AS n FROM public.tradeshow_raffle_entries`)).n === 6,
    "only the six good entries are stored",
  );

  // ---- who may draw
  await db.exec(`SET ROLE authenticated`);
  await as(rep);
  check(
    (await refused(`SELECT * FROM public.draw_raffle_winners('${GRAND}')`)).includes(
      "Only a manager",
    ),
    "a rep cannot run the draw",
  );
  check(
    (
      await refused(`INSERT INTO public.tradeshow_raffle_entries (raffle_id, first_name, last_name, email, consent_terms)
                    VALUES ('${RAFFLE}', 'A', 'B', 'a@b.co', true)`)
    ).startsWith("REFUSED"),
    "staff cannot type an entry in by hand",
  );
  check(
    (await one(`SELECT count(*)::int AS n FROM public.tradeshow_raffle_entries`)).n === 6,
    "a rep who can see the show sees its contacts",
  );

  // ---- disqualify one, then draw
  await as(manager);
  await db.exec(`UPDATE public.tradeshow_raffle_entries SET disqualified_at = now(), disqualified_reason = 'Staff'
                  WHERE email = 'person6@example.com'`);
  const grand = (await db.query(`SELECT * FROM public.draw_raffle_winners('${GRAND}')`)).rows;
  check(
    grand.length === 1 && grand[0].pool_size === 5,
    "the grand prize draws one from the five eligible",
  );
  check(
    (await one(`SELECT status FROM public.tradeshow_raffles WHERE id = '${RAFFLE}'`)).status ===
      "closed",
    "drawing closes entries",
  );
  check((await enter("late@example.com")).reason === "closed", "nobody enters after the draw");
  check(
    (await refused(`SELECT * FROM public.draw_raffle_winners('${GRAND}')`)).includes(
      "has been drawn",
    ),
    "a prize is never overfilled",
  );

  const cards = (await db.query(`SELECT * FROM public.draw_raffle_winners('${CARD}')`)).rows;
  check(cards.length === 2, "a prize with quantity 2 draws two winners");
  check(
    cards[0].pool_size === 4 && cards[1].pool_size === 3,
    "each draw removes the winner from the hat",
  );
  const winners = (await db.query(`SELECT entry_id FROM public.tradeshow_raffle_winners`)).rows;
  check(new Set(winners.map((w) => w.entry_id)).size === 3, "nobody wins twice");
  check(
    (
      await one(`SELECT count(*)::int AS n FROM public.tradeshow_raffle_winners w
                  JOIN public.tradeshow_raffle_entries e ON e.id = w.entry_id
                 WHERE e.disqualified_at IS NOT NULL`)
    ).n === 0,
    "the disqualified are never drawn",
  );

  // ---- forfeit and redraw
  const first = cards[0].id;
  await db.exec(
    `UPDATE public.tradeshow_raffle_winners SET status = 'claimed' WHERE id = '${cards[1].id}'`,
  );
  const claimed = await one(
    `SELECT claimed_at, notified_at, updated_by FROM public.tradeshow_raffle_winners WHERE id = '${cards[1].id}'`,
  );
  check(
    !!claimed.claimed_at && !!claimed.notified_at && claimed.updated_by === manager,
    "claiming stamps itself",
  );
  check(
    (
      await refused(
        `UPDATE public.tradeshow_raffle_winners SET status = 'forfeited' WHERE id = '${cards[1].id}'`,
      )
    ).includes("already claimed"),
    "a claimed prize cannot be taken back",
  );
  check(
    (
      await refused(
        `UPDATE public.tradeshow_raffle_winners SET entry_id = entry_id WHERE id = '${first}'`,
      )
    ).startsWith("REFUSED"),
    "nobody can swap who won",
  );
  await db.exec(`UPDATE public.tradeshow_raffle_winners SET status = 'forfeited', forfeit_reason = 'No reply'
                  WHERE id = '${first}'`);
  const redraw = (await db.query(`SELECT * FROM public.draw_raffle_winners('${CARD}')`)).rows;
  check(
    redraw.length === 1 && redraw[0].pool_size === 2,
    "a forfeited slot is drawn again from those left",
  );
  check(
    (await refused(`DELETE FROM public.tradeshow_raffle_prizes WHERE id = '${CARD}'`)).includes(
      "cannot be removed",
    ),
    "a drawn prize cannot be deleted",
  );
  check(
    (await refused(`DELETE FROM public.tradeshow_raffles WHERE id = '${RAFFLE}'`)) === "ALLOWED" &&
      (await one(`SELECT count(*)::int AS n FROM public.tradeshow_raffles`)).n === 1,
    "a raffle with contacts is not deleted",
  );

  // Two left, both eligible; the grand prize is full, the cards are full.
  await db.exec(`INSERT INTO public.tradeshow_raffle_prizes (id, raffle_id, position, name, quantity)
                 VALUES ('bbbbbbbb-0000-4000-8000-000000000003', '${RAFFLE}', 3, 'T-shirt', 5)`);
  const shirts = (
    await db.query(
      `SELECT * FROM public.draw_raffle_winners('bbbbbbbb-0000-4000-8000-000000000003')`,
    )
  ).rows;
  check(shirts.length === 1, "a draw stops when the hat is empty, not at the quantity");
  check(
    (
      await refused(
        `SELECT * FROM public.draw_raffle_winners('bbbbbbbb-0000-4000-8000-000000000003')`,
      )
    ).includes("nobody left"),
    "an empty hat says so",
  );

  // ---- optional entry cap (20261111090000)
  await db.exec(`RESET ROLE`);
  await db.exec(`
    INSERT INTO public.tradeshow_raffles (id, tradeshow_id, title, token, max_entries)
    VALUES ('aaaaaaaa-0000-4000-8000-0000000000c1', '${show}', 'Capped', 'tok_capped_raffle_01', 2);
  `);
  const enterCapped = async (email) =>
    (
      await one(
        `SELECT public.raffle_public_enter('tok_capped_raffle_01', '${JSON.stringify({
          first_name: "Cap",
          last_name: "Test",
          email,
          consent_terms: true,
        })}'::jsonb) AS j`,
      )
    ).j;
  const capLoad = async () =>
    (await one(`SELECT public.raffle_public_load('tok_capped_raffle_01') AS j`)).j;
  check((await capLoad()).full === false, "a capped raffle with room is not full");
  check((await enterCapped("cap1@example.com")).ok, "first capped entry lands");
  check((await enterCapped("cap2@example.com")).ok, "second capped entry lands");
  check((await enterCapped("cap3@example.com")).reason === "full", "the third is refused as full");
  const loadedFull = await capLoad();
  check(loadedFull.full === true && loadedFull.open === false, "the form loads as full and closed");
  await db.exec(
    `UPDATE public.tradeshow_raffles SET max_entries = NULL WHERE token = 'tok_capped_raffle_01'`,
  );
  check((await enterCapped("cap3@example.com")).ok, "clearing the cap lets entries in again");
  check(
    (
      await refused(
        `UPDATE public.tradeshow_raffles SET max_entries = 0 WHERE token = 'tok_capped_raffle_01'`,
      )
    ).startsWith("REFUSED"),
    "a cap of zero is refused",
  );

  // ---- one name box and an industry (20261111140000)
  const single = (
    await one(
      `SELECT public.raffle_public_enter('tok_capped_raffle_01', '${JSON.stringify({
        first_name: "Cher",
        last_name: "",
        email: "cher@example.com",
        industry: "Property Management",
        consent_terms: true,
      })}'::jsonb) AS j`,
    )
  ).j;
  check(single.ok === true, "a one-word name is accepted");
  const cher = await one(
    `SELECT last_name, industry FROM public.tradeshow_raffle_entries WHERE email = 'cher@example.com'`,
  );
  check(
    cher.last_name === "" && cher.industry === "Property Management",
    "the empty last name and the industry are stored",
  );

  console.log(`tradeshow-raffles.pglite: ${assertions} assertions passed`);
} finally {
  await db.close();
}
