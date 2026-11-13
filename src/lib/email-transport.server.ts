/**
 * Server-only. Which transport carries an email a person sent, and the
 * Outlook half of carrying it. The order and the reasons are explained in
 * email-transport.ts; this file is the part that reads the database and talks
 * to Microsoft.
 *
 * Whose mailbox: the SENDER's (email_messages.sent_by), never the person who
 * happens to be running the sweep or pressing Resend. In delegated mode that is
 * their own Microsoft sign-in (`getDelegatedAccessToken` through
 * `resolveSenderAuth`), so Microsoft decides as well as we do. Before anything
 * is tried, `assertCanSendAs` — the one rule for "may this person send as this
 * mailbox" — is asked with the service-role client: its checks
 * (`can_manage_location`, `has_role`) take the user id explicitly, so they
 * answer for the sender, not for whoever holds the client.
 *
 * Order of mailboxes: the sender's own first (From is their address, the
 * customer's reply comes back to them). An office shared mailbox they are the
 * recorded owner of (`graph_mailboxes.owner_user_id`) is the fallback — in
 * delegated mode their own mailbox always works once they are connected, so
 * in practice the office mailbox carries mail only in application mode, where
 * there is no per-person sign-in and a mailbox must be registered.
 *
 * Attachments stay LINKS (composeOutgoingHtml), exactly as with Resend. Real
 * attachments would mean fetching each file from storage at release, base64
 * inline under Graph's 3 MB request ceiling or an upload session above it —
 * not trivial, and a removed-during-hold file must still really be removed.
 */
import type { EmailDeliveryReason } from "@/lib/email-transport";
import { graphConfigured, type GraphAuth } from "@/lib/graph.server";
import { outlookAuthMode } from "@/lib/microsoft-oauth";

export type MailboxCandidate = {
  id: string | null;
  upn: string;
  kind: string;
  user_id: string | null;
  owner_user_id: string | null;
  location_id: string | null;
};

export type OutlookRoute = {
  kind: "outlook";
  upn: string;
  auth: GraphAuth;
  mailboxId: string | null;
  shared: boolean;
};
export type ResendRoute = { kind: "resend"; fromAddress: string };

export type TransportResolution =
  | { ok: true; route: OutlookRoute | ResendRoute }
  | { ok: false; reason: EmailDeliveryReason; message: string };

/** Everything the resolver asks of the world; production below, fakes in tests. */
export type TransportDeps = {
  /** Integrations-screen values over process.env (Outlook AND Resend). */
  loadEnv(): Promise<void>;
  /** Null when Outlook is not configured at all. */
  outlookMode(): "delegated" | "application" | null;
  connection(userId: string): Promise<{ upn: string; status: string } | null>;
  isUserActive(userId: string): Promise<boolean>;
  /** Enabled mailboxes this person is the user of, or the recorded owner of. */
  mailboxesFor(userId: string): Promise<MailboxCandidate[]>;
  canSendAs(userId: string, mailbox: MailboxCandidate): Promise<boolean>;
  /** Throws a sentence the person can act on when Microsoft's half says no. */
  senderAuth(userId: string, mailbox: MailboxCandidate): Promise<GraphAuth>;
  resendKey(): string | undefined;
  resendFromAddress(): string;
};

const MESSAGES: Record<EmailDeliveryReason, string> = {
  no_transport: "No email service is connected: Outlook is not set up and Resend has no key.",
  sender_not_connected: "The sender has not connected Outlook.",
  needs_reconnect: "Microsoft stopped accepting the sender's Outlook sign-in.",
  sender_inactive: "The sender's account is not active.",
  transport_error: "The mail service did not accept the email.",
};

const fail = (reason: EmailDeliveryReason, message?: string): TransportResolution => ({
  ok: false,
  reason,
  message: message ?? MESSAGES[reason],
});

