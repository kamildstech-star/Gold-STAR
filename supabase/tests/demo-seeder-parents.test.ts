import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Runs the pglite regression test for the demo seeder inside the normal
 * `npx vitest run` gate, the way goal-activity-actuals.test.ts does.
 *
 * Found during the 15 Oct purge work: Admin → Demo data → Seed put demo
 * invoices and payments on REAL jobs. The seeders are SQL
 * (20261016130000_demo_seeder_demo_parents_only.sql), so the only honest test
 * runs the real migration files against fixture tables in memory — never
 * against the project's database.
 *
 * What it proves, against the real migration files:
 *   1. the live seeders before the fix, called in the app's old order, made
 *      no demo jobs and attached demo invoices and payments to real jobs;
 *   2. after it, every invoice, payment, note, task and estimate is on a demo
 *      job, and no real job receives anything;
 *   3. every demo row's account, contact, estimate and gift-catalog item is
 *      demo;
 *   4. every person a demo row is credited to is a demo profile or nobody;
 *   5. seeding again adds nothing and pays no invoice twice;
 *   6. the in-place patches applied, and the migration re-runs cleanly.
 */

const SCRIPT = "supabase/tests/demo-seeder-parents.pglite.mjs";
const PGLITE = "node_modules/@electric-sql/pglite/dist/index.js";

describe("demo seeder attaches demo records to demo parents only", () => {
  it("never gives a real job, account, contact, catalog item or rep a demo record", () => {
    if (!existsSync(PGLITE)) {
      expect.fail(
        `PGlite build not found at ${PGLITE}. Run \`npm install\` — @electric-sql/pglite is a devDependency.`,
      );
    }

    const out = execFileSync("node", [SCRIPT, PGLITE], {
      encoding: "utf8",
      timeout: 120_000,
    });

    expect(out).toMatch(/demo-seeder-parents\.pglite: \d+ assertions passed/);
    const count = Number(/: (\d+) assertions/.exec(out)?.[1] ?? 0);
    expect(count).toBeGreaterThanOrEqual(50);
  }, 150_000);

  it("seeds the demo accounts before any job, so the demo jobs exist for the invoices", () => {
    const src = readFileSync("src/lib/demo-data.ts", "utf8");
    const seed = src.slice(src.indexOf("export async function seedDemoData"));
    const data = seed.indexOf('supabase.rpc("seed_demo_data")');
    const jobs = seed.indexOf('supabase.rpc("seed_demo_jobs")');
    expect(data).toBeGreaterThan(-1);
    expect(jobs).toBeGreaterThan(data);
  });

  it("selects no job, invoice or catalog item in the seeders without a demo filter", () => {
    const sql = readFileSync(
      "supabase/migrations/20261016130000_demo_seeder_demo_parents_only.sql",
      "utf8",
    );
    // The old pick: any completed job in the database. (Code only — the
    // header comment quotes it.)
    const code = sql.replace(/--[^\n]*/g, "");
    expect(code).not.toMatch(
      /FROM public\.jobs\s+WHERE status IN \('complete','invoiced','paid'\)/,
    );
    expect(sql).toMatch(/WHERE jb\.is_demo\s+AND jb\.status IN \('complete','invoiced','paid'\)/);
    // Demo jobs are made before the invoices that hang off them.
    expect(sql.indexOf("RETURN QUERY SELECT * FROM public.seed_demo_jobs();")).toBeLessThan(
      sql.indexOf("-- invoices\n  -- DEMO jobs only"),
    );
    // Equipment and placements stay out: the Kahi sync owns equipment.
    expect(code).not.toMatch(/INSERT INTO public\.equipment(_placements)?\b/);
  });
});
