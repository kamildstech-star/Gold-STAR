import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";
import type { ConnectionRow, ConnectionStore } from "@/lib/microsoft-delegated.server";

/**
 * Microsoft 365 / Graph control surface.
 *
 * Administration (mailbox registry, subscriptions, manual reconciliation) is
 * restricted to owner/admin/dev. Sending and meeting creation are available to
 * any authenticated staff member, but only *as a mailbox they hold*: their own
 * personal mailbox, an office mailbox for a location they manage, or — for an
 * M365 admin — any mailbox. The registry itself is read through the caller's
 * own RLS-scoped client so it is never handed out wholesale.
 *
 * **The AI never drafts or sends outbound.** `sendGraphEmail` requires an
 * explicit human-authorship assertion and the AI modules do not import it —
 * enforced in the code path, not by convention.
 *
 * In delegated mode (`OUTLOOK_AUTH_MODE`, the default) a send or a booking
 * goes out on the CALLER's own Microsoft token, after `assertCanSendAs` has
 * already said yes — so the app's rule and Microsoft's rights both have to
 * agree. Reading a body uses the mailbox holder's token. Both are decided in
 * graph-auth.server.ts.
 */

/**
 * The Outlook values an admin typed on the Integrations screen, copied over
 * process.env before a handler reads OUTLOOK_* (loadOutlookEnv). Called after
 * the caller's own checks, so a refused caller never causes the read.
 */
async function outlookEnv(): Promise<void> {
  const { loadOutlookEnv } = await import("@/lib/microsoft-delegated.server");
  await loadOutlookEnv();
}

type CallerContext = {
  supabase: SupabaseClient<Database>;
  userId: string;
};

async function isGraphAdmin(
  supabase: { rpc: (...args: never[]) => unknown },
  userId: string,
): Promise<boolean> {
  // Call through the client so `this` stays bound — a detached `rpc` reference
  // throws "Cannot read properties of undefined (reading 'rest')".
  const client = supabase as unknown as {
    rpc: (
      fn: "has_role",
      args: { _user_id: string; _role: "owner" | "admin" | "dev" },
    ) => Promise<{ data: unknown }>;
  };
  for (const role of ["owner", "admin", "dev"] as const) {
    const { data } = await client.rpc("has_role", { _user_id: userId, _role: role });
    if (data === true) return true;
  }
  return false;
}

async function assertGraphAdmin(supabase: { rpc: (...args: never[]) => unknown }, userId: string) {
  if (await isGraphAdmin(supabase, userId)) return;
  throw new Error("Only an owner, admin or developer can manage the Microsoft 365 connection.");
}

/**
 * Who may send — or book a meeting — as a given mailbox.
 *
 * The mailbox row is looked up with the service-role client (the registry is
 * not readable by every caller), so this check is the *only* thing standing
 * between a caller and someone else's From: address. It must never be
 * conditional on an optional input field.
 */
export async function assertCanSendAs(
  context: CallerContext,
  mailbox: { upn: string; user_id: string | null; location_id: string | null },
) {
  // The person the mailbox belongs to.
  if (mailbox.user_id && mailbox.user_id === context.userId) return;

  // A shared office mailbox, sent by someone who manages that office.
  if (!mailbox.user_id && mailbox.location_id) {
    const { data } = await context.supabase.rpc("can_manage_location", {
      _user_id: context.userId,
      _location_id: mailbox.location_id,
    });
    if (data === true) return;
  }

  // Owner / admin / dev may act as any connected mailbox.
  if (await isGraphAdmin(context.supabase, context.userId)) return;

  throw new Error(
    `You cannot send as ${mailbox.upn}. Use your own mailbox, or an office mailbox for a location you manage.`,
  );
}

/** Validate related records before a service-role write or outbound send. */
export async function assertGraphContact(
  context: CallerContext,
  contactId?: string | null,
  accountId?: string | null,
) {
  if (!contactId) return;
  const { data, error } = await context.supabase
    .from("contacts")
    .select("id, account_id")
    .eq("id", contactId)
    .maybeSingle();
  if (error || !data || (accountId && data.account_id !== accountId)) {
    throw new Error("Contact not visible or does not belong to that account.");
  }
}

