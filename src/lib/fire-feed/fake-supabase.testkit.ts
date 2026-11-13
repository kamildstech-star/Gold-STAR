/**
 * Test-only: an in-memory stand-in for the slice of the Supabase query
 * builder the fire feed's run uses (select / eq / in / gte / lt / is / order /
 * limit / maybeSingle / single, insert, update, upsert, delete). Rows live in
 * plain arrays so a test can seed tables and read back exactly what the run
 * wrote. Imported only by *.test.ts files.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

type Row = Record<string, unknown>;
type Filter = (r: Row) => boolean;

export interface FakeDb {
  tables: Record<string, Row[]>;
  client: SupabaseClient;
  /** Tables that answer as if the migration were not applied. */
  missing: Set<string>;
}

let seq = 0;
const newId = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

export function fakeDb(seed: Record<string, Row[]> = {}): FakeDb {
  const tables: Record<string, Row[]> = {};
  for (const [k, v] of Object.entries(seed)) tables[k] = v.map((r) => ({ ...r }));
  const missing = new Set<string>();

  function builder(table: string) {
    const filters: Filter[] = [];
    let op: "select" | "insert" | "update" | "upsert" | "delete" = "select";
    let payload: Row | Row[] | null = null;
    let upsertOpts: { onConflict?: string; ignoreDuplicates?: boolean } = {};
    let orderBy: { col: string; asc: boolean } | null = null;
    let limitN: number | null = null;
    let returning = false;
    let mode: "many" | "single" | "maybe" = "many";

    const rows = () => (tables[table] ??= []);

    function run(): { data: unknown; error: { message: string; code?: string } | null } {
      if (missing.has(table)) {
        return {
          data: null,
          error: { message: `relation "public.${table}" does not exist`, code: "42P01" },
        };
      }
      let out: Row[] = [];
      if (op === "select") {
        out = rows().filter((r) => filters.every((f) => f(r)));
      } else if (op === "insert") {
        const list = Array.isArray(payload) ? payload : [payload!];
        out = list.map((r) => ({ id: newId(), created_at: new Date().toISOString(), ...r }));
        rows().push(...out);
      } else if (op === "update") {
        out = rows().filter((r) => filters.every((f) => f(r)));
        for (const r of out) Object.assign(r, payload);
      } else if (op === "delete") {
        const keep = rows().filter((r) => !filters.every((f) => f(r)));
        out = rows().filter((r) => filters.every((f) => f(r)));
        tables[table] = keep;
      } else if (op === "upsert") {
        const keys = (upsertOpts.onConflict ?? "id").split(",").map((k) => k.trim());
        const list = Array.isArray(payload) ? payload : [payload!];
        for (const r of list) {
          const existing = rows().find((e) => keys.every((k) => e[k] === r[k] && r[k] != null));
          if (existing) {
            if (!upsertOpts.ignoreDuplicates) Object.assign(existing, r);
            out.push(existing);
          } else {
            const created = { id: newId(), created_at: new Date().toISOString(), ...r };
            rows().push(created);
            out.push(created);
          }
        }
      }
      if (orderBy) {
        const { col, asc } = orderBy;
        out = [...out].sort(
          (a, b) => String(a[col] ?? "").localeCompare(String(b[col] ?? "")) * (asc ? 1 : -1),
        );
      }
      if (limitN != null) out = out.slice(0, limitN);
      if (mode === "single")
        return out.length === 1
          ? { data: out[0], error: null }
          : { data: null, error: { message: "not one row" } };
      if (mode === "maybe") return { data: out[0] ?? null, error: null };
      return { data: op === "select" || returning ? out : null, error: null };
    }

    const api = {
      select(_cols?: string) {
        if (op !== "select") returning = true;
        return api;
      },
      insert(p: Row | Row[]) {
        op = "insert";
        payload = p;
        return api;
      },
      update(p: Row) {
        op = "update";
        payload = p;
        return api;
      },
      upsert(p: Row | Row[], o: { onConflict?: string; ignoreDuplicates?: boolean } = {}) {
        op = "upsert";
        payload = p;
        upsertOpts = o;
        return api;
      },
      delete() {
        op = "delete";
        return api;
      },
      eq(col: string, v: unknown) {
        filters.push((r) => r[col] === v);
        return api;
      },
      in(col: string, vs: unknown[]) {
        filters.push((r) => vs.includes(r[col]));
        return api;
      },
      gte(col: string, v: string) {
        filters.push((r) => String(r[col] ?? "") >= v);
        return api;
      },
      lt(col: string, v: string) {
        filters.push((r) => r[col] != null && String(r[col]) < v);
        return api;
      },
      is(col: string, v: null) {
        filters.push((r) => (r[col] ?? null) === v);
        return api;
      },
      order(col: string, o: { ascending?: boolean } = {}) {
        orderBy = { col, asc: o.ascending !== false };
        return api;
      },
      limit(n: number) {
        limitN = n;
        return api;
      },
      single() {
        mode = "single";
        return Promise.resolve(run());
      },
      maybeSingle() {
        mode = "maybe";
        return Promise.resolve(run());
      },
      then<T>(resolve: (v: ReturnType<typeof run>) => T, reject?: (e: unknown) => T) {
        try {
          return Promise.resolve(resolve(run()));
        } catch (e) {
          return reject ? Promise.resolve(reject(e)) : Promise.reject(e);
        }
      },
    };
    return api;
  }

  const client = { from: (t: string) => builder(t) } as unknown as SupabaseClient;
  return { tables, client, missing };
}
