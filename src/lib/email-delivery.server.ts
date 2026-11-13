// Server-only. THE TRANSPORT SEAM for email a person sent: one function that
// takes a logged email_messages row and decides whether it leaves the building.
//
// Three callers, one behaviour: sendEmail when the undo window is off (delay
// 0), the email-release hook when a held email's window runs out, and the same
// hook's retry step (plus a person's Resend) for an email that was parked.
//
// Transport order (email-transport.ts explains why): the SENDER's own Outlook
// through their delegated Microsoft sign-in, then Resend, then nothing — and
// "nothing" is a row left 'queued' WITH a machine-readable reason
// (delivery_reason), never a bare 'queued' that looks the same as "on its
// way". That bare 'queued' is what David's 11 Oct invoice sat in, with the
// screen saying sent.
//
// Bookkeeping on email_messages goes through the service-role client: the
// transport columns are the sweep's, not the sender's (migration
// 20261012100000 guards them against a signed-in writer), and the immediate
// path used to write them through the sender's own client. The touchpoint is
// still written through the caller's client, exactly as before.
import { composeOutgoingHtml, parseAttachments } from "./email-hold";
import {
  EMAIL_RETRY_MAX_ATTEMPTS,
  EMAIL_WAITING_RECHECK_MINUTES,
  retryDelayMs,
  type EmailDeliveryReason,
  type EmailProvider,
} from "./email-transport";
import type { TransportResolution } from "./email-transport.server";

type Db = Awaited<typeof import("@/integrations/supabase/client.server")>["supabaseAdmin"];

export type DeliverableEmail = {
  id: string;
  to_emails: string[];
  cc_emails: string[] | null;
  subject: string;
  body_html: string;
  attachments?: unknown;
  reply_to?: string | null;
  from_name?: string | null;
  log_touchpoint?: boolean | null;
  account_id: string | null;
  contact_id: string | null;
  sent_by: string | null;
  location_id?: string | null;
  /** Real send attempts so far (absent before 20261012100000). */
  delivery_attempts?: number | null;
  /** Set on automated invoice reminders, which are re-checked before they go. */
  template_key?: string | null;
  invoice_id?: string | null;
};

export type DeliveryOutcome = {
  id: string;
  providerId: string | null;
  touchpointLogged: boolean;
  /** Nothing carried it (yet): the row stays 'queued' with `reason`, never 'failed'. */
  queued: boolean;
  provider: EmailProvider | null;
  reason: EmailDeliveryReason | null;
  /** An automated invoice reminder stopped at send time (paid, off, client exempt). */
  cancelled?: string;
};

export type DeliverOptions = {
  now?: () => Date;
  /** The transport for this row's sender; the sweep passes a per-run cache. */
  resolve?: (senderId: string | null, locationId: string | null) => Promise<TransportResolution>;
  sendOutlook?: typeof import("./email-transport.server").sendThroughOutlook;
  sendResend?: typeof import("./email.server").sendViaResend;
  /** Where email_messages bookkeeping is written (service role). */
  admin?: Db;
};

