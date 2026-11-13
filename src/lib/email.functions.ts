import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";
import type { EmailAttachmentLink } from "./email-hold";
import type { MyEmailTransport } from "./email-transport";

export type SendEmailInput = {
  to: string[];
  cc?: string[];
  subject: string;
  bodyHtml: string;
  category:
    | "estimate"
    | "invoice"
    | "follow_up"
    | "seasonal"
    | "work_authorization"
    | "reminder"
    | "notification"
    | "payment_receipt";
  templateId?: string | null;
  templateKey?: string | null;
  accountId?: string | null;
  contactId?: string | null;
  jobId?: string | null;
  invoiceId?: string | null;
  locationId?: string | null;
  attachmentUrl?: string | null;
  replyTo?: string | null;
  fromName?: string | null;
  /** Emails to a known contact also log a touchpoint so cadence counts them. */
  logTouchpoint?: boolean;
  /**
   * Files as download links. Kept apart from the body and appended when the
   * email is released, so a wrong file removed during the hold never goes.
   */
  attachments?: EmailAttachmentLink[];
};

/**
 * Sends one email a person wrote, through the undo window.
 *
 * David, 24 Sep: "Sending in 4:32 — Edit · Cancel." Unless an admin has set
 * the delay to 0, the email is logged 'held' with a release time and returned
 * at once; the sender can change or cancel it until then, and the
 * email-release hook hands it to the transport seam (email-delivery.server.ts)
 * when the window runs out. With the delay at 0 — or before the held-state
 * migration is applied — it goes to the same seam straight away, as before.
 *
 * The log row is always written before any send so a provider failure is
 * still visible as a failed row rather than vanishing.
 *
 * Automation email (automation-jobs.server.ts) does not come through here and
 * is not held: nobody pressed Send, so there is nobody to catch a mistake.
 */
export const sendEmail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: SendEmailInput) => data)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    if (!data.to.length) throw new Error("At least one recipient is required.");
    if (!data.subject.trim()) throw new Error("Subject is required.");

    const { parseSendDelay, releaseAtFrom, EMAIL_SEND_SETTINGS_KEY } = await import("./email-hold");
    const setting = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", EMAIL_SEND_SETTINGS_KEY)
      .maybeSingle();
    const delay = parseSendDelay(setting.data?.value);

    const base = {
      template_id: data.templateId ?? null,
      template_key: data.templateKey ?? null,
      category: data.category,
      to_emails: data.to,
      cc_emails: data.cc ?? [],
      subject: data.subject,
      body_html: data.bodyHtml,
      account_id: data.accountId ?? null,
      contact_id: data.contactId ?? null,
      job_id: data.jobId ?? null,
      invoice_id: data.invoiceId ?? null,
      location_id: data.locationId ?? null,
      attachment_url: data.attachmentUrl ?? null,
      sent_by: userId,
    };
    const extras = {
      attachments: data.attachments ?? [],
      reply_to: data.replyTo ?? null,
      from_name: data.fromName ?? null,
      log_touchpoint: data.logTouchpoint !== false,
    };

    if (delay > 0) {
      const releaseAt = releaseAtFrom(new Date(), delay).toISOString();
      // Asked now, while the sender can still act on the answer: an email
      // nothing will carry is said out loud before the window closes, not
      // discovered days later (David's 11 Oct invoice).
      const transport = await transportFor(userId, data.locationId ?? null);
      const held = await supabase
        .from("email_messages")
        .insert({ ...base, ...extras, status: "held", release_at: releaseAt } as never)
        .select("id")
        .single();
      if (!held.error) {
        return {
          id: (held.data as { id: string }).id,
          providerId: null,
          touchpointLogged: false,
          queued: false,
          held: true,
          releaseAt,
          provider: null,
          reason: null,
          transport,
        };
      }
      // Until 20260928121000/122000 are applied there is no held state to
      // write; send the old way rather than refuse to send at all.
      if (!heldStateMissing(held.error)) throw new Error(held.error.message);
    }

    let inserted = await supabase
      .from("email_messages")
      .insert({ ...base, ...extras, status: "queued" } as never)
      .select("id")
      .single();
    const { isMissingSchema } = await import("./schema-fallback");
    if (inserted.error && isMissingSchema(inserted.error)) {
      inserted = await supabase
        .from("email_messages")
        .insert({ ...base, status: "queued" })
        .select("id")
        .single();
    }
    if (inserted.error) throw new Error(inserted.error.message);
    const messageId = (inserted.data as { id: string }).id;

    const { deliverEmailMessage } = await import("./email-delivery.server");
    const outcome = await deliverEmailMessage(supabase as never, {
      id: messageId,
      ...base,
      ...extras,
    });
    return {
      ...outcome,
      held: false,
      releaseAt: null as string | null,
      transport: null as MyEmailTransport | null,
    };
  });

