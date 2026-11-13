import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveMailboxAuth, resolveSenderAuth, type MailboxForAuth } from "./graph-auth.server";
import type { ConnectionRow, ConnectionStore } from "./microsoft-delegated.server";

/**
 * Mailbox → token routing. The rule under test: a mailbox is read with the
 * token of the one person who holds it, a send goes out on the caller's own
 * token, and when the right person cannot speak nobody else's token is tried.
 */

const REP = "rep-1";
const OTHER = "rep-2";
const OWNER = "office-owner";
const ADMIN = "admin-1";

const ALL = ["Mail.Read", "Mail.Send", "Calendars.ReadWrite", "User.Read"];
const SHARED = [...ALL, "Mail.Read.Shared", "Mail.Send.Shared", "Calendars.ReadWrite.Shared"];

function store(
  rows: Record<string, Partial<ConnectionRow>>,
  inactive: string[] = [],
): ConnectionStore {
  const get = vi.fn(async (id: string) =>
    rows[id]
      ? ({
          user_id: id,
          tenant_id: "t",
          ms_user_id: `oid-${id}`,
          upn: `${id}@goldstar.test`,
          display_name: id,
          scopes: ALL,
          status: "connected",
          last_error: null,
          connected_at: "2026-10-01T00:00:00Z",
          last_refreshed_at: null,
          ...rows[id],
        } as ConnectionRow)
      : null,
  );
  return {
    get,
    getSealed: vi.fn(),
    save: vi.fn(),
    rotate: vi.fn(),
    markNeedsReconnect: vi.fn(),
    setError: vi.fn(),
    remove: vi.fn(),
    isUserActive: vi.fn(async (id: string) => !inactive.includes(id)),
  } as unknown as ConnectionStore;
}

const personal = (over: Partial<MailboxForAuth> = {}): MailboxForAuth => ({
  upn: "rep-1@goldstar.test",
  kind: "user",
  user_id: REP,
  owner_user_id: null,
  ...over,
});
const office = (over: Partial<MailboxForAuth> = {}): MailboxForAuth => ({
  upn: "office@goldstar.test",
  kind: "shared_office",
  user_id: null,
  owner_user_id: OWNER,
  ...over,
});

afterEach(() => vi.unstubAllEnvs());

describe("delegated mode: which token reads a mailbox", () => {
  beforeEach(() => vi.stubEnv("OUTLOOK_AUTH_MODE", "delegated"));

  it("a personal mailbox is read with its own person's token", async () => {
    expect(await resolveMailboxAuth(personal(), store({ [REP]: {} }))).toEqual({
      ok: true,
      auth: { kind: "delegated", userId: REP },
      holderUserId: REP,
    });
  });

  it("a personal mailbox never borrows an owner's token, even if one is recorded", async () => {
    const s = store({ [OWNER]: { scopes: SHARED } });
    const r = await resolveMailboxAuth(personal({ owner_user_id: OWNER }), s);
    expect(r).toMatchObject({ ok: false, problem: "not_connected", holderUserId: REP });
    expect(s.get).not.toHaveBeenCalledWith(OWNER);
  });

  it("a shared office mailbox is read with its owner's token when they granted the .Shared scopes", async () => {
    expect(await resolveMailboxAuth(office(), store({ [OWNER]: { scopes: SHARED } }))).toEqual({
      ok: true,
      auth: { kind: "delegated", userId: OWNER },
      holderUserId: OWNER,
    });
  });

  it.each([
    ["no owner recorded", office({ owner_user_id: null }), store({}), "no_owner", /needs an owner/],
    ["owner never connected", office(), store({}), "not_connected", /needs an owner/],
    [
      "owner's sign-in expired",
      office(),
      store({ [OWNER]: { scopes: SHARED, status: "needs_reconnect" } }),
      "needs_reconnect",
      /reconnect/,
    ],
    [
      "owner has left",
      office(),
      store({ [OWNER]: { scopes: SHARED } }, [OWNER]),
      "inactive",
      /needs an owner/,
    ],
    [
      "owner connected without the shared scopes",
      office(),
      store({ [OWNER]: { scopes: ALL } }),
      "missing_shared_scopes",
      /shared office mailbox/,
    ],
    ["person never connected", personal(), store({}), "not_connected", /not connected/],
    [
      "person needs to reconnect",
      personal(),
      store({ [REP]: { status: "needs_reconnect" } }),
      "needs_reconnect",
      /reconnect/,
    ],
    ["person deactivated", personal(), store({ [REP]: {} }, [REP]), "inactive", /no longer active/],
  ])(
    "%s → skipped, with a reason a person can act on",
    async (_l, mailbox, s, problem, message) => {
      const r = await resolveMailboxAuth(mailbox, s);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.problem).toBe(problem);
        expect(r.message).toMatch(message);
      }
    },
  );

  it("a shared mailbox with a dead owner is not rescued by anyone else who is connected", async () => {
    const s = store({
      [OWNER]: { status: "needs_reconnect", scopes: SHARED },
      [ADMIN]: { scopes: SHARED },
    });
    const r = await resolveMailboxAuth(office(), s);
    expect(r.ok).toBe(false);
    expect(s.get).not.toHaveBeenCalledWith(ADMIN);
  });
});

