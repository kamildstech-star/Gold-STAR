/**
 * Microsoft Graph ingestion — server only.
 *
 * Rules that are not negotiable and are enforced here, not by convention:
 *
 *  1. **Only messages matching a known contact are ingested.** A rep's
 *     personal correspondence, HR mail and internal chatter never land in the
 *     CRM. Matching is on sender/recipient addresses against `contacts`.
 *  2. **Outbound alone is not a touchpoint.** Every send is recorded, but it
 *     does not satisfy cadence until a genuine reply arrives in the same
 *     conversation. Out-of-office and bounces do not count.
 *  3. Whether a meeting happened is derived from calendar state and attendee
 *     responses — never from a rep ticking a box.
 *  4. **Every Graph call acts as the mailbox's holder** (graph-auth.server.ts).
 *     In delegated mode a mailbox whose person has not connected, needs to
 *     reconnect, or (for a shared office mailbox) has no usable owner is
 *     SKIPPED and reported — the run carries on with everyone else, and
 *     nobody else's token is ever borrowed to fill the gap.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database } from "@/integrations/supabase/types";
import { looksAutomated } from "@/lib/auto-reply";

import { resolveMailboxAuth, type MailboxAuth } from "@/lib/graph-auth.server";
import {
  createSubscription,
  deleteSubscription,
  drainDelta,
  eventsDeltaStart,
  getMessage,
  getMessageBody,
  graphConfigured,
  lookupGraphUser,
  messagesDeltaStart,
  renewSubscription,
  type GraphAuth,
  type GraphEvent,
  type GraphMessage,
  type GraphRecipient,
  usableEventsDeltaLink,
} from "@/lib/graph.server";
import { outlookAuthMode } from "@/lib/microsoft-oauth";
import { isMissingSchema } from "@/lib/schema-fallback";

export type Mailbox = {
  id: string;
  upn: string;
  graph_user_id: string | null;
  kind: string;
  location_id: string | null;
  user_id: string | null;
  enabled: boolean;
  sync_mail: boolean;
  sync_calendar: boolean;
  messages_delta_link: string | null;
  events_delta_link: string | null;
  messages_subscription_id: string | null;
  messages_subscription_expires_at: string | null;
  events_subscription_id: string | null;
  events_subscription_expires_at: string | null;
  /** Shared office mailboxes: whose delegated token reads them. */
  owner_user_id?: string | null;
};

const BASE_MAILBOX_COLUMNS =
  "id, upn, graph_user_id, kind, location_id, user_id, enabled, sync_mail, sync_calendar, messages_delta_link, events_delta_link, messages_subscription_id, messages_subscription_expires_at, events_subscription_id, events_subscription_expires_at";
/** Added by 20261007210000; read with a fallback until it is applied. */
const MAILBOX_COLUMNS = `${BASE_MAILBOX_COLUMNS}, owner_user_id`;

export async function listMailboxRows(): Promise<Mailbox[]> {
  const read = (columns: string) =>
    supabaseAdmin.from("graph_mailboxes").select(columns).order("kind").order("upn");
  const full = await read(MAILBOX_COLUMNS);
  if (!full.error) return (full.data ?? []) as unknown as Mailbox[];
  if (!isMissingSchema(full.error)) throw full.error;
  const base = await read(BASE_MAILBOX_COLUMNS);
  if (base.error) throw base.error;
  return (base.data ?? []) as unknown as Mailbox[];
}

/** One mailbox row by a column, with the same not-yet-migrated fallback. */
async function mailboxBy(column: string, value: string): Promise<Mailbox | null> {
  const read = (columns: string) =>
    supabaseAdmin.from("graph_mailboxes").select(columns).eq(column, value).maybeSingle();
  const full = await read(MAILBOX_COLUMNS);
  if (!full.error) return (full.data as unknown as Mailbox | null) ?? null;
  if (!isMissingSchema(full.error)) throw full.error;
  const base = await read(BASE_MAILBOX_COLUMNS);
  return (base.data as unknown as Mailbox | null) ?? null;
}

/* ------------------------------------------------------------------ */
/* Contact matching                                                    */
/* ------------------------------------------------------------------ */

export type ContactMatch = { contact_id: string; account_id: string | null };