/**
 * The sender's own way out right now, or null when it could not be worked out
 * (then the screen says nothing rather than guessing).
 */
async function transportFor(
  userId: string,
  locationId: string | null,
): Promise<MyEmailTransport | null> {
  try {
    const { resolveEmailTransport } = await import("./email-transport.server");
    const r = await resolveEmailTransport(userId, { locationId });
    if (!r.ok) return { configured: false, via: null, reason: r.reason, from: null };
    return {
      configured: true,
      via: r.route.kind,
      reason: null,
      from: r.route.kind === "outlook" ? r.route.upn : r.route.fromAddress,
    };
  } catch (error) {
    console.error("[email] transport check failed:", error);
    return null;
  }
}

/** The held columns or the 'held' enum value are not in the database yet. */
function heldStateMissing(error: { code?: string; message?: string }): boolean {
  if (error.code === "22P02" && /email_status/.test(error.message ?? "")) return true;
  return (
    error.code === "42703" ||
    error.code === "PGRST204" ||
    /does not exist|schema cache/i.test(error.message ?? "")
  );
}

/**
 * Whether email THIS PERSON sends would go out right now, and how — drives the
 * honest UI state. It used to ask only "is there a Resend key", which told
 * someone with Outlook connected that nothing was connected, and told nobody
 * that their email was about to sit in 'queued' forever.
 */
export const emailStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<MyEmailTransport & { checked: boolean }> => {
    const mine = await transportFor(context.userId, null);
    return mine
      ? { ...mine, checked: true }
      : { configured: false, via: null, reason: null, from: null, checked: false };
  });

type CallerContext = { supabase: SupabaseClient<Database>; userId: string };

/**
 * The sender, or an owner/admin/dev, may Resend or Cancel an email that has
 * not gone: the same people assertCanSendAs lets act for a mailbox. The row
 * must be visible to the caller through their own client first.
 */
async function assertMayActOnUnsent(context: CallerContext, id: string) {
  const { data, error } = await context.supabase
    .from("email_messages")
    .select("id, sent_by, status, sent_at")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("That email is not visible to you.");
  if (data.sent_at || !["queued", "failed"].includes(data.status as string)) {
    throw new Error("That email is not waiting to send.");
  }
  if (data.sent_by === context.userId) return;
  const { data: privileged } = await context.supabase.rpc("is_privileged", {
    _user_id: context.userId,
  });
  if (privileged !== true) {
    throw new Error("Only the person who sent it, or an admin, can resend or cancel it.");
  }
}

const BEING_SENT = "Too late: this email is being sent right now.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resend: try the transport again now, for one email that has not gone. It
 * goes out as its SENDER (their Outlook, else Resend), whoever presses it,
 * and is the only way an email older than 14 days goes out at all.
 */
export const resendQueuedEmail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { id: string }) => {
    if (!input?.id || !UUID.test(input.id)) throw new Error("Unknown email.");
    return { id: input.id };
  })
  .handler(async ({ data, context }) => {
    await assertMayActOnUnsent(context as unknown as CallerContext, data.id);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { isMissingSchema } = await import("./schema-fallback");

    // The claim is what stops a Resend and the sweep sending it twice.
    const claimed = await supabaseAdmin.rpc(
      "claim_retryable_queued_emails" as never,
      { _limit: 1, _only_id: data.id } as never,
    );
    let row: unknown;
    if (claimed.error && isMissingSchema(claimed.error)) {
      // Before 20261012100000 there is no claim to take; read and send.
      const plain = await supabaseAdmin
        .from("email_messages")
        .select("*")
        .eq("id", data.id)
        .in("status", ["queued", "failed"])
        .is("sent_at", null)
        .maybeSingle();
      if (plain.error) throw new Error(plain.error.message);
      row = plain.data;
    } else if (claimed.error) {
      throw new Error(claimed.error.message);
    } else {
      row = ((claimed.data ?? []) as unknown[])[0];
    }
    if (!row) throw new Error(BEING_SENT);

    const { deliverEmailMessage } = await import("./email-delivery.server");
    const outcome = await deliverEmailMessage(
      supabaseAdmin,
      row as Parameters<typeof deliverEmailMessage>[1],
      { admin: supabaseAdmin },
    );
    return { sent: !outcome.queued, provider: outcome.provider, reason: outcome.reason };
  });

