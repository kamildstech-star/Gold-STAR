/**
 * `readCard` — one call that turns a business-card photo into fields.
 *
 * Mark: "also the scanner needs to be able to scan business cards as well
 * with qr codes and without."
 *
 * ── The interface the capture screen calls ──────────────────────────────
 *
 *   const read = await readCard(photo.blob, { qrRaw });
 *
 *   read.source      "qr" | "ocr" | "both" | "none"
 *   read.fields      { name, company, title, email, phone, website, address }
 *                    — each a string or null; null means "not on the card or
 *                    not readable", never a guess
 *   read.uncertain   field keys worth a second look before saving
 *   read.raw.qr      the decoded code, verbatim (store it as `badgeRaw`)
 *   read.raw.ocrText every printed line, verbatim, for the review pass
 *   read.confidence  "high" | "medium" | "low"
 *   read.pending     true when the printed-text pass could not run yet
 *
 * `qrRaw` is optional: when the live badge scanner already read a code
 * (Chrome on Android decodes QR from the viewfinder), pass it and the photo
 * is not searched again. Otherwise the photo itself is searched for a QR
 * code, on the device, before anything goes over the wire.
 *
 * QR wins over OCR for any field it supplies; OCR fills the rest
 * (`mergeCardReads`). `fillLeadFromCard` maps a read onto the capture
 * screen's `LeadDetails`, filling only what the rep has not typed.
 *
 * ── Never block the booth ───────────────────────────────────────────────
 *
 * The capture screen should call this fire-and-forget the moment a card
 * photo is taken, show a "Reading card…" state on the photo, and let the rep
 * keep typing or press Save. When the promise settles, fill the empty fields
 * and flag `uncertain` ones; a field the rep already typed is theirs.
 * Nothing here writes to the database.
 *
 * ── Offline ─────────────────────────────────────────────────────────────
 *
 * The QR half needs no network and always runs. The OCR half needs the
 * gateway, so with no signal `readCard` returns straight away with
 * `pending: true` and whatever the QR gave. The photo is already stored on
 * the lead (that was true before this change), so the read is not lost —
 * it is run again later, from one of two places:
 *
 *   1. when the offline queue drains and the lead's write goes through, the
 *      capture flow calls `readCard` on the stored photo with `{ ocr: true }`
 *      and applies the result the same way (fill empties, flag uncertain);
 *   2. failing that, the review queue (`tradeshow-review-queue.tsx`) offers
 *      "Read card" on any lead with a card photo and `pending` fields.
 *
 * Wiring either is the follow-up once the capture-screen branch lands; this
 * module is the capability and its contract.
 */
import { parseBadgePayload } from "@/lib/badge-payload";
import { readBusinessCard } from "@/lib/business-card.functions";
import {
  emptyFields,
  mergeCardReads,
  normaliseCardFields,
  type CardFieldKey,
  type CardRead,
  type CardReadPart,
} from "@/lib/business-card";
import { cardImageDataUrl, decodeQrFromPhoto } from "@/lib/business-card-photo";

export type { CardFields, CardRead, CardSource } from "@/lib/business-card";

export type ReadCardOptions = {
  /** A code the live scanner already read, so the photo is not searched again. */
  qrRaw?: string | null;
  /** False skips the model pass entirely — the QR half still runs. Default true. */
  ocr?: boolean;
  /** Treat the device as offline regardless of `navigator.onLine`. For tests and the queue. */
  offline?: boolean;
};

/**
 * The QR half of a card read. The code is parsed by the same
 * `parseBadgePayload` the badge scanner uses — a vCard is a vCard whether it
 * is on a lanyard or printed on a card — and then normalised the same way
 * the OCR half is, so the two merge field-for-field. Confidence is high when
 * the code carried a contact, medium for a bare URL (the website, nothing
 * else), and low for anything opaque: an attendee id is kept verbatim in
 * `raw` and contributes no fields.
 */
