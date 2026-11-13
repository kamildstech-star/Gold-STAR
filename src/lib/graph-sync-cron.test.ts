import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { API_ROUTES } from "@/lib/security/public-surface";

/**
 * /api/public/hooks/graph-sync, now that pg_cron calls it (graph_sync_kick,
 * 20261011120000): the shared CRON_SECRET and nothing else gets in; before
 * Outlook is configured, or before any mailbox exists, a run is a quiet 200;
 * the Outlook values an admin typed on the Integrations screen are the ones it
 * sees; and a lasting fault notifies each admin once, not every quarter hour.
 */
vi.mock("@tanstack/react-router", () => ({ createFileRoute: () => (config: unknown) => config }));

const limiter = vi.hoisted(() => ({ calls: 0 }));
vi.mock("@/lib/rate-limit.server", () => ({
  throttleWebhook: async () => {
    limiter.calls += 1;
    return null;
  },
}));

type Call = { table: string; ops: Array<[string, unknown[]]> };
const db = vi.hoisted(() => ({
  calls: [] as Call[],
  tables: {} as Record<string, unknown[]>,
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from(table: string) {
      const call: Call = { table, ops: [] };
      db.calls.push(call);
      const result = { data: db.tables[table] ?? [], error: null };
      const q: unknown = new Proxy(
        {},
        {
          get(_t, key: string) {
            if (key === "then") return (resolve: (v: unknown) => void) => resolve(result);
            return (...args: unknown[]) => {
              call.ops.push([key, args]);
              return q;
            };
          },
        },
      );
      return q;
    },
  },
}));

const sync = vi.hoisted(() => ({ mailboxes: [] as Array<Record<string, unknown>> }));
vi.mock("@/lib/graph-sync.server", () => ({
  listMailboxRows: async () => sync.mailboxes,
  refreshMailboxIdentity: async () => {},
  ensureSubscriptions: async (m: { upn: string }) => ({
    upn: m.upn,
    messages: null,
    events: null,
    error: "subscription renewal refused",
  }),
  syncMailbox: async () => ({ mail: { upserted: 0 }, calendar: { held: 0 } }),
}));
vi.mock("@/lib/calendar-push.server", () => ({
  drainCalendarPushQueue: async () => ({
    configured: true,
    considered: 0,
    pushed: 0,
    failed: 0,
    stuck: 0,
    skipped: 0,
    waiting: 0,
    outcomes: [],
  }),
  calendarPushSummary: async () => ({
    pending: 0,
    stuck: 0,
    oldest_pending_at: null,
    samples: [],
  }),
}));

const { encryptValue, invalidateCredentialCache } =
  await import("@/lib/integration-credentials.server");

const CRON = "cron-secret-value-0123456789abcdef";
const TENANT = "9f1c1b5e-1234-4abc-8def-0123456789ab";
const OUTLOOK_KEYS = [
  "OUTLOOK_TENANT_ID",
  "OUTLOOK_CLIENT_ID",
  "OUTLOOK_CLIENT_SECRET",
  "OUTLOOK_WEBHOOK_CLIENT_STATE",
  "OUTLOOK_AUTH_MODE",
  "GRAPH_SYNC_SECRET",
];
let saved: Record<string, string | undefined> = {};

type Handler = (input: { request: Request }) => Promise<Response>;
const post = async (headers: Record<string, string>) => {
  const mod = (await import("@/routes/api/public/hooks/graph-sync")) as unknown as {
    Route: { server: { handlers: { POST: Handler } } };
  };
  return mod.Route.server.handlers.POST({
    request: new Request("https://hub.test/api/public/hooks/graph-sync", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: "{}",
    }),
  });
};

async function storeCredential(key_name: string, value: string) {
  const { ciphertext, iv } = await encryptValue(value);
  db.tables["integration_credentials"] = [
    ...(db.tables["integration_credentials"] ?? []),
    { key_name, ciphertext, iv },
  ];
}

const configureInEnv = () => {
  process.env["OUTLOOK_TENANT_ID"] = TENANT;
  process.env["OUTLOOK_CLIENT_ID"] = "client-id";
  process.env["OUTLOOK_CLIENT_SECRET"] = "client-secret";
  process.env["OUTLOOK_WEBHOOK_CLIENT_STATE"] = "client-state";
};

