import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  EMAIL_AUTO_SEND_MAX_AGE_DAYS,
  EMAIL_CLAIM_LEASE_MINUTES,
  EMAIL_DELIVERY_REASONS,
  EMAIL_RETRY_MAX_ATTEMPTS,
  isTooOldToAutoSend,
  noTransportSentence,
  retryDelayMs,
  sendNeedsWarning,
  unsentEmailNotice,
  type UnsentEmailRow,
} from "./email-transport";

/**
 * What the screen says about an email that has not gone, and when a sender is
 * warned. David's 11 Oct invoice: the screen said sent, the row sat in
 * 'queued', nothing ever came back for it.
 */
const now = new Date("2026-10-12T12:00:00Z");
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();
const queued = (over: Partial<UnsentEmailRow> = {}): UnsentEmailRow => ({
  status: "queued",
  sent_at: null,
  created_at: hoursAgo(14),
  sent_by: "david",
  delivery_reason: "sender_not_connected",
  ...over,
});

describe("the unsent line", () => {
  it("is nothing for an email that went, or is still held, or was canceled", () => {
    for (const status of ["sent", "delivered", "opened", "held", "cancelled"]) {
      expect(unsentEmailNotice(queued({ status }), { mine: true, canManage: false }, now)).toBe(
        null,
      );
    }
    expect(
      unsentEmailNotice(queued({ sent_at: hoursAgo(1) }), { mine: true, canManage: false }, now),
    ).toBe(null);
  });

  it("tells the sender to connect Outlook, with the link that does it", () => {
    const n = unsentEmailNotice(queued(), { mine: true, canManage: false }, now)!;
    expect(n.headline).toBe("Not sent yet — you haven't connected Outlook");
    expect(n.actions).toEqual([
      { kind: "link", label: "Connect Outlook on your Security page", to: "/security" },
      { kind: "resend" },
      { kind: "cancel" },
    ]);
  });

  it("names the sender to everyone else, and gives them no buttons", () => {
    const n = unsentEmailNotice(
      queued(),
      { mine: false, canManage: false, senderName: "David Stern " },
      now,
    )!;
    expect(n.headline).toBe("Not sent yet — David Stern hasn't connected Outlook");
    expect(n.actions).toEqual([]);
  });

  it("gives an admin the Integrations fix and Resend / Cancel on anyone's", () => {
    const n = unsentEmailNotice(
      queued({ delivery_reason: "no_transport" }),
      { mine: false, canManage: true },
      now,
    )!;
    expect(n.headline).toBe("Not sent yet — no email service is connected");
    expect(n.actions).toEqual([
      {
        kind: "link",
        label: "Connect an email service in Integrations",
        to: "/admin/integrations",
      },
      { kind: "resend" },
      { kind: "cancel" },
    ]);
  });

  it("asks for a reconnect when Microsoft refused the sign-in", () => {
    const n = unsentEmailNotice(
      queued({ delivery_reason: "needs_reconnect" }),
      { mine: true, canManage: false },
      now,
    )!;
    expect(n.headline).toMatch(/Microsoft stopped accepting your Outlook sign-in/);
    expect(n.actions[0]).toMatchObject({ to: "/security", label: /Reconnect/ });
  });

  it("past 14 days: too old to send automatically, resend or cancel", () => {
    const n = unsentEmailNotice(
      queued({ created_at: "2026-08-25T15:44:52Z" }),
      { mine: false, canManage: true },
      now,
    )!;
    expect(n.headline).toBe("Not sent — too old to send automatically; resend or cancel");
    expect(n.actions).toEqual([{ kind: "resend" }, { kind: "cancel" }]);
  });

  it("a failed send shows the provider's words", () => {
    const n = unsentEmailNotice(
      queued({ status: "failed", error: "Recipient address rejected" }),
      { mine: true, canManage: false },
      now,
    )!;
    expect(n.headline).toBe("Not sent — the mail service refused it");
    expect(n.detail).toBe("Recipient address rejected");
    expect(n.tone).toBe("destructive");
  });

  it("the sender's live state beats a stale stored reason", () => {
    const n = unsentEmailNotice(
      queued(),
      {
        mine: true,
        canManage: false,
        myTransport: { configured: true, via: "outlook", reason: null, from: "david@gs.com" },
      },
      now,
    )!;
    expect(n.headline).toBe("Not sent yet — sending shortly through your Outlook");
  });

  it("a queued row with no stored reason (before the migration) still says not sent", () => {
    const n = unsentEmailNotice(
      queued({ delivery_reason: null }),
      { mine: true, canManage: false },
      now,
    )!;
    expect(n.headline).toBe("Not sent yet — no email service is connected");
  });
});

