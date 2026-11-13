/**
 * Reading the card photo on the capture screen — the part with no React in it.
 *
 * Mark: "also the scanner needs to be able to scan business cards as well
 * with qr codes and without." `business-card-reader.ts` is the reading; this
 * is what the booth screen does with it, kept pure so the sequence a rep
 * actually produces — photo, type a name, scan a badge, Save before the read
 * is back — can be run in a test without a DOM.
 *
 * The one rule everything here serves: the read is a head start, never the
 * last word, and never a reason to wait. Save is live the moment there is a
 * photo; the read lands when it lands.
 *
 * Who wins when two things supply the same field:
 *
 *   what the rep typed  >  the badge scan  >  the card's QR code  >  the card's printed text
 *
 * Typed always wins because a person looked. A scanned badge beats the card
 * because a vCard is written by its owner and read exactly; the card's own
 * QR is the same kind of thing but a badge is the deliberate scan, so it
 * wins the tie. Printed text is a model reading a photograph and goes last.
 * The QR-over-OCR half is decided inside `readCard`; the badge-over-card
 * half is decided here, by `applyBadgeFields` overwriting a card-filled
 * field and `applyCardRead` never touching a badge-filled one.
 */
import type { BadgeFields } from "@/lib/badge-payload";
import { fillLeadFromCard, readCard, type CardRead } from "@/lib/business-card-reader";
import type { LeadDetails } from "@/lib/tradeshow-capture";

/* ------------------------------------------------------------------ */
/* What the thumbnail says                                             */
/* ------------------------------------------------------------------ */

/**
 * The four states a card photo is in once it is on the screen.
 *
 *  - `reading`  the read is in flight; Save is live regardless.
 *  - `read`     fields came back (or the card had none to give — `read.source`
 *               says which); they are on the form.
 *  - `pending`  the device was offline. The QR half still ran and its fields
 *               are on the form; the printed text is read when the signal is
 *               back, or from the review queue's "Read card".
 *  - `failed`   the read was refused (budget spent, model gave up, request
 *               lost). The photo stays on the lead and the review pass reads
 *               it by eye, or tries again.
 */
export type CardReadState =
  | { status: "reading" }
  | { status: "read"; read: CardRead }
  | { status: "pending"; read: CardRead | null }
  | { status: "failed"; read: CardRead | null };

export const CARD_READ_TEXT = {
  reading: "Reading card…",
  pending: "Will read when online",
  failed: "Couldn't read — write it up after the show",
} as const;

/**
 * What a settled `readCard` means to the screen. Offline is decided before
 * the call, not from the result: `readCard` also reports `pending` for a
 * request that was refused or lost, and that is a failure to the rep — it
 * will not fix itself when the signal comes back the way an offline read will.
 */
export function cardReadOutcome(read: CardRead | null, opts: { offline: boolean }): CardReadState {
  if (opts.offline) return { status: "pending", read };
  if (!read) return { status: "failed", read: null };
  // A refused text pass with a QR code that read is still a read: the code
  // is the card owner's own words, and the review pass can retry the text.
  if (read.source === "none") return { status: "failed", read };
  return { status: "read", read };
}

/**
 * A read in flight. Save takes the promise: the screen clears for the next
 * person the moment the lead is written, and a result that arrives after
 * that still belongs to the lead that was saved.
 */
export type InflightRead = { promise: Promise<CardRead | null> };

/**
 * Fire the read and come straight back. Nothing awaits it: the promise is
 * handed to whoever needs the result after the screen has moved on, and
 * `stillWanted` is asked when it settles — false once the photo was retaken
 * or removed, or the lead saved — so a stale result never lands on the next
 * person's form. The promise never rejects; a throw is a failed read.
 */
export function startCardRead(
  photo: Blob,
  opts: {
    offline: boolean;
    stillWanted: () => boolean;
    onOutcome: (outcome: CardReadState, read: CardRead | null) => void;
    /** The reader, injectable so the sequence can be driven in a test. */
    reader?: typeof readCard;
  },
): InflightRead {
  const reader = opts.reader ?? readCard;
  const promise = reader(photo, { offline: opts.offline }).catch(() => null);
  void promise.then((read) => {
    if (!opts.stillWanted()) return;
    opts.onOutcome(cardReadOutcome(read, { offline: opts.offline }), read);
  });
  return { promise };
}

/** "Elly Lesser · Fairmont Insurance Brokers · (718) 906-0452" — or "" when nothing was read. */
export function cardReadSummary(read: CardRead | null): string {
  if (!read) return "";
  const f = read.fields;
  return [f.name, f.company, f.phone || f.email].filter(Boolean).join(" · ");
}