beforeEach(() => {
  // ensureIntegrationEnv writes straight into process.env, so these keys are
  // saved and restored by hand rather than stubbed.
  saved = Object.fromEntries(OUTLOOK_KEYS.map((k) => [k, process.env[k]]));
  for (const k of OUTLOOK_KEYS) delete process.env[k];
  vi.stubEnv("CRON_SECRET", CRON);
  vi.stubEnv("INTEGRATION_CRED_KEY", "integration-key-for-tests");
  db.calls = [];
  db.tables = {};
  sync.mailboxes = [];
  limiter.calls = 0;
  invalidateCredentialCache();
});
afterEach(() => {
  for (const k of OUTLOOK_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllEnvs();
});

describe("graph-sync authenticates with the shared cron secret", () => {
  it("is listed as a cron-secret hook, checked by denyUnlessCron", () => {
    const entry = API_ROUTES["src/routes/api/public/hooks/graph-sync.ts"];
    expect(entry.credential).toBe("cron-secret");
    expect(String(entry.marker)).toContain("denyUnlessCron");
  });

  it("accepts CRON_SECRET in x-cron-secret", async () => {
    const res = await post({ "x-cron-secret": CRON });
    expect(res.status).toBe(200);
    expect(limiter.calls).toBe(1);
  });

  it("refuses a missing or wrong secret before the limiter or the database", async () => {
    for (const headers of [
      {},
      { "x-cron-secret": "wrong" },
      { "x-cron-secret": `${CRON}x` },
      // The old GRAPH_SYNC_SECRET path took a Bearer; the cron seam does not.
      { authorization: `Bearer ${CRON}` },
    ] as Record<string, string>[]) {
      const res = await post(headers);
      expect(res.status, JSON.stringify(headers)).toBe(401);
    }
    expect(limiter.calls).toBe(0);
    expect(db.calls).toEqual([]);
  });

  it("no longer opens for the retired GRAPH_SYNC_SECRET", async () => {
    process.env["GRAPH_SYNC_SECRET"] = "old-graph-sync-secret";
    expect((await post({ "x-cron-secret": "old-graph-sync-secret" })).status).toBe(401);
  });

  it("fails closed with CRON_SECRET unset, even for the right value", async () => {
    vi.stubEnv("CRON_SECRET", "");
    const res = await post({ "x-cron-secret": CRON });
    expect(res.status).toBe(503);
    expect(db.calls).toEqual([]);
  });
});

describe("a scheduled run before setup is a quiet no-op", () => {
  it("with no Outlook app details anywhere", async () => {
    const res = await post({ "x-cron-secret": CRON });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      skipped: "not configured",
      reason: "no_credentials",
    });
    // Only the credential store was read: no sync_runs row, no notice.
    expect(db.calls.map((c) => c.table)).toEqual(["integration_credentials"]);
  });

  it("with Outlook configured but no mailbox registered", async () => {
    configureInEnv();
    const res = await post({ "x-cron-secret": CRON });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      skipped: "not configured",
      reason: "no_mailboxes",
    });
    const tables = db.calls.map((c) => c.table);
    expect(tables).not.toContain("sync_runs");
    expect(tables).not.toContain("notifications");
    expect(tables).not.toContain("integration_connections");
  });

  it("a disabled mailbox counts as none", async () => {
    configureInEnv();
    sync.mailboxes = [{ id: "m1", upn: "rep@goldstar.test", enabled: false }];
    expect(await (await post({ "x-cron-secret": CRON })).json()).toMatchObject({
      skipped: "not configured",
      reason: "no_mailboxes",
    });
  });
});

describe("the Outlook values typed on the Integrations screen are the ones it uses", () => {
  it("picks up stored credentials when process.env has none", async () => {
    await storeCredential("OUTLOOK_TENANT_ID", TENANT);
    await storeCredential("OUTLOOK_CLIENT_ID", "client-id-from-screen");
    await storeCredential("OUTLOOK_CLIENT_SECRET", "secret-from-screen");
    const res = await post({ "x-cron-secret": CRON });
    // Configured now: it went on to look for mailboxes.
    expect(await res.json()).toMatchObject({ reason: "no_mailboxes" });
    expect(process.env["OUTLOOK_CLIENT_ID"]).toBe("client-id-from-screen");
  });
});

describe("a lasting fault notifies each admin once a day, not every run", () => {
  it("skips admins who already hold an unread notice for it", async () => {
    configureInEnv();
    sync.mailboxes = [{ id: "m1", upn: "rep@goldstar.test", enabled: true }];
    db.tables["user_roles"] = [{ user_id: "admin-a" }, { user_id: "admin-b" }];
    db.tables["notifications"] = [{ user_id: "admin-a" }];

    const res = await post({ "x-cron-secret": CRON });
    expect(res.status).toBe(200);
    expect((await res.json()).failures).toEqual([
      "rep@goldstar.test: subscription renewal refused",
    ]);

    const notices = db.calls.filter((c) => c.table === "notifications");
    const lookup = notices.find((c) => c.ops.some(([op]) => op === "select"))!;
    expect(lookup.ops).toContainEqual(["is", ["read_at", null]]);
    expect(lookup.ops).toContainEqual(["eq", ["title", "Outlook sync needs attention"]]);
    const insert = notices.find((c) => c.ops.some(([op]) => op === "insert"))!;
    const rows = insert.ops.find(([op]) => op === "insert")![1][0] as Array<{ user_id: string }>;
    expect(rows.map((r) => r.user_id)).toEqual(["admin-b"]);
  });
});
