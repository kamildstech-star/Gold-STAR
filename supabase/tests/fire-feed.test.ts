import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Runs the pglite fixture for the fire feed inside the normal `npx vitest run`
 * gate, the same arrangement as tm-rate-codes.test.ts.
 *
 * What it proves, against migration 20261011140000 read from the file: the
 * seed (an area per office town, one Google News row, the switch OFF), the
 * array check on incidents.source_links, admin-only configuration with the
 * hook's fetch state out of admins' reach, a Google News row that cannot be
 * deleted, admin-read / service-written runs and ledger, the CHECKs (two
 * minutes per URL, no paid X kind), and a kick that posts only when the feed
 * is on, an area is active, a source is due and no run is in flight.
 */

const SCRIPT = "supabase/tests/fire-feed.pglite.mjs";
const PGLITE = "node_modules/@electric-sql/pglite/dist/index.js";

describe("fire feed tables, RLS and kick (pglite)", () => {
  it("seeds, locks down and schedules the feed", () => {
    if (!existsSync(PGLITE)) {
      expect.fail(
        `PGlite build not found at ${PGLITE}. Run \`npm install\` — @electric-sql/pglite is a devDependency.`,
      );
    }
    const out = execFileSync("node", [SCRIPT, PGLITE], { encoding: "utf8", timeout: 120_000 });
    expect(out).toMatch(/fire-feed\.pglite: \d+ assertions passed/);
    const count = Number(/: (\d+) assertions/.exec(out)?.[1] ?? 0);
    expect(count).toBeGreaterThanOrEqual(50);
  }, 150_000);
});