export type MailboxStatus = {
  id: string;
  upn: string;
  display_name: string | null;
  kind: string;
  location_id: string | null;
  user_id: string | null;
  enabled: boolean;
  sync_mail: boolean;
  sync_calendar: boolean;
  messages_expires_at: string | null;
  events_expires_at: string | null;
  last_delta_sync_at: string | null;
  last_message_at: string | null;
  last_error: string | null;
  subscription_health: "ok" | "expiring" | "missing" | "failed";
};

/**
 * The mailbox registry maps executives to UPNs and offices to locations, and
 * carries `last_error`. It is read through the CALLER's client so the
 * `graph mailboxes viewable by staff` policy decides what comes back — a crew
 * member sees their own mailbox, not the whole company's. The deployment
 * details (which secrets are missing, the webhook URL) are admin-only.
 */
export const graphStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await outlookEnv();
    const { graphConfigured, graphMissingSecrets, notificationUrl } =
      await import("@/lib/graph.server");
    const admin = await isGraphAdmin(context.supabase, context.userId);

    const { data, error } = await context.supabase
      .from("graph_mailboxes")
      .select(
        "id, upn, display_name, kind, location_id, user_id, enabled, sync_mail, sync_calendar, messages_subscription_id, messages_subscription_expires_at, events_subscription_id, events_subscription_expires_at, last_delta_sync_at, last_message_at, last_error",
      )
      .order("kind")
      .order("upn");
    if (error) throw new Error(error.message);

    const now = Date.now();
    const mailboxes: MailboxStatus[] = (data ?? []).map((m) => {
      const soonest = [m.messages_subscription_expires_at, m.events_subscription_expires_at]
        .filter((v): v is string => Boolean(v))
        .map((v) => new Date(v).getTime())
        .sort((a, b) => a - b)[0];
      const wanted = (m.sync_mail ? 1 : 0) + (m.sync_calendar ? 1 : 0);
      const have = (m.messages_subscription_id ? 1 : 0) + (m.events_subscription_id ? 1 : 0);
      const health: MailboxStatus["subscription_health"] = m.last_error
        ? "failed"
        : have < wanted
          ? "missing"
          : soonest && soonest - now < 12 * 3_600_000
            ? "expiring"
            : "ok";
      return {
        id: m.id,
        upn: m.upn,
        display_name: m.display_name,
        kind: m.kind,
        location_id: m.location_id,
        user_id: m.user_id,
        enabled: m.enabled,
        sync_mail: m.sync_mail,
        sync_calendar: m.sync_calendar,
        messages_expires_at: m.messages_subscription_expires_at,
        events_expires_at: m.events_subscription_expires_at,
        last_delta_sync_at: m.last_delta_sync_at,
        last_message_at: m.last_message_at,
        last_error: m.last_error,
        subscription_health: health,
      };
    });

    return {
      configured: graphConfigured(),
      missing_secrets: admin ? graphMissingSecrets() : [],
      notification_url: admin ? notificationUrl() : null,
      mailboxes,
    };
  });

export const addGraphMailbox = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (data: {
      upn: string;
      kind: "user" | "shared_office";
      locationId?: string | null;
      userId?: string | null;
      syncMail?: boolean;
      syncCalendar?: boolean;
    }) => data,
  )
  .handler(async ({ data, context }) => {
    await assertGraphAdmin(context.supabase, context.userId);
    const upn = data.upn.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(upn)) throw new Error("Enter a valid mailbox address.");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.from("graph_mailboxes").upsert(
      {
        upn,
        kind: data.kind,
        location_id: data.locationId ?? null,
        user_id: data.userId ?? null,
        sync_mail: data.syncMail ?? true,
        sync_calendar: data.syncCalendar ?? true,
        enabled: true,
      },
      { onConflict: "upn" },
    );
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/** Pulls the shared office mailboxes straight off the locations table. */
export const importOfficeMailboxes = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertGraphAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: locations, error } = await supabaseAdmin
      .from("locations")
      .select("id, code, name, office_email")
      .eq("active", true)
      .not("office_email", "is", null);
    if (error) throw new Error(error.message);

    const rows = (locations ?? [])
      .filter((l) => (l.office_email ?? "").includes("@"))
      .map((l) => ({
        upn: (l.office_email as string).trim().toLowerCase(),
        kind: "shared_office",
        location_id: l.id,
        display_name: `${l.code} · ${l.name} office`,
        enabled: true,
      }));

    if (rows.length === 0) return { added: 0 };
    const { error: upsertError } = await supabaseAdmin
      .from("graph_mailboxes")
      .upsert(rows, { onConflict: "upn" });
    if (upsertError) throw new Error(upsertError.message);
    return { added: rows.length };
  });

