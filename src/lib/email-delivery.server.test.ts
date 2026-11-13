import { describe, expect, it, vi } from "vitest";

import { deliverEmailMessage, type DeliverableEmail } from "./email-delivery.server";
import type { OutlookRoute, TransportResolution } from "./email-transport.server";

/**
 * THE seam, end to end on fakes: what it writes on the row for each way an
 * email can go — or not go. David's invoice (7144b36a…) is the row; no real
 * Graph or Resend call is made.
 */
const NOW = new Date("2026-10-12T12:00:00Z");
const DAVID = "1f37c3ff-c589-4c5c-8960-31e55e110368";

type Write = { table: string; op: string; values: Record<string, unknown>; id?: unknown };

function fakeDb(opts: { missingColumns?: boolean } = {}) {
  const writes: Write[] = [];
  const db = {
    writes,
    from(table: string) {
      return {
        update(values: Record<string, unknown>) {
          return {
            eq: async (_col: string, id: unknown) => {
              const usesNew = Object.keys(values).some((k) =>
                [
                  "delivery_reason",
                  "provider",
                  "sent_from",
                  "claimed_at",
                  "next_attempt_at",
                  "delivery_attempts",
                ].includes(k),
              );
              if (opts.missingColumns && usesNew) {
                return {
                  error: {
                    code: "PGRST204",
                    message: "Could not find the 'delivery_reason' column in the schema cache",
                  },
                };
              }
              writes.push({ table, op: "update", values, id });
              return { error: null };
            },
          };
        },
        insert(values: Record<string, unknown>) {
          writes.push({ table, op: "insert", values });
          return {
            select: () => ({ single: async () => ({ data: { id: "tp-1" }, error: null }) }),
          };
        },
      };
    },
  };
  return db;
}

const row = (over: Partial<DeliverableEmail> = {}): DeliverableEmail => ({
  id: "7144b36a-1f57-4d81-b785-3d6d5a69d126",
  to_emails: ["customer@example.com"],
  cc_emails: [],
  subject: "Invoice 1042",
  body_html: "<p>Please find your invoice.</p>",
  attachments: [{ label: "Invoice 1042.pdf", url: "https://files.test/inv.pdf" }],
  reply_to: null,
  from_name: "Gold Star Restoration",
  log_touchpoint: true,
  account_id: "acct-1",
  contact_id: "contact-1",
  sent_by: DAVID,
  location_id: "loc-1",
  delivery_attempts: 0,
  ...over,
});

const outlook: OutlookRoute = {
  kind: "outlook",
  upn: "david@goldstarrestoration.com",
  auth: { kind: "delegated", userId: DAVID },
  mailboxId: null,
  shared: false,
};
const via = (r: TransportResolution) => async () => r;
const emailWrites = (db: ReturnType<typeof fakeDb>) =>
  db.writes.filter((w) => w.table === "email_messages");

describe("no transport for the sender", () => {
  it("parks the row 'queued' with the reason, looks again in 5 minutes, counts no attempt", async () => {
    const db = fakeDb();
    const sendOutlook = vi.fn();
    const out = await deliverEmailMessage(db as never, row(), {
      admin: db as never,
      now: () => NOW,
      resolve: via({ ok: false, reason: "sender_not_connected", message: "x" }),
      sendOutlook: sendOutlook as never,
    });
    expect(out).toMatchObject({ queued: true, reason: "sender_not_connected", provider: null });
    expect(sendOutlook).not.toHaveBeenCalled();
    const [w] = emailWrites(db);
    expect(w!.values).toEqual({
      status: "queued",
      delivery_reason: "sender_not_connected",
      error: null,
      next_attempt_at: "2026-10-12T12:05:00.000Z",
      claimed_at: null,
    });
    expect(db.writes.some((x) => x.table === "touchpoints")).toBe(false);
  });

  it("before the migration, writes only what exists (status) instead of failing", async () => {
    const db = fakeDb({ missingColumns: true });
    const out = await deliverEmailMessage(db as never, row(), {
      admin: db as never,
      now: () => NOW,
      resolve: via({ ok: false, reason: "no_transport", message: "x" }),
    });
    expect(out.queued).toBe(true);
    expect(emailWrites(db).map((w) => w.values)).toEqual([{ status: "queued" }]);
  });
});

