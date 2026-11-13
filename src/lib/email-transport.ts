/**
 * Which way an email a person sent leaves the building, and what the screen
 * says while it has not.
 *
 * David Stern sent an invoice from the app on 11 Oct; the screen said sent,
 * and it never arrived. The transport seam only knew Resend, Resend had no
 * key, and the row sat in 'queued' with nothing on it and nothing coming back
 * for it. Since then Microsoft 365 delegated access is live, so the order is:
 *
 *   1. the SENDER's own Outlook, through their own Microsoft sign-in (From is
 *      their real address, it lands in their Sent Items, replies thread);
 *   2. Resend, when an admin has connected it;
 *   3. otherwise the row stays 'queued' WITH A REASON, the sender is told
 *      before the undo window closes, and the email-release sweep tries again
 *      once the sender has a way out.
 *
 * Pure: no client, no clock of its own. The server half is
 * email-transport.server.ts; the sweep's SQL is migration 20261012100000,
 * whose literals (14 days, 6 attempts, 10-minute claim) are pinned to the
 * constants here by email-transport.test.ts.
 */

/** Machine-readable, stored on email_messages.delivery_reason. */
export type EmailDeliveryReason =
  /** No Outlook for this sender and no Resend: nothing could carry it. */
  | "no_transport"
  /** Outlook is set up for the company, but the sender never connected theirs. */
  | "sender_not_connected"
  /** Microsoft stopped accepting the sender's sign-in; only they can fix it. */
  | "needs_reconnect"
  /** The sender's Recovery Hub account is deactivated. */
  | "sender_inactive"
  /** A transport was there but refused or failed for now; retried with backoff. */
  | "transport_error";

export const EMAIL_DELIVERY_REASONS: readonly EmailDeliveryReason[] = [
  "no_transport",
  "sender_not_connected",
  "needs_reconnect",
  "sender_inactive",
  "transport_error",
];

export type EmailProvider = "outlook" | "resend";

/**
 * Older than this and the sweep leaves it alone: a two-week-old invoice going
 * out by itself the day someone connects Outlook would surprise everybody,
 * the customer most of all. A person decides — Resend or Cancel.
 */
export const EMAIL_AUTO_SEND_MAX_AGE_DAYS = 14;
/** Real send attempts (a transport tried and failed) before the row is 'failed'. */
export const EMAIL_RETRY_MAX_ATTEMPTS = 6;
/** A claimed row is the sweep's for this long; then a crashed run's claim lapses. */
export const EMAIL_CLAIM_LEASE_MINUTES = 10;
/**
 * How often a row waiting on its sender (not connected, sign-in expired) is
 * looked at again. Looking costs a database read, never a send, so it does not
 * count as an attempt — David connecting Outlook a week later still gets his
 * email out within five minutes.
 */
export const EMAIL_WAITING_RECHECK_MINUTES = 5;

/** Backoff after the Nth failed real attempt (1-based): 5, 10, 20, 40, 80 min, capped at 6 h. */
export function retryDelayMs(attempts: number): number {
  const n = Math.max(1, Math.floor(attempts));
  return Math.min(5 * 60_000 * 2 ** (n - 1), 6 * 3_600_000);
}

export function isTooOldToAutoSend(createdAt: string | Date | null | undefined, now: Date) {
  if (!createdAt) return false;
  const at = typeof createdAt === "string" ? new Date(createdAt) : createdAt;
  const age = now.getTime() - at.getTime();
  return Number.isFinite(age) && age > EMAIL_AUTO_SEND_MAX_AGE_DAYS * 86_400_000;
}

/** What the sender's own way out looks like right now (emailStatus). */
export type MyEmailTransport = {
  configured: boolean;
  via: EmailProvider | null;
  reason: EmailDeliveryReason | null;
  /** The address it would go out from, when known. */
  from: string | null;
};

export type UnsentEmailRow = {
  status: string | null;
  sent_at?: string | null;
  created_at?: string | null;
  sent_by?: string | null;
  delivery_reason?: string | null;
  next_attempt_at?: string | null;
  error?: string | null;
};

export type UnsentAction =
  | { kind: "link"; label: string; to: "/security" | "/admin/integrations" }
  | { kind: "resend" }
  | { kind: "cancel" };

export type UnsentNotice = {
  /** "Not sent yet — …" / "Not sent — …": the one line on the row. */
  headline: string;
  /** A second line when there is something useful to add. */
  detail: string | null;
  tone: "warning" | "destructive" | "muted";
  actions: UnsentAction[];
};

function asReason(value: string | null | undefined): EmailDeliveryReason | null {
  return (EMAIL_DELIVERY_REASONS as readonly string[]).includes(value ?? "")
    ? (value as EmailDeliveryReason)
    : null;
}

const CONNECT_OUTLOOK: UnsentAction = {
  kind: "link",
  label: "Connect Outlook on your Security page",
  to: "/security",
};
const RECONNECT_OUTLOOK: UnsentAction = {
  kind: "link",
  label: "Reconnect Outlook on your Security page",
  to: "/security",
};
const CONNECT_SERVICE: UnsentAction = {
  kind: "link",
  label: "Connect an email service in Integrations",
  to: "/admin/integrations",
};