export const setGraphMailboxFlags = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (data: { id: string; enabled?: boolean; syncMail?: boolean; syncCalendar?: boolean }) => data,
  )
  .handler(async ({ data, context }) => {
    await assertGraphAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("graph_mailboxes")
      .update({
        ...(data.enabled === undefined ? {} : { enabled: data.enabled }),
        ...(data.syncMail === undefined ? {} : { sync_mail: data.syncMail }),
        ...(data.syncCalendar === undefined ? {} : { sync_calendar: data.syncCalendar }),
      })
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/**
 * Who reads a shared office mailbox in delegated mode. Somebody IT has given
 * Full Access to, who then connects Outlook with the shared-mailbox box
 * ticked. Null clears it, and the mailbox shows "needs an owner" until
 * somebody else is assigned. Owner/admin/dev only, like the rest of the
 * registry. Microsoft still decides whether that person's token can reach the
 * mailbox; this only says whose token to try.
 */
export const setGraphMailboxOwner = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { id: string; ownerUserId: string | null }) => data)
  .handler(async ({ data, context }) => {
    await assertGraphAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    if (data.ownerUserId) {
      const { data: profile } = await supabaseAdmin
        .from("profiles")
        .select("user_id, is_active, approval_status")
        .eq("user_id", data.ownerUserId)
        .maybeSingle();
      if (!profile || profile.is_active !== true || profile.approval_status !== "approved") {
        throw new Error("Pick an active team member as the owner.");
      }
    }
    const { error } = await (supabaseAdmin as unknown as SupabaseClient)
      .from("graph_mailboxes")
      .update({ owner_user_id: data.ownerUserId })
      .eq("id", data.id);
    if (error) {
      const { isMissingSchema } = await import("@/lib/schema-fallback");
      if (isMissingSchema(error)) {
        throw new Error("Shared-mailbox owners need the latest database update (20261007210000).");
      }
      throw new Error(error.message);
    }
    return { ok: true };
  });

export const removeGraphMailbox = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data, context }) => {
    await assertGraphAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await outlookEnv();
    const { deleteSubscription, graphConfigured } = await import("@/lib/graph.server");

    const { data: row } = await supabaseAdmin
      .from("graph_mailboxes")
      .select("messages_subscription_id, events_subscription_id")
      .eq("id", data.id)
      .maybeSingle();

    if (row && graphConfigured()) {
      // Subscriptions are deleted with the token that owns them. With nobody
      // able to speak for the mailbox they are left to expire on their own
      // (three days at most); notifications for them match no mailbox.
      const { resolveMailboxAuthById } = await import("@/lib/graph-auth.server");
      const resolved = await resolveMailboxAuthById(data.id);
      for (const id of [row.messages_subscription_id, row.events_subscription_id]) {
        if (id && resolved.ok) {
          try {
            await deleteSubscription(id, resolved.auth);
          } catch {
            /* already gone */
          }
        }
      }
    }
    const { error } = await supabaseAdmin.from("graph_mailboxes").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/** Manual delta reconciliation — the same code the nightly job runs. */
export const runGraphSync = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { mailboxId?: string | null }) => data)
  .handler(async ({ data, context }) => {
    await assertGraphAdmin(context.supabase, context.userId);
    await outlookEnv();
    const { graphConfigured, graphMissingSecrets } = await import("@/lib/graph.server");
    if (!graphConfigured()) {
      throw new Error(
        `Microsoft 365 is not configured. Missing on the Integrations screen or in Project Settings → Secrets: ${graphMissingSecrets().join(", ")}.`,
      );
    }
    const { listMailboxRows, refreshMailboxIdentity, syncMailbox } =
      await import("@/lib/graph-sync.server");
    const all = await listMailboxRows();
    const targets = all.filter((m) => m.enabled && (!data.mailboxId || m.id === data.mailboxId));
    const results = [];
    for (const mailbox of targets) {
      await refreshMailboxIdentity(mailbox);
      results.push(await syncMailbox(mailbox));
    }
    return { results };
  });

