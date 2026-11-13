import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BINDING_COOKIE,
  DelegatedTokenError,
  beginConnect,
  completeConnect,
  disconnect,
  getDelegatedAccessToken,
  openRefreshToken,
  resetDelegatedTokenCache,
  sealRefreshToken,
  verifyCallbackRequest,
  type ConnectionRow,
  type ConnectionStore,
  type MailboxRegistration,
  type OwnMailbox,
  type SealedToken,
} from "./microsoft-delegated.server";
import { base64Url, pkceChallenge } from "./microsoft-oauth";

/**
 * The delegated flow end to end, with login.microsoftonline.com and Graph
 * replaced by a scripted fetch and the database by an in-memory store whose
 * contents the test can inspect — so "the token is encrypted at rest" is
 * checked against what would actually have been written.
 */

const TENANT = "9f1c1b5e-1234-4abc-8def-0123456789ab";
const CLIENT = "5a5a5a5a-0000-4000-8000-000000000001";
const ORIGIN = "https://flood-hero-hub.lovable.app";
const ENV = {
  OUTLOOK_TENANT_ID: TENANT,
  OUTLOOK_CLIENT_ID: CLIENT,
  OUTLOOK_CLIENT_SECRET: "client-secret-value",
  INTEGRATION_CRED_KEY: "integration-cred-key-for-tests",
};
const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);

const REFRESH_1 = "0.AAAA-refresh-token-one-SECRET";
const REFRESH_2 = "0.AAAA-refresh-token-two-SECRET";
const ACCESS_1 = "eyJ-access-token-one-SECRET";
const ACCESS_2 = "eyJ-access-token-two-SECRET";

function memoryStore(active: Record<string, boolean> = { [ALICE]: true, [BOB]: true }) {
  const rows = new Map<string, ConnectionRow>();
  const secrets = new Map<string, SealedToken>();
  /* The mailbox side is recorded, not modelled: its rules against the real
     table are in microsoft-mailbox-registration.test.ts. */
  const mailbox = {
    registered: [] as OwnMailbox[],
    disabled: [] as string[],
    result: "inserted" as MailboxRegistration,
    failRegister: false,
    failDisable: false,
  };
  const failures: { userId: string; stage: string; detail: Record<string, unknown> }[] = [];
  const store: ConnectionStore & {
    rows: typeof rows;
    secrets: typeof secrets;
    mailbox: typeof mailbox;
    failures: typeof failures;
  } = {
    rows,
    secrets,
    mailbox,
    failures,
    async get(id) {
      return rows.get(id) ?? null;
    },
    async getSealed(id) {
      return secrets.get(id) ?? null;
    },
    async save(row, sealed) {
      for (const [uid, r] of rows) {
        if (
          uid !== row.user_id &&
          r.tenant_id === row.tenant_id &&
          r.ms_user_id === row.ms_user_id
        ) {
          return { conflict: true };
        }
      }
      rows.set(row.user_id, { ...row });
      secrets.set(row.user_id, { ...sealed });
      return { conflict: false };
    },
    async rotate(id, patch, sealed) {
      const r = rows.get(id);
      if (r) rows.set(id, { ...r, ...patch });
      if (sealed) secrets.set(id, { ...sealed });
    },
    async markNeedsReconnect(id, error) {
      secrets.delete(id);
      const r = rows.get(id);
      if (r) rows.set(id, { ...r, status: "needs_reconnect", last_error: error });
    },
    async setError(id, error) {
      const r = rows.get(id);
      if (r) rows.set(id, { ...r, last_error: error });
    },
    async remove(id) {
      secrets.delete(id);
      rows.delete(id);
    },
    async isUserActive(id) {
      return active[id] === true;
    },
    async registerOwnMailbox(m) {
      if (mailbox.failRegister) throw new Error("graph_mailboxes is unavailable");
      mailbox.registered.push({ ...m });
      return mailbox.result;
    },
    async disableOwnMailbox(id) {
      if (mailbox.failDisable) throw new Error("graph_mailboxes is unavailable");
      mailbox.disabled.push(id);
    },
    async recordFailure(userId, stage, detail) {
      failures.push({ userId, stage, detail });
    },
  };
  return store;
}

