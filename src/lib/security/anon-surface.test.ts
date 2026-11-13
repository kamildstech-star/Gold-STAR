import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  checkMigrationSurface,
  mirroredArray,
  type MigrationFile,
} from "@/lib/security/migration-surface";
import { ANON_EXECUTABLE_FUNCTIONS, PUBLIC_STORAGE_BUCKETS } from "@/lib/security/public-surface";

/**
 * The anonymous-access audit over the real migration files. See
 * migration-surface.ts for the three rules and why each exists; the database
 * half is supabase/tests/anon-surface.test.ts.
 */
const DIR = "supabase/migrations/";
const FILES: MigrationFile[] = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql"))
  .map((name) => ({ name, sql: readFileSync(DIR + name, "utf8").replace(/\r\n/g, "\n") }));
const ALLOW = {
  functions: Object.keys(ANON_EXECUTABLE_FUNCTIONS),
  buckets: Object.keys(PUBLIC_STORAGE_BUCKETS),
};

describe("the migrations give anon nothing", () => {
  it("every function since the first sweep revokes anon, and nothing grants to anon or PUBLIC", () => {
    expect(checkMigrationSurface(FILES, ALLOW)).toEqual([]);
  });

  it("the sweep's arrays mirror the allowlists in code", () => {
    const sweep = FILES.find((f) => f.name.startsWith("20260929120000"))!.sql;
    // Every copy of each array in the file, not just the first.
    const fnCopies = [...sweep.matchAll(/allowed_functions\s+text\[\]\s*:=\s*ARRAY\[[^\]]*\]/g)];
    expect(fnCopies.length).toBeGreaterThanOrEqual(2);
    for (const c of fnCopies) {
      expect(mirroredArray(c[0], "allowed_functions")!.sort()).toEqual([...ALLOW.functions].sort());
    }
    expect(mirroredArray(sweep, "allowed_buckets")!.sort()).toEqual([...ALLOW.buckets].sort());
  });

  it("names the one re-defined function that carried no revoke of its own", () => {
    const sweep = FILES.find((f) => f.name.startsWith("20260929120000"))!.sql;
    expect(sweep).toMatch(
      /REVOKE ALL ON FUNCTION public\.tg_automation_rules_validate\(\) FROM PUBLIC, anon, authenticated;/,
    );
  });
});

/**
 * The point of the whole suite: it must FAIL when a future migration forgets.
 * Each case adds one synthetic file to the real set and expects exactly that
 * file to be named.
 */
describe("a future migration that forgets the pattern is caught", () => {
  const withFile = (name: string, sql: string) =>
    checkMigrationSurface([...FILES, { name, sql }], ALLOW).map((p) => p.file);

  it("a new function with no REVOKE … FROM anon", () => {
    const name = "20261101120000_forgot.sql";
    const sql = `CREATE OR REPLACE FUNCTION public.leaky_report() RETURNS int
      LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$;
      GRANT EXECUTE ON FUNCTION public.leaky_report() TO authenticated;`;
    expect(withFile(name, sql)).toEqual([name]);
  });

  it("a REVOKE that only says PUBLIC, which leaves Supabase's grant to anon in place", () => {
    const name = "20261101120000_half.sql";
    const sql = `CREATE FUNCTION public.half_closed() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;
      REVOKE ALL ON FUNCTION public.half_closed() FROM PUBLIC;`;
    expect(withFile(name, sql)).toEqual([name]);
  });

  it("a comment that mentions the revoke does not count as one", () => {
    const name = "20261101120000_comment.sql";
    const sql = `CREATE FUNCTION public.commented() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;
      -- REVOKE ALL ON FUNCTION public.commented() FROM PUBLIC, anon;`;
    expect(withFile(name, sql)).toEqual([name]);
  });

  it("a grant to anon or PUBLIC on a table or function", () => {
    const name = "20261101120000_grant.sql";
    expect(withFile(name, "GRANT SELECT ON public.jobs TO anon;")).toEqual([name]);
    expect(withFile(name, "GRANT EXECUTE ON FUNCTION public.x() TO PUBLIC;")).toEqual([name]);
  });

  it("a public bucket", () => {
    const name = "20261101120000_bucket.sql";
    const insert = `INSERT INTO storage.buckets (id, name, public) VALUES ('open-files', 'open-files', true);`;
    expect(withFile(name, insert)).toEqual([name]);
    expect(
      withFile(name, "UPDATE storage.buckets SET public = true WHERE id = 'documents';"),
    ).toEqual([name]);
  });

  it("while the correct pattern passes", () => {
    const sql = `CREATE FUNCTION public.done_right() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;
      REVOKE ALL ON FUNCTION public.done_right() FROM PUBLIC, anon;
      GRANT EXECUTE ON FUNCTION public.done_right() TO authenticated;`;
    expect(withFile("20261101120000_right.sql", sql)).toEqual([]);
  });
});