export const renewGraphSubscriptions = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertGraphAdmin(context.supabase, context.userId);
    await outlookEnv();
    const { graphConfigured } = await import("@/lib/graph.server");
    if (!graphConfigured()) throw new Error("Microsoft 365 is not configured.");
    const { ensureSubscriptions, listMailboxRows } = await import("@/lib/graph-sync.server");
    const results = [];
    for (const mailbox of (await listMailboxRows()).filter((m) => m.enabled)) {
      results.push(await ensureSubscriptions(mailbox));
    }
    return { results };
  });

/* ------------------------------------------------------------------ */
/* Sending — human-authored only                                       */
/* ------------------------------------------------------------------ */

export type GraphSendInput = {
  /** Mailbox to send from — must be a registered mailbox. */
  fromUpn: string;
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  accountId?: string | null;
  contactId?: string | null;
  replyToMessageId?: string | null;
  /**
   * Must be literally true. AI-composed client-facing text is barred by the
   * brief; the assistant code path never calls this function.
   */
  humanAuthored: true;
};

export const sendGraphEmail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: GraphSendInput) => data)
  .handler(async ({ data, context }) => {
    if (data.humanAuthored !== true) {
      throw new Error(
        "Outbound email must be human-authored. AI-composed client-facing messages are not permitted.",
      );
    }
    if (!data.to.length) throw new Error("At least one recipient is required.");
    if (!data.subject.trim()) throw new Error("Subject is required.");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { sendMailAs } = await import("@/lib/graph.server");

    const { data: mailbox } = await supabaseAdmin
      .from("graph_mailboxes")
      .select("id, upn, kind, user_id, location_id, enabled")
      .eq("upn", data.fromUpn.trim().toLowerCase())
      .maybeSingle();
    if (!mailbox || !mailbox.enabled) throw new Error("That mailbox is not connected.");

    // Unconditional: the From: address is decided here, not by whether the
    // caller happened to pass an accountId.
    await assertCanSendAs(context, mailbox);
    // Then Microsoft's half: the caller's own token (delegated mode), which
    // can only send where IT has given that person the right to.
    await outlookEnv();
    const { resolveSenderAuth } = await import("@/lib/graph-auth.server");
    const auth = await resolveSenderAuth(context.userId, mailbox);

    // The caller must be able to read the account through their own client.
    if (data.accountId) {
      const { data: account, error: accountError } = await context.supabase
        .from("accounts")
        .select("id")
        .eq("id", data.accountId)
        .maybeSingle();
      // Only a real read failure is a permissions problem; anything else must
      // report itself rather than pointing at RLS.
      if (accountError) {
        throw new Error(`Couldn't check that account — ${accountError.message}`);
      }
      if (!account) throw new Error("You do not have access to that account.");
    }

    await assertGraphContact(context, data.contactId, data.accountId);
    await sendMailAs(
      mailbox.upn,
      {
        subject: data.subject,
        contentType: "Text",
        content: data.body,
        to: data.to,
        cc: data.cc ?? [],
        replyToMessageId: data.replyToMessageId ?? null,
      },
      auth,
    );

    // Logged immediately; the delta/webhook pass will reconcile the Graph id.
    const nowIso = new Date().toISOString();
    await supabaseAdmin.from("captured_communications").insert({
      provider: "outlook",
      external_id: `sent:${mailbox.id}:${nowIso}:${Math.random().toString(36).slice(2, 8)}`,
      channel: "email",
      direction: "outbound",
      occurred_at: nowIso,
      from_address: mailbox.upn,
      to_address: data.to[0] ?? null,
      subject: data.subject,
      body_preview: data.body.slice(0, 800),
      account_id: data.accountId ?? null,
      contact_id: data.contactId ?? null,
      mailbox_id: mailbox.id,
      user_id: context.userId,
    });

    if (data.accountId) {
      await supabaseAdmin.from("touchpoints").insert({
        account_id: data.accountId,
        contact_id: data.contactId ?? null,
        type: "email",
        occurred_at: nowIso,
        capture_source: "mailbox",
        direction: "outbound",
        notes: data.subject,
        created_by: context.userId,
      });
    }

    return { ok: true };
  });