let contactIndexCache: { at: number; map: Map<string, ContactMatch> } | null = null;

export async function contactIndex(force = false): Promise<Map<string, ContactMatch>> {
  if (!force && contactIndexCache && Date.now() - contactIndexCache.at < 60_000) {
    return contactIndexCache.map;
  }
  const map = new Map<string, ContactMatch>();
  const pageSize = 1000;
  for (let page = 0; page < 20; page += 1) {
    const { data, error } = await supabaseAdmin
      .from("contacts")
      .select("id, account_id, email")
      .not("email", "is", null)
      .range(page * pageSize, page * pageSize + pageSize - 1);
    if (error) throw error;
    for (const row of data ?? []) {
      const email = (row.email ?? "").trim().toLowerCase();
      if (email) map.set(email, { contact_id: row.id, account_id: row.account_id ?? null });
    }
    if (!data || data.length < pageSize) break;
  }
  contactIndexCache = { at: Date.now(), map };
  return map;
}

function addressOf(r: GraphRecipient | undefined): string | null {
  const a = r?.emailAddress?.address;
  return a ? a.trim().toLowerCase() : null;
}

function messageAddresses(msg: GraphMessage): {
  from: string | null;
  recipients: string[];
} {
  const from = addressOf(msg.from) ?? addressOf(msg.sender);
  const recipients = [...(msg.toRecipients ?? []), ...(msg.ccRecipients ?? [])]
    .map(addressOf)
    .filter((a): a is string => Boolean(a));
  return { from, recipients };
}

/* ------------------------------------------------------------------ */
/* Auto-reply detection                                                */
/* ------------------------------------------------------------------ */

// One rule for the sync and the gateway hook — src/lib/auto-reply.ts.
export { looksAutomated };