describe("warning the sender at Send", () => {
  it("warns about a held email nothing will carry, before the window closes", () => {
    expect(
      sendNeedsWarning({
        held: true,
        releaseAt: hoursAgo(-0.1),
        transport: { configured: false, via: null, reason: "sender_not_connected", from: null },
      }),
    ).toBe("sender_not_connected");
  });

  it("stays quiet for a held email that will go, or when the check could not run", () => {
    const ok = { configured: true, via: "outlook" as const, reason: null, from: "d@gs.com" };
    expect(sendNeedsWarning({ held: true, transport: ok })).toBe(null);
    expect(sendNeedsWarning({ held: true, transport: null })).toBe(null);
  });

  it("an immediate send that stayed queued is never called sent", () => {
    expect(sendNeedsWarning({ queued: true, reason: "no_transport" })).toBe("no_transport");
    expect(sendNeedsWarning({ queued: true })).toBe("unknown");
    expect(sendNeedsWarning({ queued: false, provider: "outlook" })).toBe(null);
  });

  it("every reason has a sentence, and the default names both fixes", () => {
    for (const r of EMAIL_DELIVERY_REASONS)
      expect(noTransportSentence(r).length).toBeGreaterThan(10);
    expect(noTransportSentence(null)).toMatch(/Security page.*email service/);
  });
});

describe("retry arithmetic", () => {
  it("backs off 5, 10, 20, 40, 80 minutes and caps at six hours", () => {
    expect([1, 2, 3, 4, 5].map((n) => retryDelayMs(n) / 60_000)).toEqual([5, 10, 20, 40, 80]);
    expect(retryDelayMs(20)).toBe(6 * 3_600_000);
  });

  it("too old is strictly past 14 days", () => {
    expect(isTooOldToAutoSend(new Date(now.getTime() - 14 * 86_400_000 + 1000), now)).toBe(false);
    expect(isTooOldToAutoSend(new Date(now.getTime() - 14 * 86_400_000 - 1000), now)).toBe(true);
    expect(isTooOldToAutoSend(null, now)).toBe(false);
  });
});

describe("the migration and the code agree", () => {
  const sql = readFileSync(
    "supabase/migrations/20261012100000_email_transport_retry.sql",
    "utf8",
  ).replace(/\r\n/g, "\n");

  it("the same age, attempt and claim limits in the claim and in the kick", () => {
    const claim = sql.slice(sql.indexOf("FUNCTION public.claim_retryable_queued_emails"));
    const kick = sql.slice(sql.indexOf("FUNCTION public.email_release_kick"));
    for (const body of [claim.slice(0, claim.indexOf("$$;")), kick.slice(0, kick.indexOf("$$;"))]) {
      expect(body).toContain(`interval '${EMAIL_AUTO_SEND_MAX_AGE_DAYS} days'`);
      expect(body).toContain(`delivery_attempts < ${EMAIL_RETRY_MAX_ATTEMPTS}`);
      expect(body).toContain(`interval '${EMAIL_CLAIM_LEASE_MINUTES} minutes'`);
    }
  });

  it("the reason CHECK lists exactly the reasons the code stores", () => {
    const check = /delivery_reason IN \(([^)]*)\)/.exec(sql)![1]!;
    const listed = [...check.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(listed).toEqual([...EMAIL_DELIVERY_REASONS].sort());
  });
});