/** Full body on demand — we store metadata and a preview, not every body. */
export const graphMessageBody = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { communicationId: string }) => data)
  .handler(async ({ data, context }) => {
    const { data: comm, error } = await context.supabase
      .from("captured_communications")
      .select("external_id, mailbox_id")
      .eq("id", data.communicationId)
      .maybeSingle();
    if (error || !comm) throw new Error("Message not found or not visible to you.");
    if (!comm.mailbox_id) throw new Error("This message has no linked mailbox.");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: mailbox } = await supabaseAdmin
      .from("graph_mailboxes")
      .select("upn, user_id, location_id, enabled")
      .eq("id", comm.mailbox_id)
      .maybeSingle();
    if (!mailbox || !mailbox.enabled) throw new Error("Mailbox no longer connected.");
    // Communication rows are caller-writable for call logging. A visible row
    // alone cannot authorize its mutable mailbox/message references.
    await assertCanSendAs(context, mailbox);

    // The body is part of what the holder's sync already reads; it is fetched
    // with the same token rather than warehoused.
    await outlookEnv();
    const { resolveMailboxAuthById } = await import("@/lib/graph-auth.server");
    const resolved = await resolveMailboxAuthById(comm.mailbox_id);
    if (!resolved.ok) throw new Error(resolved.message);
    const { getMessageBody } = await import("@/lib/graph.server");
    return getMessageBody(mailbox.upn, comm.external_id, resolved.auth);
  });

/* ------------------------------------------------------------------ */
/* Meetings                                                            */
/* ------------------------------------------------------------------ */

export const createGraphMeeting = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (data: {
      fromUpn: string;
      subject: string;
      body?: string;
      startIso: string;
      endIso: string;
      attendees: string[];
      locationText?: string | null;
      accountId?: string | null;
      contactId?: string | null;
    }) => data,
  )
  .handler(async ({ data, context }) => {
    if (!data.attendees.length) throw new Error("Add at least one attendee.");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: mailbox } = await supabaseAdmin
      .from("graph_mailboxes")
      .select("id, upn, kind, enabled, user_id, location_id")
      .eq("upn", data.fromUpn.trim().toLowerCase())
      .maybeSingle();
    if (!mailbox || !mailbox.enabled) throw new Error("That mailbox is not connected.");

    // Unconditional: a meeting invite goes out under the mailbox's identity.
    await assertCanSendAs(context, mailbox);
    await outlookEnv();
    const { resolveSenderAuth } = await import("@/lib/graph-auth.server");
    const auth = await resolveSenderAuth(context.userId, mailbox);

    if (data.accountId) {
      const { data: account, error: accountError } = await context.supabase
        .from("accounts")
        .select("id")
        .eq("id", data.accountId)
        .maybeSingle();
      // Only a real read failure is a permissions problem; anything else must
      // report itself rather than pointing at RLS.
      if (accountError) {
        throw new Error(`Couldn't check that account — ${accountError.message}`);
      }
      if (!account) throw new Error("You do not have access to that account.");
    }

    await assertGraphContact(context, data.contactId, data.accountId);
    const { createCalendarEvent } = await import("@/lib/graph.server");
    const event = await createCalendarEvent(
      mailbox.upn,
      {
        subject: data.subject,
        body: data.body ?? "",
        startIso: data.startIso,
        endIso: data.endIso,
        attendees: data.attendees,
        locationText: data.locationText ?? null,
      },
      auth,
    );

    // Booked, not held. Held is derived later from calendar state.
    await supabaseAdmin.from("calendar_events").upsert(
      {
        provider: "outlook",
        external_id: event.id,
        mailbox_id: mailbox.id,
        user_id: context.userId,
        account_id: data.accountId ?? null,
        contact_id: data.contactId ?? null,
        subject: data.subject,
        starts_at: data.startIso,
        ends_at: data.endIso,
        location_text: data.locationText ?? null,
        organizer_email: mailbox.upn,
        web_link: event.webLink ?? null,
        meeting_held: false,
        // assertCanSendAs passed for this mailbox and Graph made the id in it.
        // The actor is the session's user, never anything in `data`.
        push_identity_verified: true,
        push_actor_id: context.userId,
      },
      { onConflict: "provider,external_id" },
    );

    return { ok: true, eventId: event.id, webLink: event.webLink ?? null };
  });

