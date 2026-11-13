// Server-only. The second half of the email-release hook: emails that were
// parked 'queued' with a reason get another go once their sender has a way
// out, and the admins hear about it when they pile up.
//
// David's invoice of 11 Oct is the case: claimed at 21:59, no transport, left
// 'queued' — and nothing ever looked at it again. Now the sweep claims parked
// rows (claim_retryable_queued_emails, migration 20261012100000: oldest first,
// at most 25 a run, younger than 14 days, under 6 real attempts, due by their
// backoff, never one with sent_at), resolves each sender's transport once per
// run, and hands each row to the same seam a fresh send uses. A sender who is
// still not connected costs a read and a "look again in 5 minutes" — no
// attempt is counted, because nothing was tried.
//
// Rows older than 14 days are never picked up here. The 25 Aug work
// authorization is one: it waits for a person (Mark's call) to press Resend
// or Cancel, and the screen says exactly that.
import type { DeliverableEmail, DeliveryOutcome } from "./email-delivery.server";
import { EMAIL_AUTO_SEND_MAX_AGE_DAYS, isTooOldToAutoSend } from "./email-transport";
import type { TransportResolution } from "./email-transport.server";

type Db = Awaited<typeof import("@/integrations/supabase/client.server")>["supabaseAdmin"];

export type RetrySummary = {
  /** False until 20261012100000 is applied: nothing to claim with. */
  migrated: boolean;
  claimed: number;
  sent: number;
  waiting: number;
  failed: number;
};

export const RETRY_BATCH = 25;

export async function retryQueuedEmails(
  admin: Db,
  opts: {
    deliver?: (row: DeliverableEmail, resolve: ResolveFn) => Promise<DeliveryOutcome>;
    resolve?: ResolveFn;
  } = {},
): Promise<RetrySummary> {
  const summary: RetrySummary = { migrated: true, claimed: 0, sent: 0, waiting: 0, failed: 0 };
  const { data, error } = await admin.rpc(
    "claim_retryable_queued_emails" as never,
    { _limit: RETRY_BATCH } as never,
  );
  if (error) {
    const { isMissingSchema } = await import("./schema-fallback");
    if (isMissingSchema(error)) return { ...summary, migrated: false };
    throw error;
  }

  const rows = (data ?? []) as unknown as DeliverableEmail[];
  summary.claimed = rows.length;
  if (!rows.length) return summary;

  // One sender with five parked emails is one transport lookup, not five.
  const base: ResolveFn =
    opts.resolve ??
    (async (senderId, locationId) => {
      const { resolveEmailTransport } = await import("./email-transport.server");
      return resolveEmailTransport(senderId, { locationId });
    });
  const cache = new Map<string, Promise<TransportResolution>>();
  const resolve: ResolveFn = (senderId, locationId) => {
    const key = `${senderId ?? ""}|${locationId ?? ""}`;
    let hit = cache.get(key);
    if (!hit) {
      hit = base(senderId, locationId);
      cache.set(key, hit);
    }
    return hit;
  };

  const deliver =
    opts.deliver ??
    (async (row: DeliverableEmail, r: ResolveFn) => {
      const { deliverEmailMessage } = await import("./email-delivery.server");
      return deliverEmailMessage(admin, row, { resolve: r, admin });
    });

  for (const row of rows) {
    try {
      const outcome = await deliver(row, resolve);
      if (outcome.queued) summary.waiting += 1;
      else summary.sent += 1;
    } catch {
      // The seam wrote 'failed' and the provider's words on the row.
      summary.failed += 1;
    }
  }
  return summary;
}

type ResolveFn = (
  senderId: string | null,
  locationId: string | null,
) => Promise<TransportResolution>;

/* ------------------------------------------------------------------ */
/* The admin notice                                                    */
/* ------------------------------------------------------------------ */

