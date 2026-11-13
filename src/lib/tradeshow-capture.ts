/**
 * Trade show lead capture — the flow at the booth.
 *
 * Mark, on how it has to work: "he wants to be able to just dump info into a
 * section and press save. It shouldn't have the skip, skip, skip, because when
 * you're in a tradeshow everything's rushed." And then: "So can take a picture
 * of a business card, and leave a voice note, Then it goes into Leads & accounts
 * from this show for review."
 *
 * So a booth capture is a card photo, a voice note, or both, and Save. Typing
 * is optional and happens afterwards, in the review pass. Nothing is
 * transcribed or read off the card by a machine: the recording and the photo
 * are attached to the lead as they are, and a person fills the fields in.
 *
 * Everything here is queue-aware: the write is attempted now and held on the
 * device if the hall has no signal, with the photo and the recording held
 * alongside it. The raw write lives in `tradeshow-lead-writes.ts` so the queue
 * can replay it without importing this file.
 */
import { useQuery } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import type { CardFieldKey } from "@/lib/business-card";
import { fillLeadFromCard, type CardRead } from "@/lib/business-card-reader";
import { listQueue, writeOrQueue, type QueuedItem } from "@/lib/offline-queue";
import type { OptionValue } from "@/lib/option-lists";
import { makeVariants } from "@/lib/photos";
import type { PipelineStage } from "@/lib/pipeline";
import { findTradeshowLeadSourceId as findTradeshowLeadSource } from "@/lib/tradeshow-lead-source";
import {
  TRADESHOW_LEADS_BUCKET,
  leadAccountName,
  writeTradeshowLead,
  type TradeshowLeadBlobs,
  type TradeshowLeadPayload,
} from "@/lib/tradeshow-lead-writes";
import { signStoredFile, signedUrlStaleMs } from "@/lib/signed-url";

export { leadAccountName };

/* ------------------------------------------------------------------ */
/* What the tablet holds before Save                                   */
/* ------------------------------------------------------------------ */

export type CapturedPhoto = {
  /** Re-encoded WebP when the browser could; the original when it could not. */
  blob: Blob;
  mime: string;
  width: number;
  height: number;
  /** A 480px WebP for the list, or null when re-encoding failed. */
  thumb: Blob | null;
};

export type CapturedAudio = {
  blob: Blob;
  mime: string;
  durationSec: number;
  peaks: number[];
};

export type LeadDetails = {
  name: string;
  company: string;
  phone: string;
  email: string;
  notes: string;
};

export const EMPTY_LEAD_DETAILS: LeadDetails = {
  name: "",
  company: "",
  phone: "",
  email: "",
  notes: "",
};

/**
 * The least a lead needs to be worth anything afterwards: someone or some
 * company to call, and a number or address to call them on. Returns the reason
 * it is not enough, or null when it is.
 */
export function validateLeadDetails(d: LeadDetails): string | null {
  const hasWho = !!(d.name.trim() || d.company.trim());
  const hasHow = !!(d.phone.trim() || d.email.trim());
  if (!hasWho && !hasHow) return "Add a name or company, and a phone or email.";
  if (!hasWho) return "Add a name or a company.";
  if (!hasHow) return "Add a phone number or an email — one is enough.";
  const email = d.email.trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "That email does not look right.";
  return null;
}

/**
 * The booth rule. A capture is worth saving when there is anything at all to
 * review it from: a photo of the card, a recording, a scanned badge, or
 * enough typed to be a lead outright. Anything attached makes it a
 * `needs_review` capture unless the fields are already complete by the typed
 * rule above — then it is an ordinary lead and the queue never sees it. A
 * badge that decoded to a contact card fills those fields, which is how a
 * scan becomes a lead in one tap.
 *
 * With nothing attached, the typed rule stands as it was: a name and no way
 * to reach them, with nothing to find one on, is not a lead.
 */
