/**
 * What the sync queue has to be right about.
 *
 * Two of these fail silently in production and are why the tests exist at all:
 * a drain that runs twice files two records instead of one, and a write
 * captured underground lands stamped with the time the phone found signal. The
 * first shows up as a duplicate shift in payroll, the second as hours nobody
 * worked. Neither throws, neither logs, and neither is visible on the phone.
 *
 * The third is classification: a refusal the server will repeat has to stop and
 * say why, and a refusal it will not has to keep trying.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));

/* ------------------------------------------------------------------ */
/* An IndexedDB that is a Map                                          */
/* ------------------------------------------------------------------ */

const store = new Map<string, unknown>();
vi.mock("idb-keyval", () => ({
  get: async (k: string) => store.get(k),
  set: async (k: string, v: unknown) => void store.set(k, v),
  del: async (k: string) => void store.delete(k),
  entries: async () => [...store.entries()],
}));

/* ------------------------------------------------------------------ */
/* A Supabase that is a table of rows                                  */
/* ------------------------------------------------------------------ */

type Row = Record<string, unknown>;
type Fail = { error: unknown; afterWrite?: boolean } | null;

/** Rows the fake server holds, per table, keyed by id. */
const tables = new Map<string, Map<string, Row>>();
/**
 * Queued failures, consumed one per matching call — a flaky network.
 * `afterWrite` is the case that matters most: the server applied the row and
 * the answer never came back, which is what the client sees as a failure and
 * what a naive retry turns into a second record.
 */
const failures: { table: string; error: unknown; afterWrite?: boolean }[] = [];

function rows(table: string): Map<string, Row> {
  if (!tables.has(table)) tables.set(table, new Map());
  return tables.get(table)!;
}

function nextFailure(table: string): Fail {
  const i = failures.findIndex((f) => f.table === table);
  if (i === -1) return null;
  const [f] = failures.splice(i, 1);
  return { error: f!.error, afterWrite: f!.afterWrite };
}

function builder(table: string) {
  let op: "update" | null = null;
  let patch: Row = {};
  let idFilter: string | null = null;

  const run = (wantRows: boolean) => {
    const fail = nextFailure(table);
    if (fail) return { data: null, error: fail.error };
    if (op === "update" && idFilter) {
      const existing = rows(table).get(idFilter);
      if (!existing) return { data: [], error: null };
      rows(table).set(idFilter, { ...existing, ...patch });
      return { data: wantRows ? [{ id: idFilter }] : null, error: null };
    }
    return { data: null, error: null };
  };

  const chain = {
    upsert(row: Row | Row[]) {
      const fail = nextFailure(table);
      if (!fail || fail.afterWrite) {
        const list = Array.isArray(row) ? row : [row];
        for (const r of list) rows(table).set(String(r["id"] ?? JSON.stringify(r)), r);
      }
      return Promise.resolve({ data: null, error: fail?.error ?? null });
    },
    update(p: Row) {
      op = "update";
      patch = p;
      return chain;
    },
    eq(_col: string, value: string) {
      idFilter = value;
      return chain;
    },
    select() {
      return Promise.resolve(run(true));
    },
    then(resolve: (v: unknown) => unknown) {
      return Promise.resolve(run(false)).then(resolve);
    },
  };
  return chain;
}

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      onAuthStateChange: vi.fn(),
      getSession: async () => ({
        data: { session: { user: { id: "u1" }, access_token: "token-a" } },
        error: null,
      }),
    },
  },
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ from: (table: string) => builder(table) }),
}));

import { drain, enqueue, isPermanent, listQueue, KIND_LABEL } from "@/lib/offline-queue";
import { PermanentWriteError } from "@/lib/offline-writes";

const SEVEN_AM = "2026-09-01T11:00:00.000Z";

