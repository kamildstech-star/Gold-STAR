/**
 * Presentation helpers for the Outlook mail client.
 *
 * Everything here reads from what the Graph sync already stored on
 * `captured_communications` — nothing is invented. When Outlook did not send
 * a field (folder, flag, attachment marker) we fall back to what the row
 * itself tells us rather than showing a fabricated value.
 */
import type { CapturedComm } from "@/lib/email-context";

import { DATE_LOCALE, US_DATE } from "@/lib/date-format";
export type FolderKey = "inbox" | "starred" | "sent" | "drafts" | "archive" | "spam" | "trash";

export const FOLDERS: { key: FolderKey; label: string }[] = [
  { key: "inbox", label: "Inbox" },
  { key: "starred", label: "Starred" },
  { key: "sent", label: "Sent" },
  { key: "drafts", label: "Drafts" },
  { key: "archive", label: "Archive" },
  { key: "spam", label: "Spam" },
  { key: "trash", label: "Trash" },
];

/** Well-known Outlook folder names mapped onto our rail. */
const FOLDER_ALIASES: Record<string, FolderKey> = {
  inbox: "inbox",
  sentitems: "sent",
  "sent items": "sent",
  drafts: "drafts",
  archive: "archive",
  junkemail: "spam",
  "junk email": "spam",
  deleteditems: "trash",
  "deleted items": "trash",
};

function raw(m: CapturedComm): Record<string, unknown> {
  return (m.raw && typeof m.raw === "object" ? m.raw : {}) as Record<string, unknown>;
}

export function isUnread(m: CapturedComm): boolean {
  const r = raw(m);
  if (typeof r["isRead"] === "boolean") return !r["isRead"];
  // No Outlook read state stored: inbound mail nobody has actioned yet.
  return m.direction === "inbound" && !m.touchpoint_id;
}

export function isFlagged(m: CapturedComm): boolean {
  const flag = raw(m)["flag"] as { flagStatus?: string } | undefined;
  return flag?.flagStatus === "flagged";
}

export function hasAttachment(m: CapturedComm): boolean {
  return raw(m)["hasAttachments"] === true;
}

/** Outlook categories, used as the Labels section on the rail. */
export function categories(m: CapturedComm): string[] {
  const c = raw(m)["categories"];
  return Array.isArray(c) ? c.filter((v): v is string => typeof v === "string") : [];
}

export function folderOf(m: CapturedComm): FolderKey {
  const r = raw(m);
  const name = (r["parentFolderName"] ?? r["folder"]) as string | undefined;
  if (typeof name === "string") {
    const hit = FOLDER_ALIASES[name.toLowerCase()];
    if (hit) return hit;
  }
  if (r["isDraft"] === true) return "drafts";
  return m.direction === "outbound" ? "sent" : "inbox";
}

export function inFolder(m: CapturedComm, folder: FolderKey): boolean {
  if (folder === "starred") return isFlagged(m);
  return folderOf(m) === folder;
}

/* ------------------------------------------------------------------ search */

export type MailQuery = {
  text: string[];
  from: string[];
  to: string[];
  subject: string[];
  unread: boolean;
  starred: boolean;
  attachment: boolean;
  label: string | null;
};

/** `from:kestrel is:unread has:attachment invoice` */
export function parseMailQuery(input: string): MailQuery {
  const q: MailQuery = {
    text: [],
    from: [],
    to: [],
    subject: [],
    unread: false,
    starred: false,
    attachment: false,
    label: null,
  };
  for (const token of input.trim().split(/\s+/).filter(Boolean)) {
    const [key, ...rest] = token.split(":");
    const value = rest.join(":").toLowerCase();
    switch (value ? key!.toLowerCase() : "") {
      case "from":
        q.from.push(value);
        break;
      case "to":
        q.to.push(value);
        break;
      case "subject":
        q.subject.push(value);
        break;
      case "label":
        q.label = value;
        break;
      case "is":
        if (value === "unread") q.unread = true;
        if (value === "starred" || value === "flagged") q.starred = true;
        break;
      case "has":
        if (value === "attachment" || value === "attachments") q.attachment = true;
        break;
      default:
        q.text.push(token.toLowerCase());
    }
  }
  return q;
}

export function matchesQuery(m: CapturedComm, q: MailQuery): boolean {
  const from = (m.from_address ?? "").toLowerCase();
  const to = (m.to_address ?? "").toLowerCase();
  const subject = (m.subject ?? "").toLowerCase();
  const preview = (m.body_preview ?? "").toLowerCase();

  if (q.unread && !isUnread(m)) return false;
  if (q.starred && !isFlagged(m)) return false;
  if (q.attachment && !hasAttachment(m)) return false;
  if (q.label && !categories(m).some((c) => c.toLowerCase().includes(q.label!))) return false;
  if (!q.from.every((v) => from.includes(v))) return false;
  if (!q.to.every((v) => to.includes(v))) return false;
  if (!q.subject.every((v) => subject.includes(v))) return false;
  return q.text.every(
    (v) => from.includes(v) || to.includes(v) || subject.includes(v) || preview.includes(v),
  );
}

/** Short list date: time today, `12 Aug` this year, else `12/08/25`. */
export function listDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  }
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString("en-US", { day: "numeric", month: "short" });
  }
  return d.toLocaleDateString(DATE_LOCALE, US_DATE);
}

/** "Ilana Beck" out of `Ilana Beck <ilana@kestrel.com>` or the address. */
export function senderLabel(m: CapturedComm): string {
  const addr = (m.direction === "outbound" ? m.to_address : m.from_address) ?? "";
  const named = addr.match(/^\s*"?([^"<]+?)"?\s*</);
  if (named?.[1]) return named[1].trim();
  return addr.trim() || "Unknown sender";
}