/**
 * Send now: skip the rest of the undo window for one held email. The same
 * people who may Resend or Cancel (the sender, or an owner/admin/dev). The
 * release is one conditional update — held → queued, exactly what
 * claim_due_held_emails does for a due row — so if the sweep or a Cancel got
 * there first nothing happens here, and the email can never go twice.
 */
export const sendHeldEmailNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { id: string }) => {
    if (!input?.id || !UUID.test(input.id)) throw new Error("Unknown email.");
    return { id: input.id };
  })
  .handler(async ({ data, context }) => {
    const ctx = context as unknown as CallerContext;
    const { data: visible, error: readError } = await ctx.supabase
      .from("email_messages")
      .select("id, sent_by, status")
      .eq("id", data.id)
      .maybeSingle();
    if (readError) throw new Error(readError.message);
    if (!visible) throw new Error("That email is not visible to you.");
    if (visible.status !== "held") throw new Error(NOT_HELD);
    if (visible.sent_by !== ctx.userId) {
      const { data: privileged } = await ctx.supabase.rpc("is_privileged", {
        _user_id: ctx.userId,
      });
      if (privileged !== true) {
        throw new Error("Only the person who sent it, or an admin, can send it now.");
      }
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const nowIso = new Date().toISOString();
    // The service role, because tg_email_hold_guard keeps signed-in writers
    // from releasing a held email by hand; conditioned on 'held' so the sweep
    // or a Cancel that won the race leaves nothing to release.
    const released = await supabaseAdmin
      .from("email_messages")
      .update({ status: "queued", released_at: nowIso, release_at: nowIso } as never)
      .eq("id", data.id)
      .eq("status", "held" as never)
      .select("*");
    if (released.error) throw new Error(released.error.message);
    const row = (released.data ?? [])[0];
    if (!row) throw new Error(NOT_HELD);

    const { deliverEmailMessage } = await import("./email-delivery.server");
    const outcome = await deliverEmailMessage(
      supabaseAdmin,
      row as unknown as Parameters<typeof deliverEmailMessage>[1],
      { admin: supabaseAdmin },
    );
    return { sent: !outcome.queued, provider: outcome.provider, reason: outcome.reason };
  });

const NOT_HELD = "Too late: this email has already been sent or canceled.";

/** Cancel an email that has not gone. Refused while the sweep holds it. */
export const cancelQueuedEmail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { id: string }) => {
    if (!input?.id || !UUID.test(input.id)) throw new Error("Unknown email.");
    return { id: input.id };
  })
  .handler(async ({ data, context }) => {
    await assertMayActOnUnsent(context as unknown as CallerContext, data.id);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { isMissingSchema } = await import("./schema-fallback");
    const { EMAIL_CLAIM_LEASE_MINUTES } = await import("./email-transport");
    const nowIso = new Date().toISOString();
    const leaseCutoff = new Date(Date.now() - EMAIL_CLAIM_LEASE_MINUTES * 60_000).toISOString();

    // The service role, because a released email is frozen for signed-in
    // writers (tg_email_hold_guard); conditioned so a claim in flight wins.
    const cancel = (withClaim: boolean) => {
      let q = supabaseAdmin
        .from("email_messages")
        .update(
          (withClaim
            ? { status: "cancelled", cancelled_at: nowIso, next_attempt_at: null }
            : { status: "cancelled", cancelled_at: nowIso }) as never,
        )
        .eq("id", data.id)
        .in("status", ["queued", "failed"])
        .is("sent_at", null);
      if (withClaim) q = q.or(`claimed_at.is.null,claimed_at.lt.${leaseCutoff}`);
      return q.select("id");
    };
    let res = await cancel(true);
    if (res.error && isMissingSchema(res.error)) res = await cancel(false);
    if (res.error) throw new Error(res.error.message);
    if (!res.data?.length) throw new Error(BEING_SENT);
    return { ok: true };
  });
