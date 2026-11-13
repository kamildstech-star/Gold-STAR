import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * jobs has seven foreign keys to accounts (customer, bill-to, referred by,
 * carrier, agency, public adjuster, independent reviewer). A bare
 * `accounts(...)` embed in a read FROM jobs is ambiguous, and PostgREST refuses
 * the whole query: "Could not embed because more than one relationship was
 * found for 'jobs' and 'accounts'" (live on the job Tasks tab, 2026-10-14).
 * Every jobs → accounts embed must name its key, e.g.
 * `accounts!jobs_account_id_fkey(name)`.
 */
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory()
      ? walk(p)
      : /\.(ts|tsx)$/.test(n) && !/\.test\./.test(n)
        ? [p]
        : [];
  });

describe("jobs → accounts embeds name their foreign key", () => {
  it("no read from jobs embeds a bare accounts(...)", () => {
    const offenders: string[] = [];
    for (const file of walk("src")) {
      const src = readFileSync(file, "utf8");
      // Reads written as .from("jobs") ... .select("...accounts(...")
      const re = /\.from\("jobs"\)[\s\S]{0,400}?\.select\(\s*[`"']([^`"']*)[`"']/g;
      for (const m of src.matchAll(re)) {
        if (/(^|[,(\s:])accounts(!inner)?\s*\(/.test(m[1]!)) offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