async function fetchHeaders(
  upn: string,
  messageId: string,
  auth: GraphAuth,
): Promise<{ name: string; value: string }[] | null> {
  try {
    const full = await getMessage(upn, messageId, auth);
    return full.internetMessageHeaders ?? null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Message ingestion                                                   */
/* ------------------------------------------------------------------ */

export type IngestStats = {
  seen: number;
  ingested: number;
  skipped_unknown: number;
  replies: number;
  /** Replies to an info request read into suggested job fields (info-reply.server.ts). */
  info_replies?: number;
  errors: string[];
};

/**
 * An answer to one of our info requests is read into suggested job fields
 * before the contact rule below is applied: the person was emailed from the
 * job for exactly this, so they are not "unknown" correspondence even when
 * they are not a CRM contact. Only what the reply says about the job is kept
 * (on intake_submissions) — the message itself is not stored for them.
 *
 * Loaded lazily: the extraction code and the model client stay off the path
 * of a sync that never meets an info reply. A failure is reported in the
 * run's errors and never stops the message's ordinary ingestion.
 */
async function captureInfoReplyQuietly(
  mailbox: Mailbox,
  msg: GraphMessage,
  from: string,
  auth: GraphAuth,
  stats: IngestStats,
  ai: {
    extractor?: Awaited<ReturnType<typeof import("@/lib/info-reply.server").aiReplyExtractor>>;
  },
): Promise<void> {
  try {
    const mod = await import("@/lib/info-reply.server");
    if (ai.extractor === undefined) {
      ai.extractor = await mod.aiReplyExtractor().catch(() => null);
    }
    const outcome = await mod.captureInfoReply(
      {
        messageId: msg.id,
        from,
        fromName: msg.from?.emailAddress?.name ?? null,
        subject: msg.subject ?? null,
        receivedAt: msg.receivedDateTime ?? null,
      },
      {
        db: supabaseAdmin as unknown as Parameters<typeof mod.captureInfoReply>[1]["db"],
        fetchBody: () => getMessageBody(mailbox.upn, msg.id, auth),
        isAutomated: async () =>
          looksAutomated({ subject: msg.subject, from }) ||
          looksAutomated({ headers: await fetchHeaders(mailbox.upn, msg.id, auth) }),
        aiExtract: ai.extractor,
      },
    );
    if (outcome === "suggested" || outcome === "review_task") {
      stats.info_replies = (stats.info_replies ?? 0) + 1;
    }
  } catch (e) {
    stats.errors.push(`${msg.id}: info reply: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function ingestMessages(
  mailbox: Mailbox,
  messages: GraphMessage[],
  auth: GraphAuth,
): Promise<IngestStats> {
  const stats: IngestStats = {
    seen: messages.length,
    ingested: 0,
    skipped_unknown: 0,
    replies: 0,
    errors: [],
  };
  if (messages.length === 0) return stats;

  const index = await contactIndex();
  const mailboxAddress = mailbox.upn.toLowerCase();
  const ai: Parameters<typeof captureInfoReplyQuietly>[5] = {};

  for (const msg of messages) {
    if (msg["@removed"] || msg.isDraft) continue;

    const { from, recipients } = messageAddresses(msg);
    const outbound = from === mailboxAddress;
    const counterparties = outbound ? recipients : [from, ...recipients].filter(Boolean);

    if (!outbound && from) await captureInfoReplyQuietly(mailbox, msg, from, auth, stats, ai);

    // Rule 1: no known contact, no ingestion. The mailbox stays private.
    let match: ContactMatch | undefined;
    for (const address of counterparties) {
      if (!address || address === mailboxAddress) continue;
      const hit = index.get(address);
      if (hit) {
        match = hit;
        break;
      }
    }
    if (!match) {
      stats.skipped_unknown += 1;
      continue;
    }

    const occurredAt =
      (outbound ? msg.sentDateTime : msg.receivedDateTime) ??
      msg.receivedDateTime ??
      msg.sentDateTime ??
      new Date().toISOString();

    let auto = false;
    if (!outbound) {
      const quickAuto = looksAutomated({ subject: msg.subject, from });
      auto =
        quickAuto || looksAutomated({ headers: await fetchHeaders(mailbox.upn, msg.id, auth) });
    }

    const { data: comm, error: commError } = await supabaseAdmin
      .from("captured_communications")
      .upsert(
        {
          provider: "outlook",
          external_id: msg.id,
          channel: "email",
          direction: outbound ? "outbound" : "inbound",
          occurred_at: occurredAt,
          from_address: from,
          to_address: recipients[0] ?? null,
          subject: msg.subject ?? null,
          body_preview: (msg.bodyPreview ?? "").slice(0, 800) || null,
          conversation_id: msg.conversationId ?? null,
          internet_message_id: msg.internetMessageId ?? null,
          mailbox_id: mailbox.id,
          is_auto_reply: auto,
          web_link: msg.webLink ?? null,
          account_id: match.account_id,
          contact_id: match.contact_id,
          user_id: mailbox.user_id,
          raw: {},
        },
        { onConflict: "provider,external_id" },
      )
      .select("id")
      .single();

    if (commError) {
      stats.errors.push(`${msg.id}: ${commError.message}`);
      continue;
    }
    stats.ingested += 1;

    if (!match.account_id) continue;

    // Every message is recorded as a touchpoint, but outbound does not satisfy
    // cadence — the DB trigger only counts an email once replied_at is set.
    const { data: touch } = await supabaseAdmin
      .from("touchpoints")
      .upsert(
        {
          account_id: match.account_id,
          contact_id: match.contact_id,
          type: "email",
          occurred_at: occurredAt,
          capture_source: "mailbox",
          direction: outbound ? "outbound" : "inbound",
          notes: msg.subject ?? null,
          external_ref: msg.id,
          created_by: mailbox.user_id,
          // An out-of-office is not the client answering: the cadence trigger
          // refuses it, and so does the pipeline's reply check.
          is_auto_reply: auto,
          ...(outbound || auto ? {} : { replied_at: occurredAt }),
        },
        // external_ref is the Graph message id — the only stable key a re-sync
        // can collide on. Conflicting on "id" (never supplied) matched nothing,
        // so every sweep re-inserted the same email.
        { onConflict: "external_ref" },
      )
      .select("id")
      .maybeSingle();

    if (touch?.id) {
      await supabaseAdmin
        .from("captured_communications")
        .update({ touchpoint_id: touch.id })
        .eq("id", comm.id);
    }

    if (!outbound && !auto && msg.conversationId) {
      stats.replies += await applyReply(match.account_id, msg.conversationId, occurredAt);
    }
  }

  return stats;
}

/**
 * A reply is an inbound message in the same conversation from the contact —
 * not an auto-reply. When one lands, the earlier outbound touchpoints in that
 * thread become cadence-satisfying and the account's health is recomputed.
 */
export async function applyReply(
  accountId: string,
  conversationId: string,
  repliedAt: string,
): Promise<number> {
  const { data: thread } = await supabaseAdmin
    .from("captured_communications")
    .select("external_id, direction")
    .eq("conversation_id", conversationId)
    .eq("direction", "outbound");

  const ids = (thread ?? []).map((t) => t.external_id);
  if (ids.length === 0) return 0;

  const { data: updated } = await supabaseAdmin
    .from("touchpoints")
    .update({ replied_at: repliedAt, counts_toward_cadence: true })
    .in("external_ref", ids)
    .is("replied_at", null)
    .select("id");

  await recomputeHealth(accountId);
  return updated?.length ?? 0;
}

const HEALTH_PIPELINE = "33333333-3333-4333-8333-333333333333";
const HEALTHY_STAGE = "ea0e45c6-2e00-4d6d-a098-2513c76c9ab5";

/** A genuine reply pulls an account out of Needs Attention / Ghosted. */
export async function recomputeHealth(accountId: string): Promise<void> {
  const { data: account } = await supabaseAdmin
    .from("accounts")
    .select("id, health_pipeline_id, health_stage_id")
    .eq("id", accountId)
    .maybeSingle();
  if (!account) return;
  if (account.health_pipeline_id && account.health_pipeline_id !== HEALTH_PIPELINE) return;
  if (account.health_stage_id === HEALTHY_STAGE) return;

  await supabaseAdmin
    .from("accounts")
    .update({
      health_pipeline_id: HEALTH_PIPELINE,
      health_stage_id: HEALTHY_STAGE,
      health_changed_at: new Date().toISOString(),
    })
    .eq("id", accountId);
}

/* ------------------------------------------------------------------ */
/* Calendar ingestion                                                  */
/* ------------------------------------------------------------------ */

export async function ingestEvents(
  mailbox: Mailbox,
  events: GraphEvent[],
): Promise<{ seen: number; ingested: number; held: number }> {
  const stats = { seen: events.length, ingested: 0, held: 0 };
  if (events.length === 0) return stats;

  const index = await contactIndex();
  const mailboxAddress = mailbox.upn.toLowerCase();

  for (const ev of events) {
    if (ev["@removed"]) {
      await supabaseAdmin
        .from("calendar_events")
        .update({ is_cancelled: true, meeting_held: false })
        .eq("provider", "outlook")
        .eq("external_id", ev.id);
      continue;
    }

    const attendees = ev.attendees ?? [];
    const addresses = attendees.map(addressOf).filter((a): a is string => Boolean(a));
    let match: ContactMatch | undefined;
    for (const address of addresses) {
      if (address === mailboxAddress) continue;
      const hit = index.get(address);
      if (hit) {
        match = hit;
        break;
      }
    }
    if (!match) continue;

    const accepted = attendees.filter((a) => a.status?.response === "accepted").length;
    const declined = attendees.filter((a) => a.status?.response === "declined").length;
    const startsAt = ev.start?.dateTime ? new Date(`${ev.start.dateTime}Z`).toISOString() : null;
    const endsAt = ev.end?.dateTime ? new Date(`${ev.end.dateTime}Z`).toISOString() : null;

    // Derived from calendar state, never from a rep marking it done.
    const held =
      !ev.isCancelled && endsAt != null && new Date(endsAt) < new Date() && declined === 0;

    const { data: row, error } = await supabaseAdmin
      .from("calendar_events")
      .upsert(
        {
          provider: "outlook",
          external_id: ev.id,
          mailbox_id: mailbox.id,
          user_id: mailbox.user_id,
          account_id: match.account_id,
          contact_id: match.contact_id,
          subject: ev.subject ?? null,
          body_preview: (ev.bodyPreview ?? "").slice(0, 500) || null,
          location_text: ev.location?.displayName ?? null,
          starts_at: startsAt,
          ends_at: endsAt,
          attendees: attendees.map((a) => ({
            email: addressOf(a),
            name: a.emailAddress?.name ?? null,
            response: a.status?.response ?? null,
          })),
          organizer_email: addressOf(ev.organizer),
          response_status: ev.responseStatus?.response ?? null,
          is_cancelled: Boolean(ev.isCancelled),
          is_all_day: Boolean(ev.isAllDay),
          accepted_count: accepted,
          declined_count: declined,
          meeting_held: held,
          web_link: ev.webLink ?? null,
          series_master_id: ev.seriesMasterId ?? null,
          last_modified_at: ev.lastModifiedDateTime ?? null,
          // We just read this id out of this mailbox, so the pair above is the
          // server's word — what calendar_push_authorized_event asks for. Who
          // may push an edit (push_actor_id) is left to whoever makes one.
          push_identity_verified: true,
        },
        { onConflict: "provider,external_id" },
      )
      .select("id, touchpoint_id")
      .single();

    if (error) continue;
    stats.ingested += 1;

    if (!held || !match.account_id) continue;
    stats.held += 1;

    const inPerson = !/teams|zoom|call|virtual/i.test(
      `${ev.subject ?? ""} ${ev.location?.displayName ?? ""}`,
    );

    if (!row.touchpoint_id) {
      // The link can be missing because the event is new or because a dedupe
      // dropped the copy it pointed at; upserting re-attaches to the survivor
      // instead of tripping the external_ref unique index.
      const { data: tp } = await supabaseAdmin
        .from("touchpoints")
        .upsert(
          {
            account_id: match.account_id,
            contact_id: match.contact_id,
            type: inPerson ? "meeting_in_person" : "meeting_virtual",
            occurred_at: startsAt ?? new Date().toISOString(),
            capture_source: "calendar",
            direction: "not_applicable",
            notes: ev.subject ?? null,
            external_ref: ev.id,
            meeting_held: true,
            created_by: mailbox.user_id,
          },
          { onConflict: "external_ref" },
        )
        .select("id")
        .single();
      if (tp?.id) {
        await supabaseAdmin
          .from("calendar_events")
          .update({ touchpoint_id: tp.id })
          .eq("id", row.id);
      }
    }

    if (inPerson) {
      await supabaseAdmin
        .from("accounts")
        .update({
          last_in_person_at: startsAt,
          annual_meeting_due_on: startsAt
            ? new Date(new Date(startsAt).getTime() + 365 * 86_400_000).toISOString().slice(0, 10)
            : null,
          annual_meeting_missed_at: null,
        })
        .eq("id", match.account_id);
      await recomputeHealth(match.account_id);
    }
  }

  return stats;
}

/* ------------------------------------------------------------------ */
/* Delta reconciliation + subscriptions                                */
/* ------------------------------------------------------------------ */

type MailboxPatch = Database["public"]["Tables"]["graph_mailboxes"]["Update"];

/**
 * A mailbox with no usable token in delegated mode. Not an error in the
 * mailbox's own state (last_error stays for Graph's own complaints) — it is
 * reported by the run and on the admin screen as "not connected" / "needs an
 * owner", which is a person to chase rather than a fault to fix.
 */
export type SkippedMailbox = { upn: string; problem: string; message: string };

function skipped(mailbox: Mailbox, resolved: Extract<MailboxAuth, { ok: false }>): SkippedMailbox {
  return { upn: mailbox.upn, problem: resolved.problem, message: resolved.message };
}

export async function syncMailbox(mailbox: Mailbox): Promise<{
  upn: string;
  mail: IngestStats | null;
  calendar: { seen: number; ingested: number; held: number } | null;
  error: string | null;
  skipped?: SkippedMailbox;
}> {
  let mail: IngestStats | null = null;
  let calendar: { seen: number; ingested: number; held: number } | null = null;

  const resolved = await resolveMailboxAuth(mailbox);
  if (!resolved.ok) {
    return { upn: mailbox.upn, mail, calendar, error: null, skipped: skipped(mailbox, resolved) };
  }
  const auth = resolved.auth;
  const patch: MailboxPatch = { last_delta_sync_at: new Date().toISOString() };
  const failures: string[] = [];

  // Mail and calendar are separate delta chains and fail separately: a
  // calendar fault (e.g. Graph refusing a query option) must never stop the
  // mail feed, and vice versa. Each failure is named in last_error, and only
  // the failing chain's deltaLink is reset.
  if (mailbox.sync_mail) {
    try {
      const start = mailbox.messages_delta_link ?? messagesDeltaStart(mailbox.upn);
      const { items, deltaLink } = await drainDelta<GraphMessage>(start, auth);
      mail = await ingestMessages(mailbox, items, auth);
      if (deltaLink) patch.messages_delta_link = deltaLink;
      if (items.length > 0) patch.last_message_at = new Date().toISOString();
    } catch (e) {
      const message = (e as Error).message;
      failures.push(`Mail: ${message}`);
      if (isUnusableDeltaLink(message)) patch.messages_delta_link = null;
    }
  }
  if (mailbox.sync_calendar) {
    try {
      const start =
        usableEventsDeltaLink(mailbox.events_delta_link) ?? eventsDeltaStart(mailbox.upn);
      const { items, deltaLink } = await drainDelta<GraphEvent>(start, auth);
      calendar = await ingestEvents(mailbox, items);
      if (deltaLink) patch.events_delta_link = deltaLink;
    } catch (e) {
      const message = (e as Error).message;
      failures.push(`Calendar: ${message}`);
      if (isUnusableDeltaLink(message)) patch.events_delta_link = null;
    }
  }

  const error = failures.length > 0 ? failures.join(" | ") : null;
  patch.last_error = error;
  await supabaseAdmin.from("graph_mailboxes").update(patch).eq("id", mailbox.id);
  return { upn: mailbox.upn, mail, calendar, error };
}

/**
 * A failure that a stored deltaLink could be the cause of: expired/unknown
 * sync state (410, resync, SyncStateNotFound) or a query Graph refuses
 * (ErrorInvalidUrlQuery). Dropping the link makes the next run start a fresh
 * round from a URL we build, instead of replaying the bad one forever.
 */
function isUnusableDeltaLink(message: string): boolean {
  return /\[410\]|resync|deltaLink|SyncStateNotFound|ErrorInvalidUrlQuery/i.test(message);
}

const RENEW_WINDOW_MS = 12 * 3_600_000;

/**
 * Mail subscriptions expire in about three days, so renewal runs daily and a
 * failure is written to the mailbox row — a silently dead feed is the worst
 * outcome, so it has to be visible.
 */
export async function ensureSubscriptions(mailbox: Mailbox): Promise<{
  upn: string;
  messages: string | null;
  events: string | null;
  error: string | null;
  skipped?: SkippedMailbox;
}> {
  const clientState = process.env["OUTLOOK_WEBHOOK_CLIENT_STATE"];
  if (!clientState) {
    return {
      upn: mailbox.upn,
      messages: null,
      events: null,
      error: "OUTLOOK_WEBHOOK_CLIENT_STATE is not set",
    };
  }

  // A subscription lives under the token that created it, so it is renewed,
  // replaced and deleted with the same holder's token.
  const resolved = await resolveMailboxAuth(mailbox);
  if (!resolved.ok) {
    return {
      upn: mailbox.upn,
      messages: null,
      events: null,
      error: null,
      skipped: skipped(mailbox, resolved),
    };
  }
  const auth = resolved.auth;

  const patch: MailboxPatch = {};
  let error: string | null = null;

  const work = async (
    kind: "messages" | "events",
    enabled: boolean,
    subId: string | null,
    expiresAt: string | null,
  ) => {
    if (!enabled) return;
    const resource =
      kind === "messages" ? `/users/${mailbox.upn}/messages` : `/users/${mailbox.upn}/events`;
    const expiring = !expiresAt || new Date(expiresAt).getTime() - Date.now() < RENEW_WINDOW_MS;

    if (subId && expiring) {
      try {
        const renewed = await renewSubscription(subId, auth);
        if (kind === "messages")
          patch.messages_subscription_expires_at = renewed.expirationDateTime;
        else patch.events_subscription_expires_at = renewed.expirationDateTime;
        return;
      } catch {
        // Renewal failed (often because it already lapsed) — recreate below.
        try {
          await deleteSubscription(subId, auth);
        } catch {
          /* already gone */
        }
      }
    } else if (subId) {
      return;
    }

    const created = await createSubscription({ resource, clientState }, auth);
    if (kind === "messages") {
      patch.messages_subscription_id = created.id;
      patch.messages_subscription_expires_at = created.expirationDateTime;
    } else {
      patch.events_subscription_id = created.id;
      patch.events_subscription_expires_at = created.expirationDateTime;
    }
  };

  try {
    await work(
      "messages",
      mailbox.sync_mail,
      mailbox.messages_subscription_id,
      mailbox.messages_subscription_expires_at,
    );
    await work(
      "events",
      mailbox.sync_calendar,
      mailbox.events_subscription_id,
      mailbox.events_subscription_expires_at,
    );
    patch.last_error = null;
  } catch (e) {
    error = (e as Error).message;
    patch.last_error = error;
  }

  if (Object.keys(patch).length > 0) {
    await supabaseAdmin.from("graph_mailboxes").update(patch).eq("id", mailbox.id);
  }

  return {
    upn: mailbox.upn,
    messages: patch.messages_subscription_expires_at ?? null,
    events: patch.events_subscription_expires_at ?? null,
    error,
  };
}

/**
 * Resolve the Graph object id / display name once so we can show it.
 *
 * Application mode asks the directory (`User.Read.All`). Delegated mode has
 * no directory read at all — it takes the id and name from the person's own
 * connection, which `/me` confirmed when they signed in, and only when that
 * connection is for this very address. A shared mailbox keeps the name it
 * was given.
 */
export async function refreshMailboxIdentity(mailbox: Mailbox): Promise<void> {
  if (!graphConfigured() || mailbox.graph_user_id) return;
  if (outlookAuthMode() === "delegated") {
    if (mailbox.kind === "shared_office" || !mailbox.user_id) return;
    try {
      const { supabaseConnectionStore } = await import("@/lib/microsoft-delegated.server");
      const connection = await supabaseConnectionStore.get(mailbox.user_id);
      if (connection && connection.upn.toLowerCase() === mailbox.upn.toLowerCase()) {
        await supabaseAdmin
          .from("graph_mailboxes")
          .update({ graph_user_id: connection.ms_user_id, display_name: connection.display_name })
          .eq("id", mailbox.id);
      }
    } catch {
      /* identity refresh is best-effort */
    }
    return;
  }
  try {
    const user = await lookupGraphUser(mailbox.upn);
    if (user) {
      await supabaseAdmin
        .from("graph_mailboxes")
        .update({ graph_user_id: user.id, display_name: user.displayName })
        .eq("id", mailbox.id);
    } else {
      await supabaseAdmin
        .from("graph_mailboxes")
        .update({ last_error: "Mailbox not found in the tenant directory." })
        .eq("id", mailbox.id);
    }
  } catch {
    /* identity refresh is best-effort */
  }
}

/** Handle a single change notification by fetching just that resource. */
export async function processNotification(input: {
  subscriptionId?: string;
  resource?: string;
  resourceId?: string;
  changeType?: string;
}): Promise<void> {
  if (!graphConfigured()) return;
  const resourceId = input.resourceId;
  if (typeof resourceId !== "string" || !resourceId || !input.subscriptionId) return;

  const isEvent = /\/events/i.test(input.resource ?? "");
  const column = isEvent ? "events_subscription_id" : "messages_subscription_id";

  const mailbox = await mailboxBy(column, input.subscriptionId ?? "");
  if (!mailbox) return;
  if (!mailbox.enabled || (isEvent ? !mailbox.sync_calendar : !mailbox.sync_mail)) return;
  const expiresAt = isEvent
    ? mailbox.events_subscription_expires_at
    : mailbox.messages_subscription_expires_at;
  // A delayed/replayed notification is not authority to keep using a retired
  // subscription. Delta reconciliation recovers changes missed at expiry.
  if (!expiresAt || !(Date.parse(expiresAt) > Date.now())) return;

  // The holder may have disconnected since the subscription was made; delta
  // picks up whatever this skips once somebody connects again.
  const resolved = await resolveMailboxAuth(mailbox);
  if (!resolved.ok) return;

  if (isEvent) {
    const { getEvent } = await import("@/lib/graph.server");
    const ev = await getEvent(mailbox.upn, resourceId, resolved.auth);
    await ingestEvents(mailbox, [ev]);
  } else {
    const msg = await getMessage(mailbox.upn, resourceId, resolved.auth);
    await ingestMessages(mailbox, [msg], resolved.auth);
  }
}
