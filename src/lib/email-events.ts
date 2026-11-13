import type { SupabaseClient } from "@supabase/supabase-js";

import { supabase } from "@/integrations/supabase/client";

/** One callback from the mail provider, exactly as it was recorded. */
export type EmailEvent = {
  id: string;
  email_message_id: string | null;
  provider: string;
  provider_message_id: string | null;
  provider_event_id: string;
  event_type: string;
  recipient: string | null;
  occurred_at: string;
};

export const EMAIL_EVENT_LABEL: Record<string, string> = {
  "email.sent": "Sent",
  "email.delivered": "Delivered",
  "email.delivery_delayed": "Delivery delayed",
  "email.bounced": "Bounced",
  "email.complained": "Marked as spam",
  "email.opened": "Opened",
  "email.clicked": "Link clicked",
};

export function emailEventLabel(type: string) {
  return EMAIL_EVENT_LABEL[type] ?? type.replace(/^email\./, "").replace(/_/g, " ");
}

/**
 * Events we present as facts. Each is the provider reporting on its own
 * handoff — it either accepted the message, handed it to the receiving server,
 * or was told no. None of them depend on what the recipient's mail client does
 * with images.
 */
const TRUSTED_EVENTS = new Set([
  "email.sent",
  "email.delivered",
  "email.delivery_delayed",
  "email.bounced",
  "email.complained",
]);

export function isTrustedEmailEvent(type: string) {
  return TRUSTED_EVENTS.has(type);
}

export async function fetchEmailEvents(emailMessageId: string): Promise<EmailEvent[]> {
  // email_events postdates the generated Supabase types; reach it through an
  // untyped view rather than hand-editing generated output.
  const db = supabase as unknown as SupabaseClient;
  const { data, error } = await db
    .from("email_events")
    .select(
      "id, email_message_id, provider, provider_message_id, provider_event_id, event_type, recipient, occurred_at",
    )
    .eq("email_message_id", emailMessageId)
    .order("occurred_at", { ascending: true });

  // Thrown, not swallowed: a query that failed must not reach the screen
  // looking like an email nothing ever happened to.
  if (error) throw error;
  return (data ?? []) as unknown as EmailEvent[];
}

export type EmailTrail = {
  /** Delivery milestones, oldest first. Shown one row each. */
  milestones: EmailEvent[];
  /** Every open, oldest first. Collapsed on screen — see the dialog. */
  opens: EmailEvent[];
  clicks: EmailEvent[];
  firstOpenAt: string | null;
  lastOpenAt: string | null;
  openCount: number;
  /** Recipients the provider actually reported on, for the dialog header. */
  recipients: string[];
};

/**
 * Split a raw trail into what we show plainly and what we collapse.
 *
 * The reason for the split: a single client email routinely produces thirty-odd
 * "opened" events minutes apart, all from the sender's own domain. That is
 * Gmail proxying the image, Apple Mail Privacy Protection prefetching it, and
 * security scanners following the pixel — not a person opening the mail thirty
 * times. Presenting those as a list of reads is how a rep ends up telling a
 * client "you read this eleven times" about an email nobody opened.
 */
export function summarizeEmailTrail(events: EmailEvent[]): EmailTrail {
  const milestones: EmailEvent[] = [];
  const opens: EmailEvent[] = [];
  const clicks: EmailEvent[] = [];

  for (const event of events) {
    if (event.event_type === "email.opened") opens.push(event);
    else if (event.event_type === "email.clicked") clicks.push(event);
    // Anything else — including an event type Resend adds later — is shown
    // rather than hidden, so a new signal never silently disappears.
    else milestones.push(event);
  }

  const recipients = [...new Set(events.map((e) => e.recipient).filter((r): r is string => !!r))];

  return {
    milestones,
    opens,
    clicks,
    firstOpenAt: opens[0]?.occurred_at ?? null,
    lastOpenAt: opens[opens.length - 1]?.occurred_at ?? null,
    openCount: opens.length,
    recipients,
  };
}