/** The line under the photo, one per state. */
export function cardReadLabel(state: CardReadState | null): string {
  if (!state) return "Read off it at review.";
  switch (state.status) {
    case "reading":
      return CARD_READ_TEXT.reading;
    case "pending": {
      const qr = cardReadSummary(state.read);
      return qr ? `${CARD_READ_TEXT.pending} — its QR code gave ${qr}` : CARD_READ_TEXT.pending;
    }
    case "failed":
      return CARD_READ_TEXT.failed;
    case "read": {
      const summary = cardReadSummary(state.read);
      if (!summary) return "Nothing readable on it — write it up after the show.";
      const check = state.read.uncertain.length > 0 ? " Check the marked fields." : "";
      return `Read off the card: ${summary}.${check}`;
    }
  }
}

/* ------------------------------------------------------------------ */
/* The fields, and who filled them                                     */
/* ------------------------------------------------------------------ */

export type FieldSource = "badge" | "card";
export type FilledBy = Partial<Record<keyof LeadDetails, FieldSource>>;
export type FieldFlags = Partial<Record<keyof LeadDetails, true>>;

export type FieldState = {
  details: LeadDetails;
  /** Which field a scan or a read put there — so it can be tinted, and taken back. */
  filledBy: FilledBy;
  /** Fields the reader was not sure of. A marker, not a block. */
  uncertain: FieldFlags;
};

export const BADGE_KEYS = ["name", "company", "email", "phone"] as const;

/**
 * A card read onto the form: only what is still empty, and never over a
 * badge (a badge field is never empty, so `fillLeadFromCard`'s own rule
 * covers it). A field the reader flagged is marked whether it was filled or
 * left blank — "the card has a phone I could not read" is worth a glance too.
 */
export function applyCardRead(state: FieldState, read: CardRead): FieldState {
  const { details, filled } = fillLeadFromCard(state.details, read);
  const filledBy: FilledBy = { ...state.filledBy };
  const uncertain: FieldFlags = { ...state.uncertain };
  for (const key of filled) {
    const k = key === "title" || key === "website" || key === "address" ? "notes" : key;
    if (!filledBy[k]) filledBy[k] = "card";
  }
  for (const key of read.uncertain) {
    if (key === "title" || key === "website" || key === "address") continue;
    if (filledBy[key] === "card" || !details[key].trim()) uncertain[key] = true;
  }
  return { details, filledBy, uncertain };
}

/**
 * A badge onto the form: over anything empty and over anything the card put
 * there — the badge is the deliberate scan — but never over what was typed.
 */
export function applyBadgeFields(state: FieldState, fields: BadgeFields): FieldState {
  const details = { ...state.details };
  const filledBy: FilledBy = { ...state.filledBy };
  const uncertain: FieldFlags = { ...state.uncertain };
  for (const k of BADGE_KEYS) {
    const v = fields[k];
    if (!v) continue;
    if (details[k].trim() && filledBy[k] !== "card") continue;
    details[k] = v;
    filledBy[k] = "badge";
    delete uncertain[k];
  }
  return { details, filledBy, uncertain };
}

/**
 * The rep typed. A field he changed is his from then on: it loses its
 * "from badge" / "from card" mark, so a later badge scan will not overwrite
 * the correction, and its "check this", because he has looked.
 */
export function editDetails(state: FieldState, next: LeadDetails): FieldState {
  const filledBy: FilledBy = { ...state.filledBy };
  const uncertain: FieldFlags = { ...state.uncertain };
  for (const k of Object.keys(next) as (keyof LeadDetails)[]) {
    if (next[k] === state.details[k]) continue;
    delete filledBy[k];
    delete uncertain[k];
  }
  return { details: next, filledBy, uncertain };
}

/**
 * Take back what one source put in — the badge was removed, or the photo —
 * and nothing else. Notes are left alone: the card's extra lines (a title, a
 * website) are text the rep can see and delete, and blanking a notes box
 * he may have typed into would lose more than it gives back.
 */
export function takeBackFields(state: FieldState, source: FieldSource): FieldState {
  const details = { ...state.details };
  const filledBy: FilledBy = { ...state.filledBy };
  const uncertain: FieldFlags = { ...state.uncertain };
  for (const k of Object.keys(filledBy) as (keyof LeadDetails)[]) {
    if (filledBy[k] !== source) continue;
    if (k !== "notes") details[k] = "";
    delete filledBy[k];
    delete uncertain[k];
  }
  return { details, filledBy, uncertain };
}

/**
 * The code to store on the capture as `badgeRaw`: the badge if one was
 * scanned, else whatever QR the card carried, so the reviewer's badge chip
 * and prefill work off it the same way. Both are verbatim; neither is parsed
 * here.
 */
export function badgeRawToStore(badgeRaw: string | null, read: CardRead | null): string | null {
  return badgeRaw?.trim() || read?.raw.qr?.trim() || null;
}
