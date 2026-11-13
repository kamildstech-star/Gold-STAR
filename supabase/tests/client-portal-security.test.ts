import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The client portal's security acceptance criteria, run inside the normal
 * `npx vitest run` gate. Same arrangement as `todo-items.test.ts`: the
 * `.pglite.mjs` script is the one copy of the test and runs as a child
 * process against the two real migration files.
 *
 * What it proves (see the script's header for the full list):
 *   1. deny by default — a customer session reads, writes and calls nothing
 *      outside the five portal functions, including under a `TO public`
 *      policy, a table with no RLS, storage, a PUBLIC-executable staff
 *      function, and a table created after the migration;
 *   2. customer A never reaches customer B's job, documents, photos or
 *      invoices by changing an id, nor their own unshared job;
 *   3. no cost, margin, note or EXIF field is ever returned;
 *   4. nothing is visible until chosen, and unsharing takes effect at once;
 *   5. invitations are single-use and expiring, and a customer can never
 *      hold or be switched into a staff role, office, profile or auth role.
 */

const SCRIPT = "supabase/tests/client-portal-security.pglite.mjs";
const PGLITE = "node_modules/@electric-sql/pglite/dist/index.js";

describe("client portal security", () => {
  it("customers see only what is shared with them, and nothing staff-only, ever", () => {
    if (!existsSync(PGLITE)) {
      expect.fail(
        `PGlite build not found at ${PGLITE}. Run \`npm install\` — @electric-sql/pglite is a devDependency.`,
      );
    }
    const out = execFileSync("node", [SCRIPT, PGLITE], { encoding: "utf8", timeout: 120_000 });
    expect(out).toMatch(/client-portal-security\.pglite: \d+ assertions passed/);
    const count = Number(/: (\d+) assertions/.exec(out)?.[1] ?? 0);
    expect(count).toBeGreaterThanOrEqual(120);
  }, 150_000);
});
