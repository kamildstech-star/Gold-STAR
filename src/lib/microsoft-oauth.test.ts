import { describe, expect, it } from "vitest";

import {
  DELEGATED_SCOPES,
  MICROSOFT_CALLBACK_PATH,
  REGISTERED_ORIGINS,
  SHARED_MAILBOX_SCOPES,
  authorizeUrl,
  base64Url,
  checkIdTokenClaims,
  classifyTokenError,
  describeTokenError,
  fromBase64Url,
  isTenantGuid,
  missingScopes,
  normalizeScopes,
  oauthStateKey,
  outlookAuthMode,
  pkceChallenge,
  pkceVerifier,
  redirectOrigins,
  redirectUriFor,
  requestedScopes,
  RETURN_PATHS,
  returnTargetOf,
  signState,
  verifyState,
  type ReturnTarget,
} from "./microsoft-oauth";

const TENANT = "9f1c1b5e-1234-4abc-8def-0123456789ab";
const CLIENT = "5a5a5a5a-0000-4000-8000-000000000001";
const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);

describe("what IT registered", () => {
  it("the callback path and the two production origins are exactly what IT was told", () => {
    expect(MICROSOFT_CALLBACK_PATH).toBe("/api/auth/microsoft/callback");
    expect([...REGISTERED_ORIGINS]).toEqual([
      "https://goldstar.falconstaging.com",
      "https://flood-hero-hub.lovable.app",
    ]);
    expect(redirectUriFor("https://goldstar.falconstaging.com/api/auth/microsoft/start")).toBe(
      "https://goldstar.falconstaging.com/api/auth/microsoft/callback",
    );
    expect(redirectUriFor("https://flood-hero-hub.lovable.app/api/auth/microsoft/start")).toBe(
      "https://flood-hero-hub.lovable.app/api/auth/microsoft/callback",
    );
  });

  it("adds the deployment's own https address (PUBLIC_SITE_URL), never the request's", () => {
    const moved = "https://goldstar.example.workers.dev";
    expect(redirectOrigins(null)).toEqual([...REGISTERED_ORIGINS]);
    expect(redirectOrigins(moved)).toEqual([...REGISTERED_ORIGINS, moved]);
    expect(redirectOrigins("https://goldstar.falconstaging.com")).toEqual([...REGISTERED_ORIGINS]);
    expect(redirectOrigins("http://goldstar.example.com")).toEqual([...REGISTERED_ORIGINS]);
    expect(redirectUriFor(`${moved}/api/auth/microsoft/start`, moved)).toBe(
      `${moved}/api/auth/microsoft/callback`,
    );
    // Not configured: the new host is just another unknown Host header.
    expect(redirectUriFor(`${moved}/api/auth/microsoft/start`)).toBeNull();
    expect(redirectUriFor("https://evil.example/x", moved)).toBeNull();
  });

  it("derives the redirect URI from the request origin only when it is on the allowlist", () => {
    expect(redirectUriFor("http://localhost:8080/api/auth/microsoft/start")).toBe(
      "http://localhost:8080/api/auth/microsoft/callback",
    );
    expect(redirectUriFor("http://127.0.0.1:3000/x")).toBe(
      "http://127.0.0.1:3000/api/auth/microsoft/callback",
    );
    for (const bad of [
      "https://evil.example/api/auth/microsoft/start",
      "https://flood-hero-hub.lovable.app.evil.example/x",
      "http://flood-hero-hub.lovable.app/x",
      "https://localhost/x",
      "https://id-preview--abc.lovable.app/x",
      "not a url",
    ]) {
      expect(redirectUriFor(bad), bad).toBeNull();
    }
  });

  it("asks for the delegated scopes IT was told, and the .Shared ones only on request", () => {
    expect([...DELEGATED_SCOPES]).toEqual([
      "openid",
      "profile",
      "email",
      "offline_access",
      "User.Read",
      "Mail.Read",
      "Mail.Send",
      "Calendars.ReadWrite",
    ]);
    expect([...SHARED_MAILBOX_SCOPES]).toEqual([
      "Mail.Read.Shared",
      "Mail.Send.Shared",
      "Calendars.ReadWrite.Shared",
    ]);
    expect(requestedScopes(false)).not.toContain("Mail.Read.Shared");
    expect(requestedScopes(true)).toContain("Calendars.ReadWrite.Shared");
    // Never directory-wide, never write-all.
    for (const s of requestedScopes(true)) {
      expect(s).not.toMatch(/\.All$|ReadWrite\.All|Mail\.ReadWrite$/);
    }
  });

  it("normalizes granted scopes and reports what is missing", () => {
    const granted = normalizeScopes(
      "https://graph.microsoft.com/Mail.Read Mail.Send openid profile https://graph.microsoft.com/User.Read",
    );
    expect(granted).toEqual(["Mail.Read", "Mail.Send", "openid", "profile", "User.Read"]);
    expect(missingScopes(granted)).toEqual(["Calendars.ReadWrite"]);
  });

  it("is delegated unless application is set deliberately", () => {
    expect(outlookAuthMode({})).toBe("delegated");
    expect(outlookAuthMode({ OUTLOOK_AUTH_MODE: "delegated" })).toBe("delegated");
    expect(outlookAuthMode({ OUTLOOK_AUTH_MODE: " Application " })).toBe("application");
    expect(outlookAuthMode({ OUTLOOK_AUTH_MODE: "something-else" })).toBe("delegated");
  });

  it("wants the tenant as a GUID", () => {
    expect(isTenantGuid(TENANT)).toBe(true);
    expect(isTenantGuid("goldstar.onmicrosoft.com")).toBe(false);
    expect(isTenantGuid(undefined)).toBe(false);
  });
});

