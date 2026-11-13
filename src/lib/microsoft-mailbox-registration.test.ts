import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The production store's half of "connecting puts your inbox on the Mail
 * page": what registerOwnMailbox and disableOwnMailbox do to
 * `graph_mailboxes`, run against a small in-memory table behind the same
 * query-builder calls the service-role client answers. The rule is that a
 * sign-in only ever creates or reclaims the person's OWN personal mailbox —
 * never a shared office mailbox, never somebody else's.
 */

type Row = {
  id: string;
  upn: string;
  kind: string;
  user_id: string | null;
  graph_user_id: string | null;
  display_name: string | null;
  enabled: boolean;
  sync_mail: boolean;
  sync_calendar: boolean;
  location_id: string | null;
  updated_at?: string;
};

const db = vi.hoisted(() => ({
  rows: [] as Row[],
  writes: [] as { op: string; filters: string[] }[],
  failInsert: null as { code?: string; message: string } | null,
}));

vi.mock("@/integrations/supabase/client.server", () => {
  type Filter = { col: string; op: "eq" | "is"; value: unknown };
  // `.is(col, null)` and `.eq(col, v)` both come down to equality here.
  const matches = (row: Record<string, unknown>, filters: Filter[]) =>
    filters.every((f) => row[f.col] === f.value);

  class Query {
    private filters: Filter[] = [];
    constructor(
      private op: "select" | "insert" | "update",
      private payload?: Record<string, unknown>,
    ) {}
    eq(col: string, value: unknown) {
      this.filters.push({ col, op: "eq", value });
      return this;
    }
    is(col: string, value: unknown) {
      this.filters.push({ col, op: "is", value });
      return this;
    }
    async maybeSingle() {
      const found = db.rows.filter((r) => matches(r, this.filters));
      return { data: found[0] ? { ...found[0] } : null, error: null };
    }
    private run() {
      db.writes.push({ op: this.op, filters: this.filters.map((f) => `${f.op}:${f.col}`) });
      if (this.op === "insert") {
        if (db.failInsert) return { error: db.failInsert };
        db.rows.push({
          id: `mb-${db.rows.length + 1}`,
          kind: "user",
          user_id: null,
          graph_user_id: null,
          display_name: null,
          enabled: true,
          sync_mail: true,
          sync_calendar: true,
          location_id: null,
          ...(this.payload as Partial<Row>),
        } as Row);
        return { error: null };
      }
      for (const r of db.rows) {
        if (matches(r, this.filters)) Object.assign(r, this.payload);
      }
      return { error: null };
    }
    then<T>(resolve: (v: { error: unknown }) => T) {
      return Promise.resolve(this.run()).then(resolve);
    }
  }

  return {
    supabaseAdmin: {
      from(table: string) {
        if (table !== "graph_mailboxes") throw new Error(`unexpected table ${table}`);
        return {
          select: () => new Query("select"),
          insert: (row: Record<string, unknown>) => new Query("insert", row),
          update: (patch: Record<string, unknown>) => new Query("update", patch),
        };
      },
    },
  };
});

import { supabaseConnectionStore as store } from "./microsoft-delegated.server";

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const MINE = {
  userId: ALICE,
  upn: "alice@goldstar.test",
  graphUserId: "oid-alice",
  displayName: "Alice Adams",
};

const row = (over: Partial<Row>): Row => ({
  id: "mb-existing",
  upn: "alice@goldstar.test",
  kind: "user",
  user_id: null,
  graph_user_id: null,
  display_name: "Alice (added by an admin)",
  enabled: false,
  sync_mail: true,
  sync_calendar: false,
  location_id: null,
  ...over,
});

beforeEach(() => {
  db.rows = [];
  db.writes = [];
  db.failInsert = null;
});

describe("registering the person's own mailbox", () => {
  it("no row for that address: inserts a personal mailbox for this person, syncing mail", async () => {
    expect(await store.registerOwnMailbox(MINE)).toBe("inserted");
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]).toMatchObject({
      upn: "alice@goldstar.test",
      kind: "user",
      user_id: ALICE,
      graph_user_id: "oid-alice",
      display_name: "Alice Adams",
      enabled: true,
      sync_mail: true,
    });
  });

  it("an admin's row with no person on it yet, or this person's own: claimed and switched on", async () => {
    for (const userId of [null, ALICE]) {
      db.rows = [row({ user_id: userId })];
      expect(await store.registerOwnMailbox(MINE)).toBe("updated");
      expect(db.rows[0]).toMatchObject({
        id: "mb-existing",
        user_id: ALICE,
        graph_user_id: "oid-alice",
        display_name: "Alice Adams",
        enabled: true,
        // What an admin chose about calendar sync is not overwritten.
        sync_calendar: false,
      });
    }
    // The update repeats the ownership conditions, so a row reassigned in
    // between is not taken over.
    const updates = db.writes.filter((w) => w.op === "update");
    expect(updates[0].filters).toEqual(["eq:id", "eq:kind", "is:user_id"]);
    expect(updates[1].filters).toEqual(["eq:id", "eq:kind", "eq:user_id"]);
  });

  it("somebody else's personal mailbox at that address is left exactly as it was", async () => {
    db.rows = [row({ user_id: BOB, enabled: true })];
    const before = structuredClone(db.rows);
    expect(await store.registerOwnMailbox(MINE)).toBe("skipped");
    expect(db.rows).toEqual(before);
    expect(db.writes).toEqual([]);
  });

  it("a shared office mailbox is never claimed by a personal sign-in", async () => {
    db.rows = [row({ kind: "shared_office", user_id: null, location_id: "loc-1", enabled: true })];
    const before = structuredClone(db.rows);
    expect(await store.registerOwnMailbox(MINE)).toBe("skipped");
    expect(db.rows).toEqual(before);
    expect(db.writes).toEqual([]);
  });

  it("an admin adding the same address at the same moment wins the race; anything else is an error", async () => {
    db.failInsert = { code: "23505", message: "duplicate key value" };
    expect(await store.registerOwnMailbox(MINE)).toBe("skipped");
    db.failInsert = { code: "42501", message: "permission denied" };
    await expect(store.registerOwnMailbox(MINE)).rejects.toMatchObject({ code: "42501" });
  });
});

describe("switching the mailbox off on disconnect", () => {
  it("turns off only this person's own personal mailbox", async () => {
    db.rows = [
      row({ id: "a", user_id: ALICE, enabled: true }),
      row({ id: "b", upn: "bob@goldstar.test", user_id: BOB, enabled: true }),
      row({
        id: "office",
        upn: "office@goldstar.test",
        kind: "shared_office",
        user_id: ALICE,
        enabled: true,
      }),
    ];
    await store.disableOwnMailbox(ALICE);
    expect(Object.fromEntries(db.rows.map((r) => [r.id, r.enabled]))).toEqual({
      a: false,
      b: true,
      office: true,
    });
  });

  it("reconnecting switches it back on", async () => {
    db.rows = [row({ user_id: ALICE, enabled: true })];
    await store.disableOwnMailbox(ALICE);
    expect(db.rows[0].enabled).toBe(false);
    expect(await store.registerOwnMailbox(MINE)).toBe("updated");
    expect(db.rows[0].enabled).toBe(true);
  });
});