async function serviceDb(opts: DeliverOptions): Promise<Db> {
  if (opts.admin) return opts.admin;
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

/**
 * Write `full`; when the transport columns are not in the database yet
 * (20261012100000 unapplied), write `legacy` instead — the email's own state
 * must never be lost because its bookkeeping could not be.
 */
async function writeRow(
  db: Db,
  id: string,
  full: Record<string, unknown>,
  legacy: Record<string, unknown> | null,
) {
  const first = await db
    .from("email_messages")
    .update(full as never)
    .eq("id", id);
  if (!first.error) return;
  const { isMissingSchema } = await import("./schema-fallback");
  if (!isMissingSchema(first.error)) throw first.error;
  if (!legacy || Object.keys(legacy).length === 0) return;
  const second = await db
    .from("email_messages")
    .update(legacy as never)
    .eq("id", id);
  if (second.error) throw second.error;
}

export async function deliverEmailMessage(
  db: Db,
  row: DeliverableEmail,
  opts: DeliverOptions = {},
): Promise<DeliveryOutcome> {
  const now = opts.now ?? (() => new Date());
  const admin = await serviceDb(opts);
  const resolve =
    opts.resolve ??
    (async (senderId: string | null, locationId: string | null) => {
      const { resolveEmailTransport } = await import("./email-transport.server");
      return resolveEmailTransport(senderId, { locationId });
    });

  const parked = async (
    reason: EmailDeliveryReason,
    message: string | null,
    nextAttemptAt: Date,
    attempts?: number,
  ): Promise<DeliveryOutcome> => {
    await writeRow(
      admin,
      row.id,
      {
        status: "queued",
        delivery_reason: reason,
        error: message,
        next_attempt_at: nextAttemptAt.toISOString(),
        claimed_at: null,
        ...(attempts !== undefined
          ? { delivery_attempts: attempts, last_attempt_at: now().toISOString() }
          : {}),
      },
      { status: "queued" },
    );
    return {
      id: row.id,
      providerId: null,
      touchpointLogged: false,
      queued: true,
      provider: null,
      reason,
    };
  };

  const failed = async (message: string, attempts?: number): Promise<never> => {
    await writeRow(
      admin,
      row.id,
      {
        status: "failed",
        error: message,
        // Not parked any more: a failed row is never retried by the sweep,
        // only by a person's Resend.
        delivery_reason: null,
        claimed_at: null,
        next_attempt_at: null,
        ...(attempts !== undefined
          ? { delivery_attempts: attempts, last_attempt_at: now().toISOString() }
          : {}),
      },
      { status: "failed", error: message },
    );
    throw new Error(message);
  };

  // Automated invoice reminders are re-checked against the invoice and the
  // client as they are NOW — a payment, an "off", or the client's exemption
  // flipped after scheduling stops the send (invoice-followups.server.ts).
  if (row.template_key?.startsWith("invoice_followup")) {
    const { blockFollowupAtSend } = await import("./invoice-followups.server");
    const blocked = await blockFollowupAtSend(admin, row);
    if (blocked) {
      return {
        id: row.id,
        providerId: null,
        touchpointLogged: false,
        queued: false,
        provider: null,
        reason: null,
        cancelled: blocked,
      };
    }
  }

  const resolution = await resolve(row.sent_by, row.location_id ?? null);
  if (!resolution.ok) {
    // Nobody tried to send, so this is not an attempt: the row is looked at
    // again in a few minutes, for as long as it is young enough to auto-send.
    return parked(
      resolution.reason,
      null,
      new Date(now().getTime() + EMAIL_WAITING_RECHECK_MINUTES * 60_000),
    );
  }

  const html = composeOutgoingHtml(row.body_html, parseAttachments(row.attachments));
  const route = resolution.route;
  let providerId: string | null;
  let sentFrom: string;

  if (route.kind === "outlook") {
    const attempts = (row.delivery_attempts ?? 0) + 1;
    try {
      const { sendThroughOutlook } = opts.sendOutlook
        ? { sendThroughOutlook: opts.sendOutlook }
        : await import("./email-transport.server");
      const result = await sendThroughOutlook(route, {
        rowId: row.id,
        to: row.to_emails,
        cc: row.cc_emails ?? [],
        subject: row.subject,
        html,
        replyTo: row.reply_to ?? null,
      });
      providerId = result.providerId;
      sentFrom = route.upn;
    } catch (error) {
      const { classifyOutlookFailure } = await import("./email-transport.server");
      const failure = classifyOutlookFailure(error);
      if (failure.kind === "waiting") {
        return parked(
          failure.reason,
          null,
          new Date(now().getTime() + EMAIL_WAITING_RECHECK_MINUTES * 60_000),
        );
      }
      if (failure.kind === "transient" && attempts < EMAIL_RETRY_MAX_ATTEMPTS) {
        return parked(
          "transport_error",
          failure.message.slice(0, 1000),
          new Date(now().getTime() + retryDelayMs(attempts)),
          attempts,
        );
      }
      return failed(failure.message.slice(0, 1000), attempts);
    }
  } else {
    // Resend, unchanged in behaviour: any refusal is 'failed' with the
    // provider's own words, where the sender sees it.
    try {
      const sendViaResend = opts.sendResend ?? (await import("./email.server")).sendViaResend;
      const result = await sendViaResend({
        to: row.to_emails,
        cc: row.cc_emails ?? [],
        subject: row.subject,
        html,
        replyTo: row.reply_to ?? null,
        from: row.from_name ? `${row.from_name} <${route.fromAddress}>` : null,
      });
      providerId = result.id;
      sentFrom = route.fromAddress;
    } catch (error) {
      return failed(error instanceof Error ? error.message : String(error));
    }
  }

  let touchpointId: string | null = null;
  if (row.log_touchpoint !== false && row.contact_id && row.account_id) {
    const { data: tp } = await db
      .from("touchpoints")
      .insert({
        account_id: row.account_id,
        contact_id: row.contact_id,
        type: "email",
        notes: `Email sent: ${row.subject}`,
        created_by: row.sent_by,
      })
      .select("id")
      .single();
    touchpointId = tp?.id ?? null;
  }

  const sentAt = now().toISOString();
  await writeRow(
    admin,
    row.id,
    {
      status: "sent",
      provider_id: providerId,
      sent_at: sentAt,
      touchpoint_id: touchpointId,
      provider: route.kind,
      sent_from: sentFrom,
      delivery_reason: null,
      error: null,
      next_attempt_at: null,
      claimed_at: null,
    },
    { status: "sent", provider_id: providerId, sent_at: sentAt, touchpoint_id: touchpointId },
  );

  return {
    id: row.id,
    providerId,
    touchpointLogged: Boolean(touchpointId),
    queued: false,
    provider: route.kind,
    reason: null,
  };
}