describe("through the sender's Outlook", () => {
  it("sends the body with the files as links, logs the touchpoint, records outlook", async () => {
    const db = fakeDb();
    const sendOutlook = vi.fn(async () => ({
      providerId: "<rh-7144b36a-1f57-4d81-b785-3d6d5a69d126@goldstarrestoration.com>",
    }));
    const out = await deliverEmailMessage(db as never, row(), {
      admin: db as never,
      now: () => NOW,
      resolve: via({ ok: true, route: outlook }),
      sendOutlook: sendOutlook as never,
    });

    expect(sendOutlook).toHaveBeenCalledWith(outlook, {
      rowId: "7144b36a-1f57-4d81-b785-3d6d5a69d126",
      to: ["customer@example.com"],
      cc: [],
      subject: "Invoice 1042",
      html: '<p>Please find your invoice.</p><p><a href="https://files.test/inv.pdf">Invoice 1042.pdf</a></p>',
      replyTo: null,
    });
    expect(out).toMatchObject({ queued: false, provider: "outlook", touchpointLogged: true });

    // Touchpoint semantics unchanged: same columns as the Resend path.
    const tp = db.writes.find((w) => w.table === "touchpoints")!;
    expect(tp.values).toEqual({
      account_id: "acct-1",
      contact_id: "contact-1",
      type: "email",
      notes: "Email sent: Invoice 1042",
      created_by: DAVID,
    });
    expect(emailWrites(db).at(-1)!.values).toEqual({
      status: "sent",
      provider_id: "<rh-7144b36a-1f57-4d81-b785-3d6d5a69d126@goldstarrestoration.com>",
      sent_at: NOW.toISOString(),
      touchpoint_id: "tp-1",
      provider: "outlook",
      sent_from: "david@goldstarrestoration.com",
      delivery_reason: null,
      error: null,
      next_attempt_at: null,
      claimed_at: null,
    });
  });

  it("a throttled or down Graph is tried again with backoff, counted", async () => {
    const db = fakeDb();
    const out = await deliverEmailMessage(db as never, row({ delivery_attempts: 1 }), {
      admin: db as never,
      now: () => NOW,
      resolve: via({ ok: true, route: outlook }),
      sendOutlook: (async () => {
        throw Object.assign(new Error("Microsoft Graph request failed [503]: busy"), {
          status: 503,
        });
      }) as never,
    });
    expect(out).toMatchObject({ queued: true, reason: "transport_error" });
    expect(emailWrites(db)[0]!.values).toMatchObject({
      status: "queued",
      delivery_reason: "transport_error",
      delivery_attempts: 2,
      next_attempt_at: "2026-10-12T12:10:00.000Z",
    });
  });

  it("the sixth failed attempt is final: 'failed', with Microsoft's words", async () => {
    const db = fakeDb();
    await expect(
      deliverEmailMessage(db as never, row({ delivery_attempts: 5 }), {
        admin: db as never,
        now: () => NOW,
        resolve: via({ ok: true, route: outlook }),
        sendOutlook: (async () => {
          throw Object.assign(new Error("[503]"), { status: 503 });
        }) as never,
      }),
    ).rejects.toThrow("[503]");
    expect(emailWrites(db)[0]!.values).toMatchObject({
      status: "failed",
      error: "[503]",
      delivery_attempts: 6,
      delivery_reason: null,
    });
  });

  it("a refusal (bad address, no right to send) fails at once", async () => {
    const db = fakeDb();
    await expect(
      deliverEmailMessage(db as never, row(), {
        admin: db as never,
        now: () => NOW,
        resolve: via({ ok: true, route: outlook }),
        sendOutlook: (async () => {
          throw Object.assign(new Error("ErrorInvalidRecipients"), { status: 400 });
        }) as never,
      }),
    ).rejects.toThrow("ErrorInvalidRecipients");
    expect(emailWrites(db)[0]!.values).toMatchObject({ status: "failed" });
    expect(db.writes.some((w) => w.table === "touchpoints")).toBe(false);
  });

  it("a sign-in Microsoft has just refused parks it for a reconnect, uncounted", async () => {
    const db = fakeDb();
    const out = await deliverEmailMessage(db as never, row({ delivery_attempts: 2 }), {
      admin: db as never,
      now: () => NOW,
      resolve: via({ ok: true, route: outlook }),
      sendOutlook: (async () => {
        throw Object.assign(new Error("expired"), {
          name: "DelegatedTokenError",
          reason: "needs_reconnect",
        });
      }) as never,
    });
    expect(out).toMatchObject({ queued: true, reason: "needs_reconnect" });
    expect(emailWrites(db)[0]!.values).not.toHaveProperty("delivery_attempts");
  });
});

describe("through Resend", () => {
  it("From is the template's name on the configured address; recorded as resend", async () => {
    const db = fakeDb();
    const sendResend = vi.fn(async () => ({ id: "re_123" }));
    const out = await deliverEmailMessage(db as never, row({ log_touchpoint: false }), {
      admin: db as never,
      now: () => NOW,
      resolve: via({ ok: true, route: { kind: "resend", fromAddress: "office@gs.com" } }),
      sendResend: sendResend as never,
    });
    expect(sendResend).toHaveBeenCalledWith(
      expect.objectContaining({ from: "Gold Star Restoration <office@gs.com>" }),
    );
    expect(out).toMatchObject({
      provider: "resend",
      providerId: "re_123",
      touchpointLogged: false,
    });
    expect(emailWrites(db).at(-1)!.values).toMatchObject({
      status: "sent",
      provider: "resend",
      provider_id: "re_123",
      sent_from: "office@gs.com",
    });
  });

  it("a Resend refusal is 'failed' and thrown, as before", async () => {
    const db = fakeDb();
    await expect(
      deliverEmailMessage(db as never, row(), {
        admin: db as never,
        now: () => NOW,
        resolve: via({ ok: true, route: { kind: "resend", fromAddress: "office@gs.com" } }),
        sendResend: (async () => {
          throw new Error("Email provider rejected the send [422]");
        }) as never,
      }),
    ).rejects.toThrow("[422]");
    expect(emailWrites(db)[0]!.values).toMatchObject({ status: "failed" });
  });
});
