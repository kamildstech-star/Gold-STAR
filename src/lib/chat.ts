import type { Database } from "@/integrations/supabase/types";

import { DATE_LOCALE, US_DATE } from "@/lib/date-format";
export type Message = Database["public"]["Tables"]["messages"]["Row"];
export type Conversation = Database["public"]["Tables"]["conversations"]["Row"];
export type ConversationMember = Database["public"]["Tables"]["conversation_members"]["Row"];
export type MessageAttachment = Database["public"]["Tables"]["message_attachments"]["Row"];
export type MessageReceipt = Database["public"]["Tables"]["message_receipts"]["Row"];
export type MessageReaction = Database["public"]["Tables"]["message_reactions"]["Row"];

/** WhatsApp-style tick state for a message the current user sent. */
export type TickState = "sending" | "sent" | "delivered" | "read";

export function computeTick(
  msg: Message,
  isOwn: boolean,
  otherMemberIds: string[],
  receiptsForMessage: MessageReceipt[],
): TickState | null {
  if (!isOwn) return null;
  if (msg.id.startsWith("optimistic-")) return "sending";
  if (otherMemberIds.length === 0) return "sent";
  const others = receiptsForMessage.filter((r) => otherMemberIds.includes(r.user_id));
  const readCount = others.filter((r) => r.read_at != null).length;
  if (readCount >= otherMemberIds.length) return "read";
  if (others.length >= otherMemberIds.length) return "delivered";
  return "sent";
}

export interface MessageGroup {
  key: string;
  sender_id: string;
  items: Message[];
}

/**
 * A Polaris answer posted into the chat. It carries the asker's sender_id (the
 * person it is attributed to, and whose permissions it was scoped to), so this
 * flag, not sender_id, is what tells the UI to draw it as Polaris.
 */
export function isAssistantMessage(m: Pick<Message, "author_kind">): boolean {
  return m.author_kind === "assistant";
}

/**
 * Groups consecutive same-sender messages within 5 minutes into one bubble
 * stack. A Polaris answer never joins the asker's stack even though it shares
 * their sender_id.
 */
export function groupMessages(msgs: Message[]): MessageGroup[] {
  const groups: MessageGroup[] = [];
  for (const m of msgs) {
    const last = groups[groups.length - 1];
    const withinWindow =
      last &&
      last.sender_id === m.sender_id &&
      isAssistantMessage(last.items[0]) === isAssistantMessage(m) &&
      sameDay(last.items[last.items.length - 1].sent_at, m.sent_at) &&
      new Date(m.sent_at).getTime() -
        new Date(last.items[last.items.length - 1].sent_at).getTime() <
        5 * 60_000;
    if (withinWindow) {
      last.items.push(m);
    } else {
      groups.push({ key: m.id, sender_id: m.sender_id, items: [m] });
    }
  }
  return groups;
}

export function sameDay(a: string, b: string): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

export function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const y = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  const diff = (Date.now() - d.getTime()) / 86_400_000;
  if (diff < 7) return d.toLocaleDateString("en-US", { weekday: "long" });
  return d.toLocaleDateString(DATE_LOCALE, US_DATE);
}

export function chatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

export function relChatTime(iso: string): string {
  const d = new Date(iso).getTime();
  const diff = Date.now() - d;
  if (diff < 60_000) return "now";
  const today = new Date();
  const msgDate = new Date(iso);
  if (msgDate.toDateString() === today.toDateString()) return chatTime(iso);
  const y = new Date(Date.now() - 86_400_000);
  if (msgDate.toDateString() === y.toDateString()) return "Yesterday";
  if (diff < 7 * 86_400_000) return msgDate.toLocaleDateString("en-US", { weekday: "short" });
  return msgDate.toLocaleDateString(DATE_LOCALE, US_DATE);
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}

export const QUICK_EMOJI = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

