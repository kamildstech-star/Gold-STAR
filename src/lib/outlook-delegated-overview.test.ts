import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The admin overview of delegated access: owner/admin/dev only, names and
 * statuses only, never the secrets table, and each mailbox's "needs an
 * owner" worked out by the same router the sync uses.
 */
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    const b = { middleware: () => b, inputValidator: () => b, handler: (fn: unknown) => fn };
    return b;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));

const db = vi.hoisted(() => ({
  tables: [] as string[],
  selects: [] as string[],
  data: {} as Record<string, unknown[]>,
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      db.tables.push(table);
      const result = { data: db.data[table] ?? [], error: null };
      const q: Record<string, unknown> = {
        select: (cols: string) => {
          db.selects.push(`${table}:${cols}`);
          return q;
        },
        eq: () => q,
        order: () => q,
        limit: () => q,
        then: (resolve: (v: unknown) => void) => resolve(result),
      };
      return q;
    },
  },
}));

import { outlookDelegatedOverview } from "./graph.functions";

const ADMIN = "admin";
const call = (isAdmin: boolean) =>
  (outlookDelegatedOverview as unknown as (a: unknown) => Promise<unknown>)({
    context: {
      userId: ADMIN,
      supabase: { rpc: async () => ({ data: isAdmin }) },
    },
  }) as Promise<import("./graph.functions").DelegatedOverview>;

beforeEach(() => {
  vi.stubEnv("OUTLOOK_AUTH_MODE", "delegated");
  db.tables = [];
  db.selects = [];
  db.data = {
    microsoft_connections: [
      {
        user_id: "rep-1",
        status: "connected",
        scopes: ["Mail.Read"],
        last_refreshed_at: "2026-10-07T10:00:00Z",
      },
      {
        user_id: "owner-1",
        status: "connected",
        scopes: ["Mail.Read", "Mail.Read.Shared", "Mail.Send.Shared", "Calendars.ReadWrite.Shared"],
        last_refreshed_at: null,
      },
      { user_id: "rep-2", status: "needs_reconnect", scopes: [], last_refreshed_at: null },
    ],
    profiles: [
      { user_id: "rep-1", full_name: "Rita Rep", email: "rita@goldstar.test" },
      { user_id: "rep-2", full_name: "Sam Sales", email: "sam@goldstar.test" },
      { user_id: "rep-3", full_name: null, email: "nobody@goldstar.test" },
      { user_id: "owner-1", full_name: "Olive Office", email: "olive@goldstar.test" },
    ],
    graph_mailboxes: [
      { id: "m1", upn: "rita@goldstar.test", kind: "user", user_id: "rep-1", owner_user_id: null },
      {
        id: "m2",
        upn: "nobody@goldstar.test",
        kind: "user",
        user_id: "rep-3",
        owner_user_id: null,
      },
      {
        id: "m3",
        upn: "office@goldstar.test",
        kind: "shared_office",
        user_id: null,
        owner_user_id: "owner-1",
      },
      {
        id: "m4",
        upn: "branch@goldstar.test",
        kind: "shared_office",
        user_id: null,
        owner_user_id: null,
      },
    ],
  };
});

describe("outlookDelegatedOverview", () => {
  it("is owner/admin/dev only", async () => {
    await expect(call(false)).rejects.toThrow(/owner, admin or developer/);
    expect(db.tables).toEqual([]);
  });

  it("never reads the secrets table, and selects no token or account address", async () => {
    await call(true);
    expect(db.tables).not.toContain("microsoft_connection_secrets");
    const conn = db.selects.find((s) => s.startsWith("microsoft_connections:"))!;
    expect(conn).not.toMatch(/token|cipher|iv\b|upn|ms_user_id/);
  });

  it("lists people with a mailbox or a connection, by name, with their status", async () => {
    const r = await call(true);
    expect(r.people.map((p) => [p.name, p.status, p.has_mailbox])).toEqual([
      ["nobody@goldstar.test", "not_connected", true],
      ["Olive Office", "connected", false],
      ["Rita Rep", "connected", true],
      ["Sam Sales", "needs_reconnect", false],
    ]);
    expect(JSON.stringify(r)).not.toMatch(/Mail\.Read/);
  });

  it("works out each mailbox's access with the sync's own router", async () => {
    const r = await call(true);
    expect(r.access.m1).toMatchObject({ ok: true });
    expect(r.access.m2).toMatchObject({ ok: false, problem: "not_connected" });
    expect(r.access.m3).toMatchObject({
      ok: true,
      owner_user_id: "owner-1",
      owner_name: "Olive Office",
    });
    expect(r.access.m4).toMatchObject({ ok: false, problem: "no_owner" });
    expect(r.access.m4.message).toMatch(/needs an owner/);
  });
});

describe("the admin screen's setup request", () => {
  const CARD = readFileSync("src/components/outlook-delegated-admin.tsx", "utf8").replace(
    /\r\n/g,
    "\n",
  );
  const PAGE = readFileSync(
    "src/routes/_authenticated/admin.integrations.outlook.tsx",
    "utf8",
  ).replace(/\r\n/g, "\n");

  it("takes the redirect URIs and scopes from the constants the sign-in uses", () => {
    expect(CARD).toMatch(
      /redirectOrigins\(buildAppOrigin\(\)\)\.map\(\s*\(o\) => `\$\{o\}\$\{MICROSOFT_CALLBACK_PATH\}`,?\s*\)/,
    );
    expect(CARD).toMatch(/\{DELEGATED_SCOPES\.map\(/);
    expect(CARD).toMatch(/\{SHARED_MAILBOX_SCOPES\.map\(/);
    expect(CARD).toContain("Grant admin consent for delegated permissions is optional.");
    expect(CARD).toContain("No application permissions.");
  });

  it("application mode no longer asks IT for Mail.ReadWrite", () => {
    const list = PAGE.match(/Application permissions<\/strong>[\s\S]*?<\/ul>/)![0];
    expect(list).not.toContain("Mail.ReadWrite");
    expect(list).toContain("Mail.Read");
  });

  it("delegated mode shows the delegated request, application mode the original one", () => {
    expect(PAGE).toMatch(/\{delegated \? \(\s*<DelegatedSetupRequest/);
  });
});
