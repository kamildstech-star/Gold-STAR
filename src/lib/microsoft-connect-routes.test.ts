import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The two HTTP doors of "Connect Outlook", called the way a browser would.
 * Microsoft and the database are never reached here: these are the refusals
 * and the ordering (credential before limiter, limiter fails closed).
 */
vi.mock("@tanstack/react-router", () => ({ createFileRoute: () => (config: unknown) => config }));

const limiter = vi.hoisted(() => ({ calls: [] as string[], allow: true, degraded: false }));
vi.mock("@/lib/rate-limit.server", () => ({
  RATE_LIMITS: { microsoftConnect: { limit: 10, windowSeconds: 900, blockSeconds: 900 } },
  consumeLimit: async (bucket: string, identity: string, _rule: unknown, mode: string) => {
    limiter.calls.push(`${bucket}:${identity}:${mode}`);
    return {
      allowed: limiter.allow,
      retryAfterSeconds: 60,
      attempts: 11,
      degraded: limiter.degraded,
    };
  },
}));
// The session check itself is tested where it lives; here a well-formed Bearer
// is Alice, so the start route's own handling of the body can be seen.
vi.mock("@/integrations/supabase/validate-session", () => ({
  validateSession: async () => ({ sub: "11111111-1111-4111-8111-111111111111" }),
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: new Proxy(
    {},
    {
      get() {
        throw new Error("the database was reached");
      },
    },
  ),
}));

type Handler = (input: { request: Request; params?: Record<string, string> }) => Promise<Response>;
const load = async (file: string) =>
  (
    (await import(/* @vite-ignore */ file)) as {
      Route: { server: { handlers: Record<string, Handler> } };
    }
  ).Route.server.handlers;

const TENANT = "9f1c1b5e-1234-4abc-8def-0123456789ab";
const ORIGIN = "https://flood-hero-hub.lovable.app";
const ALICE = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  limiter.calls = [];
  limiter.allow = true;
  vi.stubEnv("OUTLOOK_TENANT_ID", TENANT);
  vi.stubEnv("OUTLOOK_CLIENT_ID", "client-id");
  vi.stubEnv("OUTLOOK_CLIENT_SECRET", "client-secret");
  vi.stubEnv("INTEGRATION_CRED_KEY", "integration-key");
  vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("POST /api/auth/microsoft/start", () => {
  it("refuses without a Bearer token, before the limiter", async () => {
    const { POST } = await load("/src/routes/api/auth/microsoft/start.ts");
    for (const headers of [
      {},
      { authorization: "Bearer " },
      { authorization: "Basic abc" },
      { cookie: "rh_doc_session=a.b.c" },
    ] as Record<string, string>[]) {
      const res = await POST({
        request: new Request(`${ORIGIN}/api/auth/microsoft/start`, { method: "POST", headers }),
      });
      expect(res.status).toBe(401);
      expect(res.headers.get("set-cookie")).toBeNull();
    }
    expect(limiter.calls).toEqual([]);
  });

  it("only answers POST: a link or an <img> cannot start a connect", async () => {
    const handlers = await load("/src/routes/api/auth/microsoft/start.ts");
    expect(Object.keys(handlers)).toEqual(["POST"]);
  });

  it("signs returnTo into the state as mail or security, and nothing else", async () => {
    const { POST } = await load("/src/routes/api/auth/microsoft/start.ts");
    const { oauthStateKey, returnTargetOf, verifyState } = await import("@/lib/microsoft-oauth");
    const key = await oauthStateKey("integration-key");
    const landing = async (body: string | undefined) => {
      const res = await POST({
        request: new Request(`${ORIGIN}/api/auth/microsoft/start`, {
          method: "POST",
          headers: { authorization: "Bearer a.b.c", "content-type": "application/json" },
          body,
        }),
      });
      expect(res.status, body).toBe(200);
      const { url } = (await res.json()) as { url: string };
      const binding = /rh_ms_oauth=([^;]*)/.exec(res.headers.get("set-cookie")!)![1];
      const check = await verifyState(key, new URL(url).searchParams.get("state"), {
        binding,
        redirectUri: `${ORIGIN}/api/auth/microsoft/callback`,
        now: Date.now(),
      });
      if (!check.ok) throw new Error(check.reason);
      // The raw payload value, not a normalised one: only the two words are ever signed.
      expect(["mail", "security"]).toContain(check.payload.t);
      return returnTargetOf(check.payload.t);
    };
    expect(await landing(JSON.stringify({ returnTo: "mail" }))).toBe("mail");
    expect(await landing(JSON.stringify({ returnTo: "security" }))).toBe("security");
    expect(await landing(JSON.stringify({ shared: true }))).toBe("security");
    expect(await landing(undefined)).toBe("security");
    for (const odd of ["https://evil.example/", "//evil.example", "/admin", "MAIL", ["mail"], 1]) {
      expect(await landing(JSON.stringify({ returnTo: odd })), String(odd)).toBe("security");
    }
  });
});