/* ------------------------------------------------------------------ */
/* Outbound calendar queue                                             */
/* ------------------------------------------------------------------ */

/**
 * Push one just-saved event, best effort.
 *
 * The row is already committed by the time this runs — the caller fires it and
 * does not wait — so a Graph outage costs a minute's delay until the scheduled
 * drain picks the row up, never the user's edit. Visibility is decided by the
 * caller's own RLS client: if they cannot read the event, they cannot make us
 * write to a mailbox on its behalf.
 */
export const pushCalendarEvent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("calendar_events")
      .select("id")
      .eq("id", data.id)
      .maybeSingle();
    if (error) throw new Error(`Couldn't check that event — ${error.message}`);
    if (!row) throw new Error("That event is not visible to you.");

    const { drainCalendarPushQueue } = await import("@/lib/calendar-push.server");
    const result = await drainCalendarPushQueue({ ids: [data.id] });
    return {
      configured: result.configured,
      pushed: result.pushed,
      failed: result.failed,
      stuck: result.stuck,
    };
  });

/** How much outbound calendar work is waiting, and what is stuck. Admin only. */
export const calendarPushStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertGraphAdmin(context.supabase, context.userId);
    const { calendarPushSummary } = await import("@/lib/calendar-push.server");
    return calendarPushSummary();
  });

/** Requeue everything that gave up, then drain immediately. Admin only. */
export const retryCalendarPushes = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertGraphAdmin(context.supabase, context.userId);
    const { drainCalendarPushQueue, retryStuckCalendarPushes } =
      await import("@/lib/calendar-push.server");
    const requeued = await retryStuckCalendarPushes();
    const { outcomes: _outcomes, ...result } = await drainCalendarPushQueue();
    return { requeued, ...result };
  });

/* ------------------------------------------------------------------ */
/* Delegated access overview (admin)                                   */
/* ------------------------------------------------------------------ */

export type DelegatedPerson = {
  user_id: string;
  name: string;
  status: "connected" | "needs_reconnect" | "not_connected";
  shared_scopes: boolean;
  last_refreshed_at: string | null;
  has_mailbox: boolean;
};

export type MailboxAccess = {
  ok: boolean;
  problem: string | null;
  message: string | null;
  owner_user_id: string | null;
  owner_name: string | null;
};

export type DelegatedOverview = {
  mode: "delegated" | "application";
  /** False until 20261007200000 is applied. */
  connections_available: boolean;
  /** False until 20261007210000 is applied. */
  owners_available: boolean;
  people: DelegatedPerson[];
  access: Record<string, MailboxAccess>;
  /** Everyone who could be made a shared mailbox's owner. */
  staff: { user_id: string; name: string; status: DelegatedPerson["status"] }[];
};

