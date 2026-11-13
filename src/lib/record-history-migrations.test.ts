import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * record_history's shared functions are redefined whole each time a table
 * joins (20261006150000, then 20261006163000, then 20261006200000, …), and
 * migrations run in version order. So a later file that was written from an
 * older copy would quietly drop a table an earlier file added — and a dropped
 * name in the CHECK makes the capture trigger's insert fail, which fails the
 * user's DELETE. This walks every migration in order and fails if any
 * redefinition covers fewer tables than the one before it.
 *
 * If this fails on your migration: start from the LATEST redefinition, not
 * from #300's, and keep every table it lists.
 */

const DIR = "supabase/migrations";
const files = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((name) => ({
    name,
    sql: readFileSync(`${DIR}/${name}`, "utf8")
      .replace(/\r\n/g, "\n")
      // Comments never count: prose can name a table without covering it.
      .replace(/--[^\n]*/g, ""),
  }));

/** The body of `CREATE OR REPLACE FUNCTION public.<fn>(` … `$$;` in a file. */
function body(sql: string, fn: string): string | null {
  const start = sql.search(
    new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+public\\.${fn}\\(`, "i"),
  );
  if (start < 0) return null;
  const open = sql.indexOf("$$", start);
  const close = sql.indexOf("$$", open + 2);
  return sql.slice(open + 2, close);
}

const names = (s: string) => new Set([...s.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!));

type Snapshot = { file: string; tables: Set<string> };

function history(extract: (sql: string) => Set<string> | null): Snapshot[] {
  const out: Snapshot[] = [];
  for (const f of files) {
    const tables = extract(f.sql);
    if (tables) out.push({ file: f.name, tables });
  }
  return out;
}

function expectCumulative(snaps: Snapshot[]) {
  expect(snaps.length).toBeGreaterThan(0);
  for (let i = 1; i < snaps.length; i++) {
    const dropped = [...snaps[i - 1]!.tables].filter((t) => !snaps[i]!.tables.has(t));
    expect(
      dropped,
      `${snaps[i]!.file} drops ${dropped.join(", ")} from ${snaps[i - 1]!.file}`,
    ).toEqual([]);
  }
}

describe("record_history redefinitions only ever add tables", () => {
  it("the CHECK on table_name", () => {
    expectCumulative(
      history((sql) => {
        const m = sql.match(
          /record_history_table_allowed\s+CHECK\s*\(\s*table_name\s+IN\s*\(([\s\S]*?)\)\s*\)/i,
        );
        return m ? names(m[1]!) : null;
      }),
    );
  });

  it("the tables record_history_capture() handles", () => {
    expectCumulative(
      history((sql) => {
        const b = body(sql, "record_history_capture");
        if (!b) return null;
        return new Set(
          [...b.matchAll(/WHEN\s+((?:'[a-z_]+'\s*,?\s*)+)THEN/g)].flatMap((m) => [...names(m[1]!)]),
        );
      }),
    );
  });

  it("the tables restore_record_history() allows", () => {
    expectCumulative(
      history((sql) => {
        const b = body(sql, "restore_record_history");
        if (!b) return null;
        const arr = b.match(/table_name\s*=\s*ANY\s*\(\s*ARRAY\[([\s\S]*?)\]/);
        return arr ? names(arr[1]!) : null;
      }),
    );
  });

  it("the tables record_history_may_restore() has a rule for", () => {
    expectCumulative(
      history((sql) => {
        const b = body(sql, "record_history_may_restore");
        if (!b) return null;
        return new Set(
          [...b.matchAll(/WHEN\s+((?:'[a-z_]+'\s*,?\s*)+)THEN/g)].flatMap((m) => [...names(m[1]!)]),
        );
      }),
    );
  });
});
