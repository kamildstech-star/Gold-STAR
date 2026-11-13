/**
 * One reading of "where is this document up to", shared by every surface that
 * lists documents.
 *
 * The nine `document_status` values are not nine things a project manager
 * cares about. They collapse to four questions: is anyone waiting on the
 * customer, did the customer open it, is it done, and did the customer say no.
 * Everything else — draft, active, expired, void — is filing, not a signature
 * chase, and painting it as one is how a red badge stops being read.
 *
 * Two facts about the data drive the design:
 *
 * 1. `documents.status` is never advanced to `viewed`. The public signing
 *    route stamps `documents.first_viewed_at` on first open (see
 *    `document-sign.functions.ts`) and leaves the status at `sent` or
 *    `pending_signature`. So "they opened it and did not sign" — the single
 *    most actionable state — is invisible if you read `status` alone. We read
 *    the timestamp.
 * 2. `pending_signature` is only ever written when a signature was actually
 *    requested (`document-send.ts` picks it over `sent` on that flag), so it
 *    is self-declaring for any document type. `sent` is ambiguous — it is also
 *    the state of a COI mailed to an adjuster — so for `sent` the document
 *    type decides whether a signature is owed.
 */
import {
  Ban,
  CalendarX,
  CheckCircle2,
  Clock,
  Eye,
  FileCheck,
  FilePen,
  Send,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import type { DocumentStatus, DocumentType } from "./documents";

import { DATE_LOCALE, US_DATE } from "@/lib/date-format";
/**
 * Types that pass through a signature flow, and so may legitimately sit in a
 * "waiting on a signature" state.
 *
 * Derived from what actually creates them: `documents.ts` signs
 * `work_authorization` natively, `contract-signing.ts` writes `contract` and
 * resolves its template from `contract`/`service_agreement`, and the seeded
 * templates in `document-templates.ts` whose bodies are operative undertakings
 * ("I authorise…", "I direct…", "The parties agree…") are the rest. A COI, a
 * W-9, an estimate or an invoice is a record, not an undertaking — nobody ever
 * owes us a signature on one, so none of them may look overdue.
 */
export const SIGNATURE_FLOW_DOCUMENT_TYPES: ReadonlySet<DocumentType> = new Set<DocumentType>([
  "work_authorization",
  "service_agreement",
  "certificate_of_completion",
  "vendor_agreement",
  "direction_to_pay",
  "non_waiver",
  "contract",
]);

/** A chase that has run this long is a phone call, not an email. */
export const SIGNATURE_STALE_DAYS = 7;

/** Only the fields the treatment reads — so any row shape can be passed in. */
export type DocumentSignatureFacts = {
  status: DocumentStatus;
  doc_type: DocumentType;
  created_at?: string | null;
  sent_at?: string | null;
  first_viewed_at?: string | null;
  signed_at?: string | null;
  declined_at?: string | null;
  declined_reason?: string | null;
  expires_at?: string | null;
  last_reminder_at?: string | null;
  reminder_count?: number | null;
};

export type DocumentStatusKey =
  | "draft"
  | "unsigned"
  | "opened"
  | "signed"
  | "declined"
  | "delivered"
  | "active"
  | "expired"
  | "void";

export type DocumentStatusTreatment = {
  key: DocumentStatusKey;
  /** The word on the badge. This, not the colour, carries the state. */
  label: string;
  /** Age suffix — "today", "9d" — or null when there is no clock running. */
  age: string | null;
  icon: LucideIcon;
  /** Tailwind tone classes, built from the app's colour tokens. */
  className: string;
  /** Full sentence, used as the tooltip and the screen-reader text. */
  description: string;
  /** True when someone outside the company still owes us a signature. */
  waiting: boolean;
  /** True when a person has to do something about this today. */
  needsAttention: boolean;
};

/** Columns the treatment needs beyond the usual document list select. */
export const DOCUMENT_SIGNATURE_COLUMNS =
  "sent_at, first_viewed_at, signed_at, declined_at, declined_reason, expires_at, last_reminder_at, reminder_count";

function daysSince(iso: string | null | undefined, now: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now - t) / 86_400_000));
}

function ageLabel(days: number): string {
  return days === 0 ? "today" : `${days}d`;
}

function reminderPhrase(count: number | null | undefined): string {
  if (!count || count < 1) return " No reminder has been sent yet.";
  return ` ${count} reminder${count === 1 ? "" : "s"} sent.`;
}

export function isSignatureFlowType(docType: DocumentType): boolean {
  return SIGNATURE_FLOW_DOCUMENT_TYPES.has(docType);
}

/**
 * Was a signature actually asked for? `pending_signature` says so outright;
 * `sent`/`viewed` only mean it on a type that is signed at all.
 */
export function signatureWasRequested(doc: DocumentSignatureFacts): boolean {
  if (doc.status === "pending_signature") return true;
  if (doc.status === "sent" || doc.status === "viewed") return isSignatureFlowType(doc.doc_type);
  return false;
}

