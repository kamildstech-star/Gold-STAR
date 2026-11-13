/**
 * The transport columns of one email (migration 20261012100000), read through
 * the viewer's own client, for the "Not sent yet" line and the delivery dialog.
 * Before the migration they are not there; the same read without them keeps
 * the screen honest ("not sent") without the reason.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { supabase } from "@/integrations/supabase/client";
import { isMissingSchema } from "@/lib/schema-fallback";

export type EmailDeliveryDetail = {
  status: string | null;
  sent_at: string | null;
  created_at: string | null;
  error: string | null;
  delivery_reason: string | null;
  next_attempt_at: string | null;
  provider: string | null;
  sent_from: string | null;
  sender_name: string | null;
};

export async function fetchEmailDeliveryDetail(
  id: string,
  senderId: string | null | undefined,
): Promise<EmailDeliveryDetail> {
  const db = supabase as unknown as SupabaseClient;
  const read = (cols: string) => db.from("email_messages").select(cols).eq("id", id).maybeSingle();
  let res = await read(
    "status, sent_at, created_at, error, delivery_reason, next_attempt_at, provider, sent_from",
  );
  if (res.error && isMissingSchema(res.error))
    res = await read("status, sent_at, created_at, error");
  if (res.error) throw res.error;
  const row = (res.data ?? {}) as Partial<EmailDeliveryDetail>;

  let senderName: string | null = null;
  if (senderId) {
    const { data } = await supabase
      .from("profiles")
      .select("full_name")
      .eq("user_id", senderId)
      .maybeSingle();
    senderName = data?.full_name?.trim() || null;
  }

  return {
    status: row.status ?? null,
    sent_at: row.sent_at ?? null,
    created_at: row.created_at ?? null,
    error: row.error ?? null,
    delivery_reason: row.delivery_reason ?? null,
    next_attempt_at: row.next_attempt_at ?? null,
    provider: row.provider ?? null,
    sent_from: row.sent_from ?? null,
    sender_name: senderName,
  };
}
