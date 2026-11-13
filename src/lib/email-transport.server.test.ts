import { describe, expect, it, vi } from "vitest";

import {
  classifyOutlookFailure,
  outlookMessageId,
  resendFromAddress,
  resolveEmailTransport,
  sendThroughOutlook,
  type MailboxCandidate,
  type OutlookRoute,
  type TransportDeps,
} from "./email-transport.server";

/**
 * Which way an email leaves: the sender's own Outlook, then Resend, then a
 * reason. No real Microsoft or Resend call is made anywhere in here — every
 * dependency is a fake.
 */
const DAVID = "1f37c3ff-c589-4c5c-8960-31e55e110368";

function deps(over: Partial<TransportDeps> = {}): TransportDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    loadEnv: async () => {
      calls.push("loadEnv");
    },
    outlookMode: () => "delegated",
    connection: async () => ({ upn: "david@goldstarrestoration.com", status: "connected" }),
    isUserActive: async () => true,
    mailboxesFor: async () => {
      calls.push("mailboxesFor");
      return [];
    },
    canSendAs: async () => true,
    senderAuth: async (userId) => ({ kind: "delegated", userId }),
    resendKey: () => undefined,
    resendFromAddress: () => "office@goldstarrestoration.com",
    ...over,
  };
}

describe("resolveEmailTransport — delegated (IT's choice)", () => {
  it("David connected: his own mailbox, with his own token", async () => {
    const d = deps();
    const r = await resolveEmailTransport(DAVID, {}, d);
    expect(r).toEqual({
      ok: true,
      route: {
        kind: "outlook",
        upn: "david@goldstarrestoration.com",
        auth: { kind: "delegated", userId: DAVID },
        mailboxId: null,
        shared: false,
      },
    });
    // The Integrations-screen values are loaded before anything is decided,
    // and a connected sender never needs the mailbox registry.
    expect(d.calls[0]).toBe("loadEnv");
    expect(d.calls).not.toContain("mailboxesFor");
  });

  it("David not connected, no Resend: sender_not_connected (today's state)", async () => {
    const r = await resolveEmailTransport(DAVID, {}, deps({ connection: async () => null }));
    expect(r).toMatchObject({ ok: false, reason: "sender_not_connected" });
  });

  it("not connected but Resend has a key: Resend carries it", async () => {
    const r = await resolveEmailTransport(
      DAVID,
      {},
      deps({ connection: async () => null, resendKey: () => "re_test" }),
    );
    expect(r).toEqual({
      ok: true,
      route: { kind: "resend", fromAddress: "office@goldstarrestoration.com" },
    });
  });

  it("Outlook wins over Resend when both are there", async () => {
    const r = await resolveEmailTransport(DAVID, {}, deps({ resendKey: () => "re_test" }));
    expect(r.ok && r.route.kind).toBe("outlook");
  });

  it("sign-in refused by Microsoft: needs_reconnect", async () => {
    const r = await resolveEmailTransport(
      DAVID,
      {},
      deps({ connection: async () => ({ upn: "d@gs.com", status: "needs_reconnect" }) }),
    );
    expect(r).toMatchObject({ ok: false, reason: "needs_reconnect" });
  });

  it("deactivated sender: sender_inactive", async () => {
    const r = await resolveEmailTransport(DAVID, {}, deps({ isUserActive: async () => false }));
    expect(r).toMatchObject({ ok: false, reason: "sender_inactive" });
  });

  it("assertCanSendAs saying no means no Outlook, even when connected", async () => {
    const r = await resolveEmailTransport(DAVID, {}, deps({ canSendAs: async () => false }));
    expect(r).toMatchObject({ ok: false, reason: "sender_not_connected" });
  });

  it("Outlook not configured at all and no Resend: no_transport", async () => {
    const r = await resolveEmailTransport(DAVID, {}, deps({ outlookMode: () => null }));
    expect(r).toMatchObject({ ok: false, reason: "no_transport" });
  });

  it("no sender (automation) can only ever use Resend", async () => {
    const connection = vi.fn(async () => ({ upn: "x@gs.com", status: "connected" }));
    expect(await resolveEmailTransport(null, {}, deps({ connection }))).toMatchObject({
      ok: false,
      reason: "no_transport",
    });
    expect(connection).not.toHaveBeenCalled();
  });
});