export function qrReadPart(raw: string): (CardReadPart & { raw: string }) | null {
  const text = raw.trim();
  if (!text) return null;
  const parsed = parseBadgePayload(text);
  const loose: Record<string, unknown> = parsed.fields
    ? { ...parsed.fields }
    : { ...emptyFields(), website: parsed.kind === "url" ? text : null };
  const { fields, dropped } = normaliseCardFields(loose);
  const contact = parsed.kind === "vcard" || parsed.kind === "mecard";
  return {
    raw: text,
    fields,
    uncertain: dropped,
    confidence: contact
      ? dropped.length > 0
        ? "medium"
        : "high"
      : parsed.kind === "url"
        ? "medium"
        : "low",
  };
}

function isOffline(opts: ReadCardOptions): boolean {
  if (opts.offline !== undefined) return opts.offline;
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

export async function readCard(photo: Blob, opts: ReadCardOptions = {}): Promise<CardRead> {
  const qrRaw = opts.qrRaw?.trim() || (await decodeQrFromPhoto(photo));
  const qr = qrRaw ? qrReadPart(qrRaw) : null;

  if (opts.ocr === false) return mergeCardReads({ qr, ocr: null, ocrPending: false });
  if (isOffline(opts)) return mergeCardReads({ qr, ocr: null, ocrPending: true });

  const imageDataUrl = await cardImageDataUrl(photo);
  // A photo the browser cannot shrink and the server would refuse is not
  // going to read any better later; the rep types it from the picture.
  if (!imageDataUrl) return mergeCardReads({ qr, ocr: null, ocrPending: false });

  let ocr: (CardReadPart & { ocrText: string | null }) | null = null;
  let ocrPending = false;
  try {
    const result = await readBusinessCard({ data: { image_data_url: imageDataUrl } });
    if (result.ok) {
      ocr = {
        fields: result.fields,
        confidence: result.confidence,
        uncertain: result.uncertain,
        ocrText: result.ocrText,
      };
    } else {
      ocrPending = result.retryable;
    }
  } catch {
    // The request never reached the server (signal dropped mid-hall) or the
    // server threw. Either way the photo is worth another try.
    ocrPending = true;
  }

  return mergeCardReads({ qr, ocr, ocrPending });
}

/* ------------------------------------------------------------------ */
/* Onto the lead                                                       */
/* ------------------------------------------------------------------ */

/** The capture screen's typed fields — the same shape as its `LeadDetails`. */
export type LeadDetailsLike = {
  name: string;
  company: string;
  phone: string;
  email: string;
  notes: string;
};

/**
 * Fill the lead's empty fields from a read. What the rep typed stays; what
 * the card adds beyond the four typed fields (title, website, address) goes
 * into notes as one line each, so nothing read is lost and nothing is
 * silently overwritten. Returns the fields that changed, so the screen can
 * flag the `uncertain` ones among them.
 */
export function fillLeadFromCard<T extends LeadDetailsLike>(
  current: T,
  read: CardRead,
): { details: T; filled: CardFieldKey[] } {
  const filled: CardFieldKey[] = [];
  const next = { ...current };
  const f = read.fields;

  const fill = (key: "name" | "company" | "phone" | "email") => {
    if (!next[key].trim() && f[key]) {
      next[key] = f[key] as T[typeof key];
      filled.push(key);
    }
  };
  fill("name");
  fill("company");
  fill("phone");
  fill("email");

  const extras: string[] = [];
  if (f.title && !current.notes.includes(f.title)) {
    extras.push(f.title);
    filled.push("title");
  }
  if (f.website && !current.notes.includes(f.website)) {
    extras.push(f.website);
    filled.push("website");
  }
  if (f.address && !current.notes.includes(f.address)) {
    extras.push(f.address);
    filled.push("address");
  }
  if (extras.length > 0) {
    next.notes = [current.notes.trim(), ...extras].filter(Boolean).join("\n") as T["notes"];
  }

  return { details: next, filled };
}