beforeEach(() => {
  store.clear();
  tables.clear();
  failures.length = 0;
  vi.stubGlobal("navigator", { onLine: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/* ------------------------------------------------------------------ */

describe("draining twice", () => {
  it("files one shift, not two, when the first response is lost", async () => {
    await enqueue({
      kind: "clock_in",
      label: "Clock in",
      payload: {
        user_id: "u1",
        location_id: "loc1",
        clock_in_at: SEVEN_AM,
        clock_in_lat: null,
        clock_in_lon: null,
      },
    });

    // The write lands and the answer does not come back.
    failures.push({
      table: "shifts",
      error: { message: "FetchError: network down", code: "" },
      afterWrite: true,
    });
    const first = await drain();
    expect(first).toEqual({ sent: 0, failed: 1 });
    expect(rows("shifts").size).toBe(1);

    const second = await drain();
    expect(second).toEqual({ sent: 1, failed: 0 });
    expect(rows("shifts").size).toBe(1);
    expect(await listQueue()).toEqual([]);
  });

  it("keys the shift by the queue item id, which is what makes that true", async () => {
    const id = await enqueue({
      kind: "clock_in",
      label: "Clock in",
      payload: {
        user_id: "u1",
        location_id: "loc1",
        clock_in_at: SEVEN_AM,
        clock_in_lat: null,
        clock_in_lon: null,
      },
    });
    await drain();
    expect([...rows("shifts").keys()]).toEqual([id]);
  });
});

describe("the time a write is stamped with", () => {
  it("is when the crew tapped, not when the phone found signal", async () => {
    await enqueue({
      kind: "clock_in",
      label: "Clock in",
      payload: {
        user_id: "u1",
        location_id: "loc1",
        clock_in_at: SEVEN_AM,
        clock_in_lat: null,
        clock_in_lon: null,
      },
    });

    // Five hours in the van.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T16:00:00.000Z"));
    await drain();
    vi.useRealTimers();

    expect([...rows("shifts").values()][0]).toMatchObject({ clock_in_at: SEVEN_AM });
  });

  it("takes a clock-out's time from the punch, not from the drain", async () => {
    rows("shifts").set("shift-1", { id: "shift-1", clock_out_at: null });
    await enqueue({
      kind: "clock_out",
      label: "Clock out",
      payload: { shiftId: "shift-1", at: SEVEN_AM, lat: null, lon: null },
    });
    await drain();
    expect(rows("shifts").get("shift-1")).toMatchObject({
      clock_out_at: SEVEN_AM,
      status: "closed",
    });
  });

  it("falls back to the moment of capture, never to now, when none was carried", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(SEVEN_AM));
    await enqueue({
      kind: "job_note",
      label: "note",
      payload: { jobId: "job-1", authorId: "u1", body: "Pulled the baseboard" },
    });
    vi.setSystemTime(new Date("2026-09-01T16:00:00.000Z"));
    await drain();
    vi.useRealTimers();

    expect([...rows("job_notes").values()][0]).toMatchObject({ created_at: SEVEN_AM });
  });
});

describe("telling a permanent refusal from a temporary one", () => {
  it("believes a typed flag before it reads any text", () => {
    expect(isPermanent(new PermanentWriteError("anything at all"))).toBe(true);
    // The wording matches none of the phrase list; the flag is what carries it.
    expect(isPermanent(new Error("anything at all"))).toBe(false);
  });

  it("treats a blocked row as permanent whatever the message says", () => {
    expect(isPermanent({ code: "42501", message: "" })).toBe(true);
    expect(isPermanent({ code: "23514", message: "" })).toBe(true);
  });

  it("keeps retrying a foreign key, because the parent row may still be queued", () => {
    expect(isPermanent({ code: "23503", message: 'violates foreign key "photo_id"' })).toBe(false);
  });

  it("keeps retrying a duplicate key, which is usually a write that worked", () => {
    expect(isPermanent({ code: "23505", message: "duplicate key value already exists" })).toBe(
      false,
    );
  });

  it("still reads the old phrase list for callers that throw plain messages", () => {
    expect(isPermanent(new Error("That lead is not claimed by you"))).toBe(true);
  });
});

describe("a write the database refuses", () => {
  const rlsError = {
    code: "42501",
    message: 'new row violates row-level security policy for table "job_notes"',
  };

  it("stops, and says something a person can act on", async () => {
    await enqueue({
      kind: "job_note",
      label: "note",
      payload: { jobId: "job-1", authorId: "u1", body: "Pulled the baseboard" },
    });
    failures.push({ table: "job_notes", error: rlsError });
    await drain();

    const [item] = await listQueue();
    expect(item!.status).toBe("rejected");
    expect(item!.lastError).toContain("blocked by database permissions");
    // The old code stringified the raw error object into the queue.
    expect(item!.lastError).not.toContain("[object Object]");
  });

  it("is not retried on the next pass", async () => {
    await enqueue({
      kind: "job_note",
      label: "note",
      payload: { jobId: "job-1", authorId: "u1", body: "b" },
    });
    failures.push({ table: "job_notes", error: rlsError });
    await drain();
    expect(await drain()).toEqual({ sent: 0, failed: 0 });
    expect(rows("job_notes").size).toBe(0);
  });
});

describe("an attempt the phone died in the middle of", () => {
  it("is picked up again rather than stranded in 'sending' forever", async () => {
    const id = await enqueue({
      kind: "job_note",
      label: "note",
      payload: { jobId: "job-1", authorId: "u1", body: "b" },
    });
    // What a killed tab leaves behind.
    store.set("sync-queue:u1:" + id, {
      ...(store.get("sync-queue:u1:" + id) as object),
      status: "sending",
      sendingSince: Date.now() - 10 * 60_000,
    });

    expect(await drain()).toEqual({ sent: 1, failed: 0 });
    expect(rows("job_notes").size).toBe(1);
  });

  it("leaves a second tab's live attempt alone", async () => {
    const id = await enqueue({
      kind: "job_note",
      label: "note",
      payload: { jobId: "job-1", authorId: "u1", body: "b" },
    });
    store.set("sync-queue:u1:" + id, {
      ...(store.get("sync-queue:u1:" + id) as object),
      status: "sending",
      sendingSince: Date.now(),
    });

    expect(await drain()).toEqual({ sent: 0, failed: 0 });
  });
});

describe("the pending list", () => {
  it("has a label for every kind, so nothing shows as a blank line", async () => {
    const { KIND_LABEL: labels } = await import("@/lib/offline-queue");
    for (const [kind, label] of Object.entries(labels)) {
      expect({ kind, label }).toEqual({ kind, label: expect.stringMatching(/\S/) });
    }
    expect(Object.keys(KIND_LABEL).length).toBeGreaterThan(0);
  });
});