export function validateBoothCapture(input: {
  details: LeadDetails;
  hasPhoto: boolean;
  hasAudio: boolean;
  /** A scanned badge, parsed or opaque — either is worth keeping. */
  hasBadge?: boolean;
}): { problem: string | null; needsReview: boolean } {
  const typed = validateLeadDetails(input.details);
  const email = input.details.email.trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { problem: "That email does not look right.", needsReview: false };
  }
  if (input.hasPhoto || input.hasAudio || input.hasBadge) {
    return { problem: null, needsReview: typed !== null };
  }
  if (!typed) return { problem: null, needsReview: false };
  const d = input.details;
  const nothingTyped = !(d.name.trim() || d.company.trim() || d.phone.trim() || d.email.trim());
  return {
    problem: nothingTyped
      ? "Photograph their card, scan their badge, leave a voice note, or type a name and a phone or email."
      : typed,
    needsReview: false,
  };
}

/**
 * What a capture with nothing typed is called until it has been reviewed.
 *
 * `accounts.name` is NOT NULL and the whole point of the quick path is that
 * nobody types anything, so the row needs a name it can be recognised by in a
 * list: what it is and the time it was taken. The review pass replaces it
 * with the real one.
 */
export function capturePlaceholderName(
  capturedAtIso: string,
  kind: "voice" | "card" = "voice",
): string {
  const label = kind === "card" ? "Card photo" : "Voice note";
  const d = new Date(capturedAtIso);
  if (Number.isNaN(d.getTime())) return label;
  const when = d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return `${label} · ${when}`;
}

/** The voice-only spelling, kept for the hold-to-talk button and its tests. */
export function voiceCaptureName(capturedAtIso: string): string {
  return capturePlaceholderName(capturedAtIso, "voice");
}

/** True when this account name is still the placeholder a booth capture gave it. */
export function isVoiceCaptureName(name: string): boolean {
  return /^(Voice note|Card photo)(\s·|$)/.test(name.trim());
}

/** The admin-managed "Tradeshow" lead source — shared with the booth form's server side. */
export function findTradeshowLeadSourceId(options: OptionValue[]): string | null {
  return findTradeshowLeadSource(options);
}

/**
 * Where a fresh lead lands on the board: the intake column when the pipeline
 * marks one, otherwise the first live column that is neither won nor lost.
 */
export function pickCaptureStage(stages: PipelineStage[]): PipelineStage | null {
  const live = stages.filter((s) => s.is_active !== false && !s.is_won && !s.is_lost);
  const intake = live.find((s) => (s as { is_intake?: boolean }).is_intake);
  return intake ?? live[0] ?? null;
}

/**
 * Re-encode the camera's output the same way the job photo module does: a
 * 2048px WebP to keep and a 480px WebP for the list. A browser that cannot
 * decode the file (HEIC on a desktop, say) keeps the original instead —
 * a lead is worth more than a thumbnail.
 */
export async function preparePhoto(file: Blob): Promise<CapturedPhoto> {
  try {
    const v = await makeVariants(file);
    return {
      blob: v.display.blob,
      mime: "image/webp",
      width: v.display.width,
      height: v.display.height,
      thumb: v.thumb.blob,
    };
  } catch {
    return { blob: file, mime: file.type || "image/jpeg", width: 0, height: 0, thumb: null };
  }
}

/* ------------------------------------------------------------------ */
/* Building the write                                                  */
/* ------------------------------------------------------------------ */

function newId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
}

