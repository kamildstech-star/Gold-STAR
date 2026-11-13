import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import type { DeliverableEmail } from "./email-delivery.server";
import {
  notifyUnsentEmailPileUp,
  retryQueuedEmails,
  UNSENT_ALERT_TITLE,
  unsentNoticeBody,
} from "./email-retry.server";

/**
 * The retry step and the admin notice in the email-release hook. David's
 * invoice (11 Oct) goes out once he connects Outlook; the 25 Aug work
 * authorization is never picked up by the sweep (the SQL claim's age rule,
 * proved in supabase/tests/email-transport-retry.pglite.mjs) and is named in
 * the admins' notice as one to resend or cancel by hand.
 */
const NOW = new Date("2026-10-12T12:00:00Z");
const DAVID = "1f37c3ff-c589-4c5c-8960-31e55e110368";

const rpcDb = (result: { data?: unknown; error?: unknown }) => ({
  rpc: vi.fn(async () => ({ data: result.data ?? null, error: result.error ?? null })),
});

const parked = (id: string, sender: string | null): DeliverableEmail => ({
  id,
  to_emails: ["c@example.com"],
  cc_emails: [],
  subject: "s",
  body_html: "b",
  account_id: null,
  contact_id: null,
  sent_by: sender,
  location_id: "loc-1",
});

describe("retryQueuedEmails", () => {
  it("before the migration: nothing to claim with, says so, sends nothing", async () => {
    const db = rpcDb({
      error: {
        code: "PGRST202",
        message:
          "Could not find the function public.claim_retryable_queued_emails in the schema cache",
      },
    });
    const deliver = vi.fn();
    expect(await retryQueuedEmails(db as never, { deliver })).toEqual({
      migrated: false,
      claimed: 0,
      sent: 0,
      waiting: 0,
      failed: 0,
    });
    expect(deliver).not.toHaveBeenCalled();
  });

  it("claims a bounded batch, and asks each sender's transport once per run", async () => {
    const db = rpcDb({ data: [parked("a", DAVID), parked("b", DAVID), parked("c", "mark")] });
    const resolve = vi.fn(async (sender: string | null, _locationId?: string | null) =>
      sender === DAVID
        ? ({ ok: false, reason: "sender_not_connected", message: "" } as const)
        : ({ ok: true, route: { kind: "resend", fromAddress: "o@gs.com" } } as const),
    );
    const deliver = vi.fn(async (row: DeliverableEmail, r: typeof resolve) => {
      const t = await r(row.sent_by, row.location_id ?? null);
      if (row.id === "c") throw new Error("rejected");
      return {
        id: row.id,
        providerId: null,
        touchpointLogged: false,
        queued: !t.ok,
        provider: null,
        reason: null,
      };
    });
    const out = await retryQueuedEmails(db as never, { deliver: deliver as never, resolve });
    expect(db.rpc).toHaveBeenCalledWith("claim_retryable_queued_emails", { _limit: 25 });
    expect(out).toEqual({ migrated: true, claimed: 3, sent: 0, waiting: 2, failed: 1 });
    expect(resolve).toHaveBeenCalledTimes(2);
  });
});

describe("the admins' notice", () => {
  it("counts by reason and names the ones too old to send by themselves", () => {
    const body = unsentNoticeBody(
      [
        { id: "inv", created_at: "2026-10-11T21:53:06Z", delivery_reason: "sender_not_connected" },
        { id: "wa", created_at: "2026-08-25T15:44:52Z", delivery_reason: "no_transport" },
      ],
      NOW,
    )!;
    expect(body).toBe(
      "2 emails people sent from Recovery Hub haven't gone out: 1 waiting for the sender to connect Outlook; 1 older than 14 days — resend or cancel by hand. Oldest sent 2026-08-25.",
    );
    expect(unsentNoticeBody([], NOW)).toBe(null);
  });

  function noticeDb(state: { stuck: unknown[]; admins: string[]; alreadyNotified: string[] }) {
    const inserted: unknown[] = [];
    const chain = (data: unknown) => {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "is", "not", "lt", "gte", "in", "order", "limit"]) {
        q[m] = () => q;
      }
      q["then"] = (resolve: (v: unknown) => void) => resolve({ data, error: null });
      return q;
    };
    return {
      inserted,
      from(table: string) {
        if (table === "email_messages") return chain(state.stuck);
        if (table === "user_roles") return chain(state.admins.map((user_id) => ({ user_id })));
        if (table === "notifications") {
          const q = chain(state.alreadyNotified.map((user_id) => ({ user_id })));
          q["insert"] = async (rows: unknown[]) => {
            inserted.push(...rows);
            return { error: null };
          };
          return q;
        }
        throw new Error(table);
      },
    };
  }

  it("once a day per admin: one who already holds an unread notice is skipped", async () => {
    const db = noticeDb({
      stuck: [{ id: "inv", created_at: "2026-10-11T21:53:06Z", delivery_reason: "no_transport" }],
      admins: ["mark", "david", "mark"],
      alreadyNotified: ["mark"],
    });
    const out = await notifyUnsentEmailPileUp(db as never, NOW);
    expect(out).toEqual({ notified: 1, stuck: 1 });
    expect(db.inserted).toEqual([
      expect.objectContaining({
        user_id: "david",
        type: "integration_disconnected",
        title: UNSENT_ALERT_TITLE,
        href: "/admin/integrations",
      }),
    ]);
  });

  it("nothing stuck, nobody told", async () => {
    const db = noticeDb({ stuck: [], admins: ["mark"], alreadyNotified: [] });
    expect(await notifyUnsentEmailPileUp(db as never, NOW)).toEqual({ notified: 0, stuck: 0 });
    expect(db.inserted).toEqual([]);
  });
});

describe("the hook runs them after the held release", () => {
  const hook = readFileSync("src/routes/api/public/hooks/email-release.ts", "utf8").replace(
    /\r\n/g,
    "\n",
  );
  it("auth, then held claim, then retry, then notice", () => {
    const auth = hook.indexOf("verifyWebhook(request, CRON_WEBHOOK)");
    const held = hook.indexOf('"claim_due_held_emails"');
    const retry = hook.indexOf("await retryQueuedEmails(supabaseAdmin)");
    const notice = hook.indexOf("await notifyUnsentEmailPileUp(supabaseAdmin)");
    expect(auth).toBeGreaterThan(0);
    expect(held).toBeGreaterThan(auth);
    expect(retry).toBeGreaterThan(held);
    expect(notice).toBeGreaterThan(retry);
  });
});