/**
 * Who has connected Outlook, and whose token each mailbox would be read with.
 * Owner/admin/dev only, through the service role — `microsoft_connections`
 * lets a person read only their own row. Names and statuses only: no token,
 * no Microsoft account address, nothing from the secrets table is selected.
 */
export const outlookDelegatedOverview = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<DelegatedOverview> => {
    await assertGraphAdmin(context.supabase, context.userId);
    await outlookEnv();
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { isMissingSchema } = await import("@/lib/schema-fallback");
    const { outlookAuthMode, hasSharedScopes } = await import("@/lib/microsoft-oauth");
    const { resolveMailboxAuth } = await import("@/lib/graph-auth.server");
    const { listMailboxRows } = await import("@/lib/graph-sync.server");
    const db = supabaseAdmin as unknown as SupabaseClient;

    const mode = outlookAuthMode();
    const [connectionsRes, ownerProbe, profilesRes, mailboxes] = await Promise.all([
      db.from("microsoft_connections").select("user_id, status, scopes, last_refreshed_at"),
      db.from("graph_mailboxes").select("owner_user_id").limit(1),
      db
        .from("profiles")
        .select("user_id, full_name, email")
        .eq("is_active", true)
        .eq("approval_status", "approved"),
      listMailboxRows(),
    ]);

    const connectionsAvailable = !connectionsRes.error;
    if (connectionsRes.error && !isMissingSchema(connectionsRes.error)) {
      throw new Error(connectionsRes.error.message);
    }
    if (profilesRes.error) throw new Error(profilesRes.error.message);

    type Conn = {
      user_id: string;
      status: "connected" | "needs_reconnect";
      scopes: string[] | null;
      last_refreshed_at: string | null;
    };
    const connections = new Map(
      ((connectionsRes.data ?? []) as Conn[]).map((c) => [c.user_id, c] as const),
    );
    const profiles = (profilesRes.data ?? []) as {
      user_id: string;
      full_name: string | null;
      email: string | null;
    }[];
    const nameOf = new Map(profiles.map((p) => [p.user_id, p.full_name || p.email || "Unnamed"]));
    const statusOf = (id: string): DelegatedPerson["status"] =>
      connections.get(id)?.status ?? "not_connected";

    // The router, fed from what was just read instead of one query per row.
    const store = {
      get: async (id: string) => {
        const c = connections.get(id);
        return c
          ? ({
              ...c,
              scopes: c.scopes ?? [],
            } as unknown as ConnectionRow)
          : null;
      },
      isUserActive: async (id: string) => nameOf.has(id),
    } as unknown as ConnectionStore;

    const access: Record<string, MailboxAccess> = {};
    for (const m of mailboxes) {
      const owner = m.owner_user_id ?? null;
      const resolved = await resolveMailboxAuth(m, store);
      access[m.id] = {
        ok: resolved.ok,
        problem: resolved.ok ? null : resolved.problem,
        message: resolved.ok ? null : resolved.message,
        owner_user_id: owner,
        owner_name: owner ? (nameOf.get(owner) ?? "Former team member") : null,
      };
    }

    const mailboxPeople = new Set(
      mailboxes.filter((m) => m.kind !== "shared_office" && m.user_id).map((m) => m.user_id!),
    );
    const people: DelegatedPerson[] = profiles
      .filter((p) => mailboxPeople.has(p.user_id) || connections.has(p.user_id))
      .map((p) => {
        const c = connections.get(p.user_id);
        return {
          user_id: p.user_id,
          name: nameOf.get(p.user_id) as string,
          status: statusOf(p.user_id),
          shared_scopes: hasSharedScopes(c?.scopes ?? []),
          last_refreshed_at: c?.last_refreshed_at ?? null,
          has_mailbox: mailboxPeople.has(p.user_id),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    return {
      mode,
      connections_available: connectionsAvailable,
      owners_available: !ownerProbe.error,
      people,
      access,
      staff: profiles
        .map((p) => ({
          user_id: p.user_id,
          name: nameOf.get(p.user_id) as string,
          status: statusOf(p.user_id),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  });
