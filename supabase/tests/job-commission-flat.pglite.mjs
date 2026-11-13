// Run with: node supabase/tests/job-commission-flat.pglite.mjs <PGlite dist/index.js>
// In-memory fixtures only. No connection string, network access or live writes.
//
// The per-job flat-fee override (migration 20261007224200). Mark, 7 Oct:
// "commission amount, which will auto calculate as the charges get added, or
// a flat fee". The migration is READ FROM THE FILE.
//
// What it proves:
//   1. the column exists, is nullable, and takes a fee;
//   2. a negative fee is refused;
//   3. a job cannot carry a percent override AND a flat override at once;
//   4. clearing one and setting the other in a single update is accepted
//      (what the Commissions card does);
//   5. it is idempotent: applying it twice changes nothing.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const db = new PGlite();
const migration = readFileSync(
  new URL("../migrations/20261007224200_job_commission_flat_override.sql", import.meta.url),
  "utf8",
);

let assertions = 0;
const check = (value, what) => {
  assert.equal(value, true, what);
  assertions++;
};
const fails = async (sql, code, what) => {
  try {
    await db.exec(sql);
  } catch (e) {
    assert.equal(e.code, code, `${what}: wrong error ${e.code} ${e.message}`);
    assertions++;
    return;
  }
  assert.fail(`${what}: expected a refusal`);
};

const JOB = "01010101-0101-4101-8101-010101010101";

try {
  await db.exec(`
    CREATE TABLE public.jobs (
      id uuid PRIMARY KEY,
      commission_source text,
      commission_rate_pct numeric(5,2)
    );
    INSERT INTO public.jobs (id) VALUES ('${JOB}');
  `);
  await db.exec(migration);
  await db.exec(migration);

  const col = (
    await db.query(`SELECT data_type, is_nullable, numeric_precision, numeric_scale
                    FROM information_schema.columns
                    WHERE table_name = 'jobs' AND column_name = 'commission_flat_amount'`)
  ).rows[0];
  check(col?.data_type === "numeric" && col.is_nullable === "YES", "a nullable numeric column");
  check(col.numeric_precision === 12 && col.numeric_scale === 2, "money-shaped: numeric(12,2)");

  await db.exec(`UPDATE public.jobs SET commission_flat_amount = 350 WHERE id = '${JOB}'`);
  check(
    (await db.query(`SELECT commission_flat_amount AS f FROM public.jobs`)).rows[0].f === "350.00",
    "a flat fee is stored",
  );
  await fails(
    `UPDATE public.jobs SET commission_flat_amount = -1 WHERE id = '${JOB}'`,
    "23514",
    "a negative fee is refused",
  );
  await fails(
    `UPDATE public.jobs SET commission_rate_pct = 10 WHERE id = '${JOB}'`,
    "23514",
    "a percent override beside a flat one is refused",
  );
  await db.exec(
    `UPDATE public.jobs SET commission_rate_pct = 10, commission_flat_amount = NULL WHERE id = '${JOB}'`,
  );
  const row = (
    await db.query(`SELECT commission_rate_pct AS p, commission_flat_amount AS f FROM public.jobs`)
  ).rows[0];
  check(
    row.p === "10.00" && row.f === null,
    "switching from flat to percent in one update is fine",
  );
  const cons = (
    await db.query(`SELECT count(*)::int AS n FROM pg_constraint
                    WHERE conname IN ('job_commission_flat_sane', 'job_commission_one_override')`)
  ).rows[0].n;
  check(cons === 2, "both constraints exist exactly once after two applies");

  console.log(`job-commission-flat.pglite: ${assertions} assertions passed`);
} finally {
  await db.close();
}