export function displayBody(msg: Message): string {
  if (msg.deleted_at) return "This message was deleted";
  return msg.body ?? "";
}

/** Shape of the embedded profile on chat member/sender rows. */
export interface PersonProfile {
  full_name: string | null;
}

/**
 * Terminal display name for a person: name, else "Removed user".
 * Email is deliberately not a fallback — `profiles.email` is revoked from the
 * `authenticated` role, so selecting it fails the whole query. Manager screens
 * that need an address go through the SECURITY DEFINER admin RPCs.
 * Never renders "Unknown": a missing profile means the row is gone, and a
 * fetch failure must surface as an error, not as a placeholder name.
 */
export function personLabel(profile: PersonProfile | null | undefined): string {
  const name = profile?.full_name?.trim();
  if (name) return name;
  return "Removed user";
}

// ---------- files and records as their own messages ----------

/**
 * A message whose payload is a thing rather than words: a photo, a file, or a
 * shared job/account. These render as a card first, and any text sent with
 * them (or added later via "Add note") is a separate reply that threads
 * underneath. Voice notes are deliberately not items: they are the message.
 * Deleted items are not items either; the card is gone, so nothing can nest.
 */
export function isItemMessage(
  msg: Pick<Message, "deleted_at" | "shared_record_type" | "shared_record_id">,
  attachments: Pick<MessageAttachment, "kind">[],
): boolean {
  if (msg.deleted_at) return false;
  if (msg.shared_record_type && msg.shared_record_id) return true;
  return attachments.some((a) => a.kind !== "audio");
}

type ThreadableMessage = Pick<Message, "id" | "reply_to_message_id">;

export interface NoteThreads<T> {
  /** Notes keyed by the item message they hang under, in send order. */
  notesByItem: Map<string, T[]>;
  /** Every message that rendered as a note, so the top-level stream can skip it. */
  noteIds: Set<string>;
}

/**
 * Folds consecutive notes under the item they reply to.
 *
 * A note is a reply to the most recent top-level message when that message is
 * an item and nothing but notes on that same item has been sent since, so a
 * run of replies (from anyone) directly after a file all group under it, and
 * the first unrelated message closes the thread. A reply that arrives after
 * other chat stays a normal quoted reply in the stream; nesting it would move
 * it out of chronological order. A reply that is itself an item is never a
 * note: a file answered with a file is two cards.
 */
export function threadNotes<T extends ThreadableMessage>(
  msgs: T[],
  isItem: (m: T) => boolean,
): NoteThreads<T> {
  const notesByItem = new Map<string, T[]>();
  const noteIds = new Set<string>();
  let openItemId: string | null = null;
  for (const m of msgs) {
    if (openItemId !== null && m.reply_to_message_id === openItemId && !isItem(m)) {
      const arr = notesByItem.get(openItemId) ?? [];
      arr.push(m);
      notesByItem.set(openItemId, arr);
      noteIds.add(m.id);
      continue;
    }
    openItemId = isItem(m) ? m.id : null;
  }
  return { notesByItem, noteIds };
}

/**
 * The name a user chose for an upload. Storage paths are
 * `<conversation>/<message>/<uuid>-<original name>`; the uuid keeps two
 * uploads of "photo.jpg" from colliding and must not leak into the UI.
 */
export function attachmentFileName(storagePath: string): string {
  const last = storagePath.split("/").pop() ?? storagePath;
  return last.replace(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i, "");
}

export function formatBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/** One-line label for an item message, used in reply quotes and the composer banner. */
export function itemLabel(
  msg: Pick<Message, "shared_record_type" | "body">,
  attachments: Pick<MessageAttachment, "kind" | "storage_path">[],
): string {
  const att = attachments.find((a) => a.kind !== "audio");
  if (att) return attachmentFileName(att.storage_path);
  if (msg.shared_record_type) return msg.body?.trim() || `Shared ${msg.shared_record_type}`;
  return msg.body?.trim() || "";
}