/**
 * The words on an email that has not gone, and what fixes it. Null when the
 * row is not an unsent one (held, cancelled, sent and beyond).
 *
 * `mine` is the viewer being the sender; `canManage` is owner/admin/dev, who
 * may connect a service and may Resend or Cancel anyone's (assertCanSendAs
 * already lets them act as any connected mailbox). `myTransport`, for the
 * sender's own rows, is their live state — fresher than the stored reason, so
 * a row parked as "not connected" says "Outlook is connected now" the moment
 * they connect, rather than repeating an old excuse until the next sweep.
 */
export function unsentEmailNotice(
  row: UnsentEmailRow,
  viewer: {
    mine: boolean;
    canManage: boolean;
    senderName?: string | null;
    myTransport?: MyEmailTransport | null;
  },
  now: Date,
): UnsentNotice | null {
  if (row.sent_at) return null;
  if (row.status !== "queued" && row.status !== "failed") return null;

  const control: UnsentAction[] =
    viewer.mine || viewer.canManage ? [{ kind: "resend" }, { kind: "cancel" }] : [];
  const sender = viewer.mine
    ? "you haven't"
    : `${viewer.senderName?.trim() || "The sender"} hasn't`;

  if (row.status === "failed") {
    return {
      headline: "Not sent — the mail service refused it",
      detail: row.error?.trim() || null,
      tone: "destructive",
      actions: control,
    };
  }

  if (isTooOldToAutoSend(row.created_at, now)) {
    return {
      headline: "Not sent — too old to send automatically; resend or cancel",
      detail: null,
      tone: "destructive",
      actions: control,
    };
  }

  const live = viewer.mine ? viewer.myTransport : null;
  if (live?.configured) {
    return {
      headline: `Not sent yet — sending shortly${live.via === "outlook" ? " through your Outlook" : ""}`,
      detail:
        "Your email service is connected now; it goes out on the next sweep, or press Resend.",
      tone: "warning",
      actions: control,
    };
  }

  const reason = (viewer.mine ? live?.reason : null) ?? asReason(row.delivery_reason);
  const adminFix = viewer.canManage ? [CONNECT_SERVICE] : [];
  switch (reason) {
    case "sender_not_connected":
      return {
        headline: `Not sent yet — ${sender} connected Outlook`,
        detail: viewer.mine
          ? "Recovery Hub sends as you, from your own mailbox. It goes out within minutes of connecting."
          : "It goes out within minutes of them connecting Outlook on their Security page.",
        tone: "warning",
        actions: [...(viewer.mine ? [CONNECT_OUTLOOK] : []), ...adminFix, ...control],
      };
    case "needs_reconnect":
      return {
        headline: viewer.mine
          ? "Not sent yet — Microsoft stopped accepting your Outlook sign-in"
          : `Not sent yet — ${viewer.senderName?.trim() || "the sender"} needs to reconnect Outlook`,
        detail: null,
        tone: "warning",
        actions: [...(viewer.mine ? [RECONNECT_OUTLOOK] : []), ...adminFix, ...control],
      };
    case "sender_inactive":
      return {
        headline: "Not sent — the sender's account is no longer active",
        detail: viewer.canManage ? "Resend it from an active account, or cancel it." : null,
        tone: "destructive",
        actions: [...adminFix, ...control],
      };
    case "transport_error":
      return {
        headline: "Not sent yet — the mail service didn't take it; trying again",
        detail:
          [
            row.error?.trim() || null,
            row.next_attempt_at
              ? `Next try ${new Date(row.next_attempt_at).toLocaleString("en-US")}`
              : null,
          ]
            .filter(Boolean)
            .join(" · ") || null,
        tone: "warning",
        actions: control,
      };
    case "no_transport":
    case null:
    default:
      return {
        headline: "Not sent yet — no email service is connected",
        detail: viewer.canManage
          ? null
          : viewer.mine
            ? "Connect Outlook on your Security page, or ask an admin to connect an email service."
            : "Ask an admin to connect an email service.",
        tone: "warning",
        actions: [...(viewer.mine ? [CONNECT_OUTLOOK] : []), ...adminFix, ...control],
      };
  }
}

/** What a Send returns, as far as telling the sender is concerned. */
export type SendResultLike = {
  /** The email_messages row, so a held send can be released from the toast. */
  id?: string | null;
  held?: boolean;
  releaseAt?: string | null;
  queued?: boolean;
  touchpointLogged?: boolean;
  provider?: EmailProvider | null;
  reason?: EmailDeliveryReason | null;
  /** Held path: whether anything can carry it when the window runs out. */
  transport?: MyEmailTransport | null;
};

/** The one sentence a sender is owed when no transport will carry their email. */
export function noTransportSentence(reason: EmailDeliveryReason | null | undefined): string {
  switch (reason) {
    case "sender_not_connected":
      return "It won't go out until you connect Outlook on your Security page.";
    case "needs_reconnect":
      return "It won't go out until you reconnect Outlook on your Security page — Microsoft stopped accepting your sign-in.";
    case "sender_inactive":
      return "It won't go out: your account is not active.";
    case "transport_error":
      return "The mail service didn't take it; Recovery Hub will try again.";
    default:
      return "It won't go out until you connect Outlook on your Security page, or an admin connects an email service.";
  }
}

/**
 * Whether the sender must be warned: a held email nothing will carry, or an
 * immediate send that stayed queued. Never true for a send that went out.
 */
export function sendNeedsWarning(result: SendResultLike): EmailDeliveryReason | "unknown" | null {
  if (result.held) {
    if (!result.transport) return null;
    return result.transport.configured ? null : (result.transport.reason ?? "no_transport");
  }
  if (result.queued) return result.reason ?? "unknown";
  return null;
}