async function resolveOutlook(
  senderId: string,
  locationId: string | null,
  mode: "delegated" | "application",
  deps: TransportDeps,
): Promise<TransportResolution> {
  const candidates: MailboxCandidate[] = [];

  if (mode === "delegated") {
    const conn = await deps.connection(senderId);
    if (!conn) return fail("sender_not_connected");
    if (conn.status !== "connected") return fail("needs_reconnect");
    if (!(await deps.isUserActive(senderId))) return fail("sender_inactive");
    candidates.push({
      id: null,
      upn: conn.upn,
      kind: "user",
      user_id: senderId,
      owner_user_id: null,
      location_id: null,
    });
  }

  let registered: MailboxCandidate[] | null = null;
  const tried = new Set<string>();
  let lastRefusal: string | null = null;

  const attempt = async (c: MailboxCandidate): Promise<TransportResolution | null> => {
    const key = c.upn.trim().toLowerCase();
    if (!key || tried.has(key)) return null;
    tried.add(key);
    if (!(await deps.canSendAs(senderId, c))) return null;
    try {
      const auth = await deps.senderAuth(senderId, c);
      return {
        ok: true,
        route: {
          kind: "outlook",
          upn: c.upn,
          auth,
          mailboxId: c.id,
          shared: c.kind === "shared_office",
        },
      };
    } catch (e) {
      lastRefusal = e instanceof Error ? e.message : String(e);
      return null;
    }
  };

  for (const c of candidates) {
    const hit = await attempt(c);
    if (hit) return hit;
  }

  registered ??= await deps.mailboxesFor(senderId);
  const personal = registered.filter((m) => m.kind !== "shared_office" && m.user_id === senderId);
  const shared = registered
    .filter((m) => m.kind === "shared_office" && m.owner_user_id === senderId)
    // The office the email is about first: an invoice for Lakewood from the
    // Lakewood mailbox, when the sender looks after more than one.
    .sort((a, b) => Number(b.location_id === locationId) - Number(a.location_id === locationId));
  for (const c of [...personal, ...shared]) {
    const hit = await attempt(c);
    if (hit) return hit;
  }

  return fail("sender_not_connected", lastRefusal ?? undefined);
}

/**
 * The transport for one sender, or the reason there is none. Outlook first,
 * Resend second; a null sender (automation) can only ever use Resend.
 */
export async function resolveEmailTransport(
  senderId: string | null,
  opts: { locationId?: string | null } = {},
  deps: TransportDeps = productionTransportDeps,
): Promise<TransportResolution> {
  await deps.loadEnv();

  let outlookProblem: TransportResolution | null = null;
  const mode = deps.outlookMode();
  if (mode && senderId) {
    const outlook = await resolveOutlook(senderId, opts.locationId ?? null, mode, deps);
    if (outlook.ok) return outlook;
    outlookProblem = outlook;
  }

  if (deps.resendKey()) {
    return { ok: true, route: { kind: "resend", fromAddress: deps.resendFromAddress() } };
  }

  return outlookProblem ?? fail("no_transport");
}

/* ------------------------------------------------------------------ */
/* Sending through Outlook                                             */
/* ------------------------------------------------------------------ */

/**
 * Our own Message-ID for a row, the same on every attempt: Graph's sendMail
 * returns 202 and no id, so this is what provider_id holds for an Outlook
 * send, and a repeat after a crash between "Microsoft took it" and "we wrote
 * sent" reaches the customer's server with the id it has already seen.
 */
export function outlookMessageId(rowId: string, upn: string): string {
  const domain = (upn.split("@")[1] ?? "").trim().toLowerCase() || "recoveryhub.local";
  return `<rh-${rowId}@${domain}>`;
}

export type OutlookSend = {
  rowId: string;
  to: string[];
  cc: string[];
  subject: string;
  html: string;
  replyTo: string | null;
};

type SendMail = typeof import("@/lib/graph.server").sendMailAs;

export async function sendThroughOutlook(
  route: OutlookRoute,
  message: OutlookSend,
  sendMail?: SendMail,
): Promise<{ providerId: string }> {
  const send = sendMail ?? (await import("@/lib/graph.server")).sendMailAs;
  const internetMessageId = outlookMessageId(message.rowId, route.upn);
  const payload = {
    subject: message.subject,
    contentType: "HTML" as const,
    content: message.html,
    to: message.to,
    cc: message.cc,
    replyTo: message.replyTo ? [message.replyTo] : null,
  };
  try {
    await send(route.upn, { ...payload, internetMessageId }, route.auth);
  } catch (e) {
    // Microsoft documents internetMessageId as settable on a new message; if
    // a tenant refuses it, the email matters more than our handle on it.
    const { status, body } = e as { status?: number; body?: string };
    if (status === 400 && /internetMessageId/i.test(String(body ?? ""))) {
      await send(route.upn, payload, route.auth);
      return { providerId: internetMessageId };
    }
    throw e;
  }
  return { providerId: internetMessageId };
}

export type OutlookFailure =
  /** Nothing went out and only the sender can fix it: park, do not count. */
  | { kind: "waiting"; reason: EmailDeliveryReason; message: string }
  /** Try again later with backoff; counts as an attempt. */
  | { kind: "transient"; message: string }
  /** Microsoft said no to this email: 'failed', with its words. */
  | { kind: "permanent"; message: string };