export function buildLeadPayload(input: {
  tradeshowId: string;
  tradeshowName: string;
  locationId: string;
  userId: string;
  details: LeadDetails;
  photo: CapturedPhoto | null;
  badge?: CapturedPhoto | null;
  audio: CapturedAudio | null;
  leadSourceId: string | null;
  stageId: string | null;
  pipelineId: string | null;
  capturedAt?: string;
  /** A capture nobody has written up yet — the review pass fills the fields. */
  needsReview?: boolean;
  /** Whatever a scanned badge produced, verbatim. Never parsed here. */
  badgeRaw?: string | null;
}): { payload: TradeshowLeadPayload; blobs: TradeshowLeadBlobs } {
  const d = input.details;
  const capturedAt = input.capturedAt ?? new Date().toISOString();
  const payload: TradeshowLeadPayload = {
    accountId: newId(),
    contactId: d.name.trim() ? newId() : null,
    touchpointId: newId(),
    photoMediaId: input.photo ? newId() : null,
    badgeMediaId: input.badge ? newId() : null,
    badge: input.badge
      ? {
          mime: input.badge.mime,
          width: input.badge.width,
          height: input.badge.height,
          sizeBytes: input.badge.blob.size,
        }
      : null,
    audioMediaId: input.audio ? newId() : null,
    tradeshowId: input.tradeshowId,
    tradeshowName: input.tradeshowName,
    locationId: input.locationId,
    userId: input.userId,
    capturedAt,
    name: d.name.trim(),
    company: d.company.trim(),
    phone: d.phone.trim(),
    email: d.email.trim(),
    notes: d.notes.trim(),
    // A note is the richer thing to be called after; a card alone is a card.
    placeholderName: capturePlaceholderName(capturedAt, input.audio ? "voice" : "card"),
    needsReview: input.needsReview ?? false,
    badgeRaw: (input.badgeRaw ?? "").trim() || null,
    leadSourceId: input.leadSourceId,
    stageId: input.stageId,
    pipelineId: input.pipelineId,
    photo: input.photo
      ? {
          mime: input.photo.mime,
          width: input.photo.width,
          height: input.photo.height,
          sizeBytes: input.photo.blob.size,
          hasThumb: !!input.photo.thumb,
        }
      : null,
    audio: input.audio
      ? {
          mime: input.audio.mime,
          durationSec: input.audio.durationSec,
          peaks: input.audio.peaks,
          sizeBytes: input.audio.blob.size,
        }
      : null,
  };
  const blobs: TradeshowLeadBlobs = {};
  if (input.photo) {
    blobs.photo = { blob: input.photo.blob, mime: input.photo.mime };
    if (input.photo.thumb) blobs.thumb = { blob: input.photo.thumb, mime: "image/webp" };
  }
  if (input.badge) blobs.badge = { blob: input.badge.blob, mime: input.badge.mime };
  if (input.audio) blobs.audio = { blob: input.audio.blob, mime: input.audio.mime };
  return { payload, blobs };
}

/**
 * Save now, or hold on the tablet until the hall has signal. The caller must
 * render `queued: true` as pending — "on this tablet, going up when online" —
 * never as saved.
 */
export async function captureTradeshowLead(
  payload: TradeshowLeadPayload,
  blobs: TradeshowLeadBlobs,
): Promise<{ queued: boolean }> {
  return writeOrQueue({
    kind: "tradeshow_lead",
    id: payload.accountId,
    payload: payload as unknown as Record<string, unknown>,
    blobs,
    label: `${leadAccountName(payload)} · ${payload.tradeshowName}`,
    write: () => writeTradeshowLead(payload, blobs),
  });
}

/**
 * A card read that came back after Save. The rep did not wait for it — the
 * booth rule is that nothing waits — so the lead is already written and the
 * read lands on it here: only the fields the capture left empty, exactly as
 * `fillLeadFromCard` would have filled them on the screen, so a later pass
 * finds the same lead the screen would have saved a second slower. The
 * capture stays `needs_review`: a model read a photograph, and a person
 * confirms it in the review pass, where these fields are its prefill.
 *
 * Only for a lead that went straight through. A queued one is not in the
 * database yet; the review queue's "Read card" reads it once it is.
 * Returns the keys it filled — none means nothing was written.
 */
