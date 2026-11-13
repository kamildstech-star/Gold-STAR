/**
 * Sending documents out for signature.
 *
 * A packet is one link to one recipient carrying one or more documents. The
 * token in that link is the recipient's only credential, so it is generated
 * with the platform CSPRNG and never derived from anything guessable such as
 * the job number.
 *
 * Status lives on the documents themselves (draft → sent → viewed → signed);
 * the packet only records what was sent to whom and when, so a document that
 * gets re-sent keeps one continuous history.
 */
import { browserAppOrigin } from "@/lib/app-origin";
import { textToEmailHtml } from "@/lib/safe-html";
import { supabase } from "@/integrations/supabase/client";
import { logDocumentEvent } from "./document-templates";
import type { Database } from "@/integrations/supabase/types";

export type SendPacket = Database["public"]["Tables"]["document_send_packets"]["Row"];

export type PacketWithItems = SendPacket & {
  items: {
    document_id: string;
    requires_signature: boolean;
    document: { id: string; name: string; status: string } | null;
  }[];
};

export function newToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function signUrl(token: string): string {
  const origin = browserAppOrigin();
  return `${origin}/sign/${token}`;
}

export type CreatePacketInput = {
  locationId: string;
  jobId: string | null;
  accountId: string | null;
  documentIds: string[];
  requireSignature: boolean;
  recipientEmail: string;
  recipientName: string | null;
  subject: string;
  message: string;
  /** Fields the recipient must complete before signing. */
  requiredFields: { key: string; label: string }[];
  reminderDays: number;
  expiresInDays: number;
  userId: string | null;
};

export async function createSendPacket(input: CreatePacketInput): Promise<SendPacket> {
  if (!input.documentIds.length) throw new Error("Pick at least one document to send.");
  if (!input.recipientEmail.trim()) throw new Error("A recipient email is required.");

  const token = newToken();
  const { data: packet, error } = await supabase
    .from("document_send_packets")
    .insert({
      location_id: input.locationId,
      job_id: input.jobId,
      account_id: input.accountId,
      token,
      recipient_email: input.recipientEmail.trim(),
      recipient_name: input.recipientName?.trim() || null,
      subject: input.subject,
      message: input.message,
      required_fields: input.requiredFields as never,
      reminder_days: input.reminderDays,
      expires_at: new Date(Date.now() + input.expiresInDays * 86400_000).toISOString(),
      sent_at: new Date().toISOString(),
      created_by: input.userId,
    })
    .select("*")
    .single();
  if (error) throw error;

  const items = input.documentIds.map((id, i) => ({
    packet_id: packet.id,
    document_id: id,
    requires_signature: input.requireSignature,
    sort_order: i,
  }));
  const { error: itemsError } = await supabase.from("document_send_items").insert(items);
  if (itemsError) throw itemsError;

  const { error: docError } = await supabase
    .from("documents")
    .update({
      status: input.requireSignature ? "pending_signature" : "sent",
      sent_at: new Date().toISOString(),
      sent_to: input.recipientEmail.trim(),
    })
    .in("id", input.documentIds);
  if (docError) throw docError;

  for (const id of input.documentIds) {
    await logDocumentEvent(id, "sent", {
      packet_id: packet.id,
      to: input.recipientEmail.trim(),
      requires_signature: input.requireSignature,
    });
  }

  return packet;
}