describe("GET /api/auth/microsoft/callback", () => {
  const callback = async (url: string, cookie?: string) => {
    const { GET } = await load("/src/routes/api/auth/microsoft/callback.ts");
    return GET({ request: new Request(url, { headers: cookie ? { cookie } : {} }) });
  };

  it("no state or no cookie: a 400 page, the cookie cleared, no limiter, no database", async () => {
    for (const [url, cookie] of [
      [`${ORIGIN}/api/auth/microsoft/callback?code=x`, "rh_ms_oauth=abc"],
      [`${ORIGIN}/api/auth/microsoft/callback?code=x&state=v1.a.b`, undefined],
      [`${ORIGIN}/api/auth/microsoft/callback?code=x&state=v1.a.b`, "rh_ms_oauth=abc"],
      [
        `${ORIGIN}/api/auth/microsoft/callback?error=access_denied&error_description=<script>`,
        "rh_ms_oauth=abc",
      ],
    ] as const) {
      const res = await callback(url, cookie);
      expect(res.status, url).toBe(400);
      expect(res.headers.get("set-cookie")).toMatch(/rh_ms_oauth=;.*Max-Age=0/);
      const body = await res.text();
      expect(body).not.toContain("<script>");
      expect(body).not.toMatch(/access_denied|v1\.a\.b/);
    }
    expect(limiter.calls).toEqual([]);
  });

  it("a verified state reaches the limiter keyed by its user, failing closed; refused means no token request", async () => {
    const { beginConnect } = await import("@/lib/microsoft-delegated.server");
    const started = await beginConnect({
      userId: ALICE,
      requestUrl: `${ORIGIN}/api/auth/microsoft/start`,
      shared: false,
    });
    if (!started.ok) throw new Error(started.message);
    const state = new URL(started.url).searchParams.get("state")!;
    const cookie = /rh_ms_oauth=[^;]*/.exec(started.setCookie)![0];
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    limiter.allow = false;
    const res = await callback(
      `${ORIGIN}/api/auth/microsoft/callback?code=c&state=${encodeURIComponent(state)}`,
      cookie,
    );
    expect(limiter.calls).toEqual([`ms-oauth:callback:${ALICE}:closed`]);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/security?outlook=failed");
    expect(res.headers.get("set-cookie")).toMatch(/Max-Age=0/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Microsoft's cancel, with a valid state, goes back to Security with a fixed code", async () => {
    const { beginConnect } = await import("@/lib/microsoft-delegated.server");
    const started = await beginConnect({ userId: ALICE, requestUrl: `${ORIGIN}/x`, shared: false });
    if (!started.ok) throw new Error(started.message);
    const state = new URL(started.url).searchParams.get("state")!;
    const cookie = /rh_ms_oauth=[^;]*/.exec(started.setCookie)![0];
    const res = await callback(
      `${ORIGIN}/api/auth/microsoft/callback?error=access_denied&error_description=${encodeURIComponent("<b>hi</b>")}&state=${encodeURIComponent(state)}`,
      cookie,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/security?outlook=cancelled");
  });

  it("goes back to Mail when Connect was pressed there — and the request itself cannot pick the page", async () => {
    const { beginConnect } = await import("@/lib/microsoft-delegated.server");
    const started = await beginConnect({
      userId: ALICE,
      requestUrl: `${ORIGIN}/x`,
      shared: false,
      returnTo: "mail",
    });
    if (!started.ok) throw new Error(started.message);
    const state = encodeURIComponent(new URL(started.url).searchParams.get("state")!);
    const cookie = /rh_ms_oauth=[^;]*/.exec(started.setCookie)![0];
    const extra = "&returnTo=https%3A%2F%2Fevil.example%2F&next=%2F%2Fevil.example&t=security";

    const cancelled = await callback(
      `${ORIGIN}/api/auth/microsoft/callback?error=access_denied&state=${state}${extra}`,
      cookie,
    );
    expect(cancelled.headers.get("location")).toBe("/mail?outlook=cancelled");

    vi.stubGlobal("fetch", vi.fn());
    limiter.allow = false;
    const refused = await callback(
      `${ORIGIN}/api/auth/microsoft/callback?code=c&state=${state}${extra}`,
      cookie,
    );
    expect(refused.headers.get("location")).toBe("/mail?outlook=failed");
  });

  it("an unverifiable callback still gets the refusal page, wherever Connect was pressed", async () => {
    const { beginConnect } = await import("@/lib/microsoft-delegated.server");
    const started = await beginConnect({
      userId: ALICE,
      requestUrl: `${ORIGIN}/x`,
      shared: false,
      returnTo: "mail",
    });
    if (!started.ok) throw new Error(started.message);
    const state = encodeURIComponent(new URL(started.url).searchParams.get("state")!);
    // Right state, no cookie: a different browser.
    const res = await callback(`${ORIGIN}/api/auth/microsoft/callback?code=c&state=${state}`);
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect(limiter.calls).toEqual([]);
  });
});

describe("the Security page's Outlook card", () => {
  const read = (file: string) => readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const START = read("src/lib/outlook-connect-start.ts");
  const CARD = read("src/components/outlook-connection-card.tsx");
  const MAIL = read("src/routes/_authenticated/mail.index.tsx");
  const PAGE = read("src/routes/_authenticated/security.tsx");

  it("starts with the session's Bearer token and leaves only for Microsoft's sign-in host", () => {
    const start = START.match(/export async function startConnect[\s\S]*?\n}\n/)![0];
    expect(start).toContain('fetch("/api/auth/microsoft/start"');
    expect(start).toMatch(/Authorization: `Bearer \$\{token\}`/);
    expect(start).toMatch(/if \(!body\.url\.startsWith\(LOGIN_PREFIX\)\)/);
    expect(START).toContain('export const LOGIN_PREFIX = "https://login.microsoftonline.com/";');
    expect(start).toContain("window.location.assign(body.url)");
  });

  it("the card and the Mail page share that one implementation, each naming its own page", () => {
    for (const file of [CARD, MAIL]) {
      expect(file).toContain('import { startConnect } from "@/lib/outlook-connect-start";');
      expect(file).not.toMatch(/fetch\("\/api\/auth\/microsoft\/start"/);
      expect(file).not.toContain("window.location.assign");
    }
    expect(CARD).toContain('startConnect({ shared, returnTo: "security" })');
    expect(MAIL).toContain('startConnect({ shared: false, returnTo: "mail" })');
  });

  it("the page keeps only known outcome codes from the URL", () => {
    const validate = PAGE.match(/validateSearch:[\s\S]*?\n {2}\},/)![0];
    expect(validate).toContain("outlook in OUTLOOK_OUTCOME_MESSAGES");
    expect(PAGE).toMatch(/<OutlookConnectionCard outcome=\{outlook\}/);
  });
});