describe("resolveEmailTransport — office mailboxes", () => {
  const office = (id: string, location: string): MailboxCandidate => ({
    id,
    upn: `${id}@goldstarrestoration.com`,
    kind: "shared_office",
    user_id: null,
    owner_user_id: DAVID,
    location_id: location,
  });

  it("application mode: the sender's registered personal mailbox first", async () => {
    const r = await resolveEmailTransport(
      DAVID,
      { locationId: "loc-b" },
      deps({
        outlookMode: () => "application",
        mailboxesFor: async () => [
          office("lakewood", "loc-a"),
          {
            id: "mb-david",
            upn: "david@goldstarrestoration.com",
            kind: "user",
            user_id: DAVID,
            owner_user_id: null,
            location_id: null,
          },
        ],
        senderAuth: async () => ({ kind: "application" }),
      }),
    );
    expect(r).toMatchObject({
      ok: true,
      route: { upn: "david@goldstarrestoration.com", mailboxId: "mb-david", shared: false },
    });
  });

  it("an office mailbox he owns, the email's own office first", async () => {
    const r = await resolveEmailTransport(
      DAVID,
      { locationId: "loc-b" },
      deps({
        outlookMode: () => "application",
        mailboxesFor: async () => [office("lakewood", "loc-a"), office("brooklyn", "loc-b")],
        senderAuth: async () => ({ kind: "application" }),
      }),
    );
    expect(r).toMatchObject({
      ok: true,
      route: { upn: "brooklyn@goldstarrestoration.com", shared: true },
    });
  });

  it("an office mailbox Microsoft refuses is skipped for the next one", async () => {
    const r = await resolveEmailTransport(
      DAVID,
      { locationId: "loc-b" },
      deps({
        outlookMode: () => "application",
        mailboxesFor: async () => [office("brooklyn", "loc-b"), office("lakewood", "loc-a")],
        senderAuth: async (_u, m) => {
          if (m.upn.startsWith("brooklyn")) throw new Error("No Send As on brooklyn");
          return { kind: "application" };
        },
      }),
    );
    expect(r).toMatchObject({ ok: true, route: { upn: "lakewood@goldstarrestoration.com" } });
  });
});

describe("sendThroughOutlook", () => {
  const route: OutlookRoute = {
    kind: "outlook",
    upn: "david@goldstarrestoration.com",
    auth: { kind: "delegated", userId: DAVID },
    mailboxId: null,
    shared: false,
  };
  const message = {
    rowId: "7144b36a-1f57-4d81-b785-3d6d5a69d126",
    to: ["customer@example.com"],
    cc: [],
    subject: "Invoice 1042",
    html: '<p>Hi</p><p><a href="https://x">Invoice.pdf</a></p>',
    replyTo: "billing@goldstarrestoration.com",
  };

  it("sends HTML as the sender, with our Message-ID, reply-to and the links body", async () => {
    const sendMail = vi.fn(async () => undefined);
    const out = await sendThroughOutlook(route, message, sendMail as never);
    expect(out.providerId).toBe(
      "<rh-7144b36a-1f57-4d81-b785-3d6d5a69d126@goldstarrestoration.com>",
    );
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail).toHaveBeenCalledWith(
      "david@goldstarrestoration.com",
      {
        subject: "Invoice 1042",
        contentType: "HTML",
        content: message.html,
        to: ["customer@example.com"],
        cc: [],
        replyTo: ["billing@goldstarrestoration.com"],
        internetMessageId: out.providerId,
      },
      route.auth,
    );
  });

  it("a tenant that refuses our Message-ID still gets the email, once", async () => {
    const sendMail = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("bad"), { status: 400, body: "Invalid internetMessageId" }),
      )
      .mockResolvedValueOnce(undefined);
    const out = await sendThroughOutlook(route, message, sendMail as never);
    expect(sendMail).toHaveBeenCalledTimes(2);
    expect(sendMail.mock.calls[1]![1]).not.toHaveProperty("internetMessageId");
    expect(out.providerId).toMatch(/^<rh-/);
  });

  it("any other refusal is the caller's to classify", async () => {
    const sendMail = vi.fn().mockRejectedValue(Object.assign(new Error("x"), { status: 403 }));
    await expect(sendThroughOutlook(route, message, sendMail as never)).rejects.toThrow("x");
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it("the Message-ID is stable per row, on the sender's domain", () => {
    expect(outlookMessageId("abc", "x@Gold.COM")).toBe("<rh-abc@gold.com>");
    expect(outlookMessageId("abc", "nodomain")).toBe("<rh-abc@recoveryhub.local>");
  });
});

describe("classifyOutlookFailure", () => {
  const delegated = (reason: string) =>
    Object.assign(new Error(reason), { name: "DelegatedTokenError", reason });

  it("a dead or missing sign-in parks the email for the sender to fix", () => {
    expect(classifyOutlookFailure(delegated("needs_reconnect"))).toMatchObject({
      kind: "waiting",
      reason: "needs_reconnect",
    });
    expect(classifyOutlookFailure(delegated("not_connected"))).toMatchObject({
      reason: "sender_not_connected",
    });
    expect(classifyOutlookFailure(delegated("inactive"))).toMatchObject({
      reason: "sender_inactive",
    });
    expect(classifyOutlookFailure(delegated("transient")).kind).toBe("transient");
  });

  it("throttling, outages and network failures are retried; a refusal is final", () => {
    const graph = (status: number) => Object.assign(new Error(`[${status}]`), { status });
    expect(classifyOutlookFailure(graph(429)).kind).toBe("transient");
    expect(classifyOutlookFailure(graph(503)).kind).toBe("transient");
    expect(classifyOutlookFailure(new TypeError("fetch failed")).kind).toBe("transient");
    expect(classifyOutlookFailure(graph(400)).kind).toBe("permanent");
    expect(classifyOutlookFailure(graph(403)).kind).toBe("permanent");
  });
});

describe("resendFromAddress", () => {
  it("RESEND_FROM_ADDRESS, else the address inside RESEND_FROM, else Resend's sandbox", () => {
    expect(resendFromAddress({ RESEND_FROM_ADDRESS: "office@gs.com" })).toBe("office@gs.com");
    expect(resendFromAddress({ RESEND_FROM: "Gold Star <billing@gs.com>" })).toBe("billing@gs.com");
    expect(resendFromAddress({})).toBe("onboarding@resend.dev");
  });
});