export function classifyOutlookFailure(error: unknown): OutlookFailure {
  const message = error instanceof Error ? error.message : String(error);
  const named = error as { name?: string; reason?: string; status?: number };
  if (named?.name === "DelegatedTokenError") {
    switch (named.reason) {
      case "needs_reconnect":
        return { kind: "waiting", reason: "needs_reconnect", message };
      case "not_connected":
        return { kind: "waiting", reason: "sender_not_connected", message };
      case "inactive":
        return { kind: "waiting", reason: "sender_inactive", message };
      default:
        return { kind: "transient", message };
    }
  }
  if (typeof named?.status === "number") {
    const s = named.status;
    // graphFetch has already retried 429/503/504 with Retry-After and a 401
    // with a fresh token; what is left of those is still worth another go later.
    if (s === 401 || s === 408 || s === 429 || s >= 500) return { kind: "transient", message };
    return { kind: "permanent", message };
  }
  // A network failure before any answer: nothing was accepted.
  return { kind: "transient", message };
}

/* ------------------------------------------------------------------ */
/* Production                                                          */
/* ------------------------------------------------------------------ */

async function adminDb() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

export const productionTransportDeps: TransportDeps = {
  async loadEnv() {
    // loadOutlookEnv is ensureIntegrationEnv: every stored credential, so a
    // Resend key typed on the Integrations screen counts as much as Outlook's.
    const { loadOutlookEnv } = await import("@/lib/microsoft-delegated.server");
    await loadOutlookEnv();
  },
  outlookMode() {
    // Synchronous, and sees the Integrations-screen values because loadEnv
    // (loadOutlookEnv) always runs first — resolveEmailTransport's first line.
    return graphConfigured() ? outlookAuthMode() : null;
  },
  async connection(userId) {
    const { supabaseConnectionStore } = await import("@/lib/microsoft-delegated.server");
    const row = await supabaseConnectionStore.get(userId);
    return row ? { upn: row.upn, status: row.status } : null;
  },
  async isUserActive(userId) {
    const { supabaseConnectionStore } = await import("@/lib/microsoft-delegated.server");
    return supabaseConnectionStore.isUserActive(userId);
  },
  async mailboxesFor(userId) {
    const { isMissingSchema } = await import("@/lib/schema-fallback");
    const db = (await adminDb()) as unknown as import("@supabase/supabase-js").SupabaseClient;
    const withOwner = await db
      .from("graph_mailboxes")
      .select("id, upn, kind, user_id, owner_user_id, location_id")
      .eq("enabled", true)
      .or(`user_id.eq.${userId},owner_user_id.eq.${userId}`);
    if (!withOwner.error) return (withOwner.data ?? []) as MailboxCandidate[];
    if (!isMissingSchema(withOwner.error)) throw withOwner.error;
    // Before 20261007210000 there is no owner column: personal mailboxes only.
    const plain = await db
      .from("graph_mailboxes")
      .select("id, upn, kind, user_id, location_id")
      .eq("enabled", true)
      .eq("user_id", userId);
    if (plain.error) throw plain.error;
    return ((plain.data ?? []) as Omit<MailboxCandidate, "owner_user_id">[]).map((m) => ({
      ...m,
      owner_user_id: null,
    }));
  },
  async canSendAs(userId, mailbox) {
    const { assertCanSendAs } = await import("@/lib/graph.functions");
    const db = await adminDb();
    try {
      await assertCanSendAs(
        { supabase: db as never, userId },
        {
          upn: mailbox.upn,
          // A shared office mailbox has no user; the rule then asks whether
          // the sender manages its office (or is an owner/admin/dev).
          user_id: mailbox.kind === "shared_office" ? null : mailbox.user_id,
          location_id: mailbox.location_id,
        },
      );
      return true;
    } catch {
      return false;
    }
  },
  async senderAuth(userId, mailbox) {
    const { resolveSenderAuth } = await import("@/lib/graph-auth.server");
    return resolveSenderAuth(userId, {
      upn: mailbox.upn,
      kind: mailbox.kind,
      user_id: mailbox.user_id,
      owner_user_id: mailbox.owner_user_id,
    });
  },
  resendKey() {
    return process.env["RESEND_API_KEY"]?.trim() || undefined;
  },
  resendFromAddress() {
    return resendFromAddress();
  },
};

/**
 * RESEND_FROM_ADDRESS is a bare address the From name is put in front of;
 * RESEND_FROM (older) is a whole "Name <address>". Either may be set.
 */
export function resendFromAddress(env: Record<string, string | undefined> = process.env): string {
  const bare = env["RESEND_FROM_ADDRESS"]?.trim();
  if (bare) return bare;
  const full = env["RESEND_FROM"]?.trim();
  const inAngles = full ? /<([^>]+)>/.exec(full)?.[1]?.trim() : null;
  return inAngles || full || "onboarding@resend.dev";
}