function idToken(claims: Record<string, unknown>): string {
  const enc = (o: unknown) => base64Url(new TextEncoder().encode(JSON.stringify(o)));
  return `${enc({ alg: "RS256", typ: "JWT" })}.${enc(claims)}.signature`;
}

/** Scripted Microsoft: records every request, answers from the handlers given. */
function microsoft(handlers: {
  token?: (body: URLSearchParams) => Response;
  me?: (auth: string | null) => Response;
}) {
  const calls: { url: string; body: URLSearchParams | null; auth: string | null }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body instanceof URLSearchParams ? init.body : null;
    const auth = new Headers(init?.headers).get("Authorization");
    calls.push({ url, body, auth });
    // "manual", never "error": Cloudflare Workers reject "error" outright.
    expect(init?.redirect).toBe("manual");
    if (url === `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`) {
      return handlers.token ? handlers.token(body!) : new Response("{}", { status: 500 });
    }
    if (url.startsWith("https://graph.microsoft.com/v1.0/me?")) {
      return handlers.me ? handlers.me(auth) : new Response("{}", { status: 500 });
    }
    throw new Error(`unexpected request to ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

async function startFlow(
  userId = ALICE,
  origin = ORIGIN,
  shared = false,
  returnTo?: "mail" | "security",
) {
  const started = await beginConnect({
    userId,
    requestUrl: `${origin}/api/auth/microsoft/start`,
    shared,
    returnTo,
    env: ENV,
    now: NOW,
  });
  if (!started.ok) throw new Error(started.message);
  const url = new URL(started.url);
  const cookieValue = /rh_ms_oauth=([^;]*)/.exec(started.setCookie)![1];
  return {
    started,
    url,
    state: url.searchParams.get("state")!,
    nonce: url.searchParams.get("nonce")!,
    challenge: url.searchParams.get("code_challenge")!,
    cookie: `${BINDING_COOKIE}=${cookieValue}`,
  };
}

function callbackUrl(params: Record<string, string>, origin = ORIGIN) {
  return `${origin}/api/auth/microsoft/callback?${new URLSearchParams(params)}`;
}

const goodClaims = (nonce: string, over: Record<string, unknown> = {}) => ({
  aud: CLIENT,
  iss: `https://login.microsoftonline.com/${TENANT}/v2.0`,
  tid: TENANT,
  oid: "oid-alice",
  nonce,
  exp: NOW / 1000 + 3600,
  preferred_username: "Alice@GoldStar.test",
  name: "Alice Adams",
  ...over,
});

const tokenOk = (
  nonce: string,
  over: Record<string, unknown> = {},
  claimOver: Record<string, unknown> = {},
) =>
  Response.json({
    access_token: ACCESS_1,
    refresh_token: REFRESH_1,
    id_token: idToken(goodClaims(nonce, claimOver)),
    scope: "Mail.Read Mail.Send Calendars.ReadWrite User.Read openid profile email",
    expires_in: 3600,
    ...over,
  });

const meOk = (over: Record<string, unknown> = {}) =>
  Response.json({
    id: "oid-alice",
    userPrincipalName: "alice@goldstar.test",
    displayName: "Alice Adams",
    userType: "Member",
    ...over,
  });

