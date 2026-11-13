import { afterEach, describe, expect, it, vi } from "vitest";
import { graphFetch, graphJson, graphRequestUrl, sendMailAs } from "./graph.server";
import { assertCanSendAs, assertGraphContact } from "./graph.functions";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Graph application-token destination boundary", () => {
  it.each([
    "http://graph.microsoft.com/v1.0/users",
    "https://evil.example/v1.0/users",
    "https://graph.microsoft.com.evil.example/v1.0/users",
    "https://graph.microsoft.com@evil.example/v1.0/users",
    "https://user@graph.microsoft.com/v1.0/users",
    "https://graph.microsoft.com:444/v1.0/users",
    "https://127.0.0.1/v1.0/",
    "https://graph.microsoft.com/v1.0/../../beta/users",
    "/users\\evil",
    "https://graph.microsoft.com/v1.0/users#fragment",
  ])("rejects %s before token acquisition", async (url) => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(graphFetch(url)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("allows relative paths and genuine opaque delta queries", () => {
    expect(graphRequestUrl("/users/a/messages")).toBe(
      "https://graph.microsoft.com/v1.0/users/a/messages",
    );
    const url = "https://graph.microsoft.com/v1.0/users/a/messages/delta?$deltatoken=a%2Fb";
    expect(graphRequestUrl(url)).toBe(url);
  });
  it("overrides a caller's redirect-follow preference", async () => {
    // Application mode: the company token, exactly as before delegated access.
    vi.stubEnv("OUTLOOK_AUTH_MODE", "application");
    vi.stubEnv("OUTLOOK_CLIENT_ID", "test");
    vi.stubEnv("OUTLOOK_CLIENT_SECRET", "test");
    vi.stubEnv("OUTLOOK_TENANT_ID", "test");
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ access_token: "fake", expires_in: 3600 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await graphFetch("/users", { redirect: "follow" });
    // "manual", never "error": Cloudflare Workers reject "error" outright.
    expect(fetch.mock.calls[1][1].redirect).toBe("manual");
  });

  it("refuses a redirect from Graph instead of following it with the token", async () => {
    vi.stubEnv("OUTLOOK_AUTH_MODE", "application");
    vi.stubEnv("OUTLOOK_CLIENT_ID", "test");
    vi.stubEnv("OUTLOOK_CLIENT_SECRET", "test");
    vi.stubEnv("OUTLOOK_TENANT_ID", "test");
    // By address, not by order: an earlier test may have left the company
    // token cached, so the token endpoint is not always called.
    const fetch = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes("login.microsoftonline.com")
        ? Response.json({ access_token: "fake", expires_in: 3600 })
        : new Response(null, { status: 302, headers: { Location: "https://elsewhere.example/" } }),
    );
    vi.stubGlobal("fetch", fetch);
    await expect(graphFetch("/users")).rejects.toThrow(/redirect; not followed/);
    const graphCalls = fetch.mock.calls.filter(([u]) => String(u).includes("graph.microsoft.com"));
    expect(graphCalls).toHaveLength(1);
  });
});

describe("empty successful answers", () => {
  function stubGraph(answer: () => Response) {
    vi.stubEnv("OUTLOOK_AUTH_MODE", "application");
    vi.stubEnv("OUTLOOK_CLIENT_ID", "test");
    vi.stubEnv("OUTLOOK_CLIENT_SECRET", "test");
    vi.stubEnv("OUTLOOK_TENANT_ID", "test");
    const fetch = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes("login.microsoftonline.com")
        ? Response.json({ access_token: "fake", expires_in: 3600 })
        : answer(),
    );
    vi.stubGlobal("fetch", fetch);
    return fetch;
  }

  // 2026-10-13: sendMail's 202 with no body was parsed as JSON, threw after
  // Outlook had sent the mail, and the retry sweep sent it again and again.
  it("sendMail's 202 Accepted with no body is a sent message, not an error", async () => {
    const fetch = stubGraph(() => new Response(null, { status: 202 }));
    await expect(
      sendMailAs(
        "sender@example.com",
        { subject: "Paperwork", contentType: "HTML", content: "<p>Hi</p>", to: ["a@example.com"] },
        { kind: "application" },
      ),
    ).resolves.toBeUndefined();
    const graphCalls = fetch.mock.calls.filter(([u]) => String(u).includes("/sendMail"));
    expect(graphCalls).toHaveLength(1);
  });

  it("a 200 with an empty body is empty, and a JSON body is still parsed", async () => {
    stubGraph(() => new Response("", { status: 200 }));
    await expect(graphJson("/users")).resolves.toBeUndefined();
    stubGraph(() => Response.json({ value: [1] }));
    await expect(graphJson<{ value: number[] }>("/users")).resolves.toEqual({ value: [1] });
  });

  it("a failure is still a failure", async () => {
    stubGraph(() => new Response("{}", { status: 400 }));
    await expect(graphJson("/users")).rejects.toThrow();
  });
});

describe("privileged send authorization", () => {
  it("does not grant a manager another person's personal mailbox", async () => {
    const context = {
      userId: "manager",
      supabase: { rpc: vi.fn(async (fn) => ({ data: fn === "can_manage_location" })) },
    };
    await expect(
      assertCanSendAs(context as never, {
        upn: "boss@example.com",
        user_id: "boss",
        location_id: "office",
      }),
    ).rejects.toThrow("cannot send as");
  });
  it.each([null, { id: "c", account_id: "other" }])(
    "rejects hidden or unrelated contacts",
    async (data) => {
      const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data, error: null }) };
      await expect(
        assertGraphContact({ supabase: { from: () => q } } as never, "c", "account"),
      ).rejects.toThrow("Contact not visible");
    },
  );
  it("allows a visible contact on the selected account", async () => {
    const q = {
      select: () => q,
      eq: () => q,
      maybeSingle: async () => ({ data: { id: "c", account_id: "account" }, error: null }),
    };
    await expect(
      assertGraphContact({ supabase: { from: () => q } } as never, "c", "account"),
    ).resolves.toBeUndefined();
  });
});
