import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Runs the pglite fixture for proposals on a pipeline card inside the normal
 * `npx vitest run` gate, the same arrangement as job-tm-forms.test.ts.
 *
 * What it proves, against migration 20261012200000 read from the file: the
 * Proposal sent stage lands between its neighbours on both account pipelines
 * and a second run changes nothing; the account's rep and office manager
 * write, the office reads, everyone else is shut out; line totals and the
 * proposal total cannot be forged; the lifecycle holds; sent moves the card
 * forward only, through the account's own stage write; a signed document
 * activates the client and never fails the signature; declined leaves the
 * stage alone; Proposals sent counts quotes and proposals.
 */

const SCRIPT = "supabase/tests/account-proposals.pglite.mjs";
const PGLITE = "node_modules/@electric-sql/pglite/dist/index.js";

describe("account proposals (pglite)", () => {
  it("proposals: access, money, lifecycle, the card moving itself, and the count", () => {
    if (!existsSync(PGLITE)) {
      expect.fail(
        `PGlite build not found at ${PGLITE}. Run \`npm install\` — @electric-sql/pglite is a devDependency.`,
      );
    }
    const out = execFileSync("node", [SCRIPT, PGLITE], { encoding: "utf8", timeout: 120_000 });
    expect(out).toMatch(/account-proposals\.pglite: \d+ assertions passed/);
    const count = Number(/: (\d+) assertions/.exec(out)?.[1] ?? 0);
    expect(count).toBeGreaterThanOrEqual(79);
  }, 150_000);
});