let errors: unknown[][];
beforeEach(() => {
  resetDelegatedTokenCache();
  errors = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args);
  });
  vi.stubEnv("INTEGRATION_CRED_KEY", ENV.INTEGRATION_CRED_KEY);
});
afterEach(() => {
  // No log line, from any test, may carry a token.
  const logged = JSON.stringify(errors);
  for (const secret of [REFRESH_1, REFRESH_2, ACCESS_1, ACCESS_2, ENV.OUTLOOK_CLIENT_SECRET]) {
    expect(logged).not.toContain(secret);
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/* ------------------------------------------------------------------ */

describe("start", () => {
  it("returns an authorize URL for this origin and sets an HttpOnly, path-pinned binding cookie", async () => {
    const { started, url } = await startFlow();
    expect(url.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/auth/microsoft/callback`);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("prompt")).toBe("select_account");
    expect(started.setCookie).toMatch(/HttpOnly/);
    expect(started.setCookie).toMatch(/SameSite=Lax/);
    expect(started.setCookie).toMatch(/Secure/);
    expect(started.setCookie).toMatch(/Path=\/api\/auth\/microsoft\/callback/);
    expect(started.setCookie).toMatch(/Max-Age=600/);
  });

  it("the staging site gets the staging redirect URI", async () => {
    const { url } = await startFlow(ALICE, "https://goldstar.falconstaging.com");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://goldstar.falconstaging.com/api/auth/microsoft/callback",
    );
  });

  it("asks for the .Shared scopes only when the person opts in", async () => {
    expect((await startFlow(ALICE, ORIGIN, false)).url.searchParams.get("scope")).not.toMatch(
      /Shared/,
    );
    expect((await startFlow(ALICE, ORIGIN, true)).url.searchParams.get("scope")).toMatch(
      /Mail\.Read\.Shared Mail\.Send\.Shared Calendars\.ReadWrite\.Shared/,
    );
  });

  it("refuses an unregistered origin, application mode and missing secrets", async () => {
    const at = (requestUrl: string, env: Record<string, string>) =>
      beginConnect({ userId: ALICE, requestUrl, shared: false, env, now: NOW });
    expect(await at("https://evil.example/api/auth/microsoft/start", ENV)).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(await at(`${ORIGIN}/x`, { ...ENV, OUTLOOK_AUTH_MODE: "application" })).toMatchObject({
      ok: false,
      status: 409,
    });
    expect(await at(`${ORIGIN}/x`, { ...ENV, OUTLOOK_CLIENT_SECRET: "" })).toMatchObject({
      ok: false,
      status: 503,
    });
    expect(
      await at(`${ORIGIN}/x`, { ...ENV, OUTLOOK_TENANT_ID: "goldstar.onmicrosoft.com" }),
    ).toMatchObject({
      ok: false,
      status: 503,
    });
  });
});

describe("callback: state verification happens before anything else", () => {
  it("a valid state from this browser passes", async () => {
    const f = await startFlow();
    const r = await verifyCallbackRequest({
      requestUrl: callbackUrl({ code: "CODE", state: f.state }),
      cookieHeader: `other=1; ${f.cookie}`,
      env: ENV,
      now: NOW + 30_000,
    });
    expect(r).toMatchObject({
      ok: true,
      value: { userId: ALICE, shared: false, returnTo: "security" },
    });
  });

  it("brings back the page Connect was pressed on, from the signed state", async () => {
    const verify = async (
      f: Awaited<ReturnType<typeof startFlow>>,
      params: Record<string, string>,
    ) =>
      verifyCallbackRequest({
        requestUrl: callbackUrl({ ...params, state: f.state }),
        cookieHeader: f.cookie,
        env: ENV,
        now: NOW,
      });
    const fromMail = await startFlow(ALICE, ORIGIN, false, "mail");
    expect(await verify(fromMail, { code: "CODE" })).toMatchObject({
      ok: true,
      value: { returnTo: "mail" },
    });
    // A cancel comes back to the same page.
    expect(await verify(fromMail, { error: "access_denied" })).toEqual({
      ok: false,
      outcome: "cancelled",
      returnTo: "mail",
    });
    expect(
      await verify(await startFlow(ALICE, ORIGIN, false, "security"), { code: "CODE" }),
    ).toMatchObject({ ok: true, value: { returnTo: "security" } });
    // Anything else a caller hands in (the route only ever passes the two
    // words, but the state does not rely on that) is Security.
    const odd = await startFlow(ALICE, ORIGIN, false, "https://evil.example/" as "mail");
    expect(await verify(odd, { code: "CODE" })).toMatchObject({
      ok: true,
      value: { returnTo: "security" },
    });
  });

  it("a tampered state is refused", async () => {
    const f = await startFlow();
    const [v, body, sig] = f.state.split(".");
    const flipped = body.slice(0, -2) + (body.endsWith("A") ? "B" : "A") + body.slice(-1);
    const r = await verifyCallbackRequest({
      requestUrl: callbackUrl({ code: "CODE", state: `${v}.${flipped}.${sig}` }),
      cookieHeader: f.cookie,
      env: ENV,
      now: NOW,
    });
    expect(r).toMatchObject({ ok: false, outcome: "invalid_state" });
  });

  it("an expired state is refused as expired", async () => {
    const f = await startFlow();
    const r = await verifyCallbackRequest({
      requestUrl: callbackUrl({ code: "CODE", state: f.state }),
      cookieHeader: f.cookie,
      env: ENV,
      now: NOW + 11 * 60_000,
    });
    expect(r).toEqual({ ok: false, outcome: "expired", reason: "expired" });
  });

  it("another user's state is refused: Alice's callback finished in Bob's browser connects nothing", async () => {
    const alice = await startFlow(ALICE);
    const bob = await startFlow(BOB);
    for (const cookieHeader of [bob.cookie, null, ""]) {
      const r = await verifyCallbackRequest({
        requestUrl: callbackUrl({ code: "CODE", state: alice.state }),
        cookieHeader,
        env: ENV,
        now: NOW,
      });
      expect(r.ok, String(cookieHeader)).toBe(false);
    }
  });

  it("a state from the staging site is refused at the production callback", async () => {
    const f = await startFlow(ALICE, "https://goldstar.falconstaging.com");
    const r = await verifyCallbackRequest({
      requestUrl: callbackUrl({ code: "CODE", state: f.state }, ORIGIN),
      cookieHeader: f.cookie,
      env: ENV,
      now: NOW,
    });
    expect(r).toMatchObject({ ok: false, outcome: "invalid_state", reason: "redirect" });
  });

  it("Microsoft's cancel is reported only for a state that verifies", async () => {
    const f = await startFlow();
    expect(
      await verifyCallbackRequest({
        requestUrl: callbackUrl({ error: "access_denied", state: f.state }),
        cookieHeader: f.cookie,
        env: ENV,
        now: NOW,
      }),
    ).toEqual({ ok: false, outcome: "cancelled", returnTo: "security" });
    expect(
      await verifyCallbackRequest({
        requestUrl: callbackUrl({ error: "access_denied", state: "v1.forged.forged" }),
        cookieHeader: f.cookie,
        env: ENV,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, outcome: "invalid_state" });
  });
});

describe("callback: code exchange, tenant check, storage", () => {
  async function finish(
    opts: {
      store?: ReturnType<typeof memoryStore>;
      token?: (body: URLSearchParams, nonce: string) => Response;
      me?: () => Response;
      userId?: string;
    } = {},
  ) {
    const store = opts.store ?? memoryStore();
    const f = await startFlow(opts.userId ?? ALICE);
    const requestUrl = callbackUrl({ code: "AUTH-CODE", state: f.state });
    const verified = await verifyCallbackRequest({
      requestUrl,
      cookieHeader: f.cookie,
      env: ENV,
      now: NOW,
    });
    if (!verified.ok) throw new Error("state should verify");
    const ms = microsoft({
      token: (body) => (opts.token ? opts.token(body, f.nonce) : tokenOk(f.nonce)),
      me: opts.me ?? (() => meOk()),
    });
    const outcome = await completeConnect({
      verified: verified.value,
      requestUrl,
      store,
      env: ENV,
      now: NOW,
    });
    return { outcome, store, ms, f };
  }

  it("redeems the code with the PKCE verifier that matches the challenge, then stores an encrypted token", async () => {
    const { outcome, store, ms, f } = await finish();
    expect(outcome).toBe("connected");

    const tokenCall = ms.calls.find((c) => c.url.includes("/oauth2/v2.0/token"))!;
    expect(tokenCall.body!.get("grant_type")).toBe("authorization_code");
    expect(tokenCall.body!.get("code")).toBe("AUTH-CODE");
    expect(tokenCall.body!.get("redirect_uri")).toBe(`${ORIGIN}/api/auth/microsoft/callback`);
    expect(await pkceChallenge(tokenCall.body!.get("code_verifier")!)).toBe(f.challenge);

    const meCall = ms.calls.find((c) => c.url.includes("/me?"))!;
    expect(meCall.auth).toBe(`Bearer ${ACCESS_1}`);

    const row = store.rows.get(ALICE)!;
    expect(row).toMatchObject({
      tenant_id: TENANT,
      ms_user_id: "oid-alice",
      upn: "alice@goldstar.test",
      display_name: "Alice Adams",
      status: "connected",
    });
    expect(row.scopes).toEqual([
      "Calendars.ReadWrite",
      "email",
      "Mail.Read",
      "Mail.Send",
      "openid",
      "profile",
      "User.Read",
    ]);
    // Nothing secret on the readable row.
    expect(JSON.stringify(row)).not.toContain("SECRET");
  });

  it("encrypts the refresh token at rest, bound to its owner", async () => {
    const { store } = await finish();
    const sealed = store.secrets.get(ALICE)!;
    expect(sealed.ciphertext).not.toContain(REFRESH_1);
    expect(atob(sealed.ciphertext)).not.toContain("refresh-token-one");
    expect(await openRefreshToken(ALICE, sealed)).toBe(REFRESH_1);
    // Copied onto Bob's row, it will not open.
    await expect(openRefreshToken(BOB, sealed)).rejects.toThrow();
    // Two seals of the same token differ (fresh IV each time).
    const again = await sealRefreshToken(ALICE, REFRESH_1);
    expect(again.ciphertext).not.toBe(sealed.ciphertext);
    expect(again.iv).not.toBe(sealed.iv);
  });

  it("refuses an account from another tenant and stores nothing", async () => {
    const { outcome, store, ms } = await finish({
      token: (_b, nonce) => tokenOk(nonce, {}, { tid: "00000000-0000-4000-8000-000000000000" }),
    });
    expect(outcome).toBe("wrong_tenant");
    expect(store.rows.size + store.secrets.size).toBe(0);
    expect(ms.calls.some((c) => c.url.includes("/me?"))).toBe(false);
  });

  it("refuses another tenant's issuer even when tid is spoofed", async () => {
    const { outcome, store } = await finish({
      token: (_b, nonce) =>
        tokenOk(
          nonce,
          {},
          { iss: "https://login.microsoftonline.com/00000000-0000-4000-8000-000000000000/v2.0" },
        ),
    });
    expect(outcome).toBe("wrong_tenant");
    expect(store.rows.size).toBe(0);
  });

  it("refuses a guest whose home is another tenant (by idp claim, and by Graph userType)", async () => {
    const byClaim = await finish({
      token: (_b, nonce) =>
        tokenOk(
          nonce,
          {},
          { idp: "https://sts.windows.net/00000000-0000-4000-8000-000000000000/" },
        ),
    });
    expect(byClaim.outcome).toBe("guest_account");
    expect(byClaim.store.rows.size).toBe(0);
    const byGraph = await finish({ me: () => meOk({ userType: "Guest" }) });
    expect(byGraph.outcome).toBe("guest_account");
    expect(byGraph.store.rows.size).toBe(0);
  });

  it("refuses an id_token minted for another sign-in (nonce) or another app (aud)", async () => {
    expect((await finish({ token: (_b) => tokenOk("other-nonce") })).outcome).toBe("failed");
    expect(
      (await finish({ token: (_b, nonce) => tokenOk(nonce, {}, { aud: "other-app" }) })).outcome,
    ).toBe("failed");
  });

  it("refuses when Graph /me names a different account than the id_token", async () => {
    const { outcome, store } = await finish({ me: () => meOk({ id: "oid-mallory" }) });
    expect(outcome).toBe("failed");
    expect(store.rows.size).toBe(0);
  });

  it("refuses a code exchange Microsoft rejects, without logging anything secret", async () => {
    const { outcome, store } = await finish({
      token: () =>
        Response.json(
          {
            error: "invalid_grant",
            error_description: "AADSTS70008: The provided authorization code has expired.",
          },
          { status: 400 },
        ),
    });
    expect(outcome).toBe("failed");
    expect(store.rows.size).toBe(0);
    expect(JSON.stringify(errors)).toContain("AADSTS70008");
    // Microsoft's reason is kept where an admin can read it, and nothing else.
    expect(store.failures).toEqual([
      {
        userId: ALICE,
        stage: "code_exchange",
        detail: {
          http_status: 400,
          reason: "invalid_grant: AADSTS70008: The provided authorization code has expired.",
        },
      },
    ]);
    expect(JSON.stringify(store.failures)).not.toContain("AUTH-CODE");
  });

  it("records the stage when Microsoft answers without a refresh token", async () => {
    const { outcome, store } = await finish({
      token: () => Response.json({ access_token: "at", id_token: "x" }),
    });
    expect(outcome).toBe("failed");
    expect(store.failures.map((x) => [x.stage, x.detail.reason])).toEqual([
      ["code_exchange", "no refresh token in Microsoft's answer"],
    ]);
  });

  it("a failed sign-in is still failed when the failure cannot be recorded", async () => {
    const store = memoryStore();
    store.recordFailure = async () => {
      throw new Error("security_events is unavailable");
    };
    const { outcome } = await finish({
      store,
      token: () => Response.json({ error: "invalid_client" }, { status: 401 }),
    });
    expect(outcome).toBe("failed");
  });

  it("one Microsoft account, one Recovery Hub user", async () => {
    const store = memoryStore();
    expect((await finish({ store, userId: ALICE })).outcome).toBe("connected");
    const second = await finish({ store, userId: BOB });
    expect(second.outcome).toBe("already_linked");
    expect(store.rows.has(BOB)).toBe(false);
    expect(store.secrets.has(BOB)).toBe(false);
  });

  it("a person deactivated mid-flow gets nothing stored and no token is requested", async () => {
    const { outcome, store, ms } = await finish({ store: memoryStore({ [ALICE]: false }) });
    expect(outcome).toBe("inactive");
    expect(store.rows.size).toBe(0);
    expect(ms.fetchMock).not.toHaveBeenCalled();
    expect(store.mailbox.registered).toEqual([]);
  });
});

describe("callback: the person's own mailbox is registered for sync", () => {
  async function finish(store = memoryStore(), userId = ALICE, me = () => meOk()) {
    const f = await startFlow(userId);
    const requestUrl = callbackUrl({ code: "AUTH-CODE", state: f.state });
    const verified = await verifyCallbackRequest({
      requestUrl,
      cookieHeader: f.cookie,
      env: ENV,
      now: NOW,
    });
    if (!verified.ok) throw new Error("state should verify");
    microsoft({ token: () => tokenOk(f.nonce), me });
    const outcome = await completeConnect({
      verified: verified.value,
      requestUrl,
      store,
      env: ENV,
      now: NOW,
    });
    return { outcome, store };
  }

  it("a successful connect registers the signed-in mailbox, as Graph named it, for this person", async () => {
    const { outcome, store } = await finish();
    expect(outcome).toBe("connected");
    expect(store.mailbox.registered).toEqual([
      {
        userId: ALICE,
        upn: "alice@goldstar.test",
        graphUserId: "oid-alice",
        displayName: "Alice Adams",
      },
    ]);
  });

  it("a connect that is refused registers nothing", async () => {
    const store = memoryStore();
    expect((await finish(store, ALICE, () => meOk({ userType: "Guest" }))).outcome).toBe(
      "guest_account",
    );
    expect(store.mailbox.registered).toEqual([]);
    // Bob signing in with Alice's Microsoft account: already linked, and her
    // mailbox is not touched on his behalf.
    expect((await finish(store, ALICE)).outcome).toBe("connected");
    expect((await finish(store, BOB)).outcome).toBe("already_linked");
    expect(store.mailbox.registered.map((m) => m.userId)).toEqual([ALICE]);
  });

  it("a registration that fails does not fail the connect: the sign-in is stored and the error logged", async () => {
    const store = memoryStore();
    store.mailbox.failRegister = true;
    const { outcome } = await finish(store);
    expect(outcome).toBe("connected");
    expect(store.rows.get(ALICE)?.status).toBe("connected");
    expect(store.secrets.has(ALICE)).toBe(true);
    expect(JSON.stringify(errors)).toContain("graph_mailboxes is unavailable");
  });

  it("a mailbox that is shared or someone else's is left alone, with a short warning naming only the address", async () => {
    const warned: unknown[][] = [];
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warned.push(args);
    });
    const store = memoryStore();
    store.mailbox.result = "skipped";
    expect((await finish(store)).outcome).toBe("connected");
    expect(warned).toHaveLength(1);
    expect(warned[0][1]).toBe("alice@goldstar.test");
    const logged = JSON.stringify(warned);
    for (const secret of [REFRESH_1, ACCESS_1, "AUTH-CODE"]) expect(logged).not.toContain(secret);
  });
});

describe("refresh", () => {
  async function connected(store = memoryStore()) {
    const sealed = await sealRefreshToken(ALICE, REFRESH_1);
    store.rows.set(ALICE, {
      user_id: ALICE,
      tenant_id: TENANT,
      ms_user_id: "oid-alice",
      upn: "alice@goldstar.test",
      display_name: "Alice",
      scopes: ["Mail.Read", "Mail.Send", "Calendars.ReadWrite", "User.Read"],
      status: "connected",
      last_error: null,
      connected_at: new Date(NOW).toISOString(),
      last_refreshed_at: null,
    });
    store.secrets.set(ALICE, sealed);
    return store;
  }
  const opts = (store: ConnectionStore, now = NOW) => ({ store, env: ENV, now: () => now });

  it("rotates: the new refresh token replaces the old one, encrypted, and the access token is cached", async () => {
    const store = await connected();
    const ms = microsoft({
      token: (body) => {
        expect(body.get("grant_type")).toBe("refresh_token");
        expect(body.get("refresh_token")).toBe(REFRESH_1);
        expect(body.get("scope")).toContain("offline_access");
        return Response.json({
          access_token: ACCESS_2,
          refresh_token: REFRESH_2,
          expires_in: 3600,
        });
      },
    });
    expect(await getDelegatedAccessToken(ALICE, opts(store))).toBe(ACCESS_2);
    const sealed = store.secrets.get(ALICE)!;
    expect(sealed.ciphertext).not.toContain(REFRESH_2);
    expect(await openRefreshToken(ALICE, sealed)).toBe(REFRESH_2);
    expect(store.rows.get(ALICE)!.last_refreshed_at).toBe(new Date(NOW).toISOString());

    // Cached for its hour: no second token request.
    expect(await getDelegatedAccessToken(ALICE, opts(store, NOW + 30 * 60_000))).toBe(ACCESS_2);
    expect(ms.fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the stored refresh token when Microsoft does not send a new one", async () => {
    const store = await connected();
    microsoft({ token: () => Response.json({ access_token: ACCESS_2, expires_in: 3600 }) });
    await getDelegatedAccessToken(ALICE, opts(store));
    expect(await openRefreshToken(ALICE, store.secrets.get(ALICE)!)).toBe(REFRESH_1);
  });

  it("two requests at once share one refresh", async () => {
    const store = await connected();
    const ms = microsoft({
      token: () =>
        Response.json({ access_token: ACCESS_2, refresh_token: REFRESH_2, expires_in: 3600 }),
    });
    const [a, b] = await Promise.all([
      getDelegatedAccessToken(ALICE, opts(store)),
      getDelegatedAccessToken(ALICE, opts(store)),
    ]);
    expect(a).toBe(ACCESS_2);
    expect(b).toBe(ACCESS_2);
    expect(ms.fetchMock).toHaveBeenCalledTimes(1);
  });

  it("invalid_grant marks the connection needs_reconnect, deletes the dead token, and never retries it", async () => {
    const store = await connected();
    const ms = microsoft({
      token: () =>
        Response.json(
          {
            error: "invalid_grant",
            error_description: "AADSTS700082: The refresh token has expired due to inactivity.",
          },
          { status: 400 },
        ),
    });
    const err = await getDelegatedAccessToken(ALICE, opts(store)).catch((e) => e);
    expect(err).toBeInstanceOf(DelegatedTokenError);
    expect((err as DelegatedTokenError).reason).toBe("needs_reconnect");
    expect(store.rows.get(ALICE)).toMatchObject({ status: "needs_reconnect" });
    expect(store.rows.get(ALICE)!.last_error).toMatch(/AADSTS700082/);
    expect(store.secrets.has(ALICE)).toBe(false);

    const again = await getDelegatedAccessToken(ALICE, opts(store)).catch((e) => e);
    expect((again as DelegatedTokenError).reason).toBe("needs_reconnect");
    expect(ms.fetchMock).toHaveBeenCalledTimes(1);
  });

  it("interaction_required (conditional access) is also a reconnect", async () => {
    const store = await connected();
    microsoft({ token: () => Response.json({ error: "interaction_required" }, { status: 400 }) });
    await expect(getDelegatedAccessToken(ALICE, opts(store))).rejects.toMatchObject({
      reason: "needs_reconnect",
    });
  });

  it("our own client secret being rejected is a config error, not the person's fault", async () => {
    const store = await connected();
    microsoft({
      token: () =>
        Response.json(
          {
            error: "invalid_client",
            error_description: "AADSTS7000222: The client secret is expired.",
          },
          { status: 401 },
        ),
    });
    await expect(getDelegatedAccessToken(ALICE, opts(store))).rejects.toMatchObject({
      reason: "config",
    });
    expect(store.rows.get(ALICE)!.status).toBe("connected");
    expect(store.secrets.has(ALICE)).toBe(true);
    expect(store.rows.get(ALICE)!.last_error).toMatch(/AADSTS7000222/);
  });

  it("a token that will not decrypt (rotated key, or moved rows) means reconnect", async () => {
    const store = await connected();
    store.secrets.set(ALICE, await sealRefreshToken(BOB, REFRESH_1));
    const ms = microsoft({});
    await expect(getDelegatedAccessToken(ALICE, opts(store))).rejects.toMatchObject({
      reason: "needs_reconnect",
    });
    expect(ms.fetchMock).not.toHaveBeenCalled();
  });

  it("an inactive person's token is not used", async () => {
    const store = await connected(memoryStore({ [ALICE]: false }));
    const ms = microsoft({});
    await expect(getDelegatedAccessToken(ALICE, opts(store))).rejects.toMatchObject({
      reason: "inactive",
    });
    expect(ms.fetchMock).not.toHaveBeenCalled();
  });

  it("not connected is a typed refusal, and nothing broader is tried", async () => {
    const ms = microsoft({});
    await expect(getDelegatedAccessToken(BOB, opts(memoryStore()))).rejects.toMatchObject({
      reason: "not_connected",
    });
    expect(ms.fetchMock).not.toHaveBeenCalled();
  });

  it("disconnect deletes the row, the token, and the cached access token", async () => {
    const store = await connected();
    const ms = microsoft({
      token: () => Response.json({ access_token: ACCESS_2, expires_in: 3600 }),
    });
    await getDelegatedAccessToken(ALICE, opts(store));
    await disconnect(ALICE, store);
    expect(store.rows.has(ALICE)).toBe(false);
    expect(store.secrets.has(ALICE)).toBe(false);
    await expect(getDelegatedAccessToken(ALICE, opts(store))).rejects.toMatchObject({
      reason: "not_connected",
    });
    expect(ms.fetchMock).toHaveBeenCalledTimes(1);
  });

  it("disconnect switches off the person's own mailbox, so sync stops trying a token that is gone", async () => {
    const store = await connected();
    await disconnect(ALICE, store);
    expect(store.mailbox.disabled).toEqual([ALICE]);
  });

  it("a mailbox that will not switch off still leaves the person disconnected", async () => {
    const store = await connected();
    store.mailbox.failDisable = true;
    await expect(disconnect(ALICE, store)).resolves.toBeUndefined();
    expect(store.rows.has(ALICE)).toBe(false);
    expect(store.secrets.has(ALICE)).toBe(false);
    expect(JSON.stringify(errors)).toContain("graph_mailboxes is unavailable");
  });
});