describe("PKCE", () => {
  it("S256 of the verifier, per RFC 7636 appendix B", async () => {
    expect(await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("the verifier is derived from the browser binding: 43 unreserved characters, different per binding", async () => {
    const key = await oauthStateKey("test-integration-key");
    const a = await pkceVerifier(key, "binding-a");
    const b = await pkceVerifier(key, "binding-b");
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
    expect(await pkceVerifier(key, "binding-a")).toBe(a);
    const otherKey = await oauthStateKey("a-different-server-key");
    expect(await pkceVerifier(otherKey, "binding-a")).not.toBe(a);
  });
});

describe("state", () => {
  const redirect = "https://flood-hero-hub.lovable.app/api/auth/microsoft/callback";
  const mint = async (
    over: Partial<{ userId: string; binding: string; now: number; redirectUri: string }> = {},
  ) => {
    const key = await oauthStateKey("test-integration-key");
    const token = await signState(key, {
      userId: over.userId ?? "user-a",
      binding: over.binding ?? "cookie-a",
      redirectUri: over.redirectUri ?? redirect,
      shared: false,
      now: over.now ?? NOW,
    });
    return { key, token };
  };

  it("round-trips for the same browser, origin and time window", async () => {
    const { key, token } = await mint();
    const r = await verifyState(key, token, {
      binding: "cookie-a",
      redirectUri: redirect,
      now: NOW + 60_000,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload.u).toBe("user-a");
  });

  it("refuses a tampered payload (someone rewriting the user it names)", async () => {
    const { key, token } = await mint();
    const [v, body, sig] = token.split(".");
    const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(body)));
    payload.u = "user-b";
    const forged = `${v}.${base64Url(new TextEncoder().encode(JSON.stringify(payload)))}.${sig}`;
    const r = await verifyState(key, forged, {
      binding: "cookie-a",
      redirectUri: redirect,
      now: NOW,
    });
    expect(r).toEqual({ ok: false, reason: "signature" });
  });

  it("refuses a state signed with another key", async () => {
    const { token } = await mint();
    const other = await oauthStateKey("not-our-key");
    expect(
      await verifyState(other, token, { binding: "cookie-a", redirectUri: redirect, now: NOW }),
    ).toEqual({
      ok: false,
      reason: "signature",
    });
  });

  it("expires after ten minutes", async () => {
    const { key, token } = await mint();
    expect(
      (
        await verifyState(key, token, {
          binding: "cookie-a",
          redirectUri: redirect,
          now: NOW + 599_000,
        })
      ).ok,
    ).toBe(true);
    expect(
      await verifyState(key, token, {
        binding: "cookie-a",
        redirectUri: redirect,
        now: NOW + 600_000,
      }),
    ).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("refuses another user's state: it is bound to the browser that started it", async () => {
    const { key, token } = await mint({ userId: "user-a", binding: "cookie-a" });
    // User B's browser has B's cookie (or none) — A's state is useless there.
    expect(
      await verifyState(key, token, { binding: "cookie-b", redirectUri: redirect, now: NOW }),
    ).toEqual({
      ok: false,
      reason: "binding",
    });
    expect(
      await verifyState(key, token, { binding: null, redirectUri: redirect, now: NOW }),
    ).toEqual({
      ok: false,
      reason: "binding",
    });
  });

  it("refuses a state minted for another origin", async () => {
    const { key, token } = await mint();
    expect(
      await verifyState(key, token, {
        binding: "cookie-a",
        redirectUri: "https://goldstar.falconstaging.com/api/auth/microsoft/callback",
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: "redirect" });
  });

  it("carries where to land afterwards as one of two words; anything else is Security", async () => {
    const key = await oauthStateKey("test-integration-key");
    const ctx = { binding: "cookie-a", redirectUri: redirect, now: NOW };
    const mintTo = (returnTo: unknown) =>
      signState(key, {
        userId: "user-a",
        binding: "cookie-a",
        redirectUri: redirect,
        shared: false,
        returnTo: returnTo as ReturnTarget,
        now: NOW,
      });
    const landed = async (token: string) => {
      const r = await verifyState(key, token, ctx);
      if (!r.ok) throw new Error(r.reason);
      return returnTargetOf(r.payload.t);
    };
    expect(await landed(await mintTo("mail"))).toBe("mail");
    expect(await landed(await mintTo("security"))).toBe("security");
    expect(await landed(await mintTo(undefined))).toBe("security");
    expect(await landed(await mintTo("https://evil.example/"))).toBe("security");
    expect(await landed(await mintTo("/admin"))).toBe("security");
  });

  it("a state from before the return target existed, or with a value this build does not know, lands on Security", async () => {
    const key = await oauthStateKey("test-integration-key");
    const signed = async (payload: Record<string, unknown>) => {
      const body = base64Url(new TextEncoder().encode(JSON.stringify(payload)));
      const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v1.${body}`));
      return `v1.${body}.${base64Url(new Uint8Array(sig))}`;
    };
    const { token } = await mint();
    const base = JSON.parse(new TextDecoder().decode(fromBase64Url(token.split(".")[1])));
    for (const t of [undefined, "//evil.example", "Mail", 1]) {
      const r = await verifyState(key, await signed({ ...base, t }), {
        binding: "cookie-a",
        redirectUri: redirect,
        now: NOW,
      });
      expect(r.ok, String(t)).toBe(true);
      if (r.ok) expect(returnTargetOf(r.payload.t)).toBe("security");
    }
    expect(RETURN_PATHS).toEqual({ security: "/security", mail: "/mail" });
  });

  it("refuses garbage without throwing", async () => {
    const key = await oauthStateKey("test-integration-key");
    for (const bad of [
      null,
      "",
      "v1",
      "v1.a",
      "v2.a.b",
      "v1.!!!.???",
      "v1.e30.AAAA",
      "x".repeat(5000),
    ]) {
      const r = await verifyState(key, bad, {
        binding: "cookie-a",
        redirectUri: redirect,
        now: NOW,
      });
      expect(r.ok, String(bad).slice(0, 20)).toBe(false);
    }
  });
});

describe("authorize URL", () => {
  it("is a v2 authorize request on our tenant with PKCE S256, select_account and a query response", () => {
    const url = new URL(
      authorizeUrl({
        tenantId: TENANT,
        clientId: CLIENT,
        redirectUri: "https://flood-hero-hub.lovable.app/api/auth/microsoft/callback",
        state: "STATE",
        nonce: "NONCE",
        codeChallenge: "CHALLENGE",
        scopes: requestedScopes(false),
      }),
    );
    expect(url.origin).toBe("https://login.microsoftonline.com");
    expect(url.pathname).toBe(`/${TENANT}/oauth2/v2.0/authorize`);
    const p = url.searchParams;
    expect(p.get("response_type")).toBe("code");
    expect(p.get("response_mode")).toBe("query");
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("code_challenge")).toBe("CHALLENGE");
    expect(p.get("prompt")).toBe("select_account");
    expect(p.get("state")).toBe("STATE");
    expect(p.get("nonce")).toBe("NONCE");
    expect(p.get("scope")).toBe(
      "openid profile email offline_access User.Read Mail.Read Mail.Send Calendars.ReadWrite",
    );
    expect(p.has("client_secret")).toBe(false);
  });
});

describe("id_token claims", () => {
  const good = {
    aud: CLIENT,
    iss: `https://login.microsoftonline.com/${TENANT}/v2.0`,
    tid: TENANT,
    oid: "oid-1",
    nonce: "NONCE",
    exp: NOW / 1000 + 3600,
  };
  const expected = { tenantId: TENANT, clientId: CLIENT, nonce: "NONCE", now: NOW };

  it("accepts Gold Star's tenant", () => {
    expect(checkIdTokenClaims(good, expected).ok).toBe(true);
    expect(checkIdTokenClaims({ ...good, tid: TENANT.toUpperCase() }, expected).ok).toBe(true);
  });

  it.each([
    ["another tenant", { tid: "00000000-0000-4000-8000-000000000000" }, "wrong_tenant"],
    ["another issuer", { iss: "https://login.microsoftonline.com/common/v2.0" }, "wrong_issuer"],
    [
      "a guest from elsewhere",
      { idp: "https://sts.windows.net/00000000-0000-4000-8000-000000000000/" },
      "guest",
    ],
    ["a personal account invited in", { idp: "live.com" }, "guest"],
    ["another app's token", { aud: "someone-else" }, "wrong_audience"],
    ["a replayed sign-in", { nonce: "OTHER" }, "nonce"],
    ["an old token", { exp: NOW / 1000 - 3600 }, "expired"],
    ["no oid", { oid: undefined }, "missing"],
  ])("refuses %s", (_label, patch, reason) => {
    expect(checkIdTokenClaims({ ...good, ...patch }, expected)).toEqual({ ok: false, reason });
  });

  it("accepts an idp claim naming our own tenant", () => {
    expect(
      checkIdTokenClaims({ ...good, idp: `https://sts.windows.net/${TENANT}/` }, expected).ok,
    ).toBe(true);
  });
});

describe("token endpoint errors", () => {
  it("only a dead grant is the person's to fix", () => {
    expect(classifyTokenError(400, { error: "invalid_grant" })).toBe("reconnect");
    expect(classifyTokenError(400, { error: "interaction_required" })).toBe("reconnect");
    expect(classifyTokenError(401, { error: "invalid_client" })).toBe("config");
    expect(classifyTokenError(503, null)).toBe("transient");
    expect(classifyTokenError(429, null)).toBe("transient");
  });

  it("describes an error by code and first line only", () => {
    expect(
      describeTokenError({
        error: "invalid_grant",
        error_description:
          "AADSTS700082: The refresh token has expired.\r\nTrace ID: abc\r\nCorrelation ID: def",
      }),
    ).toBe("invalid_grant: AADSTS700082: The refresh token has expired.");
    expect(describeTokenError(null)).toBe("unknown_error");
  });
});
