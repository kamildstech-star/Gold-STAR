import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * run_document_signature_reminders() was edited in the Lovable SQL editor and
 * the edit lived nowhere in git. 20261007091000 records the live body; this
 * holds it there.
 *
 * The fixture (`document-signature-reminders.pglite.mjs`, run as a child
 * process like `room-field-capture.test.ts`) proves the behaviour and the
 * EXECUTE fix. The md5 below proves the body is live's to the character: it is
 * md5(prosrc) read from production on 2026-10-07. If this fails, the file's
 * body was edited -- which is fine only if live was changed to match, and then
 * the hash is re-read from live, not from the file.
 */

const SCRIPT = "supabase/tests/document-signature-reminders.pglite.mjs";
const PGLITE = "node_modules/@electric-sql/pglite/dist/index.js";
const MIGRATION = "supabase/migrations/20261007091000_document_signature_reminders_live_body.sql";
const LIVE_PROSRC_MD5 = "3c85d002ea83594233737e7447ec421f";

describe("run_document_signature_reminders() is the body production runs", () => {
  it("captures live's body verbatim", () => {
    const sql = readFileSync(MIGRATION, "utf8").replace(/\r\n/g, "\n");
    const body = /AS \$function\$([\s\S]*?)\$function\$;/.exec(sql)?.[1];
    expect(body, "the function body between $function$ markers").toBeDefined();
    expect(createHash("md5").update(body!).digest("hex")).toBe(LIVE_PROSRC_MD5);
  });

  it("passes the pglite fixture", () => {
    if (!existsSync(PGLITE)) {
      expect.fail(
        `PGlite build not found at ${PGLITE}. Run \`npm install\` — @electric-sql/pglite is a devDependency.`,
      );
    }
    const out = execFileSync("node", [SCRIPT, PGLITE], { encoding: "utf8", timeout: 120_000 });
    expect(out).toMatch(/document-signature-reminders\.pglite: \d+ assertions passed/);
    const count = Number(/: (\d+) assertions/.exec(out)?.[1] ?? 0);
    expect(count).toBeGreaterThanOrEqual(15);
  }, 150_000);
});