export async function applyLateCardRead(
  payload: TradeshowLeadPayload,
  read: CardRead,
): Promise<CardFieldKey[]> {
  const current = {
    name: payload.name,
    company: payload.company,
    phone: payload.phone,
    email: payload.email,
    notes: payload.notes,
  };
  const { details, filled } = fillLeadFromCard(current, read);
  if (filled.length === 0) return [];

  const patch: Record<string, unknown> = {};
  if (filled.includes("company") || filled.includes("name")) {
    patch.name = leadAccountName({ ...details, placeholderName: payload.placeholderName });
  }
  if (filled.includes("phone")) patch.phone = details.phone.trim();
  if (filled.includes("email")) patch.email = details.email.trim();
  if (details.notes !== current.notes) patch.notes = details.notes.trim() || null;

  const { error: accErr } = await supabase
    .from("accounts")
    .update(patch as never)
    .eq("id", payload.accountId);
  if (accErr) throw accErr;

  // The person on the card. A contact the capture already made is updated;
  // one the card names for the first time is created against the same lead.
  const touchesContact = (["name", "phone", "email"] as const).some((k) => filled.includes(k));
  if (details.name.trim() && touchesContact) {
    const { error } = await supabase.from("contacts").upsert(
      {
        id: payload.contactId ?? newId(),
        account_id: payload.accountId,
        location_id: payload.locationId,
        full_name: details.name.trim(),
        phone: details.phone.trim() || null,
        email: details.email.trim() || null,
        is_primary: true,
        created_by: payload.userId,
      } as never,
      { onConflict: "id" },
    );
    if (error) throw error;
  }
  return filled;
}

/** Leads for this show still sitting on this device. */
export async function listQueuedLeads(tradeshowId: string): Promise<QueuedItem[]> {
  const all = await listQueue();
  return all.filter(
    (i) =>
      i.kind === "tradeshow_lead" &&
      (i.payload as { tradeshowId?: string }).tradeshowId === tradeshowId,
  );
}

/* ------------------------------------------------------------------ */
/* Reading captures back                                               */
/* ------------------------------------------------------------------ */

export type LeadMedia = Database["public"]["Tables"]["tradeshow_lead_media"]["Row"];

export async function fetchTradeshowLeadMedia(tradeshowId: string): Promise<LeadMedia[]> {
  const { data, error } = await supabase
    .from("tradeshow_lead_media")
    .select("*")
    .eq("tradeshow_id", tradeshowId)
    .order("created_at", { ascending: false })
    .limit(2000);
  if (error) throw error;
  return (data ?? []) as LeadMedia[];
}

/** Captures grouped by the account they belong to. */
export function mediaByAccount(
  media: LeadMedia[],
): Map<string, { photo: LeadMedia | null; audio: LeadMedia | null; badge: LeadMedia | null }> {
  const out = new Map<
    string,
    { photo: LeadMedia | null; audio: LeadMedia | null; badge: LeadMedia | null }
  >();
  for (const m of media) {
    const cur = out.get(m.account_id) ?? { photo: null, audio: null, badge: null };
    const isBadge = /\/badge\.[^/]+$/.test(m.storage_path);
    if (m.kind === "photo" && isBadge && !cur.badge) cur.badge = m;
    if (m.kind === "photo" && !isBadge && !cur.photo) cur.photo = m;
    if (m.kind === "audio" && !cur.audio) cur.audio = m;
    out.set(m.account_id, cur);
  }
  return out;
}

export async function signedLeadMediaUrl(path: string): Promise<string> {
  const { data, error } = await signStoredFile(supabase, TRADESHOW_LEADS_BUCKET, path);
  if (error) throw error;
  return data.signedUrl;
}

/** The stored photo itself, for reading a card off it after the fact. */
export async function fetchLeadMediaBlob(path: string): Promise<Blob> {
  const url = await signedLeadMediaUrl(path);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not fetch the photo (${res.status})`);
  return res.blob();
}

export function useLeadMediaUrl(path: string | null | undefined) {
  return useQuery({
    queryKey: ["tradeshow-lead-media-url", path ?? null],
    enabled: !!path,
    // A minute short of the ten-minute link (was 55 of 60).
    staleTime: signedUrlStaleMs(),
    queryFn: () => signedLeadMediaUrl(path!),
  });
}

export function waveformPeaks(m: LeadMedia | null): number[] {
  const raw = m?.waveform_peaks;
  return Array.isArray(raw) ? raw.filter((n): n is number => typeof n === "number") : [];
}
