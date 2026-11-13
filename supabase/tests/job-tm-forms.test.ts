import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Runs the pglite fixture for the T&M daily sheets inside the normal
 * `npx vitest run` gate, the same arrangement as job-task-templates.test.ts.
 *
 * What it proves, against migration 20261007231000 read from the file: the
 * job's viewers read and start sheets as themselves; one sheet per kind per
 * job per day, with a second phone's upsert landing on the same row and the
 * row keeping its id and author; a later save keeps the filed PDF; only an
 * admin deletes; inactive profiles, portal customers and anon are shut out;
 * the CHECKs hold.
 */

const SCRIPT = "supabase/tests/job-tm-forms.pglite.mjs";
const PGLITE = "node_modules/@electric-sql/pglite/dist/index.js";

describe("T&M daily sheets (pglite)", () => {
  it("one sheet per kind per job per day, open to the job's crew, closed to everyone else", () => {
    if (!existsSync(PGLITE)) {
      expect.fail(
        `PGlite build not found at ${PGLITE}. Run \`npm install\` — @electric-sql/pglite is a devDependency.`,
      );
    }
    const out = execFileSync("node", [SCRIPT, PGLITE], { encoding: "utf8", timeout: 120_000 });
    expect(out).toMatch(/job-tm-forms\.pglite: \d+ assertions passed/);
    const count = Number(/: (\d+) assertions/.exec(out)?.[1] ?? 0);
    expect(count).toBeGreaterThanOrEqual(26);
  }, 150_000);
});