describe("delegated mode: which token a send goes out on", () => {
  beforeEach(() => vi.stubEnv("OUTLOOK_AUTH_MODE", "delegated"));

  it("your own mailbox, your own token", async () => {
    expect(await resolveSenderAuth(REP, personal(), store({ [REP]: {} }))).toEqual({
      kind: "delegated",
      userId: REP,
    });
  });

  it("an office mailbox needs your .Shared consent, and then it is still YOUR token", async () => {
    await expect(
      resolveSenderAuth(REP, office(), store({ [REP]: { scopes: ALL } })),
    ).rejects.toThrow(/shared office mailbox/);
    expect(await resolveSenderAuth(REP, office(), store({ [REP]: { scopes: SHARED } }))).toEqual({
      kind: "delegated",
      userId: REP,
    });
  });

  it("an admin sending as a rep's mailbox uses the admin's token, never the rep's", async () => {
    const s = store({ [REP]: {}, [ADMIN]: { scopes: SHARED } });
    expect(await resolveSenderAuth(ADMIN, personal(), s)).toEqual({
      kind: "delegated",
      userId: ADMIN,
    });
    expect(s.get).not.toHaveBeenCalledWith(REP);
  });

  it("a colleague's personal mailbox without .Shared consent is refused before Graph", async () => {
    await expect(resolveSenderAuth(OTHER, personal(), store({ [OTHER]: {} }))).rejects.toThrow(
      /reconnect Outlook/,
    );
  });

  it("not connected / needs reconnect / inactive callers get a sentence, not a token", async () => {
    await expect(resolveSenderAuth(REP, personal(), store({}))).rejects.toThrow(/Connect Outlook/);
    await expect(
      resolveSenderAuth(REP, personal(), store({ [REP]: { status: "needs_reconnect" } })),
    ).rejects.toThrow(/Reconnect Outlook/);
    await expect(resolveSenderAuth(REP, personal(), store({ [REP]: {} }, [REP]))).rejects.toThrow(
      /not active/,
    );
  });
});

describe("application mode is unchanged", () => {
  beforeEach(() => vi.stubEnv("OUTLOOK_AUTH_MODE", "application"));

  it("every mailbox and every send uses the company credential, and no connection is read", async () => {
    const s = store({});
    for (const m of [personal(), office(), office({ owner_user_id: null })]) {
      expect(await resolveMailboxAuth(m, s)).toEqual({
        ok: true,
        auth: { kind: "application" },
        holderUserId: null,
      });
      expect(await resolveSenderAuth(REP, m, s)).toEqual({ kind: "application" });
    }
    expect(s.get).not.toHaveBeenCalled();
  });
});

describe("graph.functions wiring", () => {
  const SRC = readFileSync("src/lib/graph.functions.ts", "utf8").replace(/\r\n/g, "\n");
  const handler = (name: string) => {
    const start = SRC.indexOf(`export const ${name} = createServerFn`);
    const next = SRC.indexOf("export const ", start + 10);
    return SRC.slice(start, next < 0 ? undefined : next);
  };

  it.each(["sendGraphEmail", "createGraphMeeting"])(
    "%s: the app's own rule first, then the caller's own token, passed to Graph",
    (name) => {
      const body = handler(name);
      const rule = body.indexOf("await assertCanSendAs(context, mailbox)");
      const token = body.indexOf("await resolveSenderAuth(context.userId, mailbox)");
      expect(rule).toBeGreaterThan(0);
      expect(token).toBeGreaterThan(rule);
      expect(body).toMatch(/\},\s*auth,?\s*\)/);
    },
  );

  it("graphMessageBody reads with the mailbox holder's token, after the send-as check", () => {
    const body = handler("graphMessageBody");
    const rule = body.indexOf("await assertCanSendAs(context, mailbox)");
    const token = body.indexOf("await resolveMailboxAuthById(comm.mailbox_id)");
    expect(token).toBeGreaterThan(rule);
    expect(body).toContain("getMessageBody(mailbox.upn, comm.external_id, resolved.auth)");
  });
});
