/**
 * The migration-level half of the anonymous-access audit: read the SQL files
 * and refuse any that widen what `anon` can reach.
 *
 * The database-level half (supabase/tests/anon-surface.pglite.mjs) proves the
 * sweep and the default privileges close anon out. This half is what makes a
 * future migration that FORGETS the pattern fail CI, before it is applied:
 *
 *  1. Every function first created at or after the first sweep
 *     (20260924120000) must be revoked FROM anon by name, in its own file or a
 *     later one. REVOKE … FROM PUBLIC is not enough: Supabase grants anon by
 *     name. A function on ANON_EXECUTABLE_FUNCTIONS must instead be granted
 *     TO anon, on purpose.
 *  2. No migration from the second sweep (20260929120000) on may GRANT
 *     anything TO anon or TO PUBLIC, except EXECUTE on an allowlisted function.
 *  3. No migration may create or flip a bucket to public unless it is on
 *     PUBLIC_STORAGE_BUCKETS.
 *
 * Pure: file names and contents in, problems out.
 */

export type MigrationFile = { name: string; sql: string };

/** The first sweep. Functions created before it were swept by it. */
export const FIRST_SWEEP = "20260924120000";
/** The second sweep. From here on, no grant to anon or PUBLIC at all. */
export const SECOND_SWEEP = "20260929120000";

const stamp = (name: string) => name.slice(0, 14);

/** "public.foo", "goldstar_private.bar"; an unqualified name is public. */
function qualify(raw: string): string {
  const n = raw.replace(/"/g, "").toLowerCase();
  return n.includes(".") ? n : `public.${n}`;
}

/** Strip -- line comments and block comments, so prose never counts as SQL. */
function code(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
}

export type SurfaceProblem = { file: string; problem: string };

export function checkMigrationSurface(
  files: MigrationFile[],
  allow: { functions: readonly string[]; buckets: readonly string[] },
): SurfaceProblem[] {
  const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name));
  const problems: SurfaceProblem[] = [];
  const allowedFns = new Set(allow.functions.map(qualify));
  const allowedBuckets = new Set(allow.buckets);

  /* 1. Functions created since the first sweep ------------------------- */
  const firstCreated = new Map<string, string>();
  for (const f of sorted) {
    for (const m of code(f.sql).matchAll(
      /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([a-z_."]+)\s*\(/gi,
    )) {
      const fn = qualify(m[1]!);
      if (!firstCreated.has(fn)) firstCreated.set(fn, f.name);
    }
  }
  for (const [fn, file] of firstCreated) {
    if (stamp(file) < FIRST_SWEEP) continue;
    const later = sorted.filter((f) => f.name >= file).map((f) => code(f.sql));
    // The schema is optional for public functions; escape the name before
    // adding that optional group, so its own "\." is not escaped twice.
    const [schema, bare] = fn.split(".") as [string, string];
    const name = schema === "public" ? `(?:public\\.)?${bare}` : `${schema}\\.${bare}`;
    const revokeAnon = new RegExp(
      `REVOKE\\s+(?:ALL|EXECUTE)[^;]*?ON\\s+FUNCTION\\s+${name}\\s*\\([^;]*?FROM\\s+[^;]*\\banon\\b`,
      "i",
    );
    const grantAnon = new RegExp(
      `GRANT\\s+(?:ALL|EXECUTE)[^;]*?ON\\s+FUNCTION\\s+${name}\\s*\\([^;]*?TO\\s+[^;]*\\banon\\b`,
      "i",
    );
    if (allowedFns.has(fn)) {
      if (!later.some((s) => grantAnon.test(s))) {
        problems.push({
          file,
          problem: `${fn} is on ANON_EXECUTABLE_FUNCTIONS but no migration grants it TO anon`,
        });
      }
    } else if (!later.some((s) => revokeAnon.test(s))) {
      problems.push({
        file,
        problem: `${fn} is created without REVOKE … FROM anon (Supabase grants new functions to anon by name)`,
      });
    }
  }

  /* 2. No grants to anon or PUBLIC from the second sweep on ------------ */
  for (const f of sorted) {
    if (stamp(f.name) < SECOND_SWEEP) continue;
    for (const m of code(f.sql).matchAll(/GRANT\s+([^;]*?)\s+ON\s+([^;]*?)\s+TO\s+([^;]*);/gi)) {
      const grantees = m[3]!.toLowerCase();
      if (!/\b(anon|public)\b/.test(grantees)) continue;
      const fnMatch = /FUNCTION\s+([a-z_."]+)\s*\(/i.exec(m[2]!);
      if (fnMatch && allowedFns.has(qualify(fnMatch[1]!))) continue;
      problems.push({
        file: f.name,
        problem: `grants to anon/PUBLIC: GRANT ${m[1]} ON ${m[2]} TO ${m[3]}`,
      });
    }
  }

  /* 3. Buckets ---------------------------------------------------------- */
  for (const f of sorted) {
    const sql = code(f.sql);
    for (const m of sql.matchAll(
      /INSERT\s+INTO\s+storage\.buckets\s*\(([^)]*)\)\s*VALUES\s*\(([\s\S]*?)\)\s*(?:ON\s+CONFLICT[^;]*)?;/gi,
    )) {
      const cols = m[1]!.split(",").map((c) => c.trim().toLowerCase());
      const vals = m[2]!.split(",").map((v) => v.trim());
      const pub = vals[cols.indexOf("public")]?.toLowerCase();
      const id = vals[cols.indexOf("id")]?.replace(/'/g, "");
      if (pub === "true" && !allowedBuckets.has(id ?? "")) {
        problems.push({ file: f.name, problem: `creates public bucket ${id}` });
      }
    }
    for (const m of sql.matchAll(
      /UPDATE\s+storage\.buckets\s+SET\s+([^;]*?)(?:WHERE([^;]*))?;/gi,
    )) {
      if (!/public\s*=\s*true/i.test(m[1]!)) continue;
      problems.push({ file: f.name, problem: `makes a bucket public: ${m[0].slice(0, 120)}` });
    }
  }

  return problems;
}

/** The ARRAY[...] a migration mirrors an allowlist into, as plain strings. */
export function mirroredArray(sql: string, variable: string): string[] | null {
  const m = new RegExp(`${variable}\\s+text\\[\\]\\s*:=\\s*ARRAY\\[([^\\]]*)\\]`, "i").exec(sql);
  if (!m) return null;
  return [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
}