export const UNSENT_ALERT_TITLE = "Emails are waiting to send";
/** One unread notice per admin per day — the graph-sync rule (#349). */
const ALERT_QUIET_MS = 24 * 3_600_000;
/** Younger than this is an email still on its way, not a pile-up. */
const PILE_UP_AFTER_MS = 30 * 60_000;

type ParkedRow = { id: string; created_at: string; delivery_reason: string | null };

/** The notice's sentence. Pure, so the wording is tested without a database. */
export function unsentNoticeBody(rows: ParkedRow[], now: Date): string | null {
  if (!rows.length) return null;
  const tooOld = rows.filter((r) => isTooOldToAutoSend(r.created_at, now));
  const live = rows.filter((r) => !isTooOldToAutoSend(r.created_at, now));
  const count = (reason: string) => live.filter((r) => r.delivery_reason === reason).length;
  const parts = [
    [count("sender_not_connected"), "waiting for the sender to connect Outlook"],
    [count("needs_reconnect"), "waiting for the sender to reconnect Outlook"],
    [count("no_transport"), "with no email service to carry them"],
    [count("sender_inactive"), "from a deactivated account"],
    [count("transport_error"), "refused by the mail service for now (retrying)"],
    [tooOld.length, `older than ${EMAIL_AUTO_SEND_MAX_AGE_DAYS} days — resend or cancel by hand`],
  ]
    .filter(([n]) => (n as number) > 0)
    .map(([n, what]) => `${n} ${what}`);
  const oldest = rows.reduce((a, b) => (a.created_at < b.created_at ? a : b));
  const total = rows.length;
  return `${total} email${total === 1 ? "" : "s"} people sent from Recovery Hub ${
    total === 1 ? "hasn't" : "haven't"
  } gone out: ${parts.join("; ")}. Oldest sent ${new Date(oldest.created_at).toISOString().slice(0, 10)}.`;
}

/**
 * Tell owners/admins/devs when sent email is stuck — once a day each, while it
 * lasts. Never throws: a notice that cannot be written must not stop sends.
 */
export async function notifyUnsentEmailPileUp(
  admin: Db,
  now: Date = new Date(),
): Promise<{ notified: number; stuck: number }> {
  try {
    const { data, error } = await (
      admin as unknown as import("@supabase/supabase-js").SupabaseClient
    )
      .from("email_messages")
      .select("id, created_at, delivery_reason")
      .eq("status", "queued")
      .is("sent_at", null)
      .not("delivery_reason", "is", null)
      .lt("created_at", new Date(now.getTime() - PILE_UP_AFTER_MS).toISOString())
      .order("created_at", { ascending: true })
      .limit(200);
    if (error) return { notified: 0, stuck: 0 };
    const rows = (data ?? []) as ParkedRow[];
    const body = unsentNoticeBody(rows, now);
    if (!body) return { notified: 0, stuck: 0 };

    const { data: admins } = await admin
      .from("user_roles")
      .select("user_id")
      .in("role", ["owner", "admin", "dev"]);
    const adminIds = [...new Set((admins ?? []).map((a) => a.user_id))];
    if (!adminIds.length) return { notified: 0, stuck: rows.length };

    const { data: recent } = await admin
      .from("notifications")
      .select("user_id")
      .eq("type", "integration_disconnected")
      .eq("title", UNSENT_ALERT_TITLE)
      .is("read_at", null)
      .gte("created_at", new Date(now.getTime() - ALERT_QUIET_MS).toISOString())
      .in("user_id", adminIds);
    const alerted = new Set((recent ?? []).map((n) => n.user_id));
    const due = adminIds.filter((id) => !alerted.has(id));
    if (due.length) {
      await admin.from("notifications").insert(
        due.map((user_id) => ({
          user_id,
          type: "integration_disconnected" as const,
          priority: "high" as const,
          title: UNSENT_ALERT_TITLE,
          body: body.slice(0, 600),
          href: "/admin/integrations",
        })),
      );
    }
    return { notified: due.length, stuck: rows.length };
  } catch {
    return { notified: 0, stuck: 0 };
  }
}