export async function listPacketsForJob(jobId: string): Promise<PacketWithItems[]> {
  const { data, error } = await supabase
    .from("document_send_packets")
    .select(
      "*, items:document_send_items(document_id, requires_signature, document:documents(id, name, status))",
    )
    .eq("job_id", jobId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as unknown as PacketWithItems[];
}

export async function revokePacket(packetId: string): Promise<void> {
  const { error } = await supabase
    .from("document_send_packets")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", packetId);
  if (error) throw error;
}

/** Bumps the reminder counters; the email itself is sent by the caller. */
export async function markReminderSent(packetId: string, currentCount: number): Promise<void> {
  const { error } = await supabase
    .from("document_send_packets")
    .update({ last_reminder_at: new Date().toISOString(), reminder_count: currentCount + 1 })
    .eq("id", packetId);
  if (error) throw error;
}

export type PacketState = "revoked" | "expired" | "completed" | "opened" | "sent" | "created";

export function packetState(p: SendPacket): PacketState {
  if (p.revoked_at) return "revoked";
  if (p.completed_at && p.single_use !== false) return "completed";
  if (p.completed_at) return "completed";
  if (new Date(p.expires_at).getTime() < Date.now()) return "expired";
  if (p.first_viewed_at) return "opened";
  if (p.sent_at) return "sent";
  return "created";
}

export const PACKET_STATE_LABEL: Record<PacketState, string> = {
  revoked: "Revoked",
  expired: "Expired",
  completed: "Completed",
  opened: "Opened",
  sent: "Sent",
  created: "Created",
};

export const PACKET_STATE_TONE: Record<PacketState, string> = {
  revoked: "bg-muted text-muted-foreground",
  expired: "bg-destructive/15 text-destructive",
  completed: "bg-success/15 text-success",
  opened: "bg-info/15 text-info",
  sent: "bg-warning/15 text-warning",
  created: "bg-muted text-muted-foreground",
};

/** Days a packet has been outstanding — drives the "chase this" nudge. */
export function daysOutstanding(p: SendPacket): number | null {
  if (!p.sent_at || p.completed_at) return null;
  return Math.floor((Date.now() - new Date(p.sent_at).getTime()) / 86400_000);
}

/* ------------------------------------------------------------------ */
/* Email to sign                                                       */
/* ------------------------------------------------------------------ */

/**
 * The paperwork a customer signs — the "contract types". David, 15 Oct: a
 * service agreement or work authorisation could only be signed on the rep's
 * screen; there was no way to email one to the person who has to sign it.
 */
export const CONTRACT_DOC_TYPES = [
  "work_authorization",
  "service_agreement",
  "contract",
  "direction_to_pay",
  "non_waiver",
  "vendor_agreement",
  "certificate_of_completion",
] as const;

export function isContractDocType(docType: string | null | undefined): boolean {
  return !!docType && (CONTRACT_DOC_TYPES as readonly string[]).includes(docType);
}

/**
 * Should a filed document's row offer "Email to sign"? One of the contract
 * types, and not signed or locked already. Cheap — the list does not carry
 * the wording; `canEmailToSign` checks that once the row is pressed.
 */
export function offerEmailToSign(doc: {
  doc_type: string | null;
  status?: string | null;
  locked_at?: string | null;
}): boolean {
  if (!isContractDocType(doc.doc_type)) return false;
  return !doc.locked_at && doc.status !== "signed" && doc.status !== "void";
}

/**
 * Can it actually go? The public signing page shows the document's wording
 * (`rendered_body`), so an uploaded scan with no wording has nothing to put
 * in front of the signer.
 */
export function canEmailToSign(doc: {
  doc_type: string | null;
  status?: string | null;
  rendered_body?: string | null;
  locked_at?: string | null;
}): boolean {
  return offerEmailToSign(doc) && !!doc.rendered_body?.trim();
}

/** The email body: the sender's message, then the one link that is the signer's credential. */
export function signRequestEmailHtml(message: string, link: string): string {
  return `${textToEmailHtml(message)}<p><a href="${link}">Review and sign your documents</a></p>`;
}

export type EmailToSignInput = Omit<CreatePacketInput, "documentIds"> & { documentIds: string[] };

type SendEmailFn = (args: {
  data: {
    to: string[];
    subject: string;
    bodyHtml: string;
    category: "work_authorization";
    jobId: string | null;
    accountId: string | null;
    locationId: string | null;
    logTouchpoint: boolean;
  };
}) => Promise<unknown>;

/**
 * One packet for the documents, and the email carrying its link — the same
 * secure-token signing flow and the same email engine the Send for signature
 * dialog has always used, now callable from wherever a contract is.
 * `createPacket` and `send` are passed in so the sequence is testable.
 */
export async function emailDocumentsToSign<R>(
  input: EmailToSignInput,
  deps: {
    send: (args: Parameters<SendEmailFn>[0]) => Promise<R>;
    createPacket?: (input: CreatePacketInput) => Promise<Pick<SendPacket, "id" | "token">>;
  },
): Promise<{ link: string; packetId: string; result: R }> {
  const to = input.recipientEmail.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new Error("Add a valid recipient email.");
  if (!input.documentIds.length) throw new Error("Pick at least one document to send.");
  const packet = await (deps.createPacket ?? createSendPacket)({ ...input, recipientEmail: to });
  const link = signUrl(packet.token);
  const result = await deps.send({
    data: {
      to: [to],
      subject: input.subject,
      bodyHtml: signRequestEmailHtml(input.message, link),
      category: "work_authorization",
      jobId: input.jobId,
      accountId: input.accountId,
      locationId: input.locationId,
      logTouchpoint: false,
    },
  });
  return { link, packetId: packet.id, result };
}