export function treatDocumentStatus(
  doc: DocumentSignatureFacts,
  now: number = Date.now(),
): DocumentStatusTreatment {
  // Terminal states first: none of them is a chase, whatever the type.
  if (doc.status === "signed") {
    const on = doc.signed_at
      ? ` on ${new Date(doc.signed_at).toLocaleDateString(DATE_LOCALE, US_DATE)}`
      : "";
    return {
      key: "signed",
      label: "Signed",
      age: null,
      icon: CheckCircle2,
      className: "bg-success/15 text-success",
      description: `Signed and locked${on}. Nothing outstanding.`,
      waiting: false,
      needsAttention: false,
    };
  }

  if (doc.status === "declined") {
    // Never the same treatment as "unanswered" — a refusal that reads as a
    // slow reply is a refusal nobody ever acts on.
    const reason = doc.declined_reason?.trim();
    return {
      key: "declined",
      label: "Declined",
      age: null,
      icon: XCircle,
      className: "bg-destructive text-destructive-foreground",
      description: reason
        ? `The customer declined to sign: ${reason}`
        : "The customer declined to sign. No reason was recorded.",
      waiting: false,
      needsAttention: true,
    };
  }

  if (doc.status === "void") {
    return {
      key: "void",
      label: "Void",
      age: null,
      icon: Ban,
      className: "bg-muted text-muted-foreground",
      description: "Voided. This document is no longer in play.",
      waiting: false,
      needsAttention: false,
    };
  }

  if (doc.status === "expired") {
    return {
      key: "expired",
      label: "Expired",
      age: null,
      icon: CalendarX,
      className: "bg-destructive/15 text-destructive",
      description: "Expired. Replace it — it is not waiting on a signature.",
      waiting: false,
      needsAttention: false,
    };
  }

  if (doc.status === "draft") {
    return {
      key: "draft",
      label: "Draft",
      age: null,
      icon: FilePen,
      className: "bg-muted text-muted-foreground",
      description: "Draft — not sent to anyone yet, so nobody is waiting on it.",
      waiting: false,
      needsAttention: false,
    };
  }

  // `active` is the resting state of an uploaded COI, W-9 or estimate, and of
  // anything delivered that never needed signing. It is normal, not overdue.
  if (doc.status === "active") {
    return {
      key: "active",
      label: "Active",
      age: null,
      icon: FileCheck,
      className: "bg-info/10 text-info",
      description: "On file and current. No signature is owed on this document.",
      waiting: false,
      needsAttention: false,
    };
  }

  // Remaining: sent / viewed / pending_signature.
  const opened = doc.status === "viewed" || Boolean(doc.first_viewed_at);

  if (!signatureWasRequested(doc)) {
    return {
      key: "delivered",
      label: opened ? "Opened" : "Sent",
      age: null,
      icon: opened ? Eye : Send,
      className: "bg-info/10 text-info",
      description: opened
        ? "Sent and opened by the recipient. No signature was requested."
        : "Sent to the recipient. No signature was requested.",
      waiting: false,
      needsAttention: false,
    };
  }

  // A signature is genuinely outstanding. Show how long, because "waiting" with
  // no clock on it is a state people stop reading.
  const days = daysSince(doc.sent_at ?? doc.created_at, now);
  const linkDead = Boolean(doc.expires_at) && Date.parse(doc.expires_at as string) < now;
  const stale = linkDead || (days !== null && days >= SIGNATURE_STALE_DAYS);
  const since = doc.sent_at
    ? days === null
      ? "Sent for signature"
      : `Sent for signature ${days === 0 ? "today" : `${days} day${days === 1 ? "" : "s"} ago`}`
    : days === null
      ? "Awaiting a signature"
      : `Awaiting a signature for ${days} day${days === 1 ? "" : "s"}`;
  const deadNote = linkDead
    ? " The signing link has expired — it must be re-sent before it can be signed."
    : "";

  if (opened) {
    return {
      key: "opened",
      label: "Opened",
      age: days === null ? null : ageLabel(days),
      icon: Eye,
      // Amber, between red and green: they have it, they have not decided.
      // Chasing the decision, not chasing the email.
      className: stale ? "bg-warning text-warning-foreground" : "bg-warning/15 text-warning",
      description: `${since}. Opened but not signed — chase the decision, not the email.${reminderPhrase(doc.reminder_count)}${deadNote}`,
      waiting: true,
      needsAttention: stale,
    };
  }

  return {
    key: "unsigned",
    label: "Unsigned",
    age: days === null ? null : ageLabel(days),
    icon: Clock,
    className: stale
      ? "bg-destructive text-destructive-foreground"
      : "bg-destructive/15 text-destructive",
    description: `${since}. Never opened — chase whether it arrived.${reminderPhrase(doc.reminder_count)}${deadNote}`,
    waiting: true,
    needsAttention: stale,
  };
}

/** How many of these are still owed a signature. */
export function countWaitingSignatures(
  docs: DocumentSignatureFacts[],
  now: number = Date.now(),
): number {
  return docs.reduce((n, d) => (treatDocumentStatus(d, now).waiting ? n + 1 : n), 0);
}
